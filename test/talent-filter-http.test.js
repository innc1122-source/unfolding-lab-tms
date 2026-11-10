// 第五批 8.1 / 8.2（2026-10-09，A 组集成）：人才筛选、晋升评审候选（内置筛选）、继任批量加入与导入的 HTTP 契约。
// 起真服务（helpers.startServer，一次性库，永不碰 lms.db），造一棵两层部门树 + 范围内 / 范围外两组人，三个人才管理员角色：
//   scopedTP  = talent 写 + people 读，范围 = TF Root 子树（导出可用）
//   scopedT   = talent 写，范围同上，没有 people 读（导出被拒）
//   plainT    = talent 写，全公司范围
// 覆盖：
//   范围泄露（设计 3.4、16）：字段目录的部门选项、运行结果、范围外部门 id 与 "name:" 伪 id = 值不可用（不是「不筛选」）、
//     共享筛选下发前裁剪部门值、unmapped 只含范围内的人；
//   批量动作有一人在范围外 → 整批拒绝且一行不写（人工名单、批量加入继任名单、继任导入）；
//   继任导入：预览后数据变了 → 409 preview_stale；
//   导出：没有员工档案读权限 → 403 export_forbidden；
//   口径统一（设计 5.3）：只有轻微违纪的人按新口径不入选、勾选「只看重大违纪」后入选；工作台人数与候选页一致（原两处各算一份，曾不一致）；
//   保存的筛选：私有筛选他人看不到（404）、乐观锁 409、内置筛选不能删、恢复默认；PUT promotion-config 保留 HR 自己加的条件；
//   AI 一句话转条件（演示模式）：生成条件、不入库原文。
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { ADMIN, startServer, loginAs, tempDir } = require("./helpers.js");

let srv, admin, scopedTP, scopedT, plainT;
const dept = {};
const emp = {};
const day = (offsetDays) => { const d = new Date(Date.now() + offsetDays * 86400000); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };

async function makeRole(name, grants, scope) {
  const r = await admin.post("/api/admin/roles", { name, name_zh: name, grants, ...(scope ? { scope } : {}) });
  assert.equal(r.status, 200, "create role " + name);
  return r.data.role.id;
}
async function makeAdminUser(empId, adminRoleId) {
  const created = await admin.post("/api/admin/employees", { name: empId, employeeId: empId });
  assert.equal(created.status, 200, "create " + empId);
  const u = (await admin.get("/api/admin/roster")).data.find((x) => x.employeeId === empId);
  assert.equal((await admin.put("/api/admin/employees/" + u.id, { adminRoleId })).status, 200);
  const c = await loginAs(srv.base, { employeeId: empId, password: created.data.password });
  assert.equal((await c.post("/api/auth/change-password", { currentPassword: created.data.password, newPassword: empId + "-pw-2026" })).status, 200);
  return c;
}
async function makeEmployee(empId, patch) {
  const created = await admin.post("/api/admin/employees", { name: "Name " + empId, employeeId: empId });
  assert.equal(created.status, 200, "create employee " + empId);
  const u = (await admin.get("/api/admin/roster")).data.find((x) => x.employeeId === empId);
  assert.equal((await admin.put("/api/admin/employees/" + u.id, patch)).status, 200, "patch " + empId);
  emp[empId] = u.id;
}
async function addRecord(empId, type, date, fields) {
  const r = await admin.post(`/api/admin/employees/${emp[empId]}/records`, { type, date, title: `${type} ${empId}`, fields });
  assert.equal(r.status, 200, `${type} record for ${empId}: ${JSON.stringify(r.data)}`);
}
const ids = (rows) => rows.map((r) => r.employeeId).sort();
const candRow = async (c, empId) => (await c.get("/api/admin/promotion-candidates")).data.rows.find((r) => r.employeeId === empId);

before(async () => {
  // AI 演示模式（人才筛选的 AI 条件生成走本地规则）：ai 模块开、demo、清空 helpers 默认的 LMS_DISABLE_AI
  const cfgDir = tempDir("tf-cfg-");
  fs.writeFileSync(path.join(cfgDir, "config.json"), JSON.stringify({ modules: { ai: true }, ai: { demo: true, features: { talentFilter: true } } }));
  srv = await startServer({ env: { LMS_CONFIG_PATH: path.join(cfgDir, "config.json"), LMS_DISABLE_AI: "" } });
  admin = await loginAs(srv.base, ADMIN);
  for (const [name, parent] of [["TF Root", null], ["TF Child", "TF Root"], ["TF Other", null]]) {
    const r = await admin.post("/api/admin/departments", parent ? { name, parentId: dept[parent] } : { name });
    assert.equal(r.status, 200, "create department " + name);
    dept[name] = r.data.department.id;
  }
  const old = "2020-01-01";
  await makeEmployee("TF-IN", { department: "TF Root", jobLevel: "PB2", position: "Ops Lead In", hireDate: old });
  await makeEmployee("TF-KID", { department: "TF Child", jobLevel: "PB2", position: "Ops Member In", hireDate: old, managerId: emp["TF-IN"] });
  await makeEmployee("TF-MINOR", { department: "TF Root", jobLevel: "PB2", position: "Ops Analyst In", hireDate: old });
  await makeEmployee("TF-NEW", { department: "TF Root", jobLevel: "PB2", position: "Ops Junior In", hireDate: day(-40) });
  await makeEmployee("TF-NOLVL", { department: "TF Root", jobLevel: "", hireDate: old });
  await makeEmployee("TF-OUT", { department: "TF Other", jobLevel: "PB2", position: "Ops Lead Out", hireDate: old });
  await makeEmployee("TF-NOLVL-OUT", { department: "TF Other", jobLevel: "", hireDate: old });
  for (const e of ["TF-IN", "TF-MINOR", "TF-NEW", "TF-OUT"]) await addRecord(e, "performance", day(-20), { rating: "A", period: "2026-Q3" });
  // F62：近 2 期任一期 ≥ B+ 要求 2 期可比，再补一期（上一季度）
  for (const e of ["TF-IN", "TF-MINOR", "TF-NEW", "TF-OUT"]) await addRecord(e, "performance", day(-110), { rating: "B+", period: "2026-Q2" });
  await addRecord("TF-KID", "performance", day(-20), { rating: "B", period: "2026-Q3" });
  await addRecord("TF-MINOR", "violation", day(-30), { severity: "Minor" });
  // 培训门槛与本测试无关（新建员工可能有默认指派），先关掉；其余四项按默认（B+、12 个月、近 12 个月无违纪、不限严重度）
  assert.equal((await admin.put("/api/admin/promotion-config", { requireTrainings: false })).status, 200);
  const scope = { departments: [{ id: dept["TF Root"], includeChildren: true }] };
  scopedTP = await makeAdminUser("TF-A-SCOPED-P", await makeRole("TF Scoped Talent People", { talent: "manage", people: "read" }, scope));
  scopedT = await makeAdminUser("TF-A-SCOPED", await makeRole("TF Scoped Talent", { talent: "manage" }, scope));
  plainT = await makeAdminUser("TF-A-PLAIN", await makeRole("TF Plain Talent", { talent: "manage" }));
});
after(() => srv.stop());

test("catalog: shape for the editor, and department options only inside the data scope", async () => {
  const all = await admin.get("/api/admin/talent-filters/catalog");
  assert.equal(all.status, 200);
  const kinds = new Set(["dept", "level", "enum", "rating", "user", "program", "tag", "text", "number", "percent", "months", "count", "date", "bool", "record"]);
  for (const f of all.data.fields) assert.ok(kinds.has(f.valueKind), `${f.id} valueKind ${f.valueKind}`);
  const tenure = all.data.fields.find((f) => f.id === "tenureMonths");
  assert.equal(tenure.valueKind, "months");
  assert.equal(tenure.min, 0);
  assert.ok(tenure.group && tenure.group_zh, "group display names");
  assert.ok(all.data.fields.find((f) => f.id === "violation").paramOptions.severity.length >= 2);
  assert.ok(Array.isArray(all.data.columns) && all.data.columns.some((c) => c.id === "employeeId"));
  const deptAll = all.data.fields.find((f) => f.id === "dept").options.map((o) => o.label);
  assert.ok(deptAll.some((l) => l.includes("TF Other")), "super-admin sees every department");
  const scoped = await scopedTP.get("/api/admin/talent-filters/catalog");
  const deptScoped = scoped.data.fields.find((f) => f.id === "dept").options;
  assert.ok(deptScoped.some((o) => o.label.includes("TF Root")));
  assert.equal(deptScoped.some((o) => o.label.includes("TF Other") || o.value === dept["TF Other"]), false, "out-of-scope department is not offered");
});

test("run: rows and unmapped come from the scoped population only", async () => {
  const empty = { v: 1, logic: "and", items: [] };
  const s = await scopedTP.post("/api/admin/talent-filters/run", { definition: empty, columns: ["name", "employeeId", "department"], pageSize: 200 });
  assert.equal(s.status, 200);
  const got = ids(s.data.rows);
  assert.ok(got.includes("TF-IN") && got.includes("TF-KID"));
  assert.equal(got.some((x) => x.startsWith("TF-OUT") || x === "TF-NOLVL-OUT"), false, "no out-of-scope rows");
  assert.equal(s.data.total, s.data.rows.length);
  assert.ok(s.data.rows[0].cells && "department" in s.data.rows[0].cells, "column values under cells");
  const withLevel = await scopedTP.post("/api/admin/talent-filters/run", { definition: { v: 1, logic: "and", items: [{ field: "nextLevelExists", op: "isTrue" }] }, pageSize: 200 });
  const um = withLevel.data.unmapped.map((u) => u.employeeId);
  assert.ok(um.includes("TF-NOLVL"));
  assert.equal(um.includes("TF-NOLVL-OUT"), false, "unmapped is scoped too");
  const idsOnly = await scopedTP.post("/api/admin/talent-filters/run", { definition: empty, idsOnly: true });
  assert.equal(idsOnly.data.ids.includes(emp["TF-OUT"]), false);
  assert.equal(idsOnly.data.total, s.data.total);
});

test("run: an out-of-scope department (id or name: pseudo id) is 'value unavailable' and matches nobody — never 'no filter'", async () => {
  for (const value of [[dept["TF Other"]], ["name:TF Other"]]) {
    for (const op of ["in", "notIn"]) {
      const def = { v: 1, logic: "and", items: [{ id: "c1", field: "dept", op, value }] };
      const r = await scopedTP.post("/api/admin/talent-filters/run", { definition: def, pageSize: 200 });
      assert.equal(r.status, 200);
      assert.equal(r.data.total, 0, `${op} ${value} must match nobody for a scoped admin`);
      assert.ok(r.data.warnings.some((w) => w.code === "value_unavailable" && w.id === "c1"), "value_unavailable warning");
    }
  }
  // 全公司范围的管理员：同一条件照常生效
  const all = await plainT.post("/api/admin/talent-filters/run", { definition: { v: 1, logic: "and", items: [{ field: "dept", op: "in", value: [dept["TF Other"]] }] }, pageSize: 200 });
  assert.deepEqual(ids(all.data.rows), ["TF-NOLVL-OUT", "TF-OUT"]);
  // 范围内的部门含下级
  const sub = await scopedTP.post("/api/admin/talent-filters/run", { definition: { v: 1, logic: "and", items: [{ field: "dept", op: "in", value: [dept["TF Root"]] }] }, pageSize: 200 });
  assert.ok(ids(sub.data.rows).includes("TF-KID"), "parent department includes sub-units");
});

test("run: invalid definition → 400 filter_invalid with per-leaf paths", async () => {
  const r = await scopedTP.post("/api/admin/talent-filters/run", { definition: { v: 1, logic: "and", items: [{ field: "nope", op: "in", value: [] }] } });
  assert.equal(r.status, 400);
  assert.equal(r.data.code, "filter_invalid");
  assert.equal(r.data.errors[0].code, "unknown_field");
  assert.match(r.data.errors[0].path, /items/);
});

test("shared filter: values outside the viewer's scope are removed before it is sent (and from the summary)", async () => {
  const def = { v: 1, logic: "and", items: [{ field: "dept", op: "in", value: [dept["TF Root"], dept["TF Other"], "name:TF Other"] }] };
  const c = await admin.post("/api/admin/talent-filters", { name: "Shared Mix", name_zh: "共享混合", definition: def, visibility: "shared" });
  assert.equal(c.status, 200, JSON.stringify(c.data));
  const id = c.data.filter.id;
  const mine = await admin.get("/api/admin/talent-filters/" + id);
  assert.equal(mine.data.redactedValues, 0);
  const g = await scopedTP.get("/api/admin/talent-filters/" + id);
  assert.equal(g.status, 200);
  assert.equal(g.data.redactedValues, 2);
  assert.deepEqual(g.data.filter.definition.items[0].value, [dept["TF Root"]]);
  assert.equal(JSON.stringify(g.data).includes("TF Other"), false, "no out-of-scope department name anywhere in the response");
  const list = await scopedTP.get("/api/admin/talent-filters");
  const row = list.data.filters.find((f) => f.id === id);
  assert.ok(row && row.canEdit === false, "shared filter: only the owner or a super-admin edits");
  assert.equal(JSON.stringify(row).includes("TF Other"), false);
  // 运行库里保存的筛选：范围外的值同样不可用，结果只有范围内的人
  const r = await scopedTP.post("/api/admin/talent-filters/run", { filterId: id, pageSize: 200 });
  assert.equal(r.status, 200);
  assert.equal(ids(r.data.rows).some((x) => x.startsWith("TF-OUT")), false);
});

test("saved filters: private is invisible to others (404), version conflict 409, built-in cannot be deleted, reset", async () => {
  const def = { v: 1, logic: "and", items: [{ field: "tenureMonths", op: "gte", value: 12 }] };
  const c = await scopedTP.post("/api/admin/talent-filters", { name: "My Tenure", definition: def, visibility: "private" });
  assert.equal(c.status, 200);
  const id = c.data.filter.id;
  assert.equal((await plainT.get("/api/admin/talent-filters/" + id)).status, 404);
  assert.equal((await plainT.post("/api/admin/talent-filters/run", { filterId: id })).status, 404);
  assert.equal((await plainT.get("/api/admin/talent-filters")).data.filters.some((f) => f.id === id), false);
  assert.equal((await scopedTP.post("/api/admin/talent-filters", { name: "my tenure", definition: def })).data.code, "name_taken");
  const v = c.data.filter.version;
  assert.equal((await scopedTP.put("/api/admin/talent-filters/" + id, { definition: def, version: v })).status, 200);
  const stale = await scopedTP.put("/api/admin/talent-filters/" + id, { definition: def, version: v });
  assert.equal(stale.status, 409);
  assert.equal(stale.data.code, "filter_conflict");
  assert.equal((await scopedTP.del("/api/admin/talent-filters/" + id)).status, 200);
  const cand = await admin.get("/api/admin/promotion-candidates");
  const builtin = (await admin.get("/api/admin/talent-filters/" + cand.data.filterId)).data.filter;
  assert.equal(builtin.builtinKey, "promotion");
  assert.equal((await admin.del("/api/admin/talent-filters/" + builtin.id)).data.code, "builtin_locked");
});

test("promotion-config PUT only touches tagged conditions — an HR-added condition survives", async () => {
  const cand = await admin.get("/api/admin/promotion-candidates");
  const f = (await admin.get("/api/admin/talent-filters/" + cand.data.filterId)).data.filter;
  const def = { ...f.definition, items: [...f.definition.items, { field: "jobTrack", op: "in", value: ["M"] }] };   // F61：HR 自己加的条件改用职级通道（isManager 已停用）
  const put = await admin.put("/api/admin/talent-filters/" + f.id, { definition: def, version: f.version });
  assert.equal(put.status, 200, JSON.stringify(put.data));
  assert.equal((await admin.put("/api/admin/promotion-config", { minTenureMonths: 6 })).status, 200);
  const after = (await admin.get("/api/admin/talent-filters/" + f.id)).data.filter;
  assert.ok(after.definition.items.some((l) => l.field === "jobTrack" && l.value[0] === "M"), "HR leaf kept");
  assert.ok(after.definition.items.some((l) => l.tag === "tenure" && l.value === 6));
  assert.equal((await admin.get("/api/admin/promotion-config")).data.config.minTenureMonths, 6);
  // 每行的 explain 覆盖每条顶层条件（HR 自己加的条件也有自己的命中）
  const row = await candRow(admin, "TF-IN");
  const hrLeaf = after.definition.items.find((l) => l.field === "jobTrack");
  assert.equal(row.explain[hrLeaf.id], false, "TF-IN is PB2 (Professional track) → jobTrack M fails");
  // 恢复默认：回到 F62 的默认值（司龄门槛停用、现职级任职 12 个月），HR 加的条件去掉；再关掉培训门槛（与 before 一致）
  const cur = (await admin.get("/api/admin/talent-filters/" + f.id)).data.filter;
  const reset = await admin.put("/api/admin/talent-filters/" + f.id, { reset: true, version: cur.version });
  assert.equal(reset.status, 200);
  assert.equal(reset.data.filter.definition.items.some((l) => l.field === "jobTrack"), false);
  const cfg = (await admin.get("/api/admin/promotion-config")).data.config;
  assert.equal(cfg.minTenureMonths, 0);
  assert.deepEqual([cfg.minLevelTenureMonths, cfg.minRatingPeriods, cfg.windowMinRating, cfg.windowMonths], [12, 2, "B", 12]);
  assert.equal((await admin.put("/api/admin/promotion-config", { requireTrainings: false })).status, 200);
});

test("promotion criteria (design 5.3 / F62): a minor-only violation now blocks; 'major only' lets it through; time in level counts calendar months", async () => {
  const minor = await candRow(admin, "TF-MINOR");
  assert.equal(minor.checks.violations.ok, false, "any severity in the last 12 months blocks by default");
  assert.equal(minor.eligible, false);
  assert.equal((await candRow(admin, "TF-IN")).eligible, true);
  const fresh = await candRow(admin, "TF-NEW");
  // F62：司龄门槛默认停用（没有这条叶子 → ok），现职级任职时长按入职日（没有晋升记录）= 1 个月 → 不满足
  assert.equal(fresh.checks.tenure.ok, true);
  assert.equal(fresh.checks.tenure.months, 1, "hired 40 days ago = 1 full calendar month");
  assert.equal(fresh.checks.levelTenure.ok, false);
  assert.equal(fresh.checks.levelTenure.months, 1);
  assert.equal(fresh.eligible, false);
  assert.equal((await admin.put("/api/admin/promotion-config", { violationMajorOnly: true })).status, 200);
  assert.equal((await candRow(admin, "TF-MINOR")).eligible, true);
  assert.equal((await admin.put("/api/admin/promotion-config", { violationMajorOnly: false })).status, 200);
});

test("workbench promotionPool equals the candidates page (same engine, same scope) — regression for the two hand-written counts", async () => {
  for (const c of [admin, scopedTP]) {
    const cand = await c.get("/api/admin/promotion-candidates");
    const dash = await c.get("/api/admin/dashboard");
    assert.equal(dash.status, 200);
    assert.equal(dash.data.promotionPool, cand.data.rows.filter((r) => r.eligible).length);
  }
  const scopedRows = (await scopedTP.get("/api/admin/promotion-candidates")).data.rows;
  assert.equal(scopedRows.some((r) => r.employeeId === "TF-OUT"), false);
});

test("manual list: out-of-scope person rejects the whole batch; exclude needs a reason; include / exclude / remove", async () => {
  const filterId = (await admin.get("/api/admin/promotion-candidates")).data.filterId;
  const url = `/api/admin/talent-filters/${filterId}/members`;
  const rej = await scopedTP.post(url, { action: "include", userIds: [emp["TF-KID"], emp["TF-OUT"]] });
  assert.equal(rej.status, 404);
  assert.equal(rej.data.code, "out_of_scope");
  assert.equal(rej.data.outOfScope, 1);
  assert.equal((await candRow(admin, "TF-KID")).member, null, "nothing written");
  const inc = await scopedTP.post(url, { action: "include", userIds: [emp["TF-KID"], emp["TF-IN"]], note: "Panel nominee" });
  assert.equal(inc.status, 200);
  assert.equal(inc.data.done, 1);
  assert.deepEqual(inc.data.skipped.map((s) => s.code), ["already_listed"], "TF-IN already meets the conditions");
  const kid = await candRow(scopedTP, "TF-KID");
  assert.equal(kid.member, "include");
  assert.equal(kid.eligible, true);
  const noNote = await scopedTP.post(url, { action: "exclude", userIds: [emp["TF-IN"]] });
  assert.equal(noNote.status, 400);
  assert.equal(noNote.data.code, "note_required");
  assert.equal((await scopedTP.post(url, { action: "exclude", userIds: [emp["TF-IN"]], note: "On extended leave" })).status, 200);
  const tin = await candRow(scopedTP, "TF-IN");
  assert.equal(tin.member, "exclude");
  assert.equal(tin.eligible, false);
  assert.equal((await scopedTP.post(url, { action: "remove", userIds: [emp["TF-IN"], emp["TF-KID"]] })).data.done, 2);
  assert.equal((await candRow(admin, "TF-IN")).eligible, true);
  // 自定义筛选没有人工名单
  const own = await admin.post("/api/admin/talent-filters", { name: "No Members", definition: { v: 1, logic: "and", items: [] } });
  assert.equal((await admin.post(`/api/admin/talent-filters/${own.data.filter.id}/members`, { action: "include", userIds: [emp["TF-IN"]] })).data.code, "members_not_supported");
});

test("succession bulk: out-of-scope person rejects the whole batch; already listed is skipped", async () => {
  const before = (await admin.get("/api/admin/succession")).data.length;
  const rej = await scopedTP.post("/api/admin/succession/bulk", { positionName: "Ops Head", userIds: [emp["TF-IN"], emp["TF-OUT"]], readiness: "ready" });
  assert.equal(rej.status, 404);
  assert.equal(rej.data.code, "out_of_scope");
  assert.equal((await admin.get("/api/admin/succession")).data.length, before, "nothing written");
  const ok = await scopedTP.post("/api/admin/succession/bulk", { positionName: "Ops Head", userIds: [emp["TF-IN"]], readiness: "oneYear", note: "From filter" });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.created, 1);
  const again = await scopedTP.post("/api/admin/succession/bulk", { positionName: "  ops   head ", userIds: [emp["TF-IN"], emp["TF-KID"]], readiness: "ready" });
  assert.equal(again.data.created, 1);
  assert.deepEqual(again.data.skipped, [{ userId: emp["TF-IN"], employeeId: "TF-IN", code: "already_listed" }]);
  assert.equal(again.data.positionName, "Ops Head", "position name merged to the existing spelling");
  const rows = (await admin.get("/api/admin/succession")).data.filter((r) => r.positionName === "Ops Head");
  assert.equal(rows.length, 2);
  assert.ok(rows.every((r) => r.source === "filter" && r.createdBy));
});

test("succession import: preview, preview_stale when data changes, out-of-scope rejects, then import", async () => {
  const rows = [
    { line: 2, positionName: "Field Lead", employeeId: "TF-MINOR", name: "", readiness: "即刻就绪", note: "" },
    { line: 3, positionName: "Field Lead", employeeId: "TF-NOPE", name: "", readiness: "ready", note: "" },
  ];
  const p = await scopedTP.post("/api/admin/succession/import/preview", { rows });
  assert.equal(p.status, 200);
  assert.deepEqual(p.data.summary, { create: 1, update: 0, unchanged: 0, error: 1 });
  assert.ok(p.data.rows.find((r) => r.line === 3).codes.some((c) => c.code === "employee_not_found"));
  // 预览之后有人单条录入了同一（岗位，继任人）→ 动作从 create 变 update → 哈希不同 → 409
  assert.equal((await admin.post("/api/admin/succession", { positionName: "Field Lead", userId: emp["TF-MINOR"], readiness: "twoYears" })).status, 200);
  const stale = await scopedTP.post("/api/admin/succession/import", { rows, previewHash: p.data.previewHash });
  assert.equal(stale.status, 409);
  assert.equal(stale.data.code, "preview_stale");
  const p2 = await scopedTP.post("/api/admin/succession/import/preview", { rows });
  assert.equal(p2.data.summary.update, 1);
  const done = await scopedTP.post("/api/admin/succession/import", { rows, previewHash: p2.data.previewHash });
  assert.equal(done.status, 200);
  assert.deepEqual(done.data, { created: 0, updated: 1, unchanged: 0, skipped: 1 });
  const r = (await admin.get("/api/admin/succession")).data.find((x) => x.positionName === "Field Lead" && x.userId === emp["TF-MINOR"]);
  assert.equal(r.readiness, "ready");
  // 有一行在范围外：预览逐行标出，提交整批拒绝（一行都不写）
  const outRows = [{ line: 2, positionName: "Field Lead", employeeId: "TF-KID", readiness: "ready" }, { line: 3, positionName: "Field Lead", employeeId: "TF-OUT", readiness: "ready" }];
  const po = await scopedTP.post("/api/admin/succession/import/preview", { rows: outRows });
  assert.ok(po.data.rows.find((x) => x.line === 3).codes.some((c) => c.code === "employee_out_of_scope"));
  assert.equal(po.data.rows.find((x) => x.line === 3).name, "", "out-of-scope row echoes only what was typed");
  const rej = await scopedTP.post("/api/admin/succession/import", { rows: outRows, previewHash: po.data.previewHash });
  assert.equal(rej.status, 404);
  assert.equal(rej.data.outOfScope, 1);
  assert.equal((await admin.get("/api/admin/succession")).data.some((x) => x.positionName === "Field Lead" && x.userId === emp["TF-KID"]), false);
  const over = await scopedTP.post("/api/admin/succession/import/preview", { rows: Array.from({ length: 2001 }, (_, i) => ({ line: i + 2, positionName: "X", employeeId: "TF-IN", readiness: "ready" })) });
  assert.equal(over.status, 400);
  assert.equal(over.data.code, "over_cap");
});

test("export: needs employee-profile read (403 export_forbidden); CSV with BOM, a conditions line and only scoped people", async () => {
  const def = { v: 1, logic: "and", items: [{ field: "tenureMonths", op: "gte", value: 12 }] };
  const denied = await scopedT.post("/api/admin/talent-filters/export", { definition: def, lang: "zh" });
  assert.equal(denied.status, 403);
  assert.equal(denied.data.code, "export_forbidden");
  const res = await scopedTP.raw("POST", "/api/admin/talent-filters/export", { definition: def, columns: ["name", "employeeId", "department"], lang: "zh" });
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /text\/csv/);
  assert.match(res.headers.get("content-disposition"), /talent-filter-adhoc-\d{8}\.csv/);
  const bytes = Buffer.from(await res.arrayBuffer());
  assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  const text = bytes.subarray(3).toString("utf8");
  assert.ok(text.startsWith("# 条件："), text.slice(0, 40));
  assert.ok(text.includes("TF-IN"));
  assert.equal(text.includes("TF-OUT"), false);
  const logs = await admin.get("/api/admin/audit?action=export.talent-filter");
  if (logs.status === 200 && Array.isArray(logs.data.rows || logs.data)) assert.ok((logs.data.rows || logs.data).length >= 1);
});

test("AI filter drafting (demo): conditions come back for HR to review; text is validated", async () => {
  assert.equal((await scopedTP.post("/api/admin/talent-filters/ai-parse", { text: "" })).data.code, "text_required");
  assert.equal((await scopedTP.post("/api/admin/talent-filters/ai-parse", { text: "x".repeat(501) })).data.code, "text_too_long");
  const r = await scopedTP.post("/api/admin/talent-filters/ai-parse", { text: "最近一期绩效 A 以上，司龄满 2 年，无违纪", lang: "zh" });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.demo, true);
  const fields = r.data.filter.items.map((l) => l.field);
  assert.ok(fields.includes("perfRecent") && fields.includes("tenureMonths"), JSON.stringify(r.data.filter));
  assert.equal(r.data.filter.items.find((l) => l.field === "tenureMonths").value, 24);
  assert.ok(Array.isArray(r.data.choices) && Array.isArray(r.data.unsupported));
  // 生成的条件能直接运行（与手工条件同一个校验）
  assert.equal((await scopedTP.post("/api/admin/talent-filters/run", { definition: r.data.filter })).status, 200);
  // 只有 talent 读权限的角色不能调用（按写判定）
  const ro = await makeAdminUser("TF-A-RO", await makeRole("TF Talent Read", { talent: "read" }));
  assert.equal((await ro.post("/api/admin/talent-filters/ai-parse", { text: "高潜" })).status, 403);
  assert.equal((await ro.post("/api/admin/talent-filters/run", { definition: { v: 1, logic: "and", items: [] } })).status, 200, "run is read-only");
  assert.equal((await ro.post("/api/admin/talent-filters", { name: "RO", definition: { v: 1, logic: "and", items: [] } })).status, 403);
});
