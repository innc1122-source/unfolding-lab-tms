// 第二批 2.6（负责人 10/7 定，2026-10-08 波次 2 W2-A）：周期关闭后修改档案里的绩效评级。
//   · 改评级须写理由（1–1000 字，rating_reason_required）；带理由的审计 talent.record.rating-amend（原评级、新评级、理由、操作人）
//     与改记录在同一笔事务里写入（审查 P1-13）；所有绩效记录都要理由（G6），「已改动」标记只用于周期归档的记录。
//   · 周期归档的记录不能改类型（record_type_locked）、不能删除（record_from_review_cycle，G7）；改回原评级不再显示标记（G9）。
//   · 「已改动（原评级 X）」与理由只出现在后台（档案要 people 读，周期详情要 performance 读）。
//   · 员工端（本人、上级、HoD）的每个接口只给最终评级：逐个接口扫一遍 JSON，原评级、标记字段与理由一样都不能出现；
//     「我的绩效」与成长档案显示的是同一个（改后的）评级与评语。
//   · 下属档案里进行中的 v2 周期只给状态，不给评级（默认 D8）。
"use strict";
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { DatabaseSync } = require("node:sqlite");
const { ADMIN, startServer, loginAs, makeClient } = require("./helpers.js");

const DAY = 24 * 60 * 60 * 1000;
const ymd = (ms) => { const d = new Date(ms); const p = (x) => String(x).padStart(2, "0"); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; };
const NOW = Date.now();
const ORIGINAL = "B+";          // E1 归档时的评级
const AMENDED = "B";            // HR 关闭后改成的评级
const REASON = "AMEND-REASON-7f3c 申诉复核后下调";   // 哨兵：员工端任何响应里都不能出现
const MGR_COMMENT = "MGR-COMMENT-E1 稳定完成目标";
const selfBody = { outcomes: ["完成季度目标"], challenges: "", feedback: "多一些跨部门同步", goalsNext: ["下季度目标"] };

let srv, admin;
const people = {};
let C1, C2, unit, recId, items1 = {}, items2 = {};

function dbRead(fn) { const d = new DatabaseSync(srv.dbPath, { readOnly: true }); try { return fn(d); } finally { d.close(); } }
async function newPerson(employeeId, name, department, managerEid, extra) {
  const r = await admin.post("/api/admin/employees", { name, employeeId, ...(department ? { department } : {}), jobLevel: "PB2", programIds: [] });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const id = dbRead((d) => d.prepare("SELECT id FROM users WHERE employeeId = ?").get(employeeId)).id;
  if (managerEid) assert.equal((await admin.put(`/api/admin/employees/${id}`, { managerId: people[managerEid].id })).status, 200);
  if (extra) assert.equal((await admin.put(`/api/admin/employees/${id}`, extra)).status, 200);
  const c = makeClient(srv.base);
  await c.login({ employeeId, password: r.data.password });
  assert.equal((await c.post("/api/auth/change-password", { currentPassword: r.data.password, newPassword: employeeId + "-pw-2026" })).status, 200);
  people[employeeId] = { id, client: c };
  return people[employeeId];
}
async function roleUser(employeeId, grants) {
  const role = await admin.post("/api/admin/roles", { name: "Role " + employeeId, name_zh: "角色 " + employeeId, grants });
  assert.equal(role.status, 200, JSON.stringify(role.data));
  return newPerson(employeeId, "Admin " + employeeId, null, null, { adminRoleId: role.data.role.id });
}
const perfEvent = async (client, eid, title) => {
  const r = await client.get(`/api/admin/employees/${people[eid].id}/profile`);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return r.data.events.find((e) => e.source === "record" && e.type === "performance" && (!title || e.title === title));
};
const putRecord = (client, id, fields, extra) => client.put(`/api/admin/records/${id}`, { type: "performance", date: ymd(NOW), title: "2026Q2 Amend", fields, ...(extra || {}) });

before(async () => {
  srv = await startServer();
  admin = await loginAs(srv.base, ADMIN);
  await newPerson("AM-HOD", "Ada Hod", "Amend Dept");
  unit = (await admin.get("/api/admin/departments")).data.find((x) => x.name === "Amend Dept").id;
  assert.equal((await admin.put(`/api/admin/departments/${unit}`, { ownerId: people["AM-HOD"].id })).status, 200);
  await newPerson("AM-MGR", "Max Mgr", "Amend Dept", "AM-HOD");
  await newPerson("AM-E1", "Eli One", "Amend Dept", "AM-MGR");
  await newPerson("AM-E2", "Eva Two", "Amend Dept", "AM-MGR");
  // 周期 1：评级 → HoD 提交 → HR 确认 → 关闭归档
  const c1 = await admin.post("/api/admin/review-cycles", {
    name: "2026Q2 Amend", flow: "v2", kind: "quarter", dueAt: ymd(NOW + 5 * DAY), dueRateAt: ymd(NOW + 7 * DAY), dueCalibAt: ymd(NOW + 9 * DAY),
    userIds: [people["AM-E1"].id, people["AM-E2"].id],
  });
  assert.equal(c1.status, 200, JSON.stringify(c1.data));
  C1 = c1.data.cycle.id;
  for (const i of (await admin.get(`/api/admin/review-cycles/${C1}`)).data.items) items1[i.employeeId] = i.id;
  const m = people["AM-MGR"].client;
  for (const e of ["AM-E1", "AM-E2"]) assert.equal((await people[e].client.post(`/api/me/reviews/${items1[e]}/self`, selfBody)).status, 200);
  assert.equal((await m.post(`/api/me/reviews/${items1["AM-E1"]}/manager`, { rating: ORIGINAL, text: MGR_COMMENT })).status, 200);
  assert.equal((await m.post(`/api/me/reviews/${items1["AM-E2"]}/manager`, { rating: "B", text: "E2 ok" })).status, 200);
  const sub = await people["AM-HOD"].client.post("/api/me/reviews/hod/submit", { cycleId: C1, dept1Id: unit });
  assert.equal(sub.status, 200, JSON.stringify(sub.data));
  assert.equal((await admin.post(`/api/admin/review-cycles/${C1}/depts/${unit}/confirm`, {})).status, 200);
  const closed = await admin.post(`/api/admin/review-cycles/${C1}/close`, {});
  assert.equal(closed.status, 200, JSON.stringify(closed.data));
  assert.equal(closed.data.written, 2);
  recId = (await perfEvent(admin, "AM-E1", "2026Q2 Amend")).id;
  assert.ok(recId, "E1 has an archived record");
});
after(async () => { if (srv) await srv.stopAsync(); });

test("2.6: changing the rating needs a reason; the reason-carrying audit is written in the same transaction as the record", async () => {
  const base = { period: "2026Q2 Amend", summary: MGR_COMMENT };
  const noReason = await putRecord(admin, recId, { ...base, rating: AMENDED });
  assert.equal(noReason.status, 400, JSON.stringify(noReason.data));
  assert.equal(noReason.data.code, "rating_reason_required");
  assert.match(noReason.data.error, /Give a reason.*修改评级须填写理由/);
  assert.equal((await putRecord(admin, recId, { ...base, rating: AMENDED }, { ratingReason: "   " })).data.code, "rating_reason_required", "blank after trim");
  assert.equal((await putRecord(admin, recId, { ...base, rating: AMENDED }, { ratingReason: "x".repeat(1001) })).data.code, "rating_reason_required", "over 1000 characters");
  // 只改评语不改评级：不要理由
  assert.equal((await putRecord(admin, recId, { ...base, rating: ORIGINAL })).status, 200);
  assert.equal(dbRead((d) => d.prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'talent.record.rating-amend'").get()).n, 0);
  const ok = await putRecord(admin, recId, { ...base, rating: AMENDED }, { ratingReason: "  " + REASON + "  " });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.equal(ok.data.record.detail.rating, AMENDED);
  assert.equal(ok.data.record.detail.summaryAuthor, "manager", "an unchanged comment keeps its author marker");
  const rows = dbRead((d) => d.prepare("SELECT id, action, target, actorId, requestId, beforeJson, afterJson FROM audit_logs WHERE action IN ('talent.record.rating-amend', 'talent.record.update') ORDER BY id DESC LIMIT 2").all()).reverse();
  assert.deepEqual(rows.map((r) => r.action), ["talent.record.rating-amend", "talent.record.update"], "the amend row is written inside the transaction, before the after-commit update row");
  assert.equal(rows[0].requestId, rows[1].requestId);
  assert.equal(rows[0].target, recId);
  assert.deepEqual(JSON.parse(rows[0].beforeJson), { rating: ORIGINAL });
  const after = JSON.parse(rows[0].afterJson);
  assert.deepEqual(after, { rating: AMENDED, reason: REASON, userId: people["AM-E1"].id, employeeId: "AM-E1", period: "2026Q2 Amend", reviewItemId: items1["AM-E1"], cycleId: C1 });
  // 审计页能按动作筛出来
  const au = await admin.get("/api/admin/audit?action=talent.record.rating-amend");
  assert.equal(au.status, 200);
  assert.equal(au.data.rows.length, 1);
  assert.equal(au.data.rows[0].after.reason, REASON);
});

test("2.6: an archived record can't change type or be deleted; a hand-made performance record still needs a reason but carries no marker", async () => {
  const typeChange = await admin.put(`/api/admin/records/${recId}`, { type: "award", date: ymd(NOW), title: "x", fields: { awardName: "x" } });
  assert.equal(typeChange.status, 409, JSON.stringify(typeChange.data));
  assert.equal(typeChange.data.code, "record_type_locked");
  const del = await admin.del(`/api/admin/records/${recId}`);
  assert.equal(del.status, 409);
  assert.equal(del.data.code, "record_from_review_cycle");
  assert.match(del.data.error, /can't be deleted.*不能删除/);
  // 手工新建的绩效记录（另一期）：改评级同样要理由（G6），但不是周期归档的 → 没有 reviewLinked / amend，可以删除
  const made = await admin.post(`/api/admin/employees/${people["AM-E2"].id}/records`, { type: "performance", date: "2025-12-31", title: "2025 H2 manual", fields: { period: "2025 H2 manual", rating: "A", summary: "manual" } });
  assert.equal(made.status, 200, JSON.stringify(made.data));
  const mid = made.data.record.id;
  const put = (extra) => admin.put(`/api/admin/records/${mid}`, { type: "performance", date: "2025-12-31", title: "2025 H2 manual", fields: { period: "2025 H2 manual", rating: "C", summary: "manual" }, ...(extra || {}) });
  assert.equal((await put()).data.code, "rating_reason_required");
  assert.equal((await put({ ratingReason: "typo in the import" })).status, 200);
  const ev = await perfEvent(admin, "AM-E2", "2025 H2 manual");
  assert.ok(!("reviewLinked" in ev) && !("amend" in ev), JSON.stringify(ev));
  const ev2 = await perfEvent(admin, "AM-E2", "2026Q2 Amend");
  assert.equal(ev2.reviewLinked, true, "E2's archived record is linked");
  assert.ok(!("amend" in ev2), "E2's rating was never changed");
  assert.equal((await admin.del(`/api/admin/records/${mid}`)).status, 200, "a hand-made record can still be deleted");
});

test("2.6 console: the profile shows 'changed (was X)' with reason and operator; the cycle detail shows recordRating / amendedFrom; the 9-box reads the amended rating", async () => {
  const ev = await perfEvent(admin, "AM-E1", "2026Q2 Amend");
  assert.equal(ev.reviewLinked, true);
  assert.equal(ev.detail.rating, AMENDED);
  assert.equal(ev.amend.from, ORIGINAL);
  assert.equal(ev.amend.reason, REASON);
  assert.equal(ev.amend.count, 1);
  assert.equal(ev.amend.by.employeeId, "ADMIN");
  assert.ok(ev.amend.by.name);
  assert.match(ev.amend.at, /^\d{4}-\d{2}-\d{2}T/);
  const d = (await admin.get(`/api/admin/review-cycles/${C1}`)).data;
  const e1 = d.items.find((i) => i.employeeId === "AM-E1"), e2 = d.items.find((i) => i.employeeId === "AM-E2");
  assert.deepEqual([e1.finalRating || e1.managerRating, e1.recordRating, e1.amendedFrom], [ORIGINAL, AMENDED, ORIGINAL]);
  assert.deepEqual([e2.recordRating, e2.amendedFrom], ["B", null]);
  // 部门明细（hr 模式，DeptCalibration 与「导出本部门」用它）同一口径（波次 2 复核修正）
  const dd = await admin.get(`/api/admin/review-cycles/${C1}/depts/${unit}`);
  assert.equal(dd.status, 200, JSON.stringify(dd.data));
  const d1 = dd.data.view.rows.find((r) => r.employeeId === "AM-E1"), d2 = dd.data.view.rows.find((r) => r.employeeId === "AM-E2");
  assert.deepEqual([d1.recordRating, d1.amendedFrom], [AMENDED, ORIGINAL]);
  assert.deepEqual([d2.recordRating, d2.amendedFrom], ["B", null]);
  // 波次 3（W3-S）：已关闭周期的各档人数一律按档案评级 —— 部门行、部门明细、周期详情的分布、列表的已归档人数
  assert.deepEqual(d.depts.find((x) => x.dept1Id === unit).counts, { B: 2 }, "department row: E1 now counts as B, not the B+ at close");
  assert.deepEqual(dd.data.view.dept.counts, { B: 2 });
  assert.deepEqual(dd.data.row.counts, { B: 2 });
  assert.deepEqual(d.distribution, { B: 2 }, "cycle distribution: rating on file");
  assert.equal((await admin.get("/api/admin/review-cycles")).data.find((c) => c.id === C1).finalDone, 2);
  // O1：部门确认列表的已确认行带确认人（「已确认 · 时间 · 确认人」）
  const me = (await admin.get("/api/me")).data;
  const dep = d.depts.find((x) => x.dept1Id === unit);
  assert.ok(dep.status.hrConfirmedAt);
  assert.deepEqual([dep.status.hrId, dep.status.hrName], [me.id, me.name]);
  // 部门明细（hr 视图）头部同样带确认人（波次 3 W3-S，供 DeptCalibration 显示「已确认 · 时间 · 确认人」）
  assert.deepEqual([dd.data.view.dept.status.hrId, dd.data.view.dept.status.hrName], [me.id, me.name]);
  // 九宫格按周期取评级读档案记录（不读 finalRating）
  const tr = (await admin.get(`/api/admin/talent-review?cycle=${C1}`)).data;
  assert.equal(tr.source, C1);
  assert.equal(tr.rows.find((r) => r.employeeId === "AM-E1").rating, AMENDED);
  // 绩效与人才管理员（内置角色，迁移 68 起 people 只读）：看得到标记，不能改记录，可以导出人才记录 CSV（M1 方案 A）
  const roles = (await admin.get("/api/admin/roles")).data.roles;
  const pt = await newPerson("AM-PT", "Pat PerfTalent", null, null, { adminRoleId: roles.find((r) => r.key === "performance-talent-admin").id });
  const ptEv = await perfEvent(pt.client, "AM-E1", "2026Q2 Amend");
  assert.equal(ptEv.amend.from, ORIGINAL);
  assert.equal((await putRecord(pt.client, recId, { period: "2026Q2 Amend", rating: "C", summary: MGR_COMMENT }, { ratingReason: "nope" })).status, 403);
  assert.equal((await pt.client.raw("GET", "/api/admin/export/records.csv")).status, 200);
  assert.equal((await pt.client.get(`/api/admin/review-cycles/${C1}`)).data.items.find((i) => i.employeeId === "AM-E1").amendedFrom, ORIGINAL);
  // 只有绩效读、没有 people 的角色：档案 404（标记与理由只在有 people 读的档案里）
  const pr = await roleUser("AM-PR", { performance: "read" });
  assert.equal((await pr.client.get(`/api/admin/employees/${people["AM-E1"].id}/profile`)).status, 404);
  assert.equal((await pr.client.raw("GET", "/api/admin/export/records.csv")).status, 404);
});

// 员工端泄露检查：把 JSON 整个走一遍。评级选项目录（ratingOptions*、highlightRatings、tiers、bucketOf）本来就列出所有档位，跳过；
// 其余任何字符串值都不能等于原评级，任何位置都不能出现理由文字，也不能出现后台才有的标记字段。
const CATALOG_KEYS = /^(ratingOptions.*|highlightRatings|tiers|bucketOf)$/;
const FORBIDDEN_KEYS = new Set(["amend", "amendedFrom", "recordRating", "ratingReason", "reviewLinked"]);
function leaksIn(json) {
  const out = [];
  const walk = (v, path, key) => {
    if (key && CATALOG_KEYS.test(key)) return;
    if (Array.isArray(v)) { v.forEach((x, i) => walk(x, `${path}[${i}]`, null)); return; }
    if (v && typeof v === "object") {
      for (const [k, x] of Object.entries(v)) {
        if (FORBIDDEN_KEYS.has(k)) out.push(`${path}.${k} (console-only field)`);
        walk(x, `${path}.${k}`, k);
      }
      return;
    }
    if (typeof v === "string") {
      if (v === ORIGINAL) out.push(`${path} = "${v}" (the original rating)`);
      if (v.includes("AMEND-REASON-7f3c")) out.push(`${path} carries the amend reason`);
    }
  };
  walk(json, "$", null);
  return out;
}

test("2.6 + L1: after an amend, every employee-side endpoint (self, manager, HoD) returns only the final rating — never the original, the marker or the reason", async () => {
  // 检查器自检：评级字段等于原评级、后台标记字段、理由文字都会被抓到；评级选项目录不算
  assert.equal(leaksIn({ items: [{ rating: ORIGINAL, note: "x AMEND-REASON-7f3c" }], ev: { amend: null }, ratingOptions: [ORIGINAL], tiers: [ORIGINAL] }).length, 3);
  // 周期 2 进行中（E1 参与，上级已评 A）：HoD 视图非空，下属档案多一条进行中的条目
  const c2 = await admin.post("/api/admin/review-cycles", {
    name: "2026Q3 Amend", flow: "v2", kind: "quarter", dueAt: ymd(NOW + 5 * DAY), dueRateAt: ymd(NOW + 7 * DAY), dueCalibAt: ymd(NOW + 9 * DAY),
    userIds: [people["AM-E1"].id],
  });
  assert.equal(c2.status, 200, JSON.stringify(c2.data));
  C2 = c2.data.cycle.id;
  for (const i of (await admin.get(`/api/admin/review-cycles/${C2}`)).data.items) items2[i.employeeId] = i.id;
  assert.equal((await people["AM-MGR"].client.post(`/api/me/reviews/${items2["AM-E1"]}/manager`, { rating: "A", highlights: "HL-OPEN-CYCLE", text: "open comment" })).status, 200);

  const e1 = people["AM-E1"].id, mgr = people["AM-MGR"].id;
  const walks = {
    "AM-E1": ["/api/me", "/api/me/reviews", "/api/me/reviews/history", "/api/me/growth", "/api/me/notifications", "/api/me/team", "/api/me/roles", "/api/me/reviews/hod", "/api/me/reviews/hod?v=2"],
    "AM-MGR": ["/api/me", "/api/me/reviews", "/api/me/reviews/history", "/api/me/growth", "/api/me/notifications", "/api/me/team", `/api/me/reports/${e1}`, "/api/me/reviews/hod", "/api/me/reviews/hod?v=2"],
    "AM-HOD": ["/api/me", "/api/me/reviews", "/api/me/reviews/hod", "/api/me/reviews/hod?v=2", "/api/me/notifications", "/api/me/team", `/api/me/reports/${e1}`, `/api/me/reports/${mgr}`],
  };
  const seen = [];
  for (const [eid, paths] of Object.entries(walks)) {
    for (const p of paths) {
      const r = await people[eid].client.get(p);
      assert.ok(r.status === 200, `${eid} GET ${p} → ${r.status} ${JSON.stringify(r.data).slice(0, 200)}`);
      assert.deepEqual(leaksIn(r.data), [], `${eid} GET ${p}`);
      seen.push(`${eid} ${p}`);
    }
  }
  assert.equal(seen.length, 26);
  // 已关闭周期的单人评估页一律 404（不会把归档时的评级再给出来）
  assert.equal((await people["AM-MGR"].client.get(`/api/me/reviews/team/${items1["AM-E1"]}`)).status, 404);

  // 正面：员工本人「我的绩效」与成长档案是同一个（改后的）评级与评语；上级、HoD 看到的也是改后的
  const hist = (await people["AM-E1"].client.get("/api/me/reviews/history")).data;
  const row = hist.items.find((i) => i.cycleId === C1);
  assert.equal(row.rating, AMENDED);
  assert.equal(row.managerText, MGR_COMMENT, "L2 default: the employee still sees the manager's comment");
  const growth = (await people["AM-E1"].client.get("/api/me/growth")).data;
  const gEv = growth.events.find((e) => e.kind === "record" && e.title === "2026Q2 Amend");
  const line = (re) => (gEv.lines.find((l) => re.test(l.label)) || {}).value;   // 字段名称可在设置里改（迁移 57 起为 Performance Rating / Comments）
  assert.equal(line(/rating/i), AMENDED, "growth timeline agrees with My performance: " + JSON.stringify(gEv.lines));
  assert.equal(line(/comment|summary/i), row.managerText, "the comment matches too");
  for (const eid of ["AM-MGR", "AM-HOD"]) {
    const rep = (await people[eid].client.get(`/api/me/reports/${e1}`)).data;
    const arch = rep.performance.find((p) => p.source === "archived" && p.cycle === "2026Q2 Amend");
    assert.equal(arch.rating, AMENDED, eid + " sees the amended rating");
  }
});

test("D8: on a report's profile an open v2 cycle shows only its status, never the rating or the comment", async () => {
  for (const eid of ["AM-MGR", "AM-HOD"]) {
    const rep = (await people[eid].client.get(`/api/me/reports/${people["AM-E1"].id}`)).data;
    const open = rep.performance.find((p) => p.source === "open" && p.cycle === "2026Q3 Amend");
    assert.ok(open, eid + ": " + JSON.stringify(rep.performance));
    assert.deepEqual(
      { flow: open.flow, rating: open.rating, rating_zh: open.rating_zh, summary: open.summary, pending: open.pending, status: open.status },
      { flow: "v2", rating: null, rating_zh: null, summary: "", pending: false, status: { self: false, one: "none", rated: true } },
    );
    assert.ok(!JSON.stringify(rep).includes("open comment") && !JSON.stringify(rep).includes("HL-OPEN-CYCLE"));
  }
});

// 第二批 2.8（2026-10-08）绩效申诉：员工端（申诉人、上级、HoD）与征询人的每个 GET 再扫一遍 —— 申诉提交时的评级（ratingAtSubmit）、
// 结论前评级（ratingBefore）、内部说明、别人的征询意见一样都不能出现；征询人只能看到自己那条征询（可行性审查 #7：征询详情里的
// record.managerRating 是给上级 / HoD 征询人的评估原文，不算泄露，单独放行）。2.6 守卫（安全审查 #2）：申诉处理中谁都不能用 2.6 改评级；
// 有结论之后只有超级管理员能改；任何非超管都不能改自己的评级。
// （growth 的 events 是既有字段，不在此列）
const APPEAL_FORBIDDEN = new Set(["ratingAtSubmit", "ratingBefore", "internalNote", "newRating", "consults", "slaDueOn", "handlerId"]);
function appealLeaksIn(json, opts) {
  const o = opts || {};
  const out = leaksIn(json).filter((l) => !(o.allowManagerRating && /\.record\.managerRating = /.test(l)));
  const walk = (v, path) => {
    if (Array.isArray(v)) return v.forEach((x, i) => walk(x, `${path}[${i}]`));
    if (v && typeof v === "object") { for (const [k, x] of Object.entries(v)) { if (APPEAL_FORBIDDEN.has(k)) out.push(`${path}.${k} (appeal handling field)`); walk(x, `${path}.${k}`); } return; }
    if (typeof v === "string") {
      if (v.includes("APPEAL-NOTE-SECRET")) out.push(`${path} carries the internal note`);
      if (!o.ownOpinion && v.includes("OPINION-SECRET-MGR")) out.push(`${path} carries the manager's opinion`);
      if (v.includes("OPINION-SECRET-HOD")) out.push(`${path} carries the HoD's opinion`);
    }
  };
  walk(json, "$");
  return out;
}
test("2.8 appeal: employee-side and consultee walks never carry the appeal's handling data; 2.6 can't bypass an appeal", async () => {
  const it = items1["AM-E1"];
  const e1 = people["AM-E1"].client, mgrC = people["AM-MGR"].client, hodC = people["AM-HOD"].client;
  const sub = await e1.post(`/api/me/reviews/${it}/appeal`, { reason: "我对本期评级有异议：季度目标全部完成，并承担了额外的跨部门项目，请复核。".repeat(2) });
  assert.equal(sub.status, 201, JSON.stringify(sub.data));
  const apId = sub.data.appeal.id;
  // 处理中：2.6 不能改（超管也不行），审查 #2 (b)
  const under = await putRecord(admin, recId, { period: "2026Q2 Amend", rating: "C", summary: MGR_COMMENT }, { ratingReason: "while under appeal" });
  assert.equal(under.status, 409, JSON.stringify(under.data));
  assert.ok(["rating_under_appeal", "appeal_open"].includes(under.data.code), under.data.code);
  // 无人负责 → 兜底（范围内的绩效管理员）。超管在第一个用例里用 2.6 改过 E1 的评级 → 利益回避（制度审查 #6），看到的是 404；
  // 由绩效与人才管理员 AM-PT 处理：开始、征询上级与 HoD
  assert.equal((await admin.get(`/api/admin/review-appeals/${apId}`)).status, 404, "the earlier 2.6 amender is conflicted");
  const ptC = people["AM-PT"].client;
  assert.equal((await ptC.post(`/api/admin/review-appeals/${apId}/start`, {})).status, 200);
  assert.equal((await ptC.post(`/api/admin/review-appeals/${apId}/consult`, { consulteeId: people["AM-MGR"].id })).status, 200);
  assert.equal((await ptC.post(`/api/admin/review-appeals/${apId}/consult`, { consulteeId: people["AM-HOD"].id })).status, 200);
  const cM = (await mgrC.get("/api/me/reviews/appeal-consults")).data.items[0].id;
  const cH = (await hodC.get("/api/me/reviews/appeal-consults")).data.items[0].id;
  assert.equal((await mgrC.post(`/api/me/reviews/appeal-consults/${cM}/opinion`, { opinion: "OPINION-SECRET-MGR 评级符合实际表现。" })).status, 200);
  assert.equal((await hodC.post(`/api/me/reviews/appeal-consults/${cH}/opinion`, { opinion: "OPINION-SECRET-HOD 校准时已比较同级。" })).status, 200);
  const walk = async (label) => {
    const seen2 = [];
    const plan = [
      ["AM-E1", e1, ["/api/me", "/api/me/reviews", "/api/me/reviews/history", `/api/me/reviews/${it}/appeal`, "/api/me/growth", "/api/me/notifications", "/api/me/reviews/appeal-consults"], {}],
      ["AM-MGR", mgrC, ["/api/me/reviews", "/api/me/notifications", `/api/me/reports/${people["AM-E1"].id}`, "/api/me/reviews/appeal-consults", `/api/me/reviews/appeal-consults/${cM}`], { allowManagerRating: true, ownOpinion: true }],
      ["AM-HOD", hodC, ["/api/me/reviews", "/api/me/notifications", `/api/me/reports/${people["AM-E1"].id}`, "/api/me/reviews/appeal-consults", `/api/me/reviews/appeal-consults/${cH}`], { allowManagerRating: true }],
    ];
    for (const [eid, c, paths, opts] of plan) {
      for (const p of paths) {
        const r = await c.get(p);
        assert.equal(r.status, 200, `${label} ${eid} GET ${p} → ${r.status}`);
        // HoD 读自己的征询时可以看到自己的意见（OPINION-SECRET-HOD）；其他接口都不行
        const leaks = appealLeaksIn(r.data, opts).filter((l) => !(eid === "AM-HOD" && p.endsWith(cH) && /HoD's opinion/.test(l)));
        assert.deepEqual(leaks, [], `${label} ${eid} GET ${p}`);
        seen2.push(`${eid} ${p}`);
      }
    }
    assert.equal(seen2.length, 17);
  };
  await walk("in review");
  // 申诉人的「我的绩效」带申诉块
  const h = (await e1.get("/api/me/reviews/history")).data.items.find((i) => i.cycleId === C1);
  assert.equal(h.appeal.state, "in_review");
  // 别人的征询 / 别人的申诉：404
  assert.equal((await hodC.get(`/api/me/reviews/appeal-consults/${cM}`)).status, 404);
  assert.equal((await mgrC.get(`/api/me/reviews/${it}/appeal`)).status, 404);
  // 结论：维持（带内部说明）
  const dec = await ptC.post(`/api/admin/review-appeals/${apId}/decide`, { outcome: "maintain", reply: "经复核维持评级，详细理由已与你当面沟通。", internalNote: "APPEAL-NOTE-SECRET 仅内部", expectRating: AMENDED });
  assert.equal(dec.status, 200, JSON.stringify(dec.data));
  await walk("decided");
  const cd = (await mgrC.get(`/api/me/reviews/appeal-consults/${cM}`)).data;
  assert.equal(cd.consult.state, "closed");
  assert.ok(!("record" in cd) && !("appeal" in cd), "a closed consult shows only the consult itself");
  // 有结论之后：非超管不能再用 2.6 改（审查 #2 (c)）；任何非超管不能改自己的评级（审查 #2 (a)）
  const pm = await admin.post("/api/admin/roles", { name: "People mgr AM", name_zh: "人员管理 AM", grants: { people: "manage" } });
  assert.equal(pm.status, 200);
  const hr = await newPerson("AM-HR", "Hana Hr", null, null, { adminRoleId: pm.data.role.id });
  const closed = await putRecord(hr.client, recId, { period: "2026Q2 Amend", rating: "C", summary: MGR_COMMENT }, { ratingReason: "override the appeal" });
  assert.equal(closed.status, 409, JSON.stringify(closed.data));
  assert.equal(closed.data.code, "rating_appeal_closed");
  const own = await admin.post(`/api/admin/employees/${hr.id}/records`, { type: "performance", date: "2026-06-30", title: "2026 H1 self", fields: { period: "2026 H1 self", rating: "B", summary: "" } });
  assert.equal(own.status, 200, JSON.stringify(own.data));
  const self = await hr.client.put(`/api/admin/records/${own.data.record.id}`, { type: "performance", date: "2026-06-30", title: "2026 H1 self", fields: { period: "2026 H1 self", rating: "A", summary: "" }, ratingReason: "I deserve more" });
  assert.equal(self.status, 403, JSON.stringify(self.data));
  assert.equal(self.data.code, "rating_self_amend");
  assert.equal((await admin.del(`/api/admin/records/${own.data.record.id}`)).status, 200, "clean up the hand-made record (G9 counts amend rows)");
});

test("G9: changing the rating back to the archived value removes the marker everywhere", async () => {
  const back = await putRecord(admin, recId, { period: "2026Q2 Amend", rating: ORIGINAL, summary: MGR_COMMENT }, { ratingReason: "reverted after review" });
  assert.equal(back.status, 200, JSON.stringify(back.data));
  const ev = await perfEvent(admin, "AM-E1", "2026Q2 Amend");
  assert.equal(ev.reviewLinked, true);
  assert.ok(!("amend" in ev), JSON.stringify(ev));
  const det = (await admin.get(`/api/admin/review-cycles/${C1}`)).data;
  const e1 = det.items.find((i) => i.employeeId === "AM-E1");
  assert.deepEqual([e1.recordRating, e1.amendedFrom], [ORIGINAL, null]);
  // 改回原值后，按档案评级的各档人数也回到关闭时的分布（W3-S）
  assert.deepEqual(det.depts.find((x) => x.dept1Id === unit).counts, { [ORIGINAL]: 1, B: 1 });
  assert.deepEqual(det.distribution, { [ORIGINAL]: 1, B: 1 });
  assert.equal((await people["AM-E1"].client.get("/api/me/reviews/history")).data.items.find((i) => i.cycleId === C1).rating, ORIGINAL);
  assert.equal(dbRead((d) => d.prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'talent.record.rating-amend'").get()).n, 3, "every change is audited (E1 twice + the manual record)");
});

// 波次 3 复核：已关闭周期按档案评级计数后，超额名单与阻断项要跟同一口径；已关闭的周期不能再确认 / 提交，不出阻断项。
// 复现：10 人年度周期全评 B → 提交、确认、关闭 → 档案里把一人改成 A。原来部门行与部门明细都给出 over_quota 阻断项（ids 为空），
// DeptCalibration 的 HR 模式据此在已确认、已关闭的部门上摆出灰掉的「超额」阻断提示。
test("closed cycle after a 2.6 amend: counts / over follow the rating on file, but no confirm or submit blockers are listed", async () => {
  await newPerson("CQ-HOD", "Quinn Hod", "Closed Quota Dept");
  const cq = (await admin.get("/api/admin/departments")).data.find((x) => x.name === "Closed Quota Dept").id;
  assert.equal((await admin.put(`/api/admin/departments/${cq}`, { ownerId: people["CQ-HOD"].id })).status, 200);
  const rows = Array.from({ length: 10 }, (_, i) => ({ employeeId: `CQ-E${i}`, name: `Quota ${i}`, department: "Closed Quota Dept", jobLevel: "PB2", managerEmployeeId: "CQ-HOD" }));
  assert.equal((await admin.post("/api/admin/employees/bulk", { rows, programIds: [] })).status, 200);
  const roster = (await admin.get("/api/admin/employees")).data;
  const ids = rows.map((r) => roster.find((x) => x.employeeId === r.employeeId).id);
  const c = await admin.post("/api/admin/review-cycles", { name: "2026 Closed Quota Annual", kind: "annual", userIds: ids });
  assert.equal(c.status, 200, JSON.stringify(c.data));
  const cid = c.data.cycle.id;
  const hod = people["CQ-HOD"].client;
  const hg = (await hod.get("/api/me/reviews/hod")).data.groups.find((x) => x.cycle.id === cid);
  for (const r of hg.view.rows.filter((x) => !x.notCounted)) assert.equal((await hod.put(`/api/me/reviews/hod/items/${r.id}`, { rating: "B" })).status, 200);
  assert.equal((await hod.post("/api/me/reviews/hod/submit", { cycleId: cid, dept1Id: cq })).status, 200);
  assert.equal((await admin.post(`/api/admin/review-cycles/${cid}/depts/${cq}/confirm`, {})).status, 200);
  assert.equal((await admin.post(`/api/admin/review-cycles/${cid}/close`, {})).data.written, 10);
  const e0 = roster.find((x) => x.employeeId === "CQ-E0").id;
  const ev = (await admin.get(`/api/admin/employees/${e0}/profile`)).data.events.find((e) => e.source === "record" && e.type === "performance");
  const put = await admin.put(`/api/admin/records/${ev.id}`, { type: "performance", date: ev.date, title: ev.title, fields: { period: "2026 Closed Quota Annual", rating: "A", summary: "" }, ratingReason: "appeal upheld" });
  assert.equal(put.status, 200, JSON.stringify(put.data));
  const row = (await admin.get(`/api/admin/review-cycles/${cid}`)).data.depts.find((x) => x.dept1Id === cq);
  assert.deepEqual(row.counts, { A: 1, B: 9 }, "rating on file");
  assert.deepEqual(row.over.map((o) => o.tier), ["A"], "the over-quota information itself stays (same rule as the counts)");
  assert.deepEqual(row.confirmIssues, [], "a closed cycle can't be confirmed, so no blockers");
  const v = (await admin.get(`/api/admin/review-cycles/${cid}/depts/${cq}`)).data.view;
  assert.deepEqual(v.dept.confirmIssues, []);
  assert.deepEqual(v.dept.issues, []);
  const r0 = v.rows.find((r) => r.employeeId === "CQ-E0");
  assert.equal(r0.recordRating, "A");
  assert.equal(r0.overQuota, true, "the row marker follows the rating on file, like the counts");
});
