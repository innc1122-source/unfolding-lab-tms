// 第二批 2.8（2026-10-08）绩效申诉：HRBP 分工、处理、征询、结论、转交、利益回避（设计 §2、§3、§4.3、§6，§10.1 review-appeal-hrbp）。
//   · 最近的已指定上级部门生效（不与上级合并）；集团层的指定覆盖其下部门；失效的指定人退回上级；无人覆盖 → 兜底（绩效管理 + 范围内）；
//   · 并发开始 / 并发结论只有一个成功；征询只能找上级与部门负责人，意见只能提交一次，结论后征询关闭；
//   · ADJUST 在同一笔事务里走 2.6 改评级（审计 via:'appeal'），注入失败时什么都不写；内部理由不进 2.6 的审计理由（安全审查 #1）；
//   · 转交、处理人失效后接手；利益回避（本人、现任 / 周期上级、现任 / 周期 HoD、校准人、汇报线、此前改过评级的人）一律 404，
//     回避集合在提交时快照（之后改上级不能解除回避，安全审查 #3）；
//   · 分工设置两种 PUT 形状的校验、审计与通知。
"use strict";
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const W = require("./fixtures/appeal-world.js");

const NOW0 = "2026-10-09T10:00:00+08:00";
const NOTE = "INTERNAL-ADJUST-REASON-q7 内部调整理由";
const REPLY = "经复核你的书面说明与佐证材料，评级调整为 B。";
let w, Q, KC, BIG;
const ap = {};       // 名称 → 申诉 id

const expectErr = (r, status, code, msg) => {
  assert.equal(r.status, status, (msg || "") + " " + JSON.stringify(r.data));
  if (code) assert.equal(r.data.code, code, (msg || "") + " " + JSON.stringify(r.data));
};
const list = async (eid) => { const r = await (await w.as(eid)).get("/api/admin/review-appeals"); return r; };
const rowOf = async (eid, id) => { const r = await list(eid); return r.status === 200 ? r.data.items.find((x) => x.id === id) : undefined; };
const det = async (eid, id) => (await w.as(eid)).get(`/api/admin/review-appeals/${id}`);
const act = async (eid, id, a, body) => (await w.as(eid)).post(`/api/admin/review-appeals/${id}/${a}`, body || {});
const NOT_FOUND = (r, msg) => { assert.equal(r.status, 404, (msg || "") + " " + JSON.stringify(r.data)); };

before(async () => {
  w = await W.bootWorld(new Date(NOW0).toISOString());
  await W.buildAppealWorld(w);
  const hrbpRole = w.roles.HRBP;
  for (const [eid, name] of [["P-HA1", "Hal HrbpA1"], ["P-HB2", "Hazel HrbpB2"], ["P-HG", "Gus HrbpG"], ["P-HG2", "Gwen HrbpG2"], ["P-HG3", "Gail HrbpG3"]])
    await w.person(eid, name, null, null, { adminRoleId: hrbpRole });
  await w.cover("Dept A", ["HA"]);
  await w.cover("Dept B", ["HB", "HB2"]);
  await w.cover("G Group", ["HG", "HG2"]);
  Q = await w.runV2Cycle("2026Q3 HRBP", { "E-A": "B+", "E-A1": "B", "E-B": "A", "E-C": "B", "E-D": "C" });
});
after(async () => { if (w) await w.stop(); });

test("#1 resolution: nearest assigned ancestor only; several HRBPs on one department; a group node covers its subtree; an ineffective assignee falls back to the parent; uncovered → fallback", async () => {
  // 员工提交前看到的处理人
  const pre = (await (await w.as("E-A")).get(`/api/me/reviews/${Q.items["E-A"]}/appeal`)).data;
  assert.deepEqual(pre.recipients, { kind: "hrbp", names: ["Hera HrbpA"] });
  ap.A1 = await w.submitOk("E-A1", Q.items["E-A1"]);
  assert.equal((await det("HA", ap.A1)).data.view, "full", "A covers A1");
  let row = await rowOf("HA", ap.A1);
  assert.equal(row.route, "hrbp");
  assert.equal(row.view, "full");
  assert.equal(row.actionable, true);
  // A1 自己有了 HRBP：只有 A1 的 HRBP（不与 A 合并）
  await w.cover("Dept A1", ["HA1"]);
  assert.equal((await det("HA1", ap.A1)).data.view, "full");
  NOT_FOUND(await det("HA", ap.A1), "HA no longer covers A1");
  assert.equal(await rowOf("HA", ap.A1), undefined);
  const full = (await det("HA1", ap.A1)).data;
  assert.deepEqual(full.appeal.coverDept, { id: w.dept["Dept A1"], name: "Dept A1" });
  assert.deepEqual(full.appeal.hrbps.map((h) => h.name), ["Hal HrbpA1"]);
  // A1 的 HRBP 失去后台角色 → 不再生效 → 退回 A 的 HRBP
  await w.patch("HA1", { adminRoleId: null });
  assert.equal((await det("HA", ap.A1)).data.view, "full", "ineffective A1 assignee falls back to A");
  const gone = await det("HA1", ap.A1);
  assert.equal(gone.status, 403, "no console any more → Admin only: " + JSON.stringify(gone.data));
  // 一个部门两名 HRBP：都能看到完整内容
  ap.B = await w.submitOk("E-B", Q.items["E-B"]);
  for (const h of ["HB", "HB2"]) { const r = await rowOf(h, ap.B); assert.equal(r && r.view, "full", h); }
  // 集团层 G 的指定覆盖 C
  ap.C = await w.submitOk("E-C", Q.items["E-C"]);
  const c = (await det("HG", ap.C)).data;
  assert.equal(c.view, "full");
  assert.equal(c.appeal.route, "hrbp");
  assert.equal(c.appeal.coverDept.id, w.dept["G Group"]);
  // D 无人覆盖 → 兜底：超管、内置管理员、绩效与人才管理员（空范围、绩效管理）；范围 A 的绩效管理员与其他 HRBP 看不到
  ap.D = await w.submitOk("E-D", Q.items["E-D"]);
  for (const p of ["SA", "AD", "PT"]) {
    const r = await rowOf(p, ap.D);
    assert.equal(r && r.route, "fallback", p);
    assert.equal(r.view, "full", p);
  }
  assert.equal(await rowOf("PS", ap.D), undefined, "PS scope A");
  assert.equal(await rowOf("HA", ap.D), undefined);
  NOT_FOUND(await det("HB", ap.D));
  // 申诉人提交时的部门快照
  const rowD = w.appealRow(Q.items["E-D"]);
  assert.deepEqual([rowD.deptId, rowD.deptName], [w.dept["Dept D"], "Dept D"]);
  // 提交通知（N3）只发给处理人
  assert.equal(w.notifs("HB", "review_appeal").filter((n) => n.link && n.link.includes(ap.B)).length, 1);
  assert.equal(w.notifs("HB2", "review_appeal").filter((n) => n.link && n.link.includes(ap.B)).length, 1);
  assert.equal(w.notifs("HA", "review_appeal").filter((n) => n.link && n.link.includes(ap.B)).length, 0);
  const fb = w.notifs("SA", "review_appeal").find((n) => n.link && n.link.includes(ap.D));
  assert.ok(fb && /routed to you/.test(fb.body) && /转给你/.test(fb.body_zh), "fallback route wording: " + JSON.stringify(fb));
  // 读完整内容留痕（安全审查 #7）：每人每申诉每天一条 review.appeal.view；只看元数据不记
  const views = (eid, id) => w.audits("review.appeal.view").filter((a) => a.actorId === w.id(eid) && a.after.appealId === id);
  assert.equal(views("HA", ap.A1).length, 1, "HA opened A1 several times today → one row");
  assert.equal(views("HA1", ap.A1).length, 1);
  assert.equal(views("SA", ap.D).length, 0, "the list alone writes nothing");
  await det("SA", ap.D); await det("SA", ap.D);
  assert.equal(views("SA", ap.D).length, 1);
  await det("PR", ap.D);
  assert.equal(views("PR", ap.D).length, 0, "meta view is not a content read");
});

test("#2 start race: two HRBPs start at once — one 200, the other 409 appeal_state; the loser stays read-only", async () => {
  const [r1, r2] = await Promise.all([act("HB", ap.B, "start"), act("HB2", ap.B, "start")]);
  assert.deepEqual([r1.status, r2.status].sort(), [200, 409], JSON.stringify([r1.data, r2.data]));
  const loserRes = r1.status === 409 ? r1 : r2;
  assert.equal(loserRes.data.code, "appeal_state");
  w.handlerB = r1.status === 200 ? "HB" : "HB2";
  w.loserB = r1.status === 200 ? "HB2" : "HB";
  const row = w.appealRow(Q.items["E-B"]);
  assert.equal(row.status, "in_review");
  assert.equal(row.handlerId, w.id(w.handlerB));
  assert.equal(w.audits("review.appeal.start").filter((a) => a.after.appealId === ap.B).length, 1, "audited once");
  // CX-227：员工收到的「开始处理」通知中英文标题都在（曾被行尾注释吞掉 title_zh），且不点名 HRBP（CX-219）
  const started = w.notifs("E-B").filter((n) => /started reviewing/.test(n.title || ""));
  assert.equal(started.length, 1, JSON.stringify(w.notifs("E-B").map((n) => n.title)));
  assert.match(started[0].title_zh || "", /评级申诉已开始处理/);
  assert.ok(!/Your HRBP/.test(started[0].title), started[0].title);   // 周期名本身含「HRBP」，只查措辞
  const lv = (await det(w.loserB, ap.B)).data;
  assert.equal(lv.view, "full");
  assert.equal(lv.permissions.canDecide, false);
  assert.equal(lv.permissions.readOnlyReason, "not_handler");
  expectErr(await act(w.loserB, ap.B, "decide", { outcome: "maintain", reply: W.text(30), expectRating: "A" }), 403, "appeal_no_permission");
  // 员工收到 N5
  assert.ok(w.notifs("E-B", "review_appeal").some((n) => /started/.test(n.title)));
  // 动作名不在白名单 → 404
  NOT_FOUND(await act(w.handlerB, ap.B, "explode"));
});

test("#3 consult: only managers and HoDs; duplicates 409; the consultee sees reason and record but no attachments or others' opinions; opinion once; closed after decide", async () => {
  const up = await w.upload("E-A", Q.items["E-A"], W.PNG, "proof.png");
  assert.equal(up.status, 200, JSON.stringify(up.data));
  ap.A = await w.submitOk("E-A", Q.items["E-A"], { reason: W.text(90, "EXPLANATION-A "), attachmentIds: [up.data.id] });
  expectErr(await act("HA", ap.A, "consult", { consulteeId: w.id("M-A") }), 403, "appeal_no_permission", "consult before start (not the handler yet)");
  assert.equal((await act("HA", ap.A, "start")).status, 200);
  const d = (await det("HA", ap.A)).data;
  const cands = Object.fromEntries(d.consultCandidates.map((c) => [c.id, c]));
  assert.ok(cands[w.id("M-A")] && cands[w.id("M-A")].relation === "manager", JSON.stringify(d.consultCandidates));
  assert.ok(cands[w.id("H-A")] && cands[w.id("H-A")].relation === "hod");
  assert.ok(!cands[w.id("E-A")] && !cands[w.id("HA")], "neither the appellant nor the caller");
  expectErr(await act("HA", ap.A, "consult", { consulteeId: w.id("E-B") }), 400, "consultee_invalid");
  expectErr(await act("HA", ap.A, "consult", { consulteeId: w.id("P-PT") }), 400, "consultee_invalid");
  const c1 = await act("HA", ap.A, "consult", { consulteeId: w.id("M-A"), question: "QUESTION-TO-MGR 请说明评级依据" });
  assert.equal(c1.status, 200, JSON.stringify(c1.data));
  expectErr(await act("HA", ap.A, "consult", { consulteeId: w.id("M-A") }), 409, "consult_exists");
  assert.equal((await act("HA", ap.A, "consult", { consulteeId: w.id("H-A") })).status, 200);
  const au = w.audits("review.appeal.consult").filter((a) => a.after.appealId === ap.A);
  assert.equal(au.length, 2);
  assert.ok(!("consulteeName" in au[0].after), "consult audit carries no name (security #1.4)");
  // N7：征询人收到通知，指向员工端征询页
  const n7 = w.notifs("M-A", "review_appeal");
  assert.equal(n7.length, 1);
  assert.match(n7[0].link, /^\/review\?view=consult&item=rac-\d+$/);
  // 征询人（员工端）
  const mgr = await w.as("M-A");
  assert.deepEqual((await mgr.get("/api/me/reviews")).data.appealConsults, { open: 1, total: 1 });
  const lst = (await mgr.get("/api/me/reviews/appeal-consults")).data.items;
  assert.equal(lst.length, 1);
  assert.equal(lst[0].state, "open");
  assert.equal(lst[0].relation, "manager");
  const cid = lst[0].id;
  // H-A 先提交意见（10 字以下 400）
  const hod = await w.as("H-A");
  const hcid = (await hod.get("/api/me/reviews/appeal-consults")).data.items[0].id;
  expectErr(await hod.post(`/api/me/reviews/appeal-consults/${hcid}/opinion`, { opinion: "太短了" }), 400, "opinion_length");
  assert.equal((await hod.post(`/api/me/reviews/appeal-consults/${hcid}/opinion`, { opinion: "HOD-OPINION-SECRET 评级与校准一致。" })).status, 200);
  expectErr(await hod.post(`/api/me/reviews/appeal-consults/${hcid}/opinion`, { opinion: "HOD-OPINION-SECRET 想再改一次意见。" }), 409, "consult_answered");
  // 别人的征询：404
  NOT_FOUND(await hod.get(`/api/me/reviews/appeal-consults/${cid}`));
  NOT_FOUND(await (await w.as("E-A")).get(`/api/me/reviews/appeal-consults/${cid}`));
  const cd = await mgr.get(`/api/me/reviews/appeal-consults/${cid}`);
  assert.equal(cd.status, 200, JSON.stringify(cd.data));
  assert.equal(cd.data.consult.state, "open");
  assert.equal(cd.data.consult.question, "QUESTION-TO-MGR 请说明评级依据");
  assert.match(cd.data.appeal.reason, /EXPLANATION-A/);
  assert.equal(cd.data.record.finalRating, "B+");
  const s = JSON.stringify(cd.data);
  assert.ok(!s.includes("HOD-OPINION-SECRET"), "no other consultee's opinion");
  assert.ok(!s.includes(up.data.id) && W.findKeys(cd.data, ["attachments"]).length === 0, "no attachments");
  assert.ok(!s.includes("ONE-NOTE-SECRET"), "no 1-on-1 notes");
  assert.deepEqual(W.findKeys(cd.data, ["internalNote", "ratingAtSubmit", "newRating", "ratingBefore", "events", "consults", "hodText"]), [], "manager relation: no hodText, no handling data");
  // 附件：征询人 404
  NOT_FOUND(await mgr.raw("GET", "/api/attachments/" + up.data.id), "consultee can't open attachments");
  // 处理人看到两条征询与 HoD 的意见
  const hd = (await det("HA", ap.A)).data;
  assert.equal(hd.appeal.consults.length, 2);
  assert.ok(hd.appeal.consults.some((c) => c.opinion && c.opinion.includes("HOD-OPINION-SECRET")));
  assert.ok(w.notifs("HA", "review_appeal").some((n) => n.link && n.link.includes(ap.A) && /opinion/.test(n.title)), "N7b to the handler");
  w.consultMA = cid;
});

test("#4 MAINTAIN: reply length, expectRating; the employee sees outcome and reply; no HoD or manager notice; record unchanged; an open consult closes (N13, 409 consult_closed)", async () => {
  expectErr(await act("HA", ap.A, "decide", { outcome: "maintain", reply: W.text(19), expectRating: "B+" }), 400, "appeal_reply");
  expectErr(await act("HA", ap.A, "decide", { outcome: "maintain", reply: W.text(4001), expectRating: "B+" }), 400, "appeal_reply");
  expectErr(await act("HA", ap.A, "decide", { outcome: "maintain", reply: W.text(30), internalNote: W.text(4001), expectRating: "B+" }), 400, "appeal_note");
  expectErr(await act("HA", ap.A, "decide", { outcome: "maintain", reply: W.text(30), expectRating: "A" }), 409, "rating_changed");
  expectErr(await act("HA", ap.A, "decide", { outcome: "dismiss", reply: W.text(30), expectRating: "B+" }), 400);
  const mgrBefore = w.notifs("M-A", "review_appeal").length, hodBefore = w.notifs("H-A", "review_appeal").length;
  const ok = await act("HA", ap.A, "decide", { outcome: "maintain", reply: "MAINTAIN-REPLY 经复核维持原评级 B+，理由如下。", internalNote: "MAINTAIN-NOTE-SECRET", expectRating: "B+" });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  const row = w.appealRow(Q.items["E-A"]);
  assert.equal(row.status, "maintained");
  assert.equal(row.ratingBefore, "B+");
  assert.equal(row.newRating, null);
  assert.equal(w.recordRating(row.recordId), "B+", "record unchanged");
  expectErr(await act("HA", ap.A, "decide", { outcome: "maintain", reply: W.text(30), expectRating: "B+" }), 409, "appeal_state", "decided twice");
  const emp = (await (await w.as("E-A")).get(`/api/me/reviews/${Q.items["E-A"]}/appeal`)).data;
  assert.equal(emp.state, "maintained");
  assert.equal(emp.appeal.outcome, "maintain");
  assert.match(emp.appeal.reply, /MAINTAIN-REPLY/);
  assert.ok(!JSON.stringify(emp).includes("MAINTAIN-NOTE-SECRET"));
  // MAINTAIN 不通知上级与 HoD（N9 只在调整时发）；未答复的 M-A 收到「征询已关闭」（N13），H-A 已答复不收
  const mgrNew = w.notifs("M-A", "review_appeal").slice(mgrBefore);
  assert.equal(mgrNew.length, 1, JSON.stringify(mgrNew));
  assert.match(mgrNew[0].title, /closed/);
  assert.equal(w.notifs("H-A", "review_appeal").length, hodBefore);
  const mgr = await w.as("M-A");
  expectErr(await mgr.post(`/api/me/reviews/appeal-consults/${w.consultMA}/opinion`, { opinion: "TOO-LATE 想补充一句意见。" }), 409, "consult_closed");
  const closed = (await mgr.get(`/api/me/reviews/appeal-consults/${w.consultMA}`)).data;
  assert.equal(closed.consult.state, "closed");
  assert.equal(closed.closedNote, true);
  assert.ok(!("appeal" in closed) && !("record" in closed), "after the decision only the consult itself");
  assert.equal(w.audits("review.appeal.maintain").filter((a) => a.after.appealId === ap.A).length, 1);
});

test("#5 ADJUST: validation; a forced failure after the amend writes nothing; success writes the 2.6 amend audit (via appeal) in the same transaction and every surface shows the new rating", async () => {
  const H = w.handlerB, id = ap.B, itemId = Q.items["E-B"];
  const recId = w.appealRow(itemId).recordId;
  const base = { outcome: "adjust", reply: REPLY, internalNote: NOTE, newRating: "B", expectRating: "A" };
  expectErr(await act(H, id, "decide", { ...base, internalNote: "short" }), 400, "appeal_note", "ADJUST reason under 10");
  expectErr(await act(H, id, "decide", { ...base, internalNote: W.text(1001) }), 400, "appeal_note", "ADJUST reason over 1000");
  expectErr(await act(H, id, "decide", { ...base, newRating: "A" }), 400, "rating_invalid", "same as current");
  expectErr(await act(H, id, "decide", { ...base, newRating: "Z" }), 400, "rating_invalid", "not an option");
  expectErr(await act(H, id, "decide", { ...base, expectRating: "B+" }), 409, "rating_changed");
  // 注入失败（测试缝：改完记录、写完 2.6 审计之后抛错）→ 记录、审计、申诉状态全部不变
  const amendN = () => w.audits("talent.record.rating-amend").length;
  const adjN = () => w.audits("review.appeal.adjust").length;
  const a0 = amendN(), j0 = adjN();
  await w.restart(new Date(NOW0).toISOString(), { LMS_TEST_FAIL_APPEAL_DECIDE: "1" });
  try {
    const bad = await act(H, id, "decide", base);
    assert.ok(bad.status >= 500, "forced failure → 5xx: " + JSON.stringify(bad.data));
    assert.equal(w.recordRating(recId), "A", "record rolled back");
    assert.equal(amendN(), a0, "amend audit rolled back");
    assert.equal(adjN(), j0, "review.appeal.adjust rolled back");
    assert.equal(w.appealRow(itemId).status, "in_review");
  } finally { await w.restart(new Date(NOW0).toISOString(), {}); }
  const mBefore = w.notifs("M-B", "review_appeal").length, hBefore = w.notifs("H-B", "review_appeal").length;
  const ok = await act(H, id, "decide", base);
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.equal(w.recordRating(recId), "B");
  const row = w.appealRow(itemId);
  assert.deepEqual([row.status, row.ratingBefore, row.newRating, row.internalNote, row.reply], ["adjusted", "A", "B", NOTE, REPLY]);
  const amend = w.audits("talent.record.rating-amend").filter((a) => a.target === recId);
  assert.equal(amend.length, 1);
  assert.deepEqual(amend[0].before, { rating: "A" });
  assert.equal(amend[0].after.rating, "B");
  assert.equal(amend[0].after.via, "appeal");
  assert.equal(amend[0].after.appealId, id);
  assert.equal(amend[0].after.reviewItemId, itemId);
  assert.ok(!String(amend[0].after.reason || "").includes("INTERNAL-ADJUST-REASON"), "the internal reason stays on the appeal (security #1): " + amend[0].after.reason);
  const adj = w.audits("review.appeal.adjust").filter((a) => a.target === itemId);
  assert.equal(adj.length, 1);
  assert.deepEqual(adj[0].before, { status: "in_review", rating: "A" });
  assert.equal(adj[0].after.rating, "B");
  assert.equal(adj[0].after.status, "adjusted");
  assert.equal(adj[0].requestId, amend[0].requestId, "same request / transaction");
  assert.ok(!JSON.stringify(adj[0]).includes("INTERNAL-ADJUST-REASON"));
  assert.ok(w.audits("talent.record.update").some((a) => a.target === recId), "after-commit talent.record.update as in 2.6");
  // 各处显示新评级
  const tr = (await w.admin.get(`/api/admin/talent-review?cycle=${Q.id}`)).data;
  assert.equal(tr.rows.find((r) => r.employeeId === "E-B").rating, "B");
  assert.equal((await (await w.as("E-B")).get("/api/me/reviews/history")).data.items.find((i) => i.cycleId === Q.id).rating, "B");
  const rep = (await (await w.as("M-B")).get(`/api/me/reports/${w.id("E-B")}`)).data;
  assert.equal(rep.performance.find((p) => p.source === "archived" && p.cycle === "2026Q3 HRBP").rating, "B");
  const prof = (await w.admin.get(`/api/admin/employees/${w.id("E-B")}/profile`)).data;
  const ev = prof.events.find((e) => e.source === "record" && e.type === "performance" && e.title === "2026Q3 HRBP");
  assert.equal(ev.detail.rating, "B");
  assert.equal(ev.amend.from, "A");
  assert.equal(ev.amend.count, 1);
  assert.ok(!String(ev.amend.reason || "").includes("INTERNAL-ADJUST-REASON"), "profile marker never shows the internal reason");
  // N9：HoD 与上级各一条，带新评级；员工的通知不带评级
  const mNew = w.notifs("M-B", "review_appeal").slice(mBefore), hNew = w.notifs("H-B", "review_appeal").slice(hBefore);
  assert.equal(mNew.length, 1, JSON.stringify(mNew));
  assert.equal(hNew.length, 1, JSON.stringify(hNew));
  for (const n of [...mNew, ...hNew]) { assert.match(n.body, /\bB\b/); assert.match(n.body_zh, /B/); assert.ok(!n.body.includes("REPLY") && !n.body.includes("INTERNAL")); }
  assert.equal(mNew[0].link, `/team/${w.id("E-B")}`);
  const RATING = /(^|[^\w+])(A\+|A|B\+|B|C|D)(?=[^\w+]|$)/;
  for (const n of w.notifs("E-B", "review_appeal")) for (const f of ["title", "title_zh", "body", "body_zh"]) assert.ok(!RATING.test(String(n[f] || "")), `employee notice ${f}: ${n[f]}`);
  // 结论之后 2.6 不能再绕过申诉改评级（非超管 409）
  const after = await (await w.as("HB")).put(`/api/admin/records/${recId}`, { type: "performance", date: ev.date, title: ev.title, fields: { ...ev.detail, rating: "C" }, ratingReason: "try to override" });
  assert.equal(after.status, 409, "a non-super-admin can't overwrite a decided appeal through 2.6: " + JSON.stringify(after.data));
});

test("#5b concurrent decide by the same handler: one 200, the other 409; ADJUST requires expectRating", async () => {
  assert.equal((await act("HA", ap.A1, "start")).status, 200);
  expectErr(await act("HA", ap.A1, "decide", { outcome: "adjust", reply: REPLY, internalNote: NOTE, newRating: "A" }), 400, null, "ADJUST without expectRating");
  const body = { outcome: "maintain", reply: "维持评级，与部门校准结果一致，不作调整。", expectRating: "B" };
  const [r1, r2] = await Promise.all([act("HA", ap.A1, "decide", body), act("HA", ap.A1, "decide", body)]);
  assert.deepEqual([r1.status, r2.status].sort(), [200, 409], JSON.stringify([r1.data, r2.data]));
  assert.equal((r1.status === 409 ? r1 : r2).data.code, "appeal_state");
  assert.equal(w.audits("review.appeal.maintain").filter((a) => a.after.appealId === ap.A1).length, 1);
});

test("#6 distribution: counts are the record ratings of the confirm-snapshot members; a member transferred after close still counts in the original unit", async () => {
  await w.makeDept("Dept Big", "R Group");
  await w.person("BIG-H", "Bea BigHod", "Dept Big");
  await w.setOwner("Dept Big", "BIG-H");
  const eids = [];
  for (let i = 0; i < 10; i++) { await w.person(`BIG-E${i}`, `Big Member ${i}`, "Dept Big", "BIG-H"); eids.push(`BIG-E${i}`); w.unitOf[`BIG-E${i}`] = "Dept Big"; }
  w.hodOfUnit["Dept Big"] = "BIG-H";
  BIG = await w.runAnnualCycle("2026 Big Annual", Object.fromEntries(eids.map((e) => [e, "B"])));
  await w.patch("BIG-E9", { department: "Dept B" });   // 关闭后调到 B
  ap.BIG = await w.submitOk("BIG-E0", BIG.items["BIG-E0"]);
  const d = (await det("SA", ap.BIG)).data;            // 无人覆盖 → 兜底（超管）
  assert.equal(d.view, "full");
  assert.equal(d.distribution.source, "confirm_snapshot");
  assert.equal(d.distribution.headcount, 10);
  assert.equal(d.distribution.small, false);
  assert.deepEqual(d.distribution.counts, { B: 10 });
  assert.equal(d.distribution.appellantBucket, "B");
  assert.equal(d.distribution.unit, w.dept["Dept Big"]);
  // 关闭后调走的人申诉：按关闭归档时的部门路由（制度审查 #7），不交给新部门的 HRBP
  ap.BIG9 = await w.submitOk("BIG-E9", BIG.items["BIG-E9"]);
  const r9 = w.appealRow(BIG.items["BIG-E9"]);
  assert.deepEqual([r9.deptName, r9.deptId], ["Dept Big", w.dept["Dept Big"]]);
  NOT_FOUND(await det("HB", ap.BIG9), "the HRBP of the new department does not get it");
  assert.equal((await det("SA", ap.BIG9)).data.appeal.route, "fallback");
  // 小部门（不足 10 人，配额不适用）：不给逐档人数（安全审查 #12）
  const small = (await det("HG", ap.C)).data.distribution;
  assert.equal(small.small, true);
  assert.equal(small.counts, null);
});

test("#7 reassign: handler → co-HRBP; oversight manager → eligible HRBP; outside the eligible set 400; after coverage removal the appeal is stale and a newly assigned HRBP takes over", async () => {
  assert.equal((await act("HG", ap.C, "start")).status, 200);
  expectErr(await act("HG", ap.C, "reassign", { toUserId: w.id("HA") }), 400, "assignee_invalid");
  expectErr(await act("HG", ap.C, "reassign", { toUserId: w.id("HG") }), 400, "assignee_invalid", "same handler");
  const r1 = await act("HG", ap.C, "reassign", { toUserId: w.id("HG2") });
  assert.equal(r1.status, 200, JSON.stringify(r1.data));
  assert.equal(w.appealRow(Q.items["E-C"]).handlerId, w.id("HG2"));
  assert.ok(w.notifs("HG2", "review_appeal").some((n) => /reassigned to you/.test(n.title)), "N6a");
  expectErr(await act("HG", ap.C, "reassign", { toUserId: w.id("HG") }), 403, "appeal_no_permission", "no longer the handler");
  // 监督（绩效管理、范围内，路由 hrbp）：只看元数据，但可以转交
  const pt = (await det("PT", ap.C)).data;
  assert.equal(pt.view, "meta");
  assert.equal(pt.permissions.canReassign, true);
  assert.deepEqual(W.findKeys(pt, ["reason", "attachments", "consults", "events", "internalNote", "reply"]), [], "meta view carries no content");
  assert.equal((await act("PT", ap.C, "reassign", { toUserId: w.id("HG") })).status, 200);
  expectErr(await act("PR", ap.C, "reassign", { toUserId: w.id("HG2") }), 403, "appeal_no_permission", "perf read cannot reassign");
  expectErr(await act("PT", ap.C, "start"), 403, "appeal_no_permission");
  const audits = w.audits("review.appeal.reassign").filter((a) => a.after.appealId === ap.C);
  assert.equal(audits.length, 2);
  // 撤掉现任处理人的分工 → 待转交；新指定的 HRBP 接手
  await w.cover("G Group", ["HG3"]);
  NOT_FOUND(await det("HG", ap.C), "former handler loses access");
  const row = await rowOf("HG3", ap.C);
  assert.equal(row.handlerStale, true);
  assert.ok(w.notifs("HG3", "review_appeal").some((n) => /needs a new handler/.test(n.title) && n.link && n.link.includes(ap.C)), "N16 to the new handlers (policy #8)");
  assert.ok(w.notifs("HG3", "review_appeal").some((n) => /assigned as HRBP/.test(n.title)), "N14");
  assert.equal(row.actionable, true);
  const dv = (await det("HG3", ap.C)).data;
  assert.equal(dv.permissions.canTakeOver, true);
  expectErr(await act("HG3", ap.C, "decide", { outcome: "maintain", reply: W.text(30), expectRating: "B" }), 403, "appeal_no_permission", "must take over first");
  const take = await act("HG3", ap.C, "reassign", { toUserId: w.id("HG3") });
  assert.equal(take.status, 200, JSON.stringify(take.data));
  assert.equal((await rowOf("HG3", ap.C)).handlerStale, false);
  assert.equal(w.appealRow(Q.items["E-C"]).status, "in_review", "nothing decided automatically");
});

test("#8 conflicts of interest: each conflicted HRBP gets 404 everywhere; reroute to the clean HRBP, or to fallback when all are conflicted; conflicts are snapshotted at submit", async () => {
  const hr = w.roles.HRBP;
  await w.makeDept("Dept K", "R Group");
  for (const k of ["Dept K1", "Dept K2", "Dept K3"]) await w.makeDept(k, "Dept K");
  for (const [e, n] of [["K-H1", "Kai Calibrator"], ["K-H2", "Kim Submitter"], ["K-H3", "Kit CurrentHod"]]) await w.person(e, n, "Dept K", null, { adminRoleId: hr });
  await w.setOwner("Dept K", "K-H1");
  await w.person("K-S", "Ken SkipLevel", "Dept K", "K-H1", { adminRoleId: hr });
  await w.person("K-M1", "Kurt CycleMgr", "Dept K", "K-S", { adminRoleId: hr });
  await w.person("K-M2", "Kara CurrentMgr", "Dept K", "K-S", { adminRoleId: hr });
  await w.person("K-E1", "Kenji Appellant1", "Dept K1", "K-M1");
  await w.person("K-E2", "Kylie Appellant2", "Dept K2", "K-M1");
  await w.person("K-SUB", "Kobe ReportsToE2", "Dept K2", "K-E2", { adminRoleId: hr });
  await w.person("K-HX", "Kris HrbpSelf", "Dept K3", "K-M1", { adminRoleId: hr });
  await w.person("K-AM", "Kane PriorAmender", null, null, { adminRoleId: hr });
  await w.person("K-Y", "Kay Clean", null, null, { adminRoleId: hr });
  for (const e of ["K-E1", "K-E2", "K-HX"]) { w.managerOf[e] = "K-M1"; w.unitOf[e] = "Dept K"; }
  KC = await w.runV2Cycle("2026Q3 Conflict", { "K-E1": "B+", "K-E2": "B+", "K-HX": "B" }, {
    units: { "Dept K": "K-H2" },
    beforeSubmit: async (cid, items) => {
      // K-H1（时任 HoD）校准 K-E1 → review_items.hodId；随后负责人换成 K-H2，由 K-H2 提交（部门状态的 HoD）
      const h1 = await w.as("K-H1");
      const g = (await h1.get("/api/me/reviews/hod")).data.groups.find((x) => x.cycle.id === cid);
      assert.ok(g, "K-H1 sees the unit");
      const r = await h1.put(`/api/me/reviews/hod/items/${items["K-E1"]}`, { rating: "B", reason: "calibrated against peers" });
      assert.equal(r.status, 200, JSON.stringify(r.data));
      await w.setOwner("Dept K", "K-H2");
    },
  });
  await w.setOwner("Dept K", "K-H3");                      // 现任 HoD
  await w.patch("K-E2", { managerId: w.id("K-M2") });      // 现任上级（周期上级是 K-M1）
  // K-AM 在申诉之前用 2.6 改过 K-E2 的评级
  const prof = (await w.admin.get(`/api/admin/employees/${w.id("K-E2")}/profile`)).data;
  const ev = prof.events.find((e) => e.source === "record" && e.type === "performance" && e.title === "2026Q3 Conflict");
  const am = await (await w.as("K-AM")).put(`/api/admin/records/${ev.id}`, { type: "performance", date: ev.date, title: ev.title, fields: { ...ev.detail, rating: "B" }, ratingReason: "typo in archive" });
  assert.equal(am.status, 200, JSON.stringify(am.data));
  await w.cover("Dept K1", ["K-H1", "K-H2", "K-H3", "K-M1", "K-Y"]);
  await w.cover("Dept K2", ["K-M2", "K-S", "K-SUB", "K-AM", "K-Y"]);
  await w.cover("Dept K3", ["K-HX", "K-Y"]);
  const up1 = await w.upload("K-E1", KC.items["K-E1"], W.PDF, "k1.pdf");
  ap.K1 = await w.submitOk("K-E1", KC.items["K-E1"], { attachmentIds: [up1.data.id] });
  const up2 = await w.upload("K-E2", KC.items["K-E2"], W.JPG, "k2.jpg");
  ap.K2 = await w.submitOk("K-E2", KC.items["K-E2"], { attachmentIds: [up2.data.id] });
  ap.K3 = await w.submitOk("K-HX", KC.items["K-HX"]);
  // 提交之后把 K-E2 的上级从 K-M2 改回 K-M1：K-M2 的回避不解除（快照）
  await w.patch("K-E2", { managerId: w.id("K-M1") });
  const cases = [
    [ap.K1, up1.data.id, "K-H1", "calibrator (review_items.hodId)"],
    [ap.K1, up1.data.id, "K-H2", "cycle HoD (dept status submitter)"],
    [ap.K1, up1.data.id, "K-H3", "current HoD"],
    [ap.K1, up1.data.id, "K-M1", "cycle manager (rater)"],
    [ap.K2, up2.data.id, "K-M2", "current manager at submit (changed afterwards: still conflicted)"],
    [ap.K2, up2.data.id, "K-S", "skip-level manager (security #4)"],
    [ap.K2, up2.data.id, "K-SUB", "reports to the appellant (security #4)"],
    [ap.K2, up2.data.id, "K-AM", "earlier 2.6 amender (policy #6)"],
    [ap.K3, null, "K-HX", "the appellant"],
  ];
  for (const [id, att, eid, why] of cases) {
    const c = await w.as(eid);
    const l = await c.get("/api/admin/review-appeals");
    assert.equal(l.status, 200, `${eid} has an assignment, so the desk opens`);
    assert.ok(!l.data.items.some((x) => x.id === id), `${why}: row must be absent`);
    NOT_FOUND(await c.get(`/api/admin/review-appeals/${id}`), why + " detail");
    for (const a of ["start", "consult", "decide", "reassign"]) NOT_FOUND(await c.post(`/api/admin/review-appeals/${id}/${a}`, {}), `${why} ${a}`);
    if (att) NOT_FOUND(await c.raw("GET", "/api/attachments/" + att), why + " attachment");
    assert.equal((await c.get(`/api/admin/review-appeals/${id}`)).data.code, "appeal_not_found");
  }
  for (const id of [ap.K1, ap.K2, ap.K3]) {
    const d = (await det("K-Y", id)).data;
    assert.equal(d.view, "full", "the clean HRBP handles " + id);
    assert.equal(d.appeal.route, "hrbp");
    assert.deepEqual(d.appeal.hrbps.map((h) => h.name), ["Kay Clean"], "conflicted co-HRBPs are not listed as handlers");
  }
  assert.equal((await (await w.as("K-Y")).raw("GET", "/api/attachments/" + up1.data.id)).status, 200);
  // 全部回避 → 兜底（超管）
  await w.cover("Dept K1", ["K-H1", "K-H2", "K-H3", "K-M1"]);
  const sa = (await det("SA", ap.K1)).data;
  assert.equal(sa.view, "full");
  assert.equal(sa.appeal.route, "fallback");
  NOT_FOUND(await det("K-Y", ap.K1), "K-Y no longer covers K1");
  // 回避的人也不出现在统计里（安全审查 #5）：K-M1 看自己的 stats 不含 K1
  const st = await (await w.as("K-M1")).get("/api/admin/review-appeals/stats");
  assert.equal(st.status, 200);
  assert.ok(!JSON.stringify(st.data).includes(ap.K1));
  const sum = st.data.cycles.find((c) => c.cycleId === KC.id);
  assert.ok(!sum || sum.appeals === 0, "conflicted HRBP's stats count none of the conflicted appeals: " + JSON.stringify(sum));
});

test("#9 coverage PUT (a) and (b): validation codes, department.hrbp audit with before/after, N14 / N15 notices, orphan and inactive flags", async () => {
  const put = (client, body) => client.put("/api/admin/review-appeals/coverage", body);
  expectErr(await put(await w.as("AD"), { deptId: w.dept["Dept D"], userIds: [] }), 403, "super_admin_only");
  expectErr(await (await w.as("AD")).get("/api/admin/review-appeals/coverage"), 403, "super_admin_only");
  expectErr(await put(w.admin, { foo: 1 }), 400, "bad_body");
  expectErr(await put(w.admin, { deptId: "d-99999", userIds: [] }), 404, "dept_not_found");
  const ne = await put(w.admin, { deptId: w.dept["Dept D"], userIds: [w.id("P-EMP")] });
  expectErr(ne, 400, "hrbp_not_eligible");
  assert.deepEqual(ne.data.ids, [w.id("P-EMP")]);
  expectErr(await put(w.admin, { deptId: w.dept["Dept D"], userIds: [w.id("HA1")] }), 400, "hrbp_not_eligible", "role removed earlier");
  // 停用的账号
  await w.person("P-HZ", "Zed Deactivated", null, null, { adminRoleId: w.roles.HRBP });
  await w.patch("P-HZ", { active: false });
  expectErr(await put(w.admin, { deptId: w.dept["Dept D"], userIds: [w.id("P-HZ")] }), 400, "hrbp_not_eligible", "deactivated");
  expectErr(await put(w.admin, { deptId: w.dept["Dept D"], userIds: ["HA", "HB", "HB2", "HG", "HG2", "HG3"].map((e) => w.id(e)) }), 400, "too_many_hrbps");
  // (a) 部门 D 指定 HA → 审计、N14
  const n14Before = w.notifs("HA", "review_appeal").length;
  const r = await put(w.admin, { deptId: w.dept["Dept D"], userIds: [w.id("HA")] });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.ok(r.data.coverage && Array.isArray(r.data.coverage.departments));
  const au = w.audits("department.hrbp").filter((a) => a.target === w.dept["Dept D"]);
  assert.equal(au.length, 1);
  assert.deepEqual(au[0].before.hrbpIds, []);
  assert.deepEqual(au[0].after.hrbpIds, [w.id("HA")]);
  assert.deepEqual(au[0].after.hrbpNames, ["Hera HrbpA"]);
  const n14 = w.notifs("HA", "review_appeal").slice(n14Before);
  assert.equal(n14.length, 1);
  assert.match(n14[0].title, /Dept D/);
  // D 的申诉（已开始的除外）现在路由给 HA
  assert.equal((await det("HA", ap.D)).data.view, "full");
  // (b) 一个人的部门：HA → [Dept A]（去掉 D）→ N15
  const r2 = await put(w.admin, { userId: w.id("HA"), deptIds: [w.dept["Dept A"]] });
  assert.equal(r2.status, 200, JSON.stringify(r2.data));
  const n15 = w.notifs("HA", "review_appeal").slice(n14Before + 1);
  assert.equal(n15.length, 1, JSON.stringify(n15));
  assert.match(n15[0].title, /no longer/);
  assert.deepEqual(w.audits("department.hrbp").filter((a) => a.target === w.dept["Dept D"]).pop().after.hrbpIds, []);
  // 停用部门不能新增；已有的指定保留并标出
  await w.makeDept("Dept Old", "R Group");
  await w.cover("Dept Old", ["HB"]);
  const deact = await w.admin.put(`/api/admin/departments/${w.dept["Dept Old"]}`, { active: false });
  assert.equal(deact.status, 200, JSON.stringify(deact.data));
  expectErr(await put(w.admin, { deptId: w.dept["Dept Old"], userIds: [w.id("HB"), w.id("HB2")] }), 400, "dept_inactive");
  // 已删除的部门：孤儿指定
  await w.makeDept("Dept Gone", "R Group");
  await w.cover("Dept Gone", ["HB2"]);
  const del = await w.admin.del(`/api/admin/departments/${w.dept["Dept Gone"]}`);
  assert.equal(del.status, 200, JSON.stringify(del.data));
  const g = (await w.admin.get("/api/admin/review-appeals/coverage")).data;
  assert.ok(g.orphans.some((o) => o.deptId === w.dept["Dept Gone"] && o.userIds.includes(w.id("HB2"))), JSON.stringify(g.orphans));
  const old = g.departments.find((d) => d.id === w.dept["Dept Old"]);
  assert.equal(old.active, false);
  assert.ok(old.assigned.some((a) => a.id === w.id("HB")));
  const a1 = g.departments.find((d) => d.id === w.dept["Dept A1"]);
  const ha1 = a1.assigned.find((a) => a.id === w.id("HA1"));
  assert.equal(ha1.effective, false);
  assert.deepEqual(ha1.issues, ["no_console"]);
  assert.ok(g.uncovered.deptIds.includes(w.dept["Dept Big"]), "uncovered departments listed");
  assert.ok(!g.candidates.some((c) => c.id === w.id("P-EMP") || c.id === w.id("P-HZ")), "candidates are eligible accounts only");
  // 孤儿可以用空列表清掉
  // 设计 §2.7：孤儿指定用 PUT (a) 空列表清掉（已删除的部门只允许清空，不能新增）
  expectErr(await put(w.admin, { deptId: w.dept["Dept Gone"], userIds: [w.id("HB")] }), 404, "dept_not_found", "no new HRBP on a deleted department");
  const clr = await put(w.admin, { deptId: w.dept["Dept Gone"], userIds: [] });
  assert.equal(clr.status, 200, JSON.stringify(clr.data));
  assert.ok(!(await w.admin.get("/api/admin/review-appeals/coverage")).data.orphans.some((o) => o.deptId === w.dept["Dept Gone"]), "orphan row cleared");
});

test("#10 statistics and the closed-cycle header: counts, adjustment rate, handling time, SLA; scoped viewers count only appellants in scope", async () => {
  const sa = (await w.admin.get("/api/admin/review-appeals/stats")).data;
  assert.equal(sa.scope, "all");
  const q = sa.cycles.find((c) => c.cycleId === Q.id);
  assert.deepEqual(
    { appeals: q.appeals, archived: q.archived, maintained: q.maintained, adjusted: q.adjusted, open: q.open, withdrawn: q.withdrawn, withinSla: q.withinSla, avgHandleWorkdays: q.avgHandleWorkdays, appealRate: q.appealRate },
    { appeals: 5, archived: 5, maintained: 2, adjusted: 1, open: 2, withdrawn: 0, withinSla: 3, avgHandleWorkdays: 0, appealRate: 1 },
  );
  assert.ok(Math.abs(q.adjustRate - 1 / 3) < 0.01, String(q.adjustRate));
  assert.deepEqual([q.communicatedOn, q.deadline, q.windowOpen], ["2026-10-09", "2026-10-16", true]);
  const order = sa.cycles.map((c) => c.resultsAt);
  assert.deepEqual(order, [...order].sort().reverse(), "newest communication first");
  // 周期详情头部（§4.5）
  const d = (await w.admin.get(`/api/admin/review-cycles/${Q.id}`)).data.cycle;
  assert.equal(d.results.communicatedOn, "2026-10-09");
  assert.equal(d.results.deadline, "2026-10-16");
  assert.equal(d.results.windowOpen, true);
  assert.equal(d.results.employeeVisible, true);
  assert.equal(d.results.recipients, 5);
  assert.deepEqual(d.appeals, { total: 5, open: 2, decided: 3, adjusted: 1 });
  const ps = (await (await w.as("PS")).get(`/api/admin/review-cycles/${Q.id}`)).data.cycle;
  assert.equal(ps.appeals.total, 2, "PS (scope A) counts E-A and E-A1 only");
  const row = (await w.admin.get("/api/admin/review-cycles")).data.find((c) => c.id === Q.id);
  assert.equal(row.resultsAt, new Date(NOW0).toISOString());
});
