// 第二批 2.8（2026-10-08）绩效申诉：权限矩阵（设计 §3.4、§3.6，§10.1 review-appeal-rbac）。
// 人设：SA 超管；AD 内置 admin（空范围）；PT 内置绩效与人才管理员；PS 绩效管理、范围 A；PR 绩效只读；
// HA / HA2 负责 A，HB 负责 B（自定义「HRBP」角色：people manage、performance none）；LA 培训管理员；AU 审计只读；EMP 普通员工。
// 「A 申诉」= E-A（HA 负责）；「D 申诉」= E-D（无人负责 → 兜底）。
// 另：空范围与超管逐字节一致；角标等于列表；模块关闭全部 404；/api/me.appealDesk；HRBP 分工可越过角色数据范围看到申诉人工号（文档化的例外）；
// 有后台角色的申诉人在自己的档案与审计里看不到内部说明与调整前评级（安全审查 #1）。
"use strict";
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const W = require("./fixtures/appeal-world.js");

const NOW0 = "2026-10-09T10:00:00+08:00";
const NOTE = "INTERNAL-NOTE-RBAC-k2 内部理由";
let w, Q, H = [];
let apA, apD, apX, apC, attA;
const ADMINS = ["SA", "AD", "PT", "PS", "PR", "HA", "HB", "LA", "AU"];

const raw = async (eid, method, p, body) => { const c = await w.as(eid); const r = await c.raw(method, p, body); return { status: r.status, text: await r.text() }; };
const get = async (eid, p) => (await w.as(eid)).get(p);
const post = async (eid, p, b) => (await w.as(eid)).post(p, b || {});
const st = (r, s, msg) => assert.equal(r.status, s, msg + " → " + r.status + " " + JSON.stringify(r.data).slice(0, 300));

before(async () => {
  w = await W.bootWorld(new Date(NOW0).toISOString());
  await W.buildAppealWorld(w);
  await w.person("P-HA2", "Hope HrbpA2", null, null, { adminRoleId: w.roles.HRBP });
  await w.person("P-HS", "Hugh HrbpScoped", null, null, { adminRoleId: await w.role("HS", { people: "manage" }, { departments: [{ id: w.dept["Dept A"], includeChildren: true }] }) });
  await w.person("P-XA", "Xena HrAppellant", "Dept B", "M-B", { adminRoleId: await w.role("XA", { people: "manage", audit: "read" }) });
  w.managerOf["P-XA"] = "M-B"; w.unitOf["P-XA"] = "Dept B";
  await w.cover("Dept A", ["HA", "HA2"]);
  await w.cover("Dept B", ["HB"]);
  await w.cover("Dept C", ["HS"]);
  Q = await w.runV2Cycle("2026Q3 RBAC", { "E-A": "B+", "E-B": "B", "E-C": "B", "E-D": "C", "P-XA": "A" });
  await w.setPerfVisible(false);
  for (let i = 0; i < 3; i++) H.push(await w.runLegacyCycle("2026 Hidden " + i, { "E-A": "B", "E-B": "B" }));
  await w.setPerfVisible(true);
  const up = await w.upload("E-A", Q.items["E-A"], W.PDF, "a.pdf");
  assert.equal(up.status, 200, JSON.stringify(up.data));
  attA = up.data.id;
  apA = await w.submitOk("E-A", Q.items["E-A"], { attachmentIds: [attA] });
  apD = await w.submitOk("E-D", Q.items["E-D"]);
  apX = await w.submitOk("P-XA", Q.items["P-XA"]);
  apC = await w.submitOk("E-C", Q.items["E-C"]);
});
after(async () => { if (w) await w.stop(); });

test("list: rows per persona (full / meta / absent), gate 404 for unrelated admins, 403 for employees; parity with the super-admin; badge equals list", async () => {
  const exp = {
    SA: { A: "meta", D: "full" }, AD: { A: "meta", D: "full" }, PT: { A: "meta", D: "full" },
    PS: { A: "meta", D: undefined }, PR: { A: "meta", D: "meta" }, HA: { A: "full", D: undefined }, HB: { A: undefined, D: undefined },
  };
  for (const [p, e] of Object.entries(exp)) {
    const r = await get(p, "/api/admin/review-appeals");
    st(r, 200, p + " list");
    const v = (id) => { const x = r.data.items.find((i) => i.id === id); return x ? x.view : undefined; };
    assert.equal(v(apA), e.A, `${p}: A appeal`);
    assert.equal(v(apD), e.D, `${p}: D appeal`);
    // 行里没有内容字段
    assert.deepEqual(W.findKeys(r.data.items, ["reason", "attachments", "reply", "internalNote", "consults", "events"]), [], p + " rows carry no content");
    // 角标 = 列表
    const s = await get(p, "/api/admin/review-appeals/summary");
    st(s, 200, p + " summary");
    assert.equal(s.data.actionable, r.data.items.filter((i) => i.actionable).length, p + " badge = list");
    assert.equal(s.data.actionable, r.data.counts.actionable, p + " counts.actionable");
  }
  assert.equal((await get("HA", "/api/admin/review-appeals")).data.items.find((i) => i.id === apA).actionable, true);
  assert.equal((await get("PR", "/api/admin/review-appeals")).data.items.find((i) => i.id === apD).actionable, false);
  for (const p of ["LA", "AU"]) { st(await get(p, "/api/admin/review-appeals"), 404, p + " gate"); st(await get(p, "/api/admin/review-appeals/summary"), 404, p + " summary gate"); }
  const emp = await get("EMP", "/api/admin/review-appeals");
  st(emp, 403, "EMP");
  // 空范围 + 绩效管理（AD、PT）与超管逐字节一致
  for (const p of ["/api/admin/review-appeals", "/api/admin/review-appeals/summary", "/api/admin/review-appeals/stats", `/api/admin/review-appeals/${apA}`]) {
    const sa = await raw("SA", "GET", p);
    for (const q of ["AD", "PT"]) assert.equal((await raw(q, "GET", p)).text, sa.text, `${q} differs from SA on ${p}`);
  }
});

test("detail: meta for oversight, full for the covering HRBP and fallback handlers, 404 for everyone else (same body as not found)", async () => {
  const exp = {
    SA: [ "meta", "full"], AD: ["meta", "full"], PT: ["meta", "full"], PS: ["meta", 404], PR: ["meta", "meta"],
    HA: ["full", 404], HB: [404, 404], LA: [404, 404], AU: [404, 404], EMP: [403, 403],
  };
  for (const [p, [a, d]] of Object.entries(exp)) {
    for (const [id, e] of [[apA, a], [apD, d]]) {
      const r = await get(p, `/api/admin/review-appeals/${id}`);
      if (typeof e === "number") {
        st(r, e, `${p} detail ${id}`);
        if (e === 404 && !["LA", "AU"].includes(p)) assert.equal(r.data.code, "appeal_not_found");
      } else {
        st(r, 200, `${p} detail ${id}`);
        assert.equal(r.data.view, e, `${p} detail ${id}`);
        if (e === "meta") assert.deepEqual(W.findKeys(r.data, ["reason", "attachments", "reply", "internalNote", "consults", "events", "review", "distribution", "calibrationLog"]), [], p + " meta has no content");
      }
    }
  }
  st(await get("SA", "/api/admin/review-appeals/rap-99999"), 404, "unknown id");
});

test("start: 403 for oversight on an HRBP appeal, 200 for the HRBP; 200 for fallback handlers on an uncovered appeal; 404 / 403 for the rest", async () => {
  // D 申诉
  st(await post("PS", `/api/admin/review-appeals/${apD}/start`), 404, "PS out of scope");
  const pr = await post("PR", `/api/admin/review-appeals/${apD}/start`);
  st(pr, 403, "PR"); assert.equal(pr.data.code, "appeal_no_permission");
  for (const p of ["HA", "HB", "LA", "AU"]) st(await post(p, `/api/admin/review-appeals/${apD}/start`), 404, p);
  st(await post("EMP", `/api/admin/review-appeals/${apD}/start`), 403, "EMP");
  for (const p of ["AD", "PT"]) assert.equal((await get(p, `/api/admin/review-appeals/${apD}`)).data.permissions.canStart, true, p + " may start the fallback appeal");
  st(await post("SA", `/api/admin/review-appeals/${apD}/start`), 200, "SA starts D");
  // A 申诉
  for (const p of ["SA", "AD", "PT", "PS", "PR"]) { const r = await post(p, `/api/admin/review-appeals/${apA}/start`); st(r, 403, p + " on A"); assert.equal(r.data.code, "appeal_no_permission"); }
  for (const p of ["HB", "LA", "AU"]) st(await post(p, `/api/admin/review-appeals/${apA}/start`), 404, p + " on A");
  st(await post("EMP", `/api/admin/review-appeals/${apA}/start`), 403, "EMP on A");
  st(await post("HA", `/api/admin/review-appeals/${apA}/start`), 200, "HA starts A");
});

test("reassign an in-review HRBP appeal: SA / AD / PT / PS and the handler 200; PR 403; HB 404", async () => {
  const to = (eid) => ({ toUserId: w.id(eid) });
  let cur = "HA";
  const next = () => (cur === "HA" ? "HA2" : "HA");
  for (const p of ["HA", "SA", "AD", "PT", "PS"]) {
    if (p === "HA") assert.equal(cur, "HA");
    const tgt = next();
    const r = await post(p, `/api/admin/review-appeals/${apA}/reassign`, to(tgt));
    st(r, 200, `${p} reassign → ${tgt}`);
    cur = tgt;
    assert.equal(w.appealRow(Q.items["E-A"]).handlerId, w.id(cur));
  }
  const pr = await post("PR", `/api/admin/review-appeals/${apA}/reassign`, to(next()));
  st(pr, 403, "PR"); assert.equal(pr.data.code, "appeal_no_permission");
  st(await post("HB", `/api/admin/review-appeals/${apA}/reassign`, to(next())), 404, "HB");
  st(await post("LA", `/api/admin/review-appeals/${apA}/reassign`, to(next())), 404, "LA");
  st(await post("EMP", `/api/admin/review-appeals/${apA}/reassign`, to(next())), 403, "EMP");
  // 只能转给负责该部门、无冲突的人
  const bad = await post("SA", `/api/admin/review-appeals/${apA}/reassign`, to("HB"));
  st(bad, 400, "target outside the eligible set"); assert.equal(bad.data.code, "assignee_invalid");
});

test("stats: all for SA (AD / PT identical), scoped for PS, all for PR, own appeals only for an HRBP, 404 for LA / AU", async () => {
  const cyc = (r) => r.data.cycles.find((c) => c.cycleId === Q.id);
  const sa = await get("SA", "/api/admin/review-appeals/stats");
  st(sa, 200, "SA stats");
  assert.equal(sa.data.scope, "all");
  assert.equal(cyc(sa).appeals, 4);
  assert.equal(cyc(sa).archived, 5);
  const ps = await get("PS", "/api/admin/review-appeals/stats");
  assert.equal(ps.data.scope, "scoped");
  assert.equal(cyc(ps).appeals, 1, "PS (scope A) counts only E-A");
  assert.equal(cyc(ps).archived, 1);
  const pr = await get("PR", "/api/admin/review-appeals/stats");
  assert.equal(pr.data.scope, "all");
  assert.equal(cyc(pr).appeals, 4);
  const ha = await get("HA2", "/api/admin/review-appeals/stats");
  assert.equal(ha.data.scope, "hrbp");
  assert.equal(cyc(ha).appeals, 1);
  assert.equal(cyc(ha).archived, null);
  for (const p of ["LA", "AU"]) st(await get(p, "/api/admin/review-appeals/stats"), 404, p);
  st(await get("EMP", "/api/admin/review-appeals/stats"), 403, "EMP");
  // 只含已告知的已关闭周期，按 resultsAt 倒序；隐藏关闭、尚未告知的周期不在内
  assert.ok(!sa.data.cycles.some((c) => H.some((h) => h.id === c.cycleId)));
});

test("coverage GET / PUT: super-admin only (403 super_admin_only for other console users who pass the gate, 404 for LA / AU)", async () => {
  st(await get("SA", "/api/admin/review-appeals/coverage"), 200, "SA GET");
  st(await w.admin.put("/api/admin/review-appeals/coverage", { deptId: w.dept["Dept B"], userIds: [w.id("HB")] }), 200, "SA PUT");
  for (const p of ["AD", "PT", "PS", "PR", "HA", "HB"]) {
    const g = await get(p, "/api/admin/review-appeals/coverage");
    st(g, 403, p + " GET"); assert.equal(g.data.code, "super_admin_only");
    const u = await (await w.as(p)).put("/api/admin/review-appeals/coverage", { deptId: w.dept["Dept B"], userIds: [] });
    st(u, 403, p + " PUT"); assert.equal(u.data.code, "super_admin_only");
  }
  for (const p of ["LA", "AU"]) {
    st(await get(p, "/api/admin/review-appeals/coverage"), 404, p + " GET");
    st(await (await w.as(p)).put("/api/admin/review-appeals/coverage", { deptId: w.dept["Dept B"], userIds: [] }), 404, p + " PUT");
  }
  st(await get("EMP", "/api/admin/review-appeals/coverage"), 403, "EMP");
  assert.deepEqual(w.dbRead((d) => d.prepare("SELECT userId FROM hrbp_assignments WHERE deptId = ?").all(w.dept["Dept B"])).map((r) => r.userId), [w.id("HB")], "nothing changed by the rejected PUTs");
});

test("attachment of the A appeal: the appellant and the full-access handlers get 200; oversight, other HRBPs, unrelated admins and employees 404", async () => {
  const url = "/api/attachments/" + attA;
  for (const p of ["E-A", "HA", "HA2"]) {
    const r = await raw(p, "GET", url);
    assert.equal(r.status, 200, p);
  }
  const ok = await (await w.as("HA")).raw("GET", url);
  assert.match(ok.headers.get("cache-control") || "", /no-store/);
  for (const p of ["SA", "AD", "PT", "PS", "PR", "HB", "LA", "AU", "EMP", "E-B", "M-A", "H-A"]) assert.equal((await raw(p, "GET", url)).status, 404, p);
});

test("communicate: SA / AD / PT 200; PS 404 out_of_scope; PR 403; HRBP / LA 404 (no performance domain); EMP 403", async () => {
  const c = (p, i) => post(p, `/api/admin/review-cycles/${H[i].id}/communicate`);
  const ps = await c("PS", 0);
  st(ps, 404, "PS"); assert.equal(ps.data.code, "out_of_scope");
  st(await c("PR", 0), 403, "PR");
  for (const p of ["HA", "HB", "LA", "AU"]) st(await c(p, 0), 404, p);
  st(await c("EMP", 0), 403, "EMP");
  st(await c("SA", 0), 200, "SA");
  st(await c("AD", 1), 200, "AD");
  st(await c("PT", 2), 200, "PT");
});

test("/api/me.appealDesk: hrbp true for assigned HRBPs, false otherwise; an HRBP with a scoped role still sees the appellant's employee ID on appeal routes only (documented exception)", async () => {
  for (const [p, v] of [["HA", true], ["HB", true], ["HS", true], ["LA", false], ["PR", false], ["E-A", false]]) {
    const me = (await get(p, "/api/me")).data;
    // CX-014（2026-10-10）：另带 eligible（有 HRBP 资格 = 在职、非系统账号、有后台角色），守卫据此放行未分工 HRBP 的页面并显示横幅
    assert.equal(me.appealDesk.hrbp, v, p);
    assert.equal(typeof me.appealDesk.eligible, "boolean", p + " eligible");
    if (["HA", "HB", "HS"].includes(p)) assert.equal(me.appealDesk.eligible, true, p + " is an eligible HRBP");
    if (p === "E-A") assert.equal(me.appealDesk.eligible, false, "a plain employee is not eligible");
    assert.deepEqual(Object.keys(me.appealDesk).sort(), ["eligible", "hrbp"], p);
  }
  // HS：角色范围 A，分工 C → 申诉台看得到 E-C 的工号，其他后台页面看不到
  const row = (await get("HS", "/api/admin/review-appeals")).data.items.find((i) => i.id === apC);
  assert.equal(row && row.view, "full");
  assert.equal(row.employeeId, "E-C");
  assert.equal((await get("HS", `/api/admin/review-appeals/${apC}`)).data.appellant.employeeId, "E-C");
  const roster = await raw("HS", "GET", "/api/admin/roster");
  assert.equal(roster.status, 200);
  assert.ok(!roster.text.includes('"E-C"'), "the roster stays scoped");
  // 给停用账号分工：拒绝
  await w.person("P-HQ", "Quinn Inactive", null, null, { adminRoleId: w.roles.HRBP });
  await w.patch("P-HQ", { active: false });
  const r = await w.admin.put("/api/admin/review-appeals/coverage", { deptId: w.dept["Dept D"], userIds: [w.id("P-HQ")] });
  st(r, 400, "deactivated"); assert.equal(r.data.code, "hrbp_not_eligible");
});

test("an appellant who holds a console role (people manage + audit read) sees neither the internal note nor the pre-adjustment rating in their own profile or the audit log (security #1)", async () => {
  st(await post("HB", `/api/admin/review-appeals/${apX}/start`), 200, "HB starts X");
  const d = await post("HB", `/api/admin/review-appeals/${apX}/decide`, { outcome: "adjust", reply: "经复核你的书面说明与佐证材料，评级调整为 B+，详见说明。", internalNote: NOTE, newRating: "B+", expectRating: "A" });
  st(d, 200, "HB adjusts X");
  const x = await w.as("P-XA");
  const prof = await x.raw("GET", `/api/admin/employees/${w.id("P-XA")}/profile`);
  assert.equal(prof.status, 200);
  const pt = await prof.text();
  assert.ok(!pt.includes("INTERNAL-NOTE-RBAC"), "own profile carries the internal note");
  assert.ok(!pt.includes('"amend"'), "own profile carries the amend marker (pre-adjustment rating)");
  const au = await x.raw("GET", "/api/admin/audit");
  assert.equal(au.status, 200);
  const at = await au.text();
  assert.ok(!at.includes("INTERNAL-NOTE-RBAC"), "audit log carries the internal note");
  assert.ok(!at.includes("review.appeal.adjust") && !at.includes("talent.record.rating-amend"), "own appeal / amend rows are hidden from the appellant");
  assert.ok(!at.includes('"ratingAtSubmit"'));
  // 申诉人看不到自己的申诉台行（即使有后台角色）
  const own = await x.get(`/api/admin/review-appeals/${apX}`);
  assert.equal(own.status, 404);
  // HB 的档案视角能看到调整（但不含内部理由）
  const hbp = await raw("HB", "GET", `/api/admin/employees/${w.id("P-XA")}/profile`);
  assert.ok(!hbp.text.includes("INTERNAL-NOTE-RBAC"), "the internal note never leaves the appeal");
});

test("module off: every appeal route and the attachment return 404; /api/me omits appealDesk", async () => {
  w.writeConfig({ modules: { performance: false } });
  try {
    const paths = [
      ["GET", "/api/admin/review-appeals"], ["GET", "/api/admin/review-appeals/summary"], ["GET", "/api/admin/review-appeals/stats"],
      ["GET", "/api/admin/review-appeals/coverage"], ["PUT", "/api/admin/review-appeals/coverage"], ["GET", `/api/admin/review-appeals/${apA}`],
      ["POST", `/api/admin/review-appeals/${apA}/start`], ["POST", `/api/admin/review-appeals/${apA}/decide`], ["POST", `/api/admin/review-appeals/${apA}/reassign`],
      ["POST", `/api/admin/review-appeals/${apA}/consult`], ["POST", `/api/admin/review-cycles/${H[0].id}/communicate`],
    ];
    for (const [m, p] of paths) {
      const r = await (await w.as("SA")).raw(m, p, m === "GET" ? undefined : {});
      assert.equal(r.status, 404, `SA ${m} ${p}`);
    }
    assert.equal((await raw("HA", "GET", "/api/admin/review-appeals")).status, 404);
    assert.equal((await raw("HA", "GET", "/api/attachments/" + attA)).status, 404, "handler");
    assert.equal((await raw("E-A", "GET", "/api/attachments/" + attA)).status, 404, "appellant");
    for (const p of [`/api/me/reviews/${Q.items["E-A"]}/appeal`, "/api/me/reviews/appeal-consults", "/api/me/reviews/history"])
      assert.equal((await raw("E-A", "GET", p)).status, 404, p);
    assert.equal((await raw("E-B", "POST", `/api/me/reviews/${Q.items["E-B"]}/appeal`, { reason: W.text(80) })).status, 404);
    const up = await (await w.as("E-B")).raw("POST", `/api/me/reviews/appeal-files?item=${Q.items["E-B"]}&name=x.png`);
    assert.equal(up.status, 404, "upload");
    const me = (await get("HA", "/api/me")).data;
    assert.ok(!("appealDesk" in me), "appealDesk omitted");
  } finally { w.writeConfig(null); }
  assert.equal((await raw("HA", "GET", "/api/admin/review-appeals")).status, 200, "back on");
});
