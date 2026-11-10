// 8.3（第二批补充，2026-10-08，F25）记录类型「经理可见 / Visible to managers」开关（迁移 71，字段 managerVisible）。
//   · 迁移后的缺省：备注（note）关闭（与原来「经理侧不给备注」的行为一致），其余内置类型打开；
//   · 关闭后该类型的记录不出现在汇报线上级（直属上级、隔级上级）的下属档案 GET /api/me/reports/:id 里，后台档案照常；
//   · 新建类型「测评结果」只给 HR 看（场景）；改开关写审计（含前后值）；非管理员 / 无字段设置权限的后台角色不能改。
"use strict";
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { DatabaseSync } = require("node:sqlite");
const { ADMIN, startServer, loginAs, makeClient } = require("./helpers.js");

let srv, admin;
const people = {};
let ASSESS;   // 新类型的 key

function dbRead(fn) { const d = new DatabaseSync(srv.dbPath, { readOnly: true }); try { return fn(d); } finally { d.close(); } }
async function person(eid, name, managerEid, extra) {
  const r = await admin.post("/api/admin/employees", { name, employeeId: eid, department: "MV Dept", jobLevel: "PB2", programIds: [] });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const id = dbRead((d) => d.prepare("SELECT id FROM users WHERE employeeId = ?").get(eid)).id;
  const patch = { ...(managerEid ? { managerId: people[managerEid].id } : {}), ...(extra || {}) };
  if (Object.keys(patch).length) assert.equal((await admin.put(`/api/admin/employees/${id}`, patch)).status, 200);
  const c = makeClient(srv.base);
  await c.login({ employeeId: eid, password: r.data.password });
  assert.equal((await c.post("/api/auth/change-password", { currentPassword: r.data.password, newPassword: eid + "-pw-2026" })).status, 200);
  people[eid] = { id, client: c };
  return people[eid];
}
const types = async (client) => (await (client || admin).get("/api/admin/config/records")).data.types;
const typeOf = async (key) => (await types()).find((t) => t.key === key);
const setMgrVis = async (key, on, client) => {
  const t = await typeOf(key);
  return (client || admin).post("/api/admin/config/record-types", { ...t, managerVisible: on });
};
const reportTypes = async (eid, target) => {
  const r = await people[eid].client.get(`/api/me/reports/${people[target].id}`);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return r.data;
};
const recordTypesIn = (rep) => new Set((rep.events || []).filter((x) => x.kind === "record").map((x) => x.type));   // 下属档案的时间线键名是 events

before(async () => {
  srv = await startServer();
  admin = await loginAs(srv.base, ADMIN);
  await person("MV-SKIP", "Sara Skip");
  await person("MV-MGR", "Marc Mgr", "MV-SKIP");
  await person("MV-E", "Ezra Emp", "MV-MGR");
});
after(async () => { if (srv) await srv.stopAsync(); });

test("after migration 71: managerVisible is false for note and true for every other seeded type; the admin config returns it", async () => {
  const ts = await types();
  const seeded = ["performance", "training", "award", "violation", "promotion", "regularization", "transfer", "exit", "note"];
  for (const k of seeded) {
    const t = ts.find((x) => x.key === k);
    assert.ok(t, k);
    assert.equal(typeof t.managerVisible, "boolean", k + " carries managerVisible");
    assert.equal(t.managerVisible, k !== "note", k);
  }
  assert.ok(dbRead((d) => d.prepare("SELECT version FROM schema_migrations WHERE version = 71").get()), "migration 71 recorded");
  // 保存类型时不带 managerVisible → 保持原值（界面回传整条类型以外的旧客户端）
  const award = await typeOf("award");
  const { managerVisible, ...noFlag } = award;
  assert.equal((await admin.post("/api/admin/config/record-types", { ...noFlag, color: "#b8860c" })).status, 200);
  assert.equal((await typeOf("award")).managerVisible, true, "kept when absent from the body");
});

test("scenario: a new type 「测评结果」 visible to HR only — hidden from the direct and the skip-level manager, still in the admin profile; note stays hidden until switched on", async () => {
  const c = await admin.post("/api/admin/config/record-types", { label: "Assessment result", label_zh: "测评结果", color: "#336699", employeeVisible: false, managerVisible: true });
  assert.equal(c.status, 200, JSON.stringify(c.data));
  ASSESS = c.data.type.key;
  assert.equal(c.data.type.managerVisible, true);
  const e = people["MV-E"].id;
  for (const [type, title] of [[ASSESS, "Assessment 2026"], ["award", "Award 2026"], ["note", "HR note 2026"]]) {
    const r = await admin.post(`/api/admin/employees/${e}/records`, { type, date: "2026-09-01", title, fields: type === "award" ? { awardName: "Star of the Quarter" } : type === "note" ? { text: "HR-NOTE-TEXT 仅 HR 可见" } : {} });
    assert.equal(r.status, 200, type + " " + JSON.stringify(r.data));
  }
  for (const m of ["MV-MGR", "MV-SKIP"]) {
    const ts = recordTypesIn(await reportTypes(m, "MV-E"));
    assert.ok(ts.has(ASSESS) && ts.has("award"), m + " sees both while on: " + [...ts]);
    assert.ok(!ts.has("note"), m + ": note is hidden by default");
  }
  // 关闭「测评结果」
  const off = await setMgrVis(ASSESS, false);
  assert.equal(off.status, 200, JSON.stringify(off.data));
  assert.equal(off.data.type.managerVisible, false);
  for (const m of ["MV-MGR", "MV-SKIP"]) {
    const rep = await reportTypes(m, "MV-E");
    const ts = recordTypesIn(rep);
    assert.ok(!ts.has(ASSESS), m + " no longer sees the assessment");
    assert.ok(ts.has("award"), m + " still sees the award");
    assert.ok(!JSON.stringify(rep).includes("Assessment 2026"), m + ": the title is nowhere in the response");
  }
  const prof = (await admin.get(`/api/admin/employees/${e}/profile`)).data;
  assert.ok(prof.events.some((x) => x.type === ASSESS && x.title === "Assessment 2026"), "the admin console still shows it");
  assert.ok(prof.events.some((x) => x.type === "note"), "and the note");
  // 打开备注 → 上级看得到；再关上 → 看不到
  assert.equal((await setMgrVis("note", true)).status, 200);
  assert.ok(recordTypesIn(await reportTypes("MV-MGR", "MV-E")).has("note"), "note shown once switched on");
  assert.equal((await setMgrVis("note", false)).status, 200);
  assert.ok(!recordTypesIn(await reportTypes("MV-SKIP", "MV-E")).has("note"));
});

test("changing the switch is audited with before / after", async () => {
  const rows = dbRead((d) => d.prepare("SELECT action, target, beforeJson, afterJson FROM audit_logs WHERE target = ? ORDER BY id").all(ASSESS));
  const hit = rows.find((r) => { const b = JSON.parse(r.beforeJson || "null"), a = JSON.parse(r.afterJson || "null"); return b && a && b.managerVisible === true && a.managerVisible === false; });
  assert.ok(hit, "an audit row records managerVisible true → false: " + JSON.stringify(rows));
  assert.match(hit.action, /^talent\.(config\.type|record-type\.mgrvis)$/);
});

test("only console users with the settings right can change it: employees 403, a performance-only role is refused, nothing changes", async () => {
  const before = (await typeOf("award")).managerVisible;
  const emp = await setMgrVis("award", false, people["MV-E"].client);
  assert.equal(emp.status, 403, JSON.stringify(emp.data));
  const role = await admin.post("/api/admin/roles", { name: "Perf only MV", name_zh: "仅绩效 MV", grants: { performance: "manage" } });
  assert.equal(role.status, 200);
  const p = await person("MV-PERF", "Paula Perf", null, { adminRoleId: role.data.role.id });
  const r = await setMgrVis("award", false, p.client);
  assert.ok([403, 404].includes(r.status), "performance-only role refused: " + r.status + " " + JSON.stringify(r.data));
  assert.equal((await typeOf("award")).managerVisible, before, "unchanged");
});

test("the switch also trims the derived parts of the manager view (stats counts, archived performance history); a non-boolean value is 400", async () => {
  const e = people["MV-E"].id;
  assert.equal((await admin.post(`/api/admin/employees/${e}/records`, { type: "performance", date: "2026-06-30", title: "2026 H1 MV", fields: { period: "2026 H1 MV", rating: "B", summary: "PERF-SUMMARY-MV" } })).status, 200);
  let rep = await reportTypes("MV-MGR", "MV-E");
  assert.ok(rep.performance.some((p) => p.source === "archived" && p.cycle === "2026 H1 MV"), "performance history shown while on");
  assert.ok(rep.stats.awards >= 1, JSON.stringify(rep.stats));
  assert.equal((await setMgrVis("performance", false)).status, 200);
  assert.equal((await setMgrVis("award", false)).status, 200);
  try {
    rep = await reportTypes("MV-SKIP", "MV-E");
    assert.ok(!rep.performance.some((p) => p.source === "archived"), "no archived performance history for managers");
    assert.ok(!JSON.stringify(rep).includes("PERF-SUMMARY-MV"));
    assert.equal(rep.stats.awards, 0, "award count trimmed with the type");
    assert.ok(!JSON.stringify(rep).includes("Star of the Quarter"));
  } finally {
    assert.equal((await setMgrVis("performance", true)).status, 200);
    assert.equal((await setMgrVis("award", true)).status, 200);
  }
  const bad = await setMgrVis("award", "yes");
  assert.equal(bad.status, 400, JSON.stringify(bad.data));
  assert.equal((await typeOf("award")).managerVisible, true);
});
