// F60 / F61（负责人 2026-10-09）：人才盘点顶部筛选 = 整页人群范围；「管理职责 / Role type」删除、并入岗位序列。
// 起真服务（helpers.startServer，一次性库，永不碰 lms.db）。两棵部门树（SC Fin ⊃ SC Fin AP、SC Ops），一个 SC Fin 子树范围的人才管理员。
// F60 覆盖（服务端判定，modules/talent/review-scope.js 一处）：
//   · 九宫格：GET talent-review 带范围参数 → 每行 inScope（rows 仍是数据范围内全部人员）；
//   · 晋升评审候选：rows 与 unmapped 只含范围内的人；导出（talent-filters/export + 内置筛选 id）同一范围；
//   · 继任计划：rows 只含继任人在范围内的行；?withPositions=1 时关键岗位全部保留，并给出范围内继任者人数；
//   · 人才筛选：run / idsOnly / export 的结果 = 顶部范围 ∩ 条件；
//   · 批量加入继任名单、人工名单：范围外的人逐人跳过（out_of_view）；
//   · 数据范围先行：受限管理员把范围设到数据范围外（部门 id、上级 id）→ 不匹配任何人，任何端点都不多给一个人。
// F61 覆盖：字段目录没有 isManager；含 isManager 的筛选保存 / 运行都不报 400，警告 field_retired、条件被忽略；?role= 不再收窄九宫格；
//   数据迁移 91：能对应的改写成 jobTrack（版本 +1、一条系统审计），对应不了的保留；再跑一遍不改不写。
"use strict";
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { DatabaseSync } = require("node:sqlite");
const { ADMIN, startServer, loginAs } = require("./helpers.js");

let srv, admin, scoped;
const dept = {};
const emp = {};
const q = (o) => new URLSearchParams(o).toString();
const sc = (rows) => rows.map((r) => r.employeeId).filter((x) => String(x).startsWith("SC-") && x !== "SC-ADMIN").sort();   // SC-ADMIN = 受限管理员本人（无部门），不参与断言
function dbRead(fn) { const d = new DatabaseSync(srv.dbPath, { readOnly: true }); try { return fn(d); } finally { d.close(); } }

async function makeEmployee(empId, patch) {
  const created = await admin.post("/api/admin/employees", { name: "Name " + empId, employeeId: empId });
  assert.equal(created.status, 200, "create " + empId);
  const u = (await admin.get("/api/admin/roster")).data.find((x) => x.employeeId === empId);
  assert.equal((await admin.put("/api/admin/employees/" + u.id, patch)).status, 200, "patch " + empId);
  emp[empId] = u.id;
  return created.data.password;
}

before(async () => {
  srv = await startServer();
  admin = await loginAs(srv.base, ADMIN);
  for (const [name, parent] of [["SC Fin", null], ["SC Fin AP", "SC Fin"], ["SC Ops", null]]) {
    const r = await admin.post("/api/admin/departments", parent ? { name, parentId: dept[parent] } : { name });
    assert.equal(r.status, 200, "create department " + name);
    dept[name] = r.data.department.id;
  }
  await makeEmployee("SC-FM", { department: "SC Fin", jobLevel: "MB2", hireDate: "2018-01-01", empStatus: "regular" });
  await makeEmployee("SC-F1", { department: "SC Fin", jobLevel: "PB2", hireDate: "2020-01-01", empStatus: "regular", managerId: emp["SC-FM"] });
  await makeEmployee("SC-A1", { department: "SC Fin AP", jobLevel: "PB2", hireDate: "2020-01-01", empStatus: "probation", managerId: emp["SC-FM"] });
  await makeEmployee("SC-FNL", { department: "SC Fin", jobLevel: "", hireDate: "2020-01-01", empStatus: "regular" });
  await makeEmployee("SC-O2", { department: "SC Ops", jobLevel: "MB3", hireDate: "2018-01-01", empStatus: "regular" });
  await makeEmployee("SC-O1", { department: "SC Ops", jobLevel: "PB2", hireDate: "2020-01-01", empStatus: "regular", managerId: emp["SC-O2"] });
  await makeEmployee("SC-ONL", { department: "SC Ops", jobLevel: "", hireDate: "2020-01-01", empStatus: "regular" });
  for (const [pos, who] of [["Head of Finance", "SC-F1"], ["Head of Finance", "SC-O1"], ["Ops Head", "SC-O2"]])
    assert.equal((await admin.post("/api/admin/succession", { positionName: pos, userId: emp[who], readiness: "oneYear" })).status, 200);
  const role = await admin.post("/api/admin/roles", { name: "SC Fin Talent", name_zh: "SC 财务人才", grants: { talent: "manage", people: "read" }, scope: { departments: [{ id: dept["SC Fin"], includeChildren: true }] } });
  assert.equal(role.status, 200, JSON.stringify(role.data));
  const pw = await makeEmployee("SC-ADMIN", { adminRoleId: role.data.role.id });
  scoped = await loginAs(srv.base, { employeeId: "SC-ADMIN", password: pw });
  assert.equal((await scoped.post("/api/auth/change-password", { currentPassword: pw, newPassword: "SC-ADMIN-pw-2026" })).status, 200);
});
after(async () => { if (srv) await srv.stopAsync(); });

const FIN = () => ({ dept: dept["SC Fin"] });

test("F60 9-box: GET talent-review marks each row inScope by the page filters (dept incl. sub-units, track, mgr, estatus, band); rows stay complete", async () => {
  const inScope = async (o) => {
    const r = await admin.get("/api/admin/talent-review?" + q(o));
    assert.equal(r.status, 200);
    return { all: sc(r.data.rows), on: sc(r.data.rows.filter((x) => x.inScope)), scoped: r.data.scoped };
  };
  const none = await inScope({});
  assert.equal(none.scoped, false);
  assert.deepEqual(none.on, none.all, "no filters = everyone in scope");
  const fin = await inScope(FIN());
  assert.equal(fin.scoped, true);
  assert.deepEqual(fin.all, none.all, "rows still list everyone in the data scope (filter options come from them)");
  assert.deepEqual(fin.on, ["SC-A1", "SC-F1", "SC-FM", "SC-FNL"], "department includes its sub-units");
  assert.deepEqual((await inScope({ track: "M" })).on, ["SC-FM", "SC-O2"]);
  assert.deepEqual((await inScope({ ...FIN(), track: "P" })).on, ["SC-A1", "SC-F1"], "filters combine (and)");
  assert.deepEqual((await inScope({ mgr: emp["SC-FM"] })).on, ["SC-A1", "SC-F1"]);
  assert.deepEqual((await inScope({ estatus: "probation" })).on, ["SC-A1"]);
  assert.deepEqual((await inScope({ band: "none" })).on, ["SC-FNL", "SC-ONL"]);
  assert.deepEqual((await inScope({ band: "nonsense" })).on, [], "an unknown value matches nobody (never 'no filter')");
  // F61：role 不再是范围键
  const role = await inScope({ role: "mgr" });
  assert.equal(role.scoped, false);
  assert.deepEqual(role.on, role.all);
});

test("F60 promotion candidates: rows and unmapped only hold people in the page scope", async () => {
  const all = (await admin.get("/api/admin/promotion-candidates")).data;
  assert.ok(sc(all.rows).includes("SC-O1") && sc(all.unmapped).includes("SC-ONL"));
  const fin = (await admin.get("/api/admin/promotion-candidates?" + q(FIN()))).data;
  assert.deepEqual(sc(fin.rows), ["SC-A1", "SC-F1", "SC-FM"]);
  assert.deepEqual(sc(fin.unmapped), ["SC-FNL"]);
  const m = (await admin.get("/api/admin/promotion-candidates?" + q({ track: "M" }))).data;
  assert.deepEqual(sc(m.rows), ["SC-FM", "SC-O2"]);
  assert.deepEqual(m.unmapped.filter((u) => String(u.employeeId).startsWith("SC-")), [], "no job level = no track = out of a track scope");
});

test("F60 succession: rows follow the successor; withPositions keeps every key position with its in-scope successor count", async () => {
  const plain = await admin.get("/api/admin/succession?" + q(FIN()));
  assert.ok(Array.isArray(plain.data), "without withPositions the response stays an array");
  assert.deepEqual(sc(plain.data), ["SC-F1"]);
  const w = (await admin.get("/api/admin/succession?withPositions=1&" + q(FIN()))).data;
  assert.equal(w.scoped, true);
  assert.deepEqual(sc(w.rows), ["SC-F1"]);
  const pos = Object.fromEntries(w.positions.filter((p) => ["Head of Finance", "Ops Head"].includes(p.positionName)).map((p) => [p.positionName, [p.total, p.inScope]]));
  assert.deepEqual(pos, { "Head of Finance": [2, 1], "Ops Head": [1, 0] }, "key-position rows stay; 范围内继任者 N");
  const none = (await admin.get("/api/admin/succession?withPositions=1")).data;
  assert.equal(none.scoped, false);
  assert.deepEqual(sc(none.rows), ["SC-F1", "SC-O1", "SC-O2"]);
});

test("F60 talent filters: run, idsOnly and export give the page scope ∩ the conditions; dropping the scope restores the full result", async () => {
  const def = { v: 1, logic: "and", items: [{ field: "jobTrack", op: "in", value: ["P"] }] };
  const base = { definition: def, columns: ["name", "employeeId"], pageSize: 200 };
  const without = await admin.post("/api/admin/talent-filters/run", base);
  assert.deepEqual(sc(without.data.rows), ["SC-A1", "SC-F1", "SC-O1"]);
  assert.equal(without.data.scoped, false);
  const withScope = await admin.post("/api/admin/talent-filters/run", { ...base, scope: FIN() });
  assert.equal(withScope.status, 200);
  assert.equal(withScope.data.scoped, true);
  assert.deepEqual(sc(withScope.data.rows), ["SC-A1", "SC-F1"]);
  const idsOnly = await admin.post("/api/admin/talent-filters/run", { definition: def, idsOnly: true, scope: FIN() });
  assert.ok(idsOnly.data.ids.includes(emp["SC-F1"]) && !idsOnly.data.ids.includes(emp["SC-O1"]));
  assert.equal(idsOnly.data.total, withScope.data.total);
  const res = await admin.raw("POST", "/api/admin/talent-filters/export", { definition: def, columns: ["name", "employeeId"], lang: "en", scope: FIN() });
  assert.equal(res.status, 200);
  const csv = await res.text();
  assert.ok(csv.includes("SC-F1") && csv.includes("SC-A1") && !csv.includes("SC-O1"), "export follows the scope");
  const auditRow = dbRead((d) => d.prepare("SELECT afterJson FROM audit_logs WHERE action = 'export.talent-filter' ORDER BY id DESC LIMIT 1").get());
  assert.deepEqual(JSON.parse(auditRow.afterJson).pageScope, FIN(), "the export audit records the page scope");
  // 保存的筛选按 filterId 运行同样叠加
  const saved = await admin.post("/api/admin/talent-filters", { name: "SC P track", definition: def });
  const byId = await admin.post("/api/admin/talent-filters/run", { filterId: saved.data.filter.id, pageSize: 200, scope: { track: "M" } });
  assert.deepEqual(sc(byId.data.rows), [], "P-track condition ∩ M-track page scope = nobody");
});

test("F60 promotion export follows the page scope", async () => {
  // SC-F1 与 SC-O1 都满足晋升评审条件（F62 口径：近 12 个月两期评级 A、现职级任职满 12 个月（按入职日）、无违纪；培训门槛关掉）
  assert.equal((await admin.put("/api/admin/promotion-config", { requireTrainings: false })).status, 200);
  for (const e of ["SC-F1", "SC-O1"])
    for (const [date, period] of [["2025-12-31", "2025-H2"], ["2026-06-30", "2026-H1"]])
      assert.equal((await admin.post(`/api/admin/employees/${emp[e]}/records`, { type: "performance", date, title: "perf " + e + " " + period, fields: { rating: "A", period } })).status, 200);
  const filterId = (await admin.get("/api/admin/promotion-candidates")).data.filterId;
  const all = await (await admin.raw("POST", "/api/admin/talent-filters/export", { filterId, lang: "en" })).text();
  const fin = await (await admin.raw("POST", "/api/admin/talent-filters/export", { filterId, lang: "en", scope: FIN() })).text();
  assert.ok(all.includes("SC-F1") && all.includes("SC-O1"), "both are candidates without a page scope");
  assert.ok(fin.includes("SC-F1") && !fin.includes("SC-O1"), "the export follows the page scope");
  const rows = (await admin.get("/api/admin/promotion-candidates?" + q(FIN()))).data.rows;
  assert.deepEqual(sc(rows.filter((r) => r.eligible)), ["SC-F1"]);
});

test("F60 bulk actions: people outside the page scope are skipped (out_of_view), the rest are written", async () => {
  const bulk = await admin.post("/api/admin/succession/bulk", { positionName: "SC Controller", userIds: [emp["SC-A1"], emp["SC-O1"]], readiness: "ready", scope: FIN() });
  assert.equal(bulk.status, 200, JSON.stringify(bulk.data));
  assert.equal(bulk.data.created, 1);
  assert.deepEqual(bulk.data.skipped, [{ userId: emp["SC-O1"], employeeId: "SC-O1", code: "out_of_view" }]);
  assert.deepEqual(sc((await admin.get("/api/admin/succession")).data.filter((r) => r.positionName === "SC Controller")), ["SC-A1"]);
  const filterId = (await admin.get("/api/admin/promotion-candidates")).data.filterId;
  const inc = await admin.post(`/api/admin/talent-filters/${filterId}/members`, { action: "include", userIds: [emp["SC-FNL"], emp["SC-ONL"]], note: "panel", scope: FIN() });
  assert.equal(inc.status, 200, JSON.stringify(inc.data));
  assert.equal(inc.data.done, 1);
  assert.deepEqual(inc.data.skipped.map((s) => [s.employeeId, s.code]), [["SC-ONL", "out_of_view"]]);
  assert.equal((await admin.post(`/api/admin/talent-filters/${filterId}/members`, { action: "remove", userIds: [emp["SC-FNL"]] })).data.done, 1);
});

test("F60 data scope first: a scoped admin's page filters only narrow — out-of-scope departments / managers match nobody, nothing leaks", async () => {
  const ops = { dept: dept["SC Ops"] };
  const nine = (await scoped.get("/api/admin/talent-review?" + q(ops))).data;
  assert.ok(!sc(nine.rows).some((x) => x.startsWith("SC-O")), "rows never include people outside the data scope");
  assert.deepEqual(sc(nine.rows.filter((r) => r.inScope)), [], "an out-of-scope department matches nobody");
  assert.deepEqual(sc((await scoped.get("/api/admin/promotion-candidates?" + q(ops))).data.rows), []);
  const succ = (await scoped.get("/api/admin/succession?withPositions=1&" + q(ops))).data;
  assert.deepEqual(succ.rows, []);
  assert.deepEqual(succ.positions.filter((p) => ["Head of Finance", "Ops Head", "SC Controller"].includes(p.positionName)).map((p) => [p.positionName, p.total, p.inScope]).sort(),
    [["Head of Finance", 1, 0], ["SC Controller", 1, 0]], "positions only from successors inside the data scope (Ops Head and SC-O1 never appear)");
  const def = { v: 1, logic: "and", items: [] };
  assert.deepEqual(sc((await scoped.post("/api/admin/talent-filters/run", { definition: def, pageSize: 200, scope: ops })).data.rows), []);
  assert.deepEqual(sc((await scoped.post("/api/admin/talent-filters/run", { definition: def, pageSize: 200, scope: { mgr: emp["SC-O2"] } })).data.rows), [], "an out-of-scope manager matches nobody");
  // track = M：全公司看得到 SC-FM 与 SC-O2，受限管理员只有 SC-FM
  assert.deepEqual(sc((await scoped.post("/api/admin/talent-filters/run", { definition: def, pageSize: 200, scope: { track: "M" } })).data.rows), ["SC-FM"]);
  assert.deepEqual(sc((await scoped.get("/api/admin/promotion-candidates?" + q({ track: "M" }))).data.rows), ["SC-FM"]);
  const csv = await (await scoped.raw("POST", "/api/admin/talent-filters/export", { definition: def, columns: ["name", "employeeId"], lang: "en", scope: { track: "M" } })).text();
  assert.ok(csv.includes("SC-FM") && !csv.includes("SC-O2"));
  // 批量：数据范围外的人仍按原规则整批拒绝（不是逐人跳过）
  const rej = await scoped.post("/api/admin/succession/bulk", { positionName: "SC Lead", userIds: [emp["SC-F1"], emp["SC-O1"]], readiness: "ready", scope: FIN() });
  assert.equal(rej.status, 404);
  assert.equal(rej.data.code, "out_of_scope");
});

test("F61: no isManager in the catalog; a saved filter that still has it is never a 400 — the condition is retired and ignored", async () => {
  const cat = (await admin.get("/api/admin/talent-filters/catalog")).data;
  assert.ok(!cat.fields.some((f) => f.id === "isManager"));
  assert.ok(cat.fields.some((f) => f.id === "jobTrack"), "Track stays");
  const def = { v: 1, logic: "and", items: [{ id: "c1", field: "isManager", op: "isTrue" }, { id: "c2", field: "jobTrack", op: "in", value: ["P"] }] };
  const saved = await admin.post("/api/admin/talent-filters", { name: "SC Retired", definition: def });
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  const run = await admin.post("/api/admin/talent-filters/run", { filterId: saved.data.filter.id, pageSize: 200 });
  assert.equal(run.status, 200);
  assert.deepEqual(run.data.warnings.filter((w) => w.id === "c1"), [{ id: "c1", code: "field_retired" }]);
  assert.deepEqual(sc(run.data.rows), ["SC-A1", "SC-F1", "SC-O1"], "the retired condition is ignored; jobTrack still applies");
  const adhoc = await admin.post("/api/admin/talent-filters/run", { definition: def, pageSize: 200 });
  assert.equal(adhoc.status, 200, "strict validation does not reject it either");
  const g = await admin.get("/api/admin/talent-filters/" + saved.data.filter.id);
  assert.match(g.data.filter.summary_zh, /已停用的条件/);
});

test("F61 migration 91: role-type leaves become jobTrack (version + 1, one system audit); unmappable leaves stay; a re-run changes nothing", async () => {
  const s1 = await startServer();
  const now = new Date().toISOString();
  const put = (d, id, def) => d.prepare(`INSERT INTO talent_filters (id, name, name_zh, builtinKey, definition, columns, sort, visibility, ownerId, version, createdAt, updatedAt, updatedBy)
    VALUES (?, ?, NULL, NULL, ?, '["name"]', NULL, 'shared', NULL, 3, ?, ?, NULL)`).run(id, id, JSON.stringify(def), now, now);
  try {
    await s1.stopAsync();
    let d = new DatabaseSync(s1.dbPath);
    try {
      assert.ok(d.prepare("SELECT 1 FROM schema_migrations WHERE version = 91").get(), "a fresh database records migration 91");
      assert.equal(d.prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'talent.filter.role-type-to-track'").get().n, 0, "nothing to change on an empty database → no audit");
      put(d, "tf-m91-a", { v: 1, logic: "and", items: [{ id: "c1", field: "isManager", op: "isTrue" }, { logic: "or", items: [{ id: "c2", field: "isManager", op: "isFalse" }, { id: "c3", field: "tenureMonths", op: "gte", value: 12 }] }] });
      put(d, "tf-m91-b", { v: 1, logic: "and", items: [{ id: "c1", field: "isManager", op: "maybe" }] });
      put(d, "tf-m91-c", { v: 1, logic: "and", items: [{ id: "c1", field: "tenureMonths", op: "gte", value: 1 }] });
      d.prepare("DELETE FROM schema_migrations WHERE version = 91").run();
    } finally { d.close(); }
    const s2 = await startServer({ dbPath: s1.dbPath });
    await s2.stopAsync();
    d = new DatabaseSync(s1.dbPath, { readOnly: true });
    let audits;
    try {
      const row = (id) => d.prepare("SELECT definition, version FROM talent_filters WHERE id = ?").get(id);
      const a = row("tf-m91-a");
      assert.deepEqual(JSON.parse(a.definition).items, [{ id: "c1", field: "jobTrack", op: "in", value: ["M"] }, { logic: "or", items: [{ id: "c2", field: "jobTrack", op: "in", value: ["P"] }, { id: "c3", field: "tenureMonths", op: "gte", value: 12 }] }]);
      assert.equal(a.version, 4, "version bumped");
      const b = row("tf-m91-b");
      assert.deepEqual(JSON.parse(b.definition).items, [{ id: "c1", field: "isManager", op: "maybe" }], "unmappable leaf kept (retired)");
      assert.equal(b.version, 3);
      assert.equal(row("tf-m91-c").version, 3, "untouched filter");
      audits = d.prepare("SELECT actorId, afterJson FROM audit_logs WHERE action = 'talent.filter.role-type-to-track'").all();
    } finally { d.close(); }
    assert.equal(audits.length, 1);
    assert.equal(audits[0].actorId, null, "system audit");
    const after1 = JSON.parse(audits[0].afterJson);
    assert.deepEqual([after1.migration, after1.filters, after1.leaves], [91, 1, 2]);
    assert.deepEqual(after1.retiredLeft, [{ id: "tf-m91-b", name: "tf-m91-b", leaves: 1 }]);
    // 再跑一遍：没有可改写的叶子，不改数据、不写审计
    d = new DatabaseSync(s1.dbPath);
    try { d.prepare("DELETE FROM schema_migrations WHERE version = 91").run(); } finally { d.close(); }
    const s3 = await startServer({ dbPath: s1.dbPath });
    await s3.stopAsync();
    d = new DatabaseSync(s1.dbPath, { readOnly: true });
    try {
      assert.equal(d.prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'talent.filter.role-type-to-track'").get().n, 1);
      assert.equal(d.prepare("SELECT version FROM talent_filters WHERE id = 'tf-m91-a'").get().version, 4);
    } finally { d.close(); }
    // 职级体系里没有管理通道：isTrue 对应不了，保留为停用条件；isFalse 照常改写
    d = new DatabaseSync(s1.dbPath);
    try {
      d.prepare("UPDATE meta SET value = ? WHERE key = 'jobGradeConfig'").run(JSON.stringify({ ranks: [{ rank: "PB2", grade: "B", level: 10, track: "P" }] }));
      put(d, "tf-m91-d", { v: 1, logic: "and", items: [{ id: "c1", field: "isManager", op: "isTrue" }, { id: "c2", field: "isManager", op: "isFalse" }] });
      d.prepare("DELETE FROM schema_migrations WHERE version = 91").run();
    } finally { d.close(); }
    const s4 = await startServer({ dbPath: s1.dbPath });
    await s4.stopAsync();
    d = new DatabaseSync(s1.dbPath, { readOnly: true });
    try {
      assert.deepEqual(JSON.parse(d.prepare("SELECT definition FROM talent_filters WHERE id = 'tf-m91-d'").get().definition).items,
        [{ id: "c1", field: "isManager", op: "isTrue" }, { id: "c2", field: "jobTrack", op: "in", value: ["P"] }]);
    } finally { d.close(); }
  } finally {
    try { await s1.stopAsync(); } catch {}
  }
});
