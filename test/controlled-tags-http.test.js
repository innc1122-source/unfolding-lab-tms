// 12.2 受控人才标签（设计 b12-design 第 5 节、§13）HTTP 契约：
//   · POST /api/admin/employees/:id/controlled-tags：add / remove / 重复动作 unchanged（不写事件与审计）/ 理由 4–300 字 /
//     talent 只读 403、没有 talent 404 / 范围外 404；每次有效动作恰好一条事件与一条审计；
//   · PUT /api/admin/employees/:id 的 talentTags：改受控集合 → 400 controlled_tags_use_endpoint；自由标签写「HiPo」→ 400 tag_reserved；
//     受控集合不变、只改自由标签 → 200；
//   · 后台档案时间线：talent 可读者有 tag 事件，没有 talent 读的看不到；本人看自己不给「流失风险」标签与事件；
//   · 「流失风险」对直属上级（GET /api/me/reports/:id）与员工本人（/api/me、/api/me/growth）都不可见；HR 可见；
//   · 人才筛选按「高潜 HiPo」筛选照常命中；组织诊断的高潜人数只计受控标签，与工作台部门健康度的高潜人数一致；
//   · store.updateUser 直写受控差异 → source = script 的事件（演示脚本等路径不绕过留痕）。
"use strict";
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { spawnSync } = require("child_process");
const { DatabaseSync } = require("node:sqlite");
const { ADMIN, startServer, loginAs, ROOT } = require("./helpers.js");

let srv, admin;
const dept = {}, emp = {}, cli = {};
const HIPO = "高潜 HiPo", KEY = "关键人才 Key talent", FLIGHT = "流失风险 Flight risk";
const db = (fn) => { const d = new DatabaseSync(srv.dbPath, { readOnly: true }); try { return fn(d); } finally { d.close(); } };
const events = (uid) => db((d) => d.prepare("SELECT * FROM talent_tag_events WHERE userId = ? ORDER BY at, id").all(uid).map((r) => ({ ...r })));
const audits = (action) => db((d) => d.prepare("SELECT * FROM audit_logs WHERE action = ? ORDER BY id").all(action).map((r) => ({ ...r })));
const tags = (uid) => db((d) => JSON.parse(d.prepare("SELECT talentTags FROM users WHERE id = ?").get(uid).talentTags || "[]"));

async function makeRole(name, grants, scope) {
  const r = await admin.post("/api/admin/roles", { name, name_zh: name, grants, ...(scope ? { scope } : {}) });
  assert.equal(r.status, 200, "create role " + name);
  return r.data.role.id;
}
async function makeEmployee(empId, patch, login) {
  const created = await admin.post("/api/admin/employees", { name: "Name " + empId, employeeId: empId });
  assert.equal(created.status, 200, "create " + empId);
  const u = (await admin.get("/api/admin/roster")).data.find((x) => x.employeeId === empId);
  emp[empId] = u.id;
  if (patch) assert.equal((await admin.put("/api/admin/employees/" + u.id, patch)).status, 200, "patch " + empId);
  if (login) {
    const c = await loginAs(srv.base, { employeeId: empId, password: created.data.password });
    assert.equal((await c.post("/api/auth/change-password", { currentPassword: created.data.password, newPassword: empId + "-pw-2026" })).status, 200);
    cli[empId] = c;
  }
  return u.id;
}
const tagIt = (c, empId, tag, action, reason) => c.post(`/api/admin/employees/${emp[empId]}/controlled-tags`, { tag, action, reason });

before(async () => {
  srv = await startServer();
  admin = await loginAs(srv.base, ADMIN);
  for (const name of ["CT Root", "CT Other"]) {
    const r = await admin.post("/api/admin/departments", { name });
    assert.equal(r.status, 200);
    dept[name] = r.data.department.id;
  }
  await makeEmployee("CT-MGR", { department: "CT Root", jobLevel: "MB2", position: "Ops Manager", hireDate: "2020-01-01" }, true);
  await makeEmployee("CT-EMP", { department: "CT Root", jobLevel: "PB2", position: "Ops Analyst", hireDate: "2021-01-01", managerId: emp["CT-MGR"] }, true);
  await makeEmployee("CT-OUT", { department: "CT Other", jobLevel: "PB2", position: "Ops Analyst", hireDate: "2021-01-01" });
  await makeEmployee("CT-FREE", { department: "CT Root", jobLevel: "PB2", position: "Ops Analyst", hireDate: "2021-01-01" });
  const scope = { departments: [{ id: dept["CT Root"], includeChildren: true }] };
  const roles = {
    "CT-A-SCOPED": await makeRole("CT Scoped Talent", { talent: "manage", people: "manage" }, scope),
    "CT-A-TREAD": await makeRole("CT Talent Read", { talent: "read", people: "read" }),
    "CT-A-PEOPLE": await makeRole("CT People Only", { people: "read" }),
    "CT-A-LEARN": await makeRole("CT Learning", { learning: "manage", people: "read" }),
  };
  for (const [empId, roleId] of Object.entries(roles)) {
    await makeEmployee(empId, { department: "CT Root" }, true);
    assert.equal((await admin.put("/api/admin/employees/" + emp[empId], { adminRoleId: roleId })).status, 200);
  }
});
after(() => srv.stop());

test("add / remove / unchanged / reason rules; one event and one audit per effective action", async () => {
  for (const reason of ["abc", "   ab   ", "", "x".repeat(301)]) {
    const r = await tagIt(admin, "CT-EMP", "hipo", "add", reason);
    assert.equal(r.status, 400, "reason " + JSON.stringify(reason));
    assert.equal(r.data.code, "reason_required");
  }
  assert.equal((await tagIt(admin, "CT-EMP", "nope", "add", "Strong results")).data.code, "bad_tag");
  assert.equal((await tagIt(admin, "CT-EMP", "hipo", "toggle", "Strong results")).data.code, "bad_tag");
  assert.equal(events(emp["CT-EMP"]).length, 0, "rejected requests write nothing");

  const a = await tagIt(admin, "CT-EMP", "hipo", "add", "  Two quarters of A ratings  ");
  assert.equal(a.status, 200, JSON.stringify(a.data));
  assert.deepEqual(a.data.talentTags, [HIPO]);
  assert.deepEqual(tags(emp["CT-EMP"]), [HIPO]);
  let ev = events(emp["CT-EMP"]);
  assert.equal(ev.length, 1);
  assert.deepEqual([ev[0].tagKey, ev[0].action, ev[0].source, ev[0].reason], ["hipo", "add", "manual", "Two quarters of A ratings"], "reason stored trimmed");
  assert.ok(ev[0].actorId && ev[0].actorName, "actor recorded");
  assert.match(ev[0].effectiveOn, /^\d{4}-\d{2}-\d{2}$/, "effective date = today");
  assert.equal(audits("talent.tag.add").length, 1);
  assert.deepEqual(JSON.parse(audits("talent.tag.add")[0].afterJson), { tag: HIPO, reason: "Two quarters of A ratings" });

  const again = await tagIt(admin, "CT-EMP", "hipo", "add", "Same again");
  assert.equal(again.status, 200);
  assert.equal(again.data.unchanged, true, "holding it already → unchanged");
  const noop = await tagIt(admin, "CT-EMP", "key", "remove", "Not held anyway");
  assert.equal(noop.data.unchanged, true, "not held → unchanged");
  assert.equal(events(emp["CT-EMP"]).length, 1, "unchanged writes no event");
  assert.equal(audits("talent.tag.add").length, 1, "unchanged writes no audit");
  assert.equal(audits("talent.tag.remove").length, 0);

  assert.equal((await tagIt(admin, "CT-EMP", "key", "add", "Critical knowledge holder")).status, 200);
  const rm = await tagIt(admin, "CT-EMP", "key", "remove", "Role changed");
  assert.equal(rm.status, 200);
  assert.deepEqual(rm.data.talentTags, [HIPO]);
  ev = events(emp["CT-EMP"]);
  assert.deepEqual(ev.map((e) => [e.tagKey, e.action]), [["hipo", "add"], ["key", "add"], ["key", "remove"]]);
  assert.equal(audits("talent.tag.remove").length, 1);
});

test("permissions: talent read-only → 403, no talent → 404, out of scope → 404 (nothing written)", async () => {
  const before = events(emp["CT-OUT"]).length + events(emp["CT-FREE"]).length;
  assert.equal((await tagIt(cli["CT-A-TREAD"], "CT-FREE", "hipo", "add", "Read only tries")).status, 403);
  assert.equal((await tagIt(cli["CT-A-LEARN"], "CT-FREE", "hipo", "add", "Learning admin tries")).status, 404);
  assert.equal((await tagIt(cli["CT-A-PEOPLE"], "CT-FREE", "hipo", "add", "People reader tries")).status, 404);
  const out = await tagIt(cli["CT-A-SCOPED"], "CT-OUT", "hipo", "add", "Outside my scope");
  assert.equal(out.status, 404, "out of scope looks like not found");
  assert.equal((await admin.post("/api/admin/employees/u-nobody/controlled-tags", { tag: "hipo", action: "add", reason: "Nobody here" })).status, 404);
  assert.equal(events(emp["CT-OUT"]).length + events(emp["CT-FREE"]).length, before, "nothing written");
  const ok = await tagIt(cli["CT-A-SCOPED"], "CT-FREE", "key", "add", "In my scope");
  assert.equal(ok.status, 200, "talent manage inside the scope may tag");
});

test("PUT talentTags: the controlled set can't change there; reserved spellings are rejected; free tags still editable", async () => {
  const id = emp["CT-EMP"];
  const drop = await admin.put("/api/admin/employees/" + id, { talentTags: [] });
  assert.equal(drop.status, 400);
  assert.equal(drop.data.code, "controlled_tags_use_endpoint");
  const sneak = await admin.put("/api/admin/employees/" + id, { talentTags: [HIPO, FLIGHT] });
  assert.equal(sneak.data.code, "controlled_tags_use_endpoint", "adding a controlled tag through PUT is refused");
  const reserved = await admin.put("/api/admin/employees/" + id, { talentTags: [HIPO, "HiPo"] });
  assert.equal(reserved.status, 400);
  assert.equal(reserved.data.code, "tag_reserved");
  assert.equal(reserved.data.field, "HiPo");
  assert.equal((await admin.put("/api/admin/employees/" + id, { talentTags: [HIPO, "Hi-Po"] })).data.code, "tag_reserved");
  const ok = await admin.put("/api/admin/employees/" + id, { talentTags: [HIPO, "Mobile", "高潜 HiPo（2025）"] });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.deepEqual(tags(id), [HIPO, "Mobile", "高潜 HiPo（2025）"], "free tags saved; a non-mappable look-alike stays a free tag");
  assert.equal(events(id).length, 3, "PUT writes no tag event");
});

test("profile timeline: tag events for talent readers only; flight risk hidden from the person themself", async () => {
  assert.equal((await tagIt(admin, "CT-EMP", "flight", "add", "Competing offer reported")).status, 200);
  const evOf = async (c, empId) => {
    const r = await c.get(`/api/admin/employees/${emp[empId]}/profile`);
    assert.equal(r.status, 200);
    return { tagsShown: r.data.user.talentTags, ev: r.data.events.filter((e) => e.source === "tag") };
  };
  const hr = await evOf(admin, "CT-EMP");
  assert.deepEqual(hr.ev.map((e) => e.tagKey).sort(), ["flight", "hipo", "key", "key"]);
  const fl = hr.ev.find((e) => e.tagKey === "flight");
  assert.equal(fl.reason, "Competing offer reported");
  assert.equal(fl.type, "tag");
  assert.equal(fl.dateUnknown, false);
  assert.ok(hr.tagsShown.includes(FLIGHT), "HR sees the flight-risk tag");
  const reader = await evOf(cli["CT-A-TREAD"], "CT-EMP");
  assert.equal(reader.ev.length, 4, "talent read sees the events");
  const peopleOnly = await evOf(cli["CT-A-PEOPLE"], "CT-EMP");
  assert.equal(peopleOnly.ev.length, 0, "no talent read → no tag events");

  // 本人：给范围受限的人才管理员本人打上流失风险，他看自己的后台档案
  assert.equal((await tagIt(admin, "CT-A-SCOPED", "flight", "add", "Retention interview flagged")).status, 200);
  assert.equal((await tagIt(admin, "CT-A-SCOPED", "hipo", "add", "Strong leadership signals")).status, 200);
  const self = await evOf(cli["CT-A-SCOPED"], "CT-A-SCOPED");
  assert.deepEqual(self.tagsShown, [HIPO], "own flight-risk tag hidden");
  assert.deepEqual(self.ev.map((e) => e.tagKey), ["hipo"], "own flight-risk event hidden");
  const roster = (await cli["CT-A-SCOPED"].get("/api/admin/roster")).data;
  assert.ok(Array.isArray(roster));
  const meRow = (await cli["CT-A-SCOPED"].get("/api/admin/employees")).data;
  const mine = (Array.isArray(meRow) ? meRow : meRow.rows || []).find((x) => x.id === emp["CT-A-SCOPED"]);
  if (mine) assert.equal(JSON.stringify(mine).includes(FLIGHT), false, "own roster row without flight risk");
  // 本人保存自己的资料（带回看到的标签）不算改动受控集合
  const put = await cli["CT-A-SCOPED"].put("/api/admin/employees/" + emp["CT-A-SCOPED"], { talentTags: [HIPO, "Mentor"] });
  assert.equal(put.status, 200, JSON.stringify(put.data));
  assert.deepEqual(tags(emp["CT-A-SCOPED"]), [HIPO, "Mentor", FLIGHT], "the hidden flight-risk tag is preserved");
  assert.equal(JSON.stringify(put.data).includes(FLIGHT), false);
});

test("flight risk never reaches the line manager or the employee; HiPo and key talent still do for the manager", async () => {
  assert.ok(tags(emp["CT-EMP"]).includes(FLIGHT), "precondition: the employee holds flight risk");
  const mv = await cli["CT-MGR"].get("/api/me/reports/" + emp["CT-EMP"]);
  assert.equal(mv.status, 200, JSON.stringify(mv.data));
  assert.ok(mv.data.user.talentTags.includes(HIPO), "manager still sees HiPo");
  assert.equal(JSON.stringify(mv.data).includes(FLIGHT), false, "manager view: no flight risk anywhere");
  assert.equal(JSON.stringify(mv.data).toLowerCase().includes("flight"), false);
  for (const p of ["/api/me", "/api/me/growth", "/api/me/reviews"]) {
    const r = await cli["CT-EMP"].get(p);
    assert.equal(r.status, 200, p);
    assert.equal(JSON.stringify(r.data).includes(FLIGHT), false, p + ": no flight risk for the employee");
    assert.equal(JSON.stringify(r.data).includes("流失风险"), false, p);
  }
  // 员工端没有后台档案
  assert.equal((await cli["CT-EMP"].get(`/api/admin/employees/${emp["CT-EMP"]}/profile`)).status === 200, false);
});

test("talent filter by 高潜 HiPo still matches; org diagnostics and the workbench count only the controlled tag", async () => {
  const run = await admin.post("/api/admin/talent-filters/run", { definition: { v: 1, logic: "and", items: [{ field: "talentTag", op: "anyOf", value: [HIPO] }] }, columns: ["name", "employeeId"], pageSize: 200 });
  assert.equal(run.status, 200, JSON.stringify(run.data));
  const hit = run.data.rows.map((r) => r.employeeId);
  assert.ok(hit.includes("CT-EMP"));
  assert.equal(hit.includes("CT-FREE"), false);
  // CT-FREE 只有自由标签「高潜 HiPo（2025）」：旧正则 /高潜|hipo/ 会把他算成高潜
  assert.equal((await admin.put("/api/admin/employees/" + emp["CT-FREE"], { talentTags: [KEY, "高潜 HiPo（2025）"] })).status, 200);
  const diag = await admin.get("/api/admin/org-diagnostics");
  assert.equal(diag.status, 200);
  const holders = db((d) => d.prepare("SELECT id, talentTags, active, empStatus FROM users WHERE role <> 'admin'").all())
    .filter((u) => u.active !== 0 && u.empStatus !== "exited" && JSON.parse(u.talentTags || "[]").includes(HIPO)).length;
  assert.equal(diag.data.talent.hipo, holders, "org diagnostics counts exact controlled holders");
  const wb = await admin.get("/api/admin/workbench/structure");
  assert.equal(wb.status, 200);
  assert.equal(wb.data.deptHealth.total.cells.hipo.num, diag.data.talent.hipo, "workbench HiPo count equals org diagnostics");
});

test("store.updateUser fallback: a direct write that changes the controlled set leaves a source=script event", async () => {
  await srv.stopAsync();
  const id = emp["CT-OUT"];
  const script = `
    process.env.LMS_DB_PATH = ${JSON.stringify(srv.dbPath)};
    const store = require(${JSON.stringify(path.join(ROOT, "store.js"))});
    const ev = require(${JSON.stringify(path.join(ROOT, "kernel", "events.js"))});
    store.init({ hashPassword: (p) => "x:" + p });
    ev.runWithContext({ actorId: "u-admin", requestId: "r-script" }, () => store.updateUser(${JSON.stringify(id)}, { talentTags: ["Key talent", "Mentor"] }));
    store.updateUser(${JSON.stringify(id)}, { talentTags: ["关键人才 Key talent", "Mentor", "Coach"] });
    store.updateUser(${JSON.stringify(id)}, { talentTags: ["Coach"] });
    store.close();`;
  const r = spawnSync(process.execPath, ["-e", script], { cwd: ROOT, encoding: "utf8", env: { ...process.env, LMS_CONFIG_PATH: path.join(path.dirname(srv.dbPath), "config.json") } });
  assert.equal(r.status, 0, r.stderr);
  const ev = events(id);
  assert.deepEqual(ev.map((e) => [e.tagKey, e.action, e.source, e.actorId]), [["key", "add", "script", "u-admin"], ["key", "remove", "script", null]],
    "add (with the request actor) and remove (system); the free-tag-only edit in between writes nothing");
  assert.equal(ev[0].reason, "未经受控标签入口写入");
  assert.deepEqual(tags(id), ["Coach"]);
});
