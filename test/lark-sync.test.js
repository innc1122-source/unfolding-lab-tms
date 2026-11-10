// Masterlist Base → TMS 组织与员工同步（modules/core/larksync.js，2026-09-30）：
//   · 部门：L3 起为一级部门，L3 以下逐级挂父级；直接挂在 L0–L2 的人所在节点单独作一级部门；负责人 = pic；
//   · 员工：Active Employees 的每个 EID；部门优先 Lark 部门、否则 BIPO 末级名；上级优先 Lark 上级、否则部门负责人（逐级往上）；
//   · 无 EID 的 Lark 账号：Active、非 Function ID、邮箱不以 csc/smb 开头 → 建 LK-<user_id> 账号；
//   · Lark user_id 登记到 users.larkUserId（登录回调据此放行）；名单外的同步管理账号停用、踢下线，回到名单后重新启用；
//   · 预览不写库、重复执行无变更、超过停用上限时整批不停用；后台接口只给超级管理员。
// 进程内驱动真实 store（临时库），HTTP 部分经 test/helpers.js 起临时实例。
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lark-sync-"));
process.env.LMS_DB_PATH = path.join(TMP, "sync.db");
process.env.LMS_ATTACH_DIR = path.join(TMP, "attachments");
process.env.LMS_CONFIG_PATH = path.join(TMP, "config.json");
const store = require("../store.js");
const larksync = require("../modules/core/larksync.js");
const orgLib = require("../modules/core/org.js");
const { startServer, loginAs, makeClient, ADMIN } = require("./helpers.js");

store.init({ hashPassword: (pw) => "test-hash:" + pw });
test.after(() => { try { store.close(); } catch {} try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {} });

const deps = { store, hashPassword: (pw) => "test-hash:" + pw, newToken: () => Math.random().toString(36).slice(2) };
const CFG = { minEmployees: 1, maxDeactivate: 5 };

// ---- 夹具（OpenAPI 返回形状：文本 lookup 为 [{text}]，关联为 [{record_ids}]）----
const org = (rec, did, name, parent, pic) => ({ _record_id: rec, department_id: did, name, parent_department_id: parent, pic_id: pic || null, is_active: "Yes" });
const ORGS = [
  org("r0", "d0", "DigiPlus", "0"),
  org("r1", "d1", "Core Operations Group", "d0", "ou_ceo"),
  org("r2", "d2", "Retail Offline Business Unit", "d1", "ou_ceo"),
  org("r3", "d3", "Retail Offline Operations Management Department", "d2", "ou_head"),
  org("r4", "d4", "Branch Operations Group", "d3", "ou_lead"),
  org("r5", "d5", "Finance Department", "d2", "ou_fin"),
  { ...org("r6", "d6", "Closed Department", "d2"), is_active: "No" },
];
const acct = (o) => ({
  EID: o.eid || null, user_id: o.uid, open_id: "ou_" + o.uid, name: o.name, email: o.email || o.uid + "@digiplus.com.ph",
  status: o.status || "Active", nationality_status: o.nat || "Local", employee_type: o.type || "Regular", job_title: o.title || "",
  department_ids: [{ record_ids: [o.dept], table_id: "tbllEK0velRUh0Uz", text: "", type: "text" }],
  leader_user_id: o.leader ? "ou_" + o.leader : null, leader_EID: null,
});
const ACCOUNTS = [
  acct({ eid: "1001", uid: "ceo", name: "Tommy", dept: "r2" }),                       // 直接挂 L2 → 该节点单独作一级部门
  acct({ eid: "1002", uid: "head", name: "Dennis", dept: "r3", leader: "ceo" }),
  acct({ eid: "1003", uid: "lead", name: "Lea", dept: "r4", leader: "head" }),
  acct({ eid: "1004", uid: "emp", name: "Emp", dept: "r4", leader: "lead" }),
  acct({ eid: "1006", uid: "fin", name: "Fin", dept: "r5", leader: "ceo" }),
  acct({ uid: "cons", name: "Consultant", dept: "r5", type: "Consultant" }),         // 无 EID、放行
  acct({ uid: "func", name: "Branch A - Cashier", dept: "r4", nat: "Function ID" }),  // Function ID → 排除
  acct({ uid: "cscx", name: "CSC 1", dept: "r4", email: "csc01@digiplus.com.ph" }),  // csc 开头 → 排除
  acct({ uid: "gone", name: "Left", dept: "r4", status: "Inactive" }),               // Inactive → 排除
  acct({ eid: "1099", uid: "notbipo", name: "Not in BIPO", dept: "r4" }),            // 有 EID 但不在 Active Employees → 不同步
];
// Master list 形状：Department Details 为 lookup 文本，日期为毫秒时间戳，Email 为超链接
const ms = (d) => Date.parse(d + "T00:00:00+08:00");
const emp = (eid, name, pathStr, title, extra = {}) => ({
  EID: eid, "Employee Name": name, "Department Details": [{ text: pathStr, type: "text" }], Designation: title || "STAFF",
  "Job Rank (Original)": extra.rank || "PD2", "Join Date": ms(extra.join || "2025-01-02"), "Birth Date": ms(extra.birth || "1990-05-17"),
  "Employment Type": extra.type || "PERMANENT", "Employment Status": extra.status || "REGULAR", "Exit Date": extra.exit ? ms(extra.exit) : null,
  Email: { link: "mailto:" + eid + "@x.ph", text: eid + "@x.ph" }, "Mobile Phone": "0917" + eid,
});
const EMPLOYEES = [
  emp("1001", "TOMMY, TOMMY", "Retail Offline Business Unit", "CEO"),
  emp("1002", "DENNIS, D", "Retail Offline Business Unit-Retail Offline Operations Management Department", "HEAD"),
  emp("1003", "LEA, L", "Retail Offline Business Unit-Retail Offline Operations Management Department-Branch Operations Group", "LEAD"),
  emp("1004", "EMP, E", "Retail Offline Business Unit-Retail Offline Operations Management Department-Branch Operations Group", "CASHIER"),
  emp("1005", "NOLARK, N", "Retail Offline Business Unit-Retail Offline Operations Management Department-Branch Operations Group", "CASHIER"),
  emp("1006", "FIN, F", "Retail Offline Business Unit-Finance Department", "ANALYST", { rank: "MB1", status: "PROBATIONARY" }),
  emp("1008", "EXITED, X", "Retail Offline Business Unit-Finance Department", "ANALYST", { exit: "2026-09-01" }),     // 离职 → 不读
  emp("1009", "AGENCY, A", "Retail Offline Business Unit-Finance Department", "GUARD", { type: "AGENCY - OUTSOURCED" }), // agency → 不读
  emp("1010", "LEAVING, L", "Retail Offline Business Unit-Finance Department", "ANALYST", { exit: "2099-12-31" }),   // 离职日在将来 → 仍在职
];
const SRC = (over = {}) => ({ orgs: ORGS, employees: EMPLOYEES, accounts: ACCOUNTS, ...over });
const user = (eid) => store.getUserByEmployeeId(eid);
const dept = (name) => store.getDepartmentByName(name);

test("setup: pre-existing roster (one leaver, a legacy department, the admin)", () => {
  store.ensureDepartment("Legacy Division", null);
  store.createUser({ id: "u-1004", employeeId: "1004", name: "EMP, E", role: "employee", passwordHash: "x", department: "Legacy Division", mustChangePassword: 1, empStatus: "regular" });
  store.createUser({ id: "u-1007", employeeId: "1007", name: "LEAVER, L", role: "employee", passwordHash: "x", department: "Legacy Division", mustChangePassword: 1, empStatus: "regular" });
  store.createSession("tok-1007", "u-1007");
  assert.ok(store.getSessionUser("tok-1007"));
});

test("dry run changes nothing", () => {
  const before = store.listUsers().length;
  const rep = larksync.applyPlan(larksync.buildPlan(SRC(), CFG), deps, { dryRun: true, cfg: CFG });
  assert.equal(rep.dryRun, true);
  assert.ok(rep.usersCreated.length > 0);
  assert.equal(store.listUsers().length, before);
  assert.equal(dept("Branch Operations Group"), null);
  assert.equal(store.getMeta("larksync.lastReport"), null, "dry run does not replace the last report");
});

test("apply: the whole Lark tree is kept (L0–L2 as group layers); level-1 departments start at L3", () => {
  const plan = larksync.buildPlan(SRC(), CFG);
  assert.deepEqual(plan.stats.larkOnlyExcluded, { inactive: 1, functionId: 1, cscSmb: 1 });
  assert.deepEqual(plan.stats.skipped, { exited: 1, agency: 1 });
  larksync.applyPlan(plan, deps, { cfg: CFG });
  const roomd = dept("Retail Offline Operations Management Department");
  const branch = dept("Branch Operations Group");
  const bu = dept("Retail Offline Business Unit");
  const cog = dept("Core Operations Group");
  const root = dept("DigiPlus");
  assert.equal(root.parentId, null, "DigiPlus is the root, as in the org chart");
  assert.equal(cog.parentId, root.id);
  assert.equal(bu.parentId, cog.id);
  assert.equal(roomd.parentId, bu.id, "L3 keeps its real parent");
  assert.equal(branch.parentId, roomd.id, "L4 hangs under its L3");
  const groups = store.listDepartments(true).filter((d) => d.group).map((d) => d.name).sort();
  assert.deepEqual(groups, ["Core Operations Group", "DigiPlus", "Retail Offline Business Unit"], "L0–L2 are group layers");
  const idx = orgLib.buildOrgIndex(store.listDepartments(true));
  assert.equal(idx.levelsOf("Branch Operations Group").level1, "Retail Offline Operations Management Department", "level 1 = L3");
  assert.equal(idx.levelsOf("Branch Operations Group").level2, "Branch Operations Group");
  assert.equal(idx.levelsOf("Finance Department").isDirect, true);
  assert.equal(idx.levelsOf("Retail Offline Business Unit").level1, "Retail Offline Business Unit", "people sitting on a group layer: that node is their level 1");
  const hodRows = orgLib.deriveHods(store.listDepartments(true), store.listUsers()).items.map((it) => it.deptName).sort();
  for (const n of ["Finance Department", "Retail Offline Business Unit", "Retail Offline Operations Management Department"]) assert.ok(hodRows.includes(n), "HoD list has " + n);
  for (const n of ["DigiPlus", "Core Operations Group", "Branch Operations Group"]) assert.ok(!hodRows.includes(n), "HoD list has no row for " + n);
  assert.equal(dept("Closed Department"), null, "inactive Lark departments are skipped");
  assert.equal(roomd.ownerId, user("1002").id, "owner = pic");
  assert.equal(branch.ownerId, user("1003").id);
  assert.equal(dept("Legacy Division").active, 0, "emptied legacy department is deactivated");
});

test("apply: people, managers, Lark ids, Lark-only accounts, leavers", () => {
  assert.equal(user("1004").department, "Branch Operations Group", "moved off the legacy department");
  assert.equal(user("1004").managerId, user("1003").id, "Lark leader");
  assert.equal(user("1003").managerId, user("1002").id);
  assert.equal(user("1002").managerId, user("1001").id);
  assert.equal(user("1001").department, "Retail Offline Business Unit");
  assert.equal(user("1001").managerId, null);
  const nolark = user("1005");
  assert.equal(nolark.department, "Branch Operations Group", "no Lark account → BIPO leaf name");
  assert.equal(nolark.managerId, user("1003").id, "no Lark account → department owner");
  assert.equal(nolark.larkUserId, null);
  assert.equal(nolark.mustChangePassword, 1);
  assert.equal(user("1004").larkUserId, "emp");
  const lkNames = larksync.larkNames(store);
  assert.equal(lkNames[user("1004").id], "Emp", "Lark display name kept (meta larksync.larkNames)");
  assert.equal(user("1004").name, "EMP, E", "the BIPO name stays the name");
  assert.equal(lkNames[nolark.id], undefined, "no Lark account → no Lark name");
  assert.equal(lkNames[user("LK-cons").id], "Consultant");
  const lk = user("LK-cons");
  assert.ok(lk, "Lark-only account created");
  assert.equal(lk.larkUserId, "cons");
  assert.equal(lk.department, "Finance Department");
  assert.equal(lk.managerId, user("1006").id, "Lark-only without leader → department owner");
  assert.equal(lk.mustChangePassword, 0);
  for (const k of ["LK-func", "LK-cscx", "LK-gone", "1099", "1008", "1009"]) assert.equal(user(k), null, k + " is not synced");
  assert.ok(user("1010"), "exit date in the future is still active");
  const fin = user("1006");
  assert.equal(fin.jobLevel, "MB1", "job level = Job Rank");
  assert.equal(fin.empStatus, "probation");
  assert.equal(fin.hireDate, "2025-01-02");
  assert.equal(fin.email, "1006@x.ph");
  assert.equal(fin.phone, "09171006");
  assert.equal(fin.passwordHash, "test-hash:19900517", "new hire's initial password = birth date");
  assert.equal(user("1004").jobLevel, "PD2", "existing user's job level is replaced by Job Rank");
  assert.equal(user("1007").active, 0, "leaver deactivated");
  assert.equal(store.getSessionUser("tok-1007"), null, "and signed out");
  assert.equal(user("ADMIN").active, 1, "admin untouched");
});

test("second run is a no-op", () => {
  const rep = larksync.applyPlan(larksync.buildPlan(SRC(), CFG), deps, { cfg: CFG });
  const s = larksync.summary(rep);
  for (const k of ["created", "updated", "transferred", "managerChanged", "deactivated", "reactivated", "deptsCreated", "deptsRenamed", "deptsMoved", "ownersChanged", "larkLinked", "larkNames"]) assert.equal(s[k], 0, k);
});

test("rename in Lark renames the TMS department (members follow); leaver returns → reactivated", () => {
  const orgs = ORGS.map((o) => (o.department_id === "d4" ? { ...o, name: "Branch Ops" } : o));
  const rep = larksync.applyPlan(larksync.buildPlan(SRC({ orgs, employees: [...EMPLOYEES, emp("1007", "LEAVER, L", "Retail Offline Business Unit-Finance Department")] }), CFG), deps, { cfg: CFG });
  assert.deepEqual(rep.deptsRenamed, ["Branch Operations Group → Branch Ops"]);
  assert.equal(user("1004").department, "Branch Ops");
  assert.equal(user("1007").active, 1);
  assert.equal(user("1007").department, "Finance Department");
});

test("more leavers than maxDeactivate → nobody is deactivated, warning raised", () => {
const CFG2 = { ...CFG, maxDeactivate: 3 };
  const rep = larksync.applyPlan(larksync.buildPlan(SRC({ employees: [emp("1001", "TOMMY, TOMMY", "Retail Offline Business Unit")] }), CFG2), deps, { cfg: CFG2 });
  assert.ok(rep.deactivateSkipped > CFG2.maxDeactivate);
  assert.equal(rep.deactivated.length, 0);
  assert.equal(user("1004").active, 1);
  assert.ok(rep.warnings.some((w) => /停用上限/.test(w)));
});

test("too few employees fetched → refuses to sync", () => {
  assert.throws(() => larksync.applyPlan(larksync.buildPlan(SRC({ employees: [] }), { minEmployees: 10 }), deps, { cfg: { minEmployees: 10 } }), /拉取异常/);
});

test("value helpers accept both OpenAPI and lark-cli shapes", () => {
  assert.equal(larksync.text([{ text: "A", type: "text" }, { text: "B", type: "text" }]), "AB");
  assert.equal(larksync.text({ type: 1, value: [{ text: "X" }] }), "X");
  assert.equal(larksync.text(["Yes"]), "Yes");
  assert.equal(larksync.text(100000), "100000");
  assert.deepEqual(larksync.linkIds([{ record_ids: ["a", "b"] }]), ["a", "b"]);
  assert.deepEqual(larksync.linkIds([{ id: "c" }]), ["c"]);
  assert.deepEqual(larksync.linkIds({ link_record_ids: ["d"] }), ["d"]);
});

test("HTTP: /api/admin/lark-sync is super-admin only and reports configuration", async () => {
  const srv = await startServer();
  try {
    const admin = await loginAs(srv.base, ADMIN);
    const r = await admin.get("/api/admin/lark-sync");
    assert.equal(r.status, 200);
    assert.equal(r.data.configured, false);
    const run = await admin.post("/api/admin/lark-sync", { dryRun: true });
    assert.equal(run.status, 404);
    assert.equal(run.data.code, "not_configured");
    assert.equal((await makeClient(srv.base).get("/api/admin/lark-sync")).status, 401);
  } finally { await srv.stopAsync(); }
});
