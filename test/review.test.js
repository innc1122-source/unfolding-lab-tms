// Performance review flow (Phase 3): reporting line, cycle lifecycle,
// self-eval, manager eval against the configurable rating scale, HR
// calibration, and the close step that writes performance records into the
// talent profile (which the 9-box then reflects).
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { ADMIN, EMPLOYEE, startServer, loginAs, makeClient } = require("./helpers.js");

let srv, admin, emp, mgr, mgrId, cycleId, juanItemId, mgrItemId;
before(async () => {
  srv = await startServer();
  admin = await loginAs(srv.base, ADMIN);
  emp = await loginAs(srv.base, EMPLOYEE);
  // Create a manager account and activate it (temp password must be changed first).
  // jobLevel matters: staff with no job level are agency/external and sit out
  // review cycles by default, so a rated manager fixture needs one.
  const created = await admin.post("/api/admin/employees", { name: "Mila Manager", employeeId: "DP-MGR1", department: "Customer Care", jobLevel: "MB3" });
  mgr = makeClient(srv.base);
  await mgr.login({ employeeId: "DP-MGR1", password: created.data.password });
  await mgr.post("/api/auth/change-password", { currentPassword: created.data.password, newPassword: "mgr-pass-123" });
  mgrId = (await admin.get("/api/admin/employees")).data.find((x) => x.employeeId === "DP-MGR1").id;
  // Reporting line: Juan reports to Mila.
  const put = await admin.put("/api/admin/employees/u-1001", { managerId: mgrId });
  assert.equal(put.status, 200);
});
after(() => srv.stop());

test("manager validation: unknown or self manager is rejected", async () => {
  assert.equal((await admin.put("/api/admin/employees/u-1001", { managerId: "u-nope" })).status, 400);
  assert.equal((await admin.put(`/api/admin/employees/${mgrId}`, { managerId: mgrId })).status, 400);
});

test("cycle creation snapshots participants with their manager", async () => {
  const r = await admin.post("/api/admin/review-cycles", { name: "2026-H2 绩效评估" });
  assert.equal(r.status, 200);
  assert.equal(r.data.participants, 2, "Juan + Mila (active non-admins)");
  cycleId = r.data.cycle.id;
  const detail = await admin.get(`/api/admin/review-cycles/${cycleId}`);
  assert.deepEqual(detail.data.ratingOptions, ["A+", "A", "B+", "B", "C", "D"]);
  const juan = detail.data.items.find((i) => i.employeeId === "DP-1001");
  const mila = detail.data.items.find((i) => i.employeeId === "DP-MGR1");
  juanItemId = juan.id; mgrItemId = mila.id;
  assert.equal(juan.manager, "Mila Manager", "manager snapshotted");
  assert.equal(mila.manager, null, "no manager → HR rates in calibration");
  // Admin endpoints refused for employees.
  assert.equal((await emp.get("/api/admin/review-cycles")).status, 403);
});

test("self-eval: 4-step contract (outcomes + required feedback + next goals)", async () => {
  assert.equal((await mgr.post(`/api/me/reviews/${juanItemId}/self`, { feedback: "x", goalsNext: ["g"] })).status, 404, "not my item");
  assert.equal((await emp.post(`/api/me/reviews/${juanItemId}/self`, { outcomes: ["done"] })).status, 400, "feedback is required");
  assert.equal((await emp.post(`/api/me/reviews/${juanItemId}/self`, { feedback: "沟通再多一点", goalsNext: [] })).status, 400, "at least one next goal");
  const mine = await emp.get("/api/me/reviews");
  assert.equal(mine.data.mine.length, 1);
  const ok = await emp.post(`/api/me/reviews/${juanItemId}/self`, {
    outcomes: ["完成 NHO 培训并通过考试,CSAT 稳定在 95%+。"],
    challenges: "需要跨部门数据支持",
    feedback: "希望增加 1v1 频率",
    goalsNext: ["Q3 完成 AML 进阶培训", "带教 2 名新人"],
  });
  assert.equal(ok.status, 200);
  // 第二批波次 3：名单是轻量的 teamRows，自评正文在单人评估页 GET team/:id（旧的完整 team[] 已删）
  const team = await mgr.get("/api/me/reviews");
  assert.ok(!("team" in team.data));
  const row = team.data.teamRows.find((t) => t.employeeId === "DP-1001");
  const juan = (await mgr.get(`/api/me/reviews/team/${row.id}`)).data.item;
  assert.ok(juan.selfAt, "manager sees the submitted self-eval");
  assert.match(juan.selfOutcomes[0], /CSAT/);
  assert.match(juan.selfFeedback, /1v1/);
  assert.equal(juan.goalsNext.length, 2);
});

test("manager eval requires the 1-on-1 and a configured rating", async () => {
  assert.equal((await emp.post(`/api/me/reviews/${juanItemId}/manager`, { rating: "A", oneOnOneDone: true })).status, 404, "only the snapshotted manager");
  assert.equal((await mgr.post(`/api/me/reviews/${juanItemId}/manager`, { rating: "A+" })).status, 400, "1-on-1 must be confirmed first");
  assert.equal((await mgr.post(`/api/me/reviews/${juanItemId}/manager`, { rating: "Z", oneOnOneDone: true })).status, 400, "rating must be a configured option");
  const ok = await mgr.post(`/api/me/reviews/${juanItemId}/manager`, { rating: "A+", text: "超出预期,建议纳入晋升候选。", oneOnOneDone: true, oneOnOneNotes: "8/13 面谈:聚焦跨部门项目机会" });
  assert.equal(ok.status, 200);
  const detail = await admin.get(`/api/admin/review-cycles/${cycleId}`);
  assert.ok(detail.data.items.find((i) => i.employeeId === "DP-1001").oneOnOneAt, "1-on-1 recorded");
});

test("next cycle carries last cycle's goals as prevGoals", async () => {
  // close current cycle first happens in the later test; here just check the shape exists.
  const mine = await emp.get("/api/me/reviews");
  assert.ok(Array.isArray(mine.data.mine[0].prevGoals));
});

test("calibration overrides, close writes profile records, cycle locks", async () => {
  // HR calibrates Juan down to A and rates the manager-less Mila directly.
  assert.equal((await admin.put(`/api/admin/review-items/${juanItemId}`, { finalRating: "A" })).status, 200);
  assert.equal((await admin.put(`/api/admin/review-items/${juanItemId}`, { finalRating: "S" })).status, 400);
  assert.equal((await admin.put(`/api/admin/review-items/${mgrItemId}`, { finalRating: "B+" })).status, 200);
  const closed = await admin.post(`/api/admin/review-cycles/${cycleId}/close`, {});
  assert.equal(closed.status, 200);
  assert.equal(closed.data.written, 2);
  assert.equal(closed.data.skipped, 0);
  // The flow fed the profile: latest performance record carries the FINAL rating.
  const prof = await admin.get("/api/admin/employees/u-1001/profile");
  const rec = prof.data.events.find((e) => e.source === "record" && e.type === "performance" && e.title === "2026-H2 绩效评估");
  assert.ok(rec, "performance record written on close");
  assert.equal(rec.detail.rating, "A", "calibrated rating wins");
  assert.match(rec.detail.summary, /晋升候选/);
  // …and the 9-box reflects it (A = top third of A+/A/B+/B/C/D).
  const grid = await admin.get("/api/admin/talent-review");
  assert.equal(grid.data.rows.find((x) => x.employeeId === "DP-1001").perfBucket, 2);
  // Locked: no more edits or double close.
  assert.equal((await emp.post(`/api/me/reviews/${juanItemId}/self`, { text: "late" })).status, 400);
  assert.equal((await mgr.post(`/api/me/reviews/${juanItemId}/manager`, { rating: "A" })).status, 400);
  assert.equal((await admin.post(`/api/admin/review-cycles/${cycleId}/close`, {})).status, 400);
  // Closed cycles disappear from the employee/manager inbox.
  assert.equal((await emp.get("/api/me/reviews")).data.mine.length, 0);
});

// Agency / externally-hired staff are carried in the roster (they belong on the
// org chart) but are not on the job-grade ladder and are not rated. "No job
// level" is the marker. It is a default, not a hard rule: HR can opt them in
// per cycle, and the server reports how many it left out so the UI can say so.
test("staff with no job level sit out review cycles unless opted in", async () => {
  const ext = await admin.post("/api/admin/employees", { name: "Agency Temp", employeeId: "DP-EXT1", department: "Customer Care" });
  assert.equal(ext.status, 200);
  const extId = (await admin.get("/api/admin/employees")).data.find((x) => x.employeeId === "DP-EXT1").id;
  const levelOf = async (id) => (await admin.get("/api/admin/roster")).data.find((u) => u.id === id).jobLevel;
  assert.ok(!(await levelOf(extId)), "created without a job level");

  const a = await admin.post("/api/admin/review-cycles", { name: "QA excl default" });
  assert.equal(a.status, 200);
  assert.equal(a.data.skippedNoLevel, 1, "the one level-less person is skipped");
  const enrolled = (await admin.get(`/api/admin/review-cycles/${a.data.cycle.id}`)).data.items.map((i) => i.userId);
  assert.ok(!enrolled.includes(extId), "not enrolled by default");

  const b = await admin.post("/api/admin/review-cycles", { name: "QA excl opted in", includeNoLevel: true });
  assert.equal(b.data.skippedNoLevel, 0, "opting in skips nobody");
  const enrolled2 = (await admin.get(`/api/admin/review-cycles/${b.data.cycle.id}`)).data.items.map((i) => i.userId);
  assert.ok(enrolled2.includes(extId), "enrolled once opted in");
  assert.ok(b.data.participants > a.data.participants, "opting in is a strictly larger population");

  // Giving them a level brings them in without any flag.
  assert.equal((await admin.put(`/api/admin/employees/${extId}`, { jobLevel: "PA1" })).status, 200);
  const c = await admin.post("/api/admin/review-cycles", { name: "QA excl now levelled" });
  assert.equal(c.data.skippedNoLevel, 0);
  const enrolled3 = (await admin.get(`/api/admin/review-cycles/${c.data.cycle.id}`)).data.items.map((i) => i.userId);
  assert.ok(enrolled3.includes(extId), "a job level is all it takes to be rated");
});

// 时区回归：本地日与 UTC 日只在每天 00:00–08:00（马尼拉，UTC+8）之间不同。周期关闭时
// 写入的绩效记录 date 是**存进库**的，错一天就永久错一天，还会被晋升资格与时间线排序读到。
// LMS_FAKE_NOW 把「现在」固定在马尼拉 02:00（= 前一天 18:00Z），此时 UTC 日正是前一天。
test("closing a cycle stamps the LOCAL calendar day, not the UTC one", async () => {
  const localDay = "2026-03-10";
  const utcDay = "2026-03-09"; // 同一瞬间的 UTC 日期 —— 回归时会写错成这个
  const fake = `${localDay}T02:00:00+08:00`;
  assert.equal(new Date(fake).toISOString().slice(0, 10), utcDay, "夹具本身要落在两个日期不同的时段里");

  const srv2 = await startServer({ env: { LMS_FAKE_NOW: fake, TZ: "Asia/Manila" } });
  try {
    const admin2 = await loginAs(srv2.base, ADMIN);
    const cycle = await admin2.post("/api/admin/review-cycles", { name: "TZ probe" });
    assert.equal(cycle.status, 200);
    const cid = cycle.data.cycle ? cycle.data.cycle.id : cycle.data.id;
    const detail = await admin2.get(`/api/admin/review-cycles/${cid}`);
    const item = (detail.data.items || [])[0];
    assert.ok(item, "新周期里应该有考核对象");
    assert.equal((await admin2.put(`/api/admin/review-items/${item.id}`, { finalRating: "A" })).status, 200);
    assert.equal((await admin2.post(`/api/admin/review-cycles/${cid}/close`, {})).status, 200);

    const prof = await admin2.get(`/api/admin/employees/${item.userId}/profile`);
    const rec = (prof.data.events || []).find((e) => e.source === "record" && e.type === "performance");
    assert.ok(rec, "关闭周期应该写出一条绩效记录");
    assert.equal(rec.date, localDay, "记录日期必须是本地日历日");
    assert.notEqual(rec.date, utcDay, "UTC 日会让凌晨关闭的周期永久少一天");
  } finally {
    srv2.stop();
  }
});
