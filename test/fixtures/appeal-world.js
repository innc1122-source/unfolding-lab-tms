// 第二批 2.8（2026-10-08）绩效申诉测试的共用夹具（设计 appeal-design.md §10）。
//   · bootWorld(now)：在临时库上起服务端（TZ=Asia/Manila、LMS_FAKE_NOW=now），超管登录。
//   · w.restart(now)：同一个库换一个「现在」重启（culture-boot.test.js 的做法）；各账号下次 w.as() 时重新登录。
//   · buildAppealWorld(w)：部门树 R(集团) → A(→A1)、B、G(集团) → C、D；员工 E-A、E-A1、E-B、E-C、E-D，
//     上级 M-A、M-B，HoD（部门负责人）H-A、H-B、H-C、H-D；后台账号（人设）见 PERSONAS。
//   · runV2Cycle / runAnnualCycle / runLegacyCycle：评级 →（v2：HoD 提交 → HR 确认）→ 关闭归档，返回 { id, items }。
// 只用公开接口造数据；集团层标记（meta larksync.groupDepts）与少数「上线前」场景直接写临时库（WAL，服务端不缓存 meta）。
"use strict";
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");
const { ADMIN, startServer, makeClient } = require("../helpers.js");

const PW = (eid) => eid + "-pw-2026";
const SELF = { outcomes: ["完成季度目标 Quarter goals done"], challenges: "", feedback: "多一些跨部门同步", goalsNext: ["下季度目标"] };
// 马尼拉本地时间 → ISO（固定 +08:00，无夏令时）
const manila = (s) => new Date(s.length <= 10 ? s + "T10:00:00+08:00" : s + "+08:00").toISOString();
// 指定长度的文字（中英文都按字符计）
const text = (n, seed) => { const s = (seed || "WRITTEN-EXPLANATION ") ; let out = ""; while (out.length < n) out += s; return out.slice(0, n); };

// ---------- 文件样本（按内容判定类型） ----------
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("0000000dIHDR-test-png-payload-" + "x".repeat(64))]);
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from("JFIF-test-jpg-payload-" + "y".repeat(64)), Buffer.from([0xff, 0xd9])]);
const PDF = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n", "latin1")]);
const SVG = Buffer.from('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
const DOCX = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from("[Content_Types].xml word/document.xml " + "z".repeat(200))]);
const FAKE_PDF = Buffer.from("this is plain text pretending to be a pdf file");
const HTML_PDF = Buffer.from("<html><body><script>1</script><!-- %PDF-1.4 --></body></html>\n%%EOF\n");

class World {
  constructor() {
    this.people = {};   // employeeId -> { id, password, mustChange }
    this.dept = {};     // name -> id
    this.roles = {};    // key/name -> id
    this.cache = new Map();
    this.gen = 0;
    this.env = {};
  }
  get base() { return this.srv.base; }
  get dbPath() { return this.srv.dbPath; }
  get configPath() { return path.join(path.dirname(this.srv.dbPath), "config.json"); }
  dbRead(fn) { const d = new DatabaseSync(this.srv.dbPath, { readOnly: true }); try { return fn(d); } finally { d.close(); } }
  dbWrite(fn) { const d = new DatabaseSync(this.srv.dbPath); try { d.exec("PRAGMA busy_timeout = 5000"); return fn(d); } finally { d.close(); } }
  writeConfig(obj) { if (obj == null) { try { fs.unlinkSync(this.configPath); } catch {} } else fs.writeFileSync(this.configPath, JSON.stringify(obj)); }

  async start(now, env) {
    this.now = now;
    this.env = { ...(env || {}) };
    this.srv = await startServer({ dbPath: this.dbPathSaved, env: { TZ: "Asia/Manila", ...(now ? { LMS_FAKE_NOW: now } : {}), ...this.env } });
    this.dbPathSaved = this.srv.dbPath;
    this.gen++;
    this.cache = new Map();
    this.admin = makeClient(this.srv.base);
    const r = await this.admin.login(ADMIN);
    assert.equal(r.status, 200, "admin login " + JSON.stringify(r.data));
    this.cache.set("ADMIN", this.admin);
    if (!this.people.ADMIN) this.people.ADMIN = { id: this.dbRead((d) => d.prepare("SELECT id FROM users WHERE employeeId = 'ADMIN'").get()).id, password: ADMIN.password, mustChange: false };
    return this;
  }
  async restart(now, env) {
    await this.srv.stopAsync();
    return this.start(now, env === undefined ? this.env : env);
  }
  async stop() { if (this.srv) await this.srv.stopAsync(); }

  // 已登录的客户端（每次重启后第一次用时重新登录）
  async as(eid) {
    if (eid === "ADMIN" || eid === "SA") return this.admin;
    eid = this.key(eid);
    if (this.cache.has(eid)) return this.cache.get(eid);
    const p = this.people[eid];
    assert.ok(p, "unknown person " + eid);
    const c = makeClient(this.srv.base);
    const r = await c.login({ employeeId: eid, password: p.password });
    assert.equal(r.status, 200, `login ${eid}: ${JSON.stringify(r.data)}`);
    this.cache.set(eid, c);
    return c;
  }
  // 人设代号（AD、HA …）是工号 P-AD、P-HA … 的别名（工号至少 3 个字符）
  key(eid) { if (eid === "SA") return "ADMIN"; return this.people[eid] || !this.people["P-" + eid] ? eid : "P-" + eid; }
  id(eid) { const k = this.key(eid); assert.ok(this.people[k], "unknown person " + eid); return this.people[k].id; }

  async makeDept(name, parentName) {
    const r = await this.admin.post("/api/admin/departments", parentName ? { name, parentId: this.dept[parentName] } : { name });
    assert.equal(r.status, 200, "create department " + name + " " + JSON.stringify(r.data));
    this.dept[name] = r.data.department.id;
    return this.dept[name];
  }
  markGroups(names) {
    const ids = names.map((n) => this.dept[n]);
    this.dbWrite((d) => d.prepare("INSERT INTO meta (key, value) VALUES ('larksync.groupDepts', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify(ids)));
  }
  async setOwner(deptName, eid) {
    const r = await this.admin.put(`/api/admin/departments/${this.dept[deptName]}`, { ownerId: eid ? this.id(eid) : null });
    assert.equal(r.status, 200, "set owner " + deptName + " " + JSON.stringify(r.data));
  }
  // 新员工：建号（临时密码）→ 可选上级 / 其他字段 → 默认改密（keepTempPassword 时保留临时密码，用于 403 password_change_required）
  async person(eid, name, department, managerEid, extra, opts) {
    const r = await this.admin.post("/api/admin/employees", { name, employeeId: eid, ...(department ? { department } : {}), jobLevel: "PB2", programIds: [] });
    assert.equal(r.status, 200, "create " + eid + " " + JSON.stringify(r.data));
    const id = this.dbRead((d) => d.prepare("SELECT id FROM users WHERE employeeId = ?").get(eid)).id;
    this.people[eid] = { id, password: r.data.password, mustChange: true };
    const patch = { ...(managerEid ? { managerId: this.id(managerEid) } : {}), ...(extra || {}) };
    if (Object.keys(patch).length) {
      const p = await this.admin.put(`/api/admin/employees/${id}`, patch);
      assert.equal(p.status, 200, "patch " + eid + " " + JSON.stringify(p.data));
    }
    if (!(opts && opts.keepTempPassword)) {
      const c = makeClient(this.srv.base);
      await c.login({ employeeId: eid, password: r.data.password });
      const ch = await c.post("/api/auth/change-password", { currentPassword: r.data.password, newPassword: PW(eid) });
      assert.equal(ch.status, 200, "change password " + eid);
      this.people[eid] = { id, password: PW(eid), mustChange: false };
      this.cache.set(eid, c);
    }
    return id;
  }
  async patch(eid, fields) {
    const r = await this.admin.put(`/api/admin/employees/${this.id(eid)}`, fields);
    assert.equal(r.status, 200, "patch " + eid + " " + JSON.stringify(r.data));
    this.cache.delete(this.key(eid));
    return r;
  }
  async role(key, grants, scope) {
    const r = await this.admin.post("/api/admin/roles", { name: "Role " + key, name_zh: "角色 " + key, grants, ...(scope ? { scope } : {}) });
    assert.equal(r.status, 200, "role " + key + " " + JSON.stringify(r.data));
    this.roles[key] = r.data.role.id;
    return r.data.role.id;
  }
  async builtinRole(key) {
    const roles = (await this.admin.get("/api/admin/roles")).data.roles;
    const r = roles.find((x) => x.key === key);
    assert.ok(r, "built-in role " + key);
    return r.id;
  }
  // 「绩效记录」类型对员工可见 / 隐藏
  async setPerfVisible(on) {
    const t = (await this.admin.get("/api/admin/config/records")).data.types.find((x) => x.key === "performance");
    const r = await this.admin.post("/api/admin/config/record-types", { ...t, employeeVisible: !!on });
    assert.equal(r.status, 200, JSON.stringify(r.data));
  }
  // HRBP 分工：形状 (a)
  async cover(deptName, eids, client) {
    const r = await (client || this.admin).put("/api/admin/review-appeals/coverage", { deptId: this.dept[deptName], userIds: eids.map((e) => this.id(e)) });
    assert.equal(r.status, 200, "coverage " + deptName + " " + JSON.stringify(r.data));
    return r;
  }
  notifs(eid, type) {
    return this.dbRead((d) => d.prepare("SELECT * FROM notifications WHERE userId = ? " + (type ? "AND type = ? " : "") + "ORDER BY createdAt, rowid").all(...(type ? [this.id(eid), type] : [this.id(eid)])));
  }
  audits(action) {
    return this.dbRead((d) => d.prepare("SELECT * FROM audit_logs WHERE action = ? ORDER BY id").all(action)).map((r) => ({ ...r, before: r.beforeJson ? JSON.parse(r.beforeJson) : null, after: r.afterJson ? JSON.parse(r.afterJson) : null }));
  }
  appealRow(itemId) { return this.dbRead((d) => d.prepare("SELECT * FROM review_appeals WHERE itemId = ?").get(itemId)); }
  recordRating(recordId) { const r = this.dbRead((d) => d.prepare("SELECT detail FROM talent_records WHERE id = ?").get(recordId)); return r ? JSON.parse(r.detail).rating : undefined; }
  itemRow(itemId) { return this.dbRead((d) => d.prepare("SELECT * FROM review_items WHERE id = ?").get(itemId)); }

  async itemsOf(cycleId) {
    const out = {};
    for (const i of (await this.admin.get(`/api/admin/review-cycles/${cycleId}`)).data.items) out[i.employeeId] = i.id;
    return out;
  }
  // v2 季度：自评 → 上级评级 → 每个一级部门 HoD 提交 → HR 确认 → 关闭。ratings: { eid: rating }；units: 一级部门名 → HoD 账号
  async runV2Cycle(name, ratings, opts) {
    const o = opts || {};
    const eids = Object.keys(ratings);
    const c = await this.admin.post("/api/admin/review-cycles", { name, flow: "v2", kind: "quarter", dueAt: "2026-12-30", dueRateAt: "2026-12-30", dueCalibAt: "2026-12-30", userIds: eids.map((e) => this.id(e)) });
    assert.equal(c.status, 200, "cycle " + name + " " + JSON.stringify(c.data));
    const id = c.data.cycle.id;
    const items = await this.itemsOf(id);
    for (const e of eids) {
      assert.ok(items[e], `${e} is a participant of ${name}: ${JSON.stringify(items)}`);
      const s = await (await this.as(e)).post(`/api/me/reviews/${items[e]}/self`, SELF);
      assert.equal(s.status, 200, "self " + e + " " + JSON.stringify(s.data));
      const mgr = o.raters && o.raters[e] ? o.raters[e] : this.managerOf[e];
      const m = await (await this.as(mgr)).post(`/api/me/reviews/${items[e]}/manager`, { rating: ratings[e], text: "MGR-TEXT " + e, highlights: "HL-SECRET " + e });
      assert.equal(m.status, 200, `manager rating ${e} by ${mgr}: ${JSON.stringify(m.data)}`);
    }
    if (o.beforeSubmit) await o.beforeSubmit(id, items);
    for (const [unit, hod] of Object.entries(o.units || this.unitsOf(eids))) {
      const sub = await (await this.as(hod)).post("/api/me/reviews/hod/submit", { cycleId: id, dept1Id: this.dept[unit] });
      assert.equal(sub.status, 200, `hod submit ${unit} by ${hod}: ${JSON.stringify(sub.data)}`);
      const cf = await this.admin.post(`/api/admin/review-cycles/${id}/depts/${this.dept[unit]}/confirm`, {});
      assert.equal(cf.status, 200, `confirm ${unit}: ${JSON.stringify(cf.data)}`);
    }
    if (o.beforeClose) await o.beforeClose(id, items);
    const cl = await this.admin.post(`/api/admin/review-cycles/${id}/close`, {});
    assert.equal(cl.status, 200, "close " + name + " " + JSON.stringify(cl.data));
    assert.equal(cl.data.written, eids.length);
    return { id, items };
  }
  // 年度：HoD 直接评级 → 提交 → 确认 → 关闭
  async runAnnualCycle(name, ratings) {
    const eids = Object.keys(ratings);
    const c = await this.admin.post("/api/admin/review-cycles", { name, kind: "annual", userIds: eids.map((e) => this.id(e)) });
    assert.equal(c.status, 200, "annual " + JSON.stringify(c.data));
    const id = c.data.cycle.id;
    const items = await this.itemsOf(id);
    for (const [unit, hod] of Object.entries(this.unitsOf(eids))) {
      const hc = await this.as(hod);
      const g = (await hc.get("/api/me/reviews/hod")).data.groups.find((x) => x.cycle.id === id && x.unit === this.dept[unit]);
      assert.ok(g, "annual group " + unit);
      for (const r of g.view.rows.filter((x) => !x.notCounted)) {
        const e = r.employeeId;
        const p = await hc.put(`/api/me/reviews/hod/items/${r.id}`, { rating: ratings[e] });
        assert.equal(p.status, 200, "annual rate " + e + " " + JSON.stringify(p.data));
      }
      assert.equal((await hc.post("/api/me/reviews/hod/submit", { cycleId: id, dept1Id: this.dept[unit] })).status, 200);
      assert.equal((await this.admin.post(`/api/admin/review-cycles/${id}/depts/${this.dept[unit]}/confirm`, {})).status, 200);
    }
    const cl = await this.admin.post(`/api/admin/review-cycles/${id}/close`, {});
    assert.equal(cl.status, 200, "close annual " + JSON.stringify(cl.data));
    assert.equal(cl.data.written, eids.length);
    return { id, items };
  }
  // 旧流程（flow 不设）：上级评级 → 关闭
  async runLegacyCycle(name, ratings) {
    const eids = Object.keys(ratings);
    const c = await this.admin.post("/api/admin/review-cycles", { name, dueAt: "2026-12-30", userIds: eids.map((e) => this.id(e)) });
    assert.equal(c.status, 200, "legacy " + JSON.stringify(c.data));
    const id = c.data.cycle.id;
    const items = await this.itemsOf(id);
    for (const e of eids) {
      await (await this.as(e)).post(`/api/me/reviews/${items[e]}/self`, SELF);
      const m = await (await this.as(this.managerOf[e])).post(`/api/me/reviews/${items[e]}/manager`, { rating: ratings[e], text: "MGR-TEXT " + e, highlights: "HL-SECRET " + e, oneOnOneDone: true, oneOnOneNotes: "ONE-NOTE-SECRET " + e });
      assert.equal(m.status, 200, "legacy rating " + e + " " + JSON.stringify(m.data));
    }
    const cl = await this.admin.post(`/api/admin/review-cycles/${id}/close`, {});
    assert.equal(cl.status, 200, "close legacy " + JSON.stringify(cl.data));
    return { id, items };
  }
  unitsOf(eids) {
    const out = {};
    for (const e of eids) { const u = this.unitOf[e]; out[u] = this.hodOfUnit[u]; }
    return out;
  }

  // ---- 申诉 ----
  async upload(eid, itemId, buf, name) {
    const c = await this.as(eid);
    return c.upload(`/api/me/reviews/appeal-files?item=${encodeURIComponent(itemId)}&name=${encodeURIComponent(name || "evidence.pdf")}`, buf);
  }
  async submit(eid, itemId, body) {
    return (await this.as(eid)).post(`/api/me/reviews/${itemId}/appeal`, { reason: text(80), ...(body || {}) });
  }
  async submitOk(eid, itemId, body) {
    const r = await this.submit(eid, itemId, body);
    assert.equal(r.status, 201, `submit ${eid}: ${JSON.stringify(r.data)}`);
    return r.data.appeal.id;
  }
}

async function bootWorld(now, env) {
  const w = new World();
  return w.start(now, env);
}

// 设计 §10 的标准世界。人设（后台账号）：
//   SA = ADMIN（超级管理员）；AD = 内置 admin（空范围）；PT = 内置 performance-talent-admin；PS = 自定义 performance manage，范围 A（含下级）；
//   PR = 自定义 performance read；HA / HB = 自定义「HRBP」（people manage、performance none），分别负责 A、B；
//   LA = 内置 learning-admin；AU = 自定义 audit read；EMP = 普通员工；M-A 兼作征询对象（CON）。
async function buildAppealWorld(w, opts) {
  const o = opts || {};
  await w.makeDept("R Group");
  await w.makeDept("Dept A", "R Group");
  await w.makeDept("Dept A1", "Dept A");
  await w.makeDept("Dept B", "R Group");
  await w.makeDept("G Group", "R Group");
  await w.makeDept("Dept C", "G Group");
  await w.makeDept("Dept D", "R Group");
  w.markGroups(["R Group", "G Group"]);
  // HoD
  await w.person("H-A", "Hana HodA", "Dept A");
  await w.person("H-B", "Hugo HodB", "Dept B");
  await w.person("H-C", "Hiro HodC", "Dept C");
  await w.person("H-D", "Hedy HodD", "Dept D");
  for (const [d, h] of [["Dept A", "H-A"], ["Dept B", "H-B"], ["Dept C", "H-C"], ["Dept D", "H-D"]]) await w.setOwner(d, h);
  await w.person("M-A", "Mona MgrA", "Dept A", "H-A");
  await w.person("M-B", "Milo MgrB", "Dept B", "H-B");
  await w.person("E-A", "Ella EmpA", "Dept A", "M-A");
  await w.person("E-A1", "Eric EmpA1", "Dept A1", "M-A");
  await w.person("E-B", "Emma EmpB", "Dept B", "M-B");
  await w.person("E-C", "Evan EmpC", "Dept C", "H-C");
  await w.person("E-D", "Eden EmpD", "Dept D", "H-D");
  w.managerOf = { "E-A": "M-A", "E-A1": "M-A", "E-B": "M-B", "E-C": "H-C", "E-D": "H-D", "M-A": "H-A", "M-B": "H-B" };
  w.unitOf = { "E-A": "Dept A", "E-A1": "Dept A", "E-B": "Dept B", "E-C": "Dept C", "E-D": "Dept D", "M-A": "Dept A", "M-B": "Dept B" };
  w.hodOfUnit = { "Dept A": "H-A", "Dept B": "H-B", "Dept C": "H-C", "Dept D": "H-D" };
  if (o.personas !== false) {
    await w.person("P-AD", "Ada AdminRole", null, null, { adminRoleId: await w.builtinRole("admin") });
    await w.person("P-PT", "Pia PerfTalent", null, null, { adminRoleId: await w.builtinRole("performance-talent-admin") });
    await w.person("P-PS", "Pete PerfScoped", null, null, { adminRoleId: await w.role("PS", { performance: "manage" }, { departments: [{ id: w.dept["Dept A"], includeChildren: true }] }) });
    await w.person("P-PR", "Rita PerfRead", null, null, { adminRoleId: await w.role("PR", { performance: "read" }) });
    const hrbpRole = await w.role("HRBP", { people: "manage" });
    await w.person("P-HA", "Hera HrbpA", null, null, { adminRoleId: hrbpRole });
    await w.person("P-HB", "Hank HrbpB", null, null, { adminRoleId: hrbpRole });
    await w.person("P-LA", "Lars Learning", null, null, { adminRoleId: await w.builtinRole("learning-admin") });
    await w.person("P-AU", "Aria Auditor", null, null, { adminRoleId: await w.role("AU", { audit: "read" }) });
    await w.person("P-EMP", "Pam Plain", "Dept B");
  }
  return w;
}

// 员工端 / 征询人响应里不该出现的东西（设计 §4.7）：键名与哨兵文字
// （growth 的 events、待办的 overdue 等是既有字段，不在此列；申诉对象本身另按白名单核对 EMPLOYEE_APPEAL_KEYS）
const EMPLOYEE_FORBIDDEN_KEYS = ["ratingAtSubmit", "ratingBefore", "newRating", "internalNote", "slaDueOn", "handlerId", "handler", "handlerStale", "consults", "amendedFrom", "amend", "recordRating", "overdueWorkdays", "workdaysLeft", "hrbps", "decidedBy", "coverDept", "remindSoonAt", "remindOverdueOn", "escalatedAt", "conflictIds"];
// 绩效看板第二期（10/10，迁移 97）：category = 员工自己选的申诉原因分类（HRBP 改正后为改正后的分类），不是处理信息
const EMPLOYEE_APPEAL_KEYS = ["id", "status", "reason", "category", "attachments", "submittedAt", "withdrawnAt", "startedAt", "decidedAt", "outcome", "reply"];
function findKeys(json, keys) {
  const hits = [];
  const set = new Set(keys);
  const walk = (v, p) => {
    if (Array.isArray(v)) return v.forEach((x, i) => walk(x, `${p}[${i}]`));
    if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) { if (set.has(k)) hits.push(`${p}.${k}`); walk(x, `${p}.${k}`); }
  };
  walk(json, "$");
  return hits;
}

module.exports = { World, bootWorld, buildAppealWorld, manila, text, PW, SELF, PNG, JPG, PDF, SVG, DOCX, FAKE_PDF, HTML_PDF, EMPLOYEE_FORBIDDEN_KEYS, EMPLOYEE_APPEAL_KEYS, findKeys };
