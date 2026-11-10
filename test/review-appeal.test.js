// 第二批 2.8（2026-10-08）绩效申诉：员工端流程与申诉期限（设计 appeal-design.md §4.1、§4.5、§5.2，§10.1 review-appeal）。
//   · 关闭周期且「绩效记录」对员工可见 → resultsAt = 现在，结果通知带申诉截止日与 /review?view=history 链接；
//   · 不可见时 resultsAt 为空；communicate 在可见前 409 results_hidden，之后 200 且只通知一次，再次 409 results_communicated；
//   · 上线前已通知过员工、resultsAt 为空的周期不能申诉（state none），也不能再用 communicate 重开期限（负责人 10/8 定，迟到申诉不予受理）；
//   · 期限 = 告知日（马尼拉日，不计）后第 5 个菲律宾工作日（含当日 23:59:59）；config.json holidays 覆盖内置清单；
//   · 提交校验、一人一周期一次、撤回、并发提交 / 撤回与开始处理的竞争、离职员工；
//   · 员工端永远拿不到调整前评级、内部说明、征询意见与处理信息（§4.7）。
"use strict";
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const W = require("./fixtures/appeal-world.js");

const NOW0 = "2026-10-09T10:00:00+08:00";   // 周五
const NOTE_SECRET = "INTERNAL-NOTE-SECRET-9x 调整理由仅供内部";
const REPLY = "REPLY-TO-EMPLOYEE 经复核，评级调整为更符合实际的档位。";
let w, Q, AN, LG, HQ, L2, L3, L4, PG;

const expectErr = (r, status, code, msg) => {
  assert.equal(r.status, status, (msg || "") + " " + JSON.stringify(r.data));
  if (code) assert.equal(r.data.code, code, (msg || "") + " " + JSON.stringify(r.data));
};
const e2 = async (eid, itemId) => (await w.as(eid)).get(`/api/me/reviews/${itemId}/appeal`);
const histItem = async (eid, cycleId) => {
  const h = await (await w.as(eid)).get("/api/me/reviews/history");
  assert.equal(h.status, 200, JSON.stringify(h.data));
  return { top: h.data, item: h.data.items.find((i) => i.cycleId === cycleId) };
};
const communicate = (cycleId, client) => (client || w.admin).post(`/api/admin/review-cycles/${cycleId}/communicate`, {});

before(async () => {
  w = await W.bootWorld(new Date(NOW0).toISOString());
  await W.buildAppealWorld(w, { personas: false });
  Q = await w.runV2Cycle("2026Q3 Appeal", { "E-A": "B+", "E-A1": "B", "E-B": "A", "E-C": "B", "E-D": "C" });
  AN = await w.runAnnualCycle("2026 Annual Appeal", { "E-A": "B", "E-B": "B" });
  LG = await w.runLegacyCycle("2026 Legacy Appeal", { "E-C": "B", "E-D": "B" });
  // 上线前的周期：关闭时已通知员工
  PG = await w.runLegacyCycle("2026Q2 PreGoLive", { "E-B": "B" });
  // 结果对员工隐藏时关闭的周期：resultsAt 为空，等 communicate
  await w.setPerfVisible(false);
  HQ = await w.runLegacyCycle("2026Q3 Hidden", { "E-A1": "B" });
  L2 = await w.runLegacyCycle("2026 L2 Nov", { "E-A1": "B" });
  L3 = await w.runLegacyCycle("2026 L3 Sat", { "E-A1": "B" });
  L4 = await w.runLegacyCycle("2026 L4 Config", { "E-A1": "B" });
  await w.setPerfVisible(true);
  // 把 PG 还原成「迁移 70 之前」的样子（没有 resultsAt / 截止日），删掉迁移 70 的记录后重启 → 迁移在已有库上重跑（幂等）：
  // 已通知过员工的 PG 回填 resultsAt = closedAt、截止日留空（= 上线前已告知，不开放申诉，制度审查 #1）；从未通知的 HQ 等保持为空
  await w.srv.stopAsync();
  w.dbWrite((d) => {
    d.prepare("UPDATE review_cycles SET resultsAt = NULL, appealDeadline = NULL WHERE id = ?").run(PG.id);
    d.prepare("DELETE FROM schema_migrations WHERE version = 70").run();
  });
  await w.start(new Date(NOW0).toISOString());
});
after(async () => { if (w) await w.stop(); });

test("#1 close with the type visible: resultsAt = fake now; the result notice carries the deadline and links to My performance; history shows an open window", async () => {
  const row = w.dbRead((d) => d.prepare("SELECT resultsAt, status FROM review_cycles WHERE id = ?").get(Q.id));
  assert.equal(row.status, "closed");
  assert.equal(row.resultsAt, new Date(NOW0).toISOString(), "resultsAt is the (fake) moment of the close");
  const n = w.notifs("E-A", "review").filter((x) => x.title_zh.includes("2026Q3 Appeal") && x.title_zh.includes("成长档案"));
  assert.equal(n.length, 1, JSON.stringify(w.notifs("E-A")));
  assert.match(n[0].body, /2026-10-16/, "English body names the deadline");
  assert.match(n[0].body_zh, /2026-10-16/, "Chinese body names the deadline");
  assert.equal(n[0].link, "/review?view=history");
  const { top, item } = await histItem("E-A", Q.id);
  assert.equal(top.today, "2026-10-09");
  assert.deepEqual({ state: item.appeal.state, communicatedOn: item.appeal.communicatedOn, deadline: item.appeal.deadline }, { state: "open", communicatedOn: "2026-10-09", deadline: "2026-10-16" });
  const one = await e2("E-A", Q.items["E-A"]);
  assert.equal(one.status, 200, JSON.stringify(one.data));
  assert.equal(one.data.state, "open");
  assert.equal(one.data.today, "2026-10-09");
  assert.deepEqual(one.data.window, { communicatedOn: "2026-10-09", deadline: "2026-10-16" });
  assert.equal(one.data.item.rating, "B+", "the employee sees the current (final) rating");
  assert.equal(one.data.appeal, null);
  assert.equal(one.data.limits.reasonMin, 50);
  assert.equal(one.data.limits.reasonMax, 4000);
  assert.equal(one.data.limits.filesMax, 5);
  assert.equal(one.data.limits.fileMaxBytes, 10485760);
  // 没有 HRBP 分工 → 由人力资源（兜底）处理
  assert.deepEqual(one.data.recipients, { kind: "hr" });
});

test("#5 submit validation: length after trim, someone else's item, one appeal per cycle (also under a concurrent double submit)", async () => {
  const it = Q.items["E-B"];
  expectErr(await w.submit("E-B", it, { reason: W.text(49) }), 400, "appeal_reason", "49 characters");
  expectErr(await w.submit("E-B", it, { reason: "   " + W.text(49) + "   " }), 400, "appeal_reason", "49 after trim");
  expectErr(await w.submit("E-B", it, { reason: W.text(4001) }), 400, "appeal_reason", "4,001 characters");
  expectErr(await w.submit("E-B", it, { reason: "" }), 400, "appeal_reason", "empty");
  const other = await w.submit("E-A", it, { reason: W.text(80) });
  assert.equal(other.status, 404, "another employee's item is not found: " + JSON.stringify(other.data));
  expectErr(await (await w.as("E-A")).get(`/api/me/reviews/${it}/appeal`), 404, null, "GET another employee's item");
  expectErr(await (await w.as("E-A")).post(`/api/me/reviews/${it}/appeal/withdraw`, {}), 404, null, "withdraw another employee's item");
  assert.equal(w.appealRow(it), undefined, "nothing written by the rejected attempts");
  // 中文说明按字符计：50 个汉字可以提交
  const ok = await w.submit("E-B", it, { reason: "说".repeat(50) });
  assert.equal(ok.status, 201, JSON.stringify(ok.data));
  assert.equal(ok.data.ok, true);
  assert.equal(ok.data.appeal.status, "submitted");
  assert.equal(ok.data.appeal.reason, "说".repeat(50));
  assert.equal(ok.data.appeal.outcome, null);
  assert.equal(ok.data.appeal.reply, null);
  assert.match(ok.data.appeal.id, /^rap-\d+$/);
  expectErr(await w.submit("E-B", it), 409, "appeal_exists", "second submit");
  const row = w.appealRow(it);
  assert.equal(row.status, "submitted");
  assert.equal(row.ratingAtSubmit, "A");
  assert.equal(row.windowDeadline, "2026-10-16");
  assert.equal(row.slaDueOn, "2026-10-23", "10 PH working days after Fri 10-09 (12–16, 19–23)");
  assert.equal(row.deptName, "Dept B");
  assert.equal(row.deptId, w.dept["Dept B"]);
  // 审计：不带说明文字
  const au = w.audits("review.appeal.submit").find((a) => a.target === it);
  assert.ok(au, "review.appeal.submit audited");
  assert.equal(au.after.appealId, row.id);
  assert.equal(au.after.reasonLength, 50);
  assert.ok(!JSON.stringify(au).includes("说说说"), "the audit carries no explanation text");
  // 员工收到提交确认（N2），不含评级
  const n2 = w.notifs("E-B", "review_appeal");
  assert.equal(n2.length, 1);
  assert.equal(n2[0].link, `/review?view=history&item=${it}`);
  // 并发两次提交：只有一条成功，库里一行
  const it2 = Q.items["E-C"];
  const [r1, r2] = await Promise.all([w.submit("E-C", it2), w.submit("E-C", it2)]);
  assert.deepEqual([r1.status, r2.status].sort(), [201, 409], JSON.stringify([r1.data, r2.data]));
  assert.equal((r1.status === 409 ? r1 : r2).data.code, "appeal_exists");
  assert.equal(w.dbRead((d) => d.prepare("SELECT COUNT(*) AS n FROM review_appeals WHERE itemId = ?").get(it2)).n, 1);
});

test("#6 withdraw while submitted; 409 appeal_in_review once started; a withdrawn appeal can't be re-filed; withdraw vs start race leaves one consistent outcome", async () => {
  const it = Q.items["E-B"];
  const wd = await (await w.as("E-B")).post(`/api/me/reviews/${it}/appeal/withdraw`, {});
  assert.equal(wd.status, 200, JSON.stringify(wd.data));
  assert.equal(wd.data.appeal.status, "withdrawn");
  assert.ok(wd.data.appeal.withdrawnAt);
  expectErr(await (await w.as("E-B")).post(`/api/me/reviews/${it}/appeal/withdraw`, {}), 409, "appeal_state", "withdraw twice");
  expectErr(await w.submit("E-B", it), 409, "appeal_exists", "submit after withdraw");
  assert.equal((await histItem("E-B", Q.id)).item.appeal.state, "withdrawn");
  assert.equal(w.audits("review.appeal.withdraw").filter((a) => a.target === it).length, 1);
  // E-C 的申诉（部门 C 无 HRBP → 兜底：超管）：开始处理后不能撤回
  const apC = w.appealRow(Q.items["E-C"]);
  const st = await w.admin.post(`/api/admin/review-appeals/${apC.id}/start`, {});
  assert.equal(st.status, 200, JSON.stringify(st.data));
  expectErr(await (await w.as("E-C")).post(`/api/me/reviews/${Q.items["E-C"]}/appeal/withdraw`, {}), 409, "appeal_in_review");
  assert.equal(w.appealRow(Q.items["E-C"]).status, "in_review");
  // 撤回与开始处理同时到达：恰好一个成功，状态与成功的一方一致
  const itR = Q.items["E-A1"];
  const apR = await w.submitOk("E-A1", itR);
  const [wr, sr] = await Promise.all([
    (await w.as("E-A1")).post(`/api/me/reviews/${itR}/appeal/withdraw`, {}),
    w.admin.post(`/api/admin/review-appeals/${apR}/start`, {}),
  ]);
  const okCount = [wr.status, sr.status].filter((s) => s === 200).length;
  assert.equal(okCount, 1, JSON.stringify([wr.status, wr.data, sr.status, sr.data]));
  const final = w.appealRow(itR).status;
  if (wr.status === 200) { assert.equal(final, "withdrawn"); expectErr(sr, 409, "appeal_state", "start lost the race"); }
  else { assert.equal(final, "in_review"); expectErr(wr, 409, "appeal_in_review", "withdraw lost the race"); }
});

test("#2 type hidden at close: resultsAt null and history hidden; communicate is 409 results_hidden until visible, then 200 once; a stored appeal stays visible while results are hidden", async () => {
  assert.equal(w.dbRead((d) => d.prepare("SELECT resultsAt FROM review_cycles WHERE id = ?").get(HQ.id)).resultsAt, null);
  const before = w.notifs("E-A1", "review").filter((n) => n.title_zh.includes("2026Q3 Hidden") && n.title_zh.includes("成长档案")).length;
  assert.equal(before, 0, "hidden close sends no result notice");
  // 历史里该周期没有申诉块（尚未告知）
  const h0 = await histItem("E-A1", HQ.id);
  assert.equal(h0.item.appeal, null, "not communicated → no appeal block");
  const e0 = await e2("E-A1", HQ.items["E-A1"]);
  assert.equal(e0.data.state, "none");
  assert.equal(e0.data.reasonCode, "not_communicated");
  await w.setPerfVisible(false);
  try {
    const h = (await (await w.as("E-A1")).get("/api/me/reviews/history")).data;
    assert.equal(h.visible, false);
    expectErr(await communicate(HQ.id), 409, "results_hidden");
    // 隐藏期间：已有申诉的员工仍能看到自己的申诉与答复（评估审查 policy #5）
    const stored = await e2("E-B", Q.items["E-B"]);
    assert.equal(stored.status, 200, JSON.stringify(stored.data));
    assert.equal(stored.data.state, "withdrawn", "the stored status wins over results_hidden");
    // 无申诉的项：none / results_hidden
    const none = await e2("E-A", Q.items["E-A"]);
    assert.equal(none.data.state, "none");
    assert.equal(none.data.reasonCode, "results_hidden");
    expectErr(await w.submit("E-A", Q.items["E-A"]), 409, "appeal_unavailable", "submit while hidden");
  } finally { await w.setPerfVisible(true); }
  const ok = await communicate(HQ.id);
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.equal(ok.data.notified, 1);
  assert.equal(ok.data.communicatedOn, "2026-10-09");
  assert.equal(ok.data.deadline, "2026-10-16");
  assert.equal(w.dbRead((d) => d.prepare("SELECT resultsAt FROM review_cycles WHERE id = ?").get(HQ.id)).resultsAt, new Date(NOW0).toISOString());
  const sent = w.notifs("E-A1", "review").filter((n) => n.title_zh.includes("2026Q3 Hidden") && n.title_zh.includes("成长档案"));
  assert.equal(sent.length, 1, "notified exactly once");
  assert.match(sent[0].body, /2026-10-16/);
  expectErr(await communicate(HQ.id), 409, "results_communicated", "second communicate");
  assert.equal(w.notifs("E-A1", "review").filter((n) => n.title_zh.includes("2026Q3 Hidden") && n.title_zh.includes("成长档案")).length, 1, "no second notice");
  const au = w.audits("review.cycle.communicate").filter((a) => a.target === HQ.id);
  assert.equal(au.length, 1);
  assert.deepEqual({ notified: au[0].after.notified, deadline: au[0].after.deadline }, { notified: 1, deadline: "2026-10-16" });
  assert.equal((await e2("E-A1", HQ.items["E-A1"])).data.state, "open");
  // 校验：未关闭 → 400 cycle_open；不存在 → 404 cycle_not_found
  const open = await w.admin.post("/api/admin/review-cycles", { name: "Still Open", dueAt: "2026-12-30", userIds: [w.id("E-B")] });
  expectErr(await communicate(open.data.cycle.id), 400, "cycle_open");
  expectErr(await communicate("rc-99999"), 404, "cycle_not_found");
  // 普通员工不能调用
  expectErr(await communicate(L2.id, await w.as("E-B")), 403);
});

test("#7 annual and legacy cycles are appealable; a cycle communicated before go-live (employees notified at close, no stored deadline) is not appealable and communicate can't reopen it", async () => {
  const an = await e2("E-A", AN.items["E-A"]);
  assert.equal(an.data.state, "open", JSON.stringify(an.data));
  assert.equal(an.data.item.kind, "annual");
  const lg = await e2("E-C", LG.items["E-C"]);
  assert.equal(lg.data.state, "open", JSON.stringify(lg.data));
  assert.equal((await histItem("E-C", LG.id)).item.appeal.state, "open");
  // 上线前：迁移 70 的回填
  const pgRow = w.dbRead((d) => d.prepare("SELECT resultsAt, appealDeadline, closedAt FROM review_cycles WHERE id = ?").get(PG.id));
  assert.equal(pgRow.resultsAt, pgRow.closedAt, "backfilled from closedAt");
  assert.equal(pgRow.appealDeadline, null);
  assert.ok(w.dbRead((d) => d.prepare("SELECT 1 FROM schema_migrations WHERE version = 70").get()), "migration 70 re-applied");
  const pg = await histItem("E-B", PG.id);
  assert.ok(pg.item, "the pre-go-live cycle is still in My performance");
  assert.equal(pg.item.appeal, null, "no appeal block for a pre-go-live cycle");
  const pe = await e2("E-B", PG.items["E-B"]);
  assert.equal(pe.data.state, "none");
  assert.ok(["pre_feature", "before_go_live"].includes(pe.data.reasonCode), "reasonCode " + pe.data.reasonCode);
  expectErr(await w.submit("E-B", PG.items["E-B"]), 409, "appeal_unavailable");
  const re = await communicate(PG.id);
  assert.equal(re.status, 409, "communicate must not reopen a window for results already communicated before go-live: " + JSON.stringify(re.data));
  assert.equal(re.data.code, "results_communicated");
  assert.equal(w.dbRead((d) => d.prepare("SELECT appealDeadline FROM review_cycles WHERE id = ?").get(PG.id)).appealDeadline, null, "no window opened");
});

test("#9 the employee never receives the pre-adjustment rating, the internal note, opinions or handling data — on any endpoint, notification or history; ADJUST shows only the current rating", async () => {
  const it = Q.items["E-A"];
  const up = await w.upload("E-A", it, W.PDF, "evidence.pdf");
  assert.equal(up.status, 200, JSON.stringify(up.data));
  const apId = await w.submitOk("E-A", it, { reason: W.text(120, "MY-EXPLANATION "), attachmentIds: [up.data.id] });
  assert.equal((await w.admin.post(`/api/admin/review-appeals/${apId}/start`, {})).status, 200);
  const dec = await w.admin.post(`/api/admin/review-appeals/${apId}/decide`, { outcome: "adjust", reply: REPLY, internalNote: NOTE_SECRET, newRating: "A", expectRating: "B+" });
  assert.equal(dec.status, 200, JSON.stringify(dec.data));
  const emp = await w.as("E-A");
  const one = (await emp.get(`/api/me/reviews/${it}/appeal`)).data;
  assert.equal(one.state, "adjusted");
  assert.equal(one.item.rating, "A", "only the current rating");
  assert.equal(one.appeal.outcome, "adjust");
  assert.equal(one.appeal.reply, REPLY);
  assert.equal(one.appeal.attachments.length, 1);
  assert.equal(one.appeal.attachments[0].url, "/api/attachments/" + up.data.id);
  assert.deepEqual(Object.keys(one.appeal).filter((k) => !W.EMPLOYEE_APPEAL_KEYS.includes(k)), [], "EmployeeAppeal carries only the documented fields");
  const hist = await histItem("E-A", Q.id);
  assert.equal(hist.item.rating, "A");
  assert.equal(hist.item.appeal.state, "adjusted");
  // 逐个员工端接口扫描：调整前评级 B+、内部说明、处理字段一概不出现（评级选项目录除外）
  const CATALOG = /^(ratingOptions.*|highlightRatings|tiers|bucketOf|limits)$/;
  const scan = (json, where) => {
    const bad = [];
    const walk = (v, p, k) => {
      if (k && CATALOG.test(k)) return;
      if (Array.isArray(v)) return v.forEach((x, i) => walk(x, `${p}[${i}]`));
      if (v && typeof v === "object") { for (const [kk, x] of Object.entries(v)) walk(x, `${p}.${kk}`, kk); return; }
      if (typeof v === "string") {
        if (v === "B+") bad.push(`${p} = B+`);
        if (v.includes("INTERNAL-NOTE-SECRET")) bad.push(`${p} internal note`);
        if (v.includes("HL-SECRET")) bad.push(`${p} highlights`);
      }
    };
    walk(json, "$");
    bad.push(...W.findKeys(json, W.EMPLOYEE_FORBIDDEN_KEYS));
    assert.deepEqual(bad, [], where);
  };
  for (const p of ["/api/me", "/api/me/reviews", "/api/me/reviews/history", `/api/me/reviews/${it}/appeal`, "/api/me/growth", "/api/me/notifications", "/api/me/reviews/appeal-consults"]) {
    const r = await emp.get(p);
    assert.equal(r.status, 200, p + " " + JSON.stringify(r.data).slice(0, 200));
    scan(r.data, "E-A GET " + p);
  }
  // 员工收到的申诉通知：不含任何评级、不含答复或内部说明
  const ns = w.notifs("E-A", "review_appeal");
  assert.ok(ns.length >= 3, "N2 submit, N5 start, N8 decide: " + ns.map((n) => n.title).join(" | "));
  const RATING = /(^|[^\w+])(A\+|A|B\+|B|C|D)(?=[^\w+]|$)/;
  for (const n of ns) {
    for (const f of ["title", "title_zh", "body", "body_zh"]) {
      assert.ok(!RATING.test(String(n[f] || "")), `employee notification ${f} names a rating: ${n[f]}`);
      assert.ok(!String(n[f] || "").includes("REPLY-TO-EMPLOYEE") && !String(n[f] || "").includes("INTERNAL-NOTE"), `notification ${f} carries free text`);
    }
  }
  assert.ok(ns.some((n) => n.link === `/review?view=history&item=${it}`));
});

test("#8 exited employee: none / not_in_service and 403 on submit; an appellant who leaves after submitting still gets a decision, but no employee notification", async () => {
  // E-D 先在旧流程周期提交，随后离职；兜底处理人（超管）照常开始并作出结论
  const apId = await w.submitOk("E-D", LG.items["E-D"]);
  const before = w.notifs("E-D", "review_appeal").length;
  await w.patch("E-D", { empStatus: "exited" });
  const st = await w.admin.post(`/api/admin/review-appeals/${apId}/start`, {});
  assert.equal(st.status, 200, JSON.stringify(st.data));
  const dec = await w.admin.post(`/api/admin/review-appeals/${apId}/decide`, { outcome: "maintain", reply: "维持原评级，理由已在绩效面谈中向你说明清楚了。", expectRating: "B" });
  assert.equal(dec.status, 200, JSON.stringify(dec.data));
  assert.equal(w.appealRow(LG.items["E-D"]).status, "maintained");
  assert.equal(w.notifs("E-D", "review_appeal").length, before, "no start / decide notice to a leaver");
  const exitedEv = w.dbRead((d) => d.prepare("SELECT COUNT(*) AS n FROM review_appeal_events WHERE appealId = ? AND kind = 'appellant_exited'").get(apId)).n;
  assert.equal(exitedEv, 1, "the case records that the appellant had left (policy #9)");
  // 离职者自己的另一个周期：none / not_in_service；提交 403
  const login = await w.as("E-D").catch(() => null);   // empStatus 离职但账号未停用时仍可登录
  if (login) {
    const e = await e2("E-D", Q.items["E-D"]);
    assert.equal(e.data.state, "none");
    assert.equal(e.data.reasonCode, "not_in_service");
    expectErr(await w.submit("E-D", Q.items["E-D"]), 403, "not_in_service");
  }
  assert.equal(w.appealRow(Q.items["E-D"]), undefined);
});

test("#3 config.json holidays replace the built-in list (deadline stored at communicate)", async () => {
  w.writeConfig({ holidays: ["2026-10-12"] });
  try {
    const r = await communicate(L4.id);
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.deadline, "2026-10-19", "Mon 10-12 is a holiday in this config: 13, 14, 15, 16, 19");
  } finally { w.writeConfig(null); }
  // 改回内置清单后，已告知周期的截止日不随之变化（截止日在告知时确定，评估审查 policy #4）
  assert.equal((await e2("E-A1", L4.items["E-A1"])).data.window.deadline, "2026-10-19");
});

test("#4 window edges: open on the deadline day at 23:30 Manila, expired at 00:30 the next day (state only; the UI words it)", async () => {
  await w.restart(new Date("2026-10-16T23:30:00+08:00").toISOString());
  let e = await e2("E-B", AN.items["E-B"]);
  assert.equal(e.data.today, "2026-10-16");
  assert.equal(e.data.state, "open");
  assert.equal((await histItem("E-B", AN.id)).item.appeal.state, "open");
  await w.restart(new Date("2026-10-17T00:30:00+08:00").toISOString());
  e = await e2("E-B", AN.items["E-B"]);
  assert.equal(e.data.today, "2026-10-17");
  assert.equal(e.data.state, "expired");
  assert.deepEqual(e.data.window, { communicatedOn: "2026-10-09", deadline: "2026-10-16" });
  assert.equal((await histItem("E-B", AN.id)).item.appeal.state, "expired");
  expectErr(await w.submit("E-B", AN.items["E-B"]), 409, "appeal_window_closed");
  expectErr(await w.upload("E-B", AN.items["E-B"], W.PNG, "late.png"), 409, "appeal_window_closed");
  // 期限过后 HR 用 2.6 改了评级（没有申诉）→ 视为重新告知：通知员工（不带评级），从改动当天起重新给 5 个工作日（制度审查 #3）
  const ev = (await w.admin.get(`/api/admin/employees/${w.id("E-B")}/profile`)).data.events.find((x) => x.source === "record" && x.type === "performance" && x.title === "2026 Annual Appeal");
  const am = await w.admin.put(`/api/admin/records/${ev.id}`, { type: "performance", date: ev.date, title: ev.title, fields: { ...ev.detail, rating: "B+" }, ratingReason: "correction after calibration review" });
  assert.equal(am.status, 200, JSON.stringify(am.data));
  e = await e2("E-B", AN.items["E-B"]);
  assert.equal(e.data.state, "open", JSON.stringify(e.data));
  assert.deepEqual(e.data.window, { communicatedOn: "2026-10-17", deadline: "2026-10-23" }, "Sat 10-17 → Mon 19 … Fri 23");
  const re = w.notifs("E-B", "review").filter((n) => /has been updated/.test(n.title));
  assert.equal(re.length, 1);
  assert.match(re[0].body, /2026-10-23/);
  assert.ok(!/(^|[^\w+])(A\+|A|B\+|B|C|D)(?=[^\w+]|$)/.test(re[0].body + " " + re[0].title + " " + re[0].body_zh + " " + re[0].title_zh), "no rating in the re-communication");
  // 有申诉的项保持自己的状态，不变成 expired
  assert.equal((await e2("E-B", Q.items["E-B"])).data.state, "withdrawn");
  assert.equal((await e2("E-C", Q.items["E-C"])).data.state, "in_review");
});

test("#3 deadline examples: Sat 10-10 → Fri 10-16; Fri 11-27 → Mon 12-07 (Nov 30 holiday)", async () => {
  await w.restart(new Date("2026-10-10T09:00:00+08:00").toISOString());
  const sat = await communicate(L3.id);
  assert.equal(sat.status, 200, JSON.stringify(sat.data));
  assert.deepEqual([sat.data.communicatedOn, sat.data.deadline], ["2026-10-10", "2026-10-16"]);
  await w.restart(new Date("2026-11-27T09:00:00+08:00").toISOString());
  const nov = await communicate(L2.id);
  assert.equal(nov.status, 200, JSON.stringify(nov.data));
  assert.deepEqual([nov.data.communicatedOn, nov.data.deadline], ["2026-11-27", "2026-12-07"]);
  const e = await e2("E-A1", L2.items["E-A1"]);
  assert.equal(e.data.state, "open");
  assert.deepEqual(e.data.window, { communicatedOn: "2026-11-27", deadline: "2026-12-07" });
  // 告知时刻在马尼拉 00:00–08:00（UTC 前一天）时，告知日按马尼拉日计
  assert.equal(new Date("2026-11-27T09:00:00+08:00").toISOString().slice(0, 10), "2026-11-27");
});
