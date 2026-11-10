// RBAC P2 阶段 A —— store.js 的范围（scope）解析器单元测试。
//
// 这一层是纯数据层，所以不起服务：直接以 LMS_DB_PATH 指向一个一次性库 require store.js
// （与 test/ops-hardening.test.js 里那段 notify 单测同一个路数）。env 必须在 require
// 之前设置才生效。**永远不碰仓库根的 lms.db 和 config.json。**
//
// 覆盖：子树展开 / includeChildren=false 只含本部门 / 空范围=全公司 / 坏 JSON 按
// fail closed 关门 / 部门改名后缓存失效（本连接与跨连接两条通路）/ 环形 parentId 不死循环 /
// 陈旧 id 不退化全公司 / 名称集合先算再 O(1) 判定（不重复展开子树）。

const test = require("node:test");
const assert = require("node:assert");
const path = require("path");
const os = require("os");
const fs = require("fs");
const crypto = require("crypto");
const { DatabaseSync } = require("node:sqlite");

const ROOT = path.join(__dirname, "..");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lms-scope-"));
const DB_FILE = path.join(dir, "scope.db");
process.env.LMS_DB_PATH = DB_FILE;
process.env.LMS_ATTACH_DIR = path.join(dir, "attachments");
process.env.LMS_CONFIG_PATH = path.join(dir, "config-that-does-not-exist.json");
process.env.LMS_DISABLE_AI = "1";

const store = require(path.join(ROOT, "store.js"));
// 临时库由本进程打开:全部测试结束后先关连接再删目录(Windows 上打开着的库文件删不掉),不留残余目录
test.after(() => { try { store.close(); } catch {} try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 }); } catch {} });
const hashPassword = (pw) => {
  const salt = crypto.randomBytes(16).toString("hex");
  return salt + ":" + crypto.scryptSync(pw, salt, 32).toString("hex");
};
store.init({ hashPassword });

// 一棵三层树（与实测的最大深度 2 = 三层一致）+ 一个范围外的兄弟根。
// SC-* 前缀避免与 seed 出来的部门名撞车。
const RD = store.ensureDepartment("SC Root");
const MID = store.ensureDepartment("SC Mid", RD.id);
const LEAF = store.ensureDepartment("SC Leaf", MID.id);
const SIB = store.ensureDepartment("SC Sibling", RD.id);
const OUT = store.ensureDepartment("SC Outside");

function mkRole(scope, name) {
  const id = store.createRole({ name: name || "Scope Probe " + Math.random().toString(36).slice(2, 8), grants: {}, scope });
  return store.getRole(id);
}
const names = (role) => {
  const s = store.resolveScopeDepartmentNames(role);
  return s === null ? null : [...s].sort();
};

test("空范围 = 全公司：不过滤（向后兼容红线）", () => {
  for (const scope of [undefined, {}, { departments: [] }, { departments: null }]) {
    const role = mkRole(scope);
    assert.equal(store.parseScope(role).all, true, "空范围应判 all");
    assert.equal(store.parseScope(role).denyAll, false);
    assert.equal(store.resolveScopeDepartmentNames(role), null, "空范围应回 null（= 不过滤）");
    assert.equal(store.scopeAllowsDepartment(role, "SC Outside"), true);
    assert.equal(store.scopeAllowsUser(role, { department: "SC Outside" }), true);
    assert.equal(store.scopeAllowsUser(role, { department: null }), true, "全公司时无部门的人也可见");
  }
  // 没有后台角色（遗留 admin / 员工端）：范围不适用，由域闸门管。
  assert.equal(store.parseScope(null).all, true);
  assert.equal(store.resolveScopeDepartmentNames(null), null);
  assert.equal(store.scopeAllowsUser(null, { department: "SC Outside" }), true);
});

test("includeChildren=true 展开整棵子树（深度不写死）", () => {
  const role = mkRole({ departments: [{ id: RD.id, includeChildren: true }] });
  assert.deepEqual(names(role), ["SC Leaf", "SC Mid", "SC Root", "SC Sibling"]);
  assert.equal(store.scopeAllowsDepartment(role, "SC Leaf"), true, "孙部门也要在范围内（三层）");
  assert.equal(store.scopeAllowsDepartment(role, "SC Outside"), false);
  assert.equal(store.scopeAllowsUser(role, { department: "sc leaf" }), true, "大小写/空白不敏感");
  assert.equal(store.scopeAllowsUser(role, { department: "  SC Mid  " }), true);
  // 中间层为根时只拿到它自己那一支
  const mid = mkRole({ departments: [{ id: MID.id, includeChildren: true }] });
  assert.deepEqual(names(mid), ["SC Leaf", "SC Mid"]);
});

test("includeChildren=false 只含本部门（缺省也按 false 读）", () => {
  const off = mkRole({ departments: [{ id: RD.id, includeChildren: false }] });
  assert.deepEqual(names(off), ["SC Root"]);
  assert.equal(store.scopeAllowsDepartment(off, "SC Mid"), false, "关掉含下级后子部门不可见");
  // 缺省：设计约定里 includeChildren 是必填布尔，缺了按更窄的一侧读（与 fail closed 一致）。
  const missing = mkRole({ departments: [{ id: RD.id }] });
  assert.deepEqual(names(missing), ["SC Root"]);
  assert.equal(store.parseScope(missing).departments[0].includeChildren, false);
  // 同一部门两条、含下级取并集（否则顺序会决定结果）
  const both = mkRole({ departments: [{ id: RD.id, includeChildren: false }, { id: RD.id, includeChildren: true }] });
  assert.deepEqual(names(both), ["SC Leaf", "SC Mid", "SC Root", "SC Sibling"]);
  assert.equal(store.parseScope(both).departments.length, 1, "重复的部门 id 应去重");
});

test("多部门并列 + 范围生效时无部门的员工不可见", () => {
  const role = mkRole({ departments: [{ id: LEAF.id, includeChildren: true }, { id: OUT.id, includeChildren: false }] });
  assert.deepEqual(names(role), ["SC Leaf", "SC Outside"]);
  assert.equal(store.scopeAllowsUser(role, { department: "" }), false);
  assert.equal(store.scopeAllowsUser(role, { department: null }), false);
  assert.equal(store.scopeAllowsUser(role, {}), false);
  assert.equal(store.scopeAllowsUser(role, null), false);
});

test("坏结构 = fail closed（零可见），不退化全公司", () => {
  // a. scope 文本 JSON.parse 失败（直接喂原始字符串这条防御通路）
  const badText = { id: 9001, scope: "{\"departments\": [" };
  assert.equal(store.parseScope(badText).denyAll, true);
  assert.equal(store.parseScope(badText).malformed, true);
  assert.equal(store.parseScope(badText).all, false, "坏 JSON 绝不能判成全公司");
  const s1 = store.resolveScopeDepartmentNames(badText);
  assert.ok(s1 instanceof Set, "关门时应回空 Set 而不是 null");
  assert.equal(s1.size, 0);
  assert.equal(store.scopeAllowsDepartment(badText, "SC Root"), false);
  assert.equal(store.scopeAllowsUser(badText, { department: "SC Root" }), false);

  // b. departments 存在但不是数组
  for (const raw of [{ departments: "SC Root" }, { departments: 7 }, { departments: { id: RD.id } }]) {
    const r = { id: 9002, scope: raw };
    assert.equal(store.parseScope(r).denyAll, true, JSON.stringify(raw) + " 应关门");
  }
  // c. departments 非空数组但一条 id 都解析不出来
  for (const raw of [{ departments: [{}] }, { departments: [null, ""] }, { departments: [{ includeChildren: true }] }]) {
    const r = { id: 9003, scope: raw };
    assert.equal(store.parseScope(r).denyAll, true, JSON.stringify(raw) + " 应关门");
  }
  // scope 本身是数组（rowToRole 以前会静默吞成 {}）
  assert.equal(store.parseScope({ id: 9004, scope: [{ id: RD.id }] }).denyAll, true);
  // 空字符串 scope 不算坏（老库里的空值）
  assert.equal(store.parseScope({ id: 9005, scope: "" }).all, true);
  assert.equal(store.parseScope({ id: 9006, scope: "{}" }).all, true);
});

test("库里真的躺着坏 JSON：rowToRole 打 scopeMalformed，解析器关门", () => {
  const role = mkRole({ departments: [{ id: RD.id, includeChildren: true }] }, "Corrupt Probe");
  assert.equal(store.getRole(role.id).scopeMalformed, undefined, "正常行不带 scopeMalformed（响应形状不变）");
  // 用第二个连接直写坏 JSON —— 顺带真实地触发跨进程失效信号 PRAGMA data_version。
  const raw = new DatabaseSync(DB_FILE);
  raw.prepare("UPDATE roles SET scope = ? WHERE id = ?").run("{oops", role.id);
  raw.close();
  const reread = store.getRole(role.id);
  assert.equal(reread.scopeMalformed, true, "坏 JSON 行必须挂标记，不能静默吞成 {}");
  assert.deepEqual(reread.scope, {}, "scope 字段仍是普通对象（前端形状不变）");
  assert.equal(store.parseScope(reread).denyAll, true);
  assert.equal(store.resolveScopeDepartmentNames(reread).size, 0);
});

test("陈旧 id（指向已删部门）→ 零可见，不退化全公司", () => {
  const role = mkRole({ departments: [{ id: "d-does-not-exist", includeChildren: true }] });
  const s = store.resolveScopeDepartmentNames(role);
  assert.ok(s instanceof Set);
  assert.equal(s.size, 0);
  assert.equal(store.parseScope(role).malformed, false, "陈旧 id 不是坏结构，是配置的真实含义");
  assert.equal(store.scopeAllowsUser(role, { department: "SC Root" }), false);
});

test("部门改名后缓存失效（本连接的写：data_version 不动，靠 epoch）", () => {
  const dept = store.ensureDepartment("SC Rename Me");
  const role = mkRole({ departments: [{ id: dept.id, includeChildren: true }] });
  assert.deepEqual(names(role), ["SC Rename Me"]);
  store.updateDepartment(dept.id, { name: "SC Renamed" });
  assert.deepEqual(names(role), ["SC Renamed"], "改名后必须解析到新名称（缓存要失效）");
  assert.equal(store.scopeAllowsUser(role, { department: "SC Rename Me" }), false, "旧名不再可见");
  assert.equal(store.scopeAllowsUser(role, { department: "SC Renamed" }), true);

  // 新增子部门也要立刻可见（子树是缓存的一部分）
  const kid = store.ensureDepartment("SC Renamed Kid", dept.id);
  assert.deepEqual(names(role), ["SC Renamed", "SC Renamed Kid"]);
  // 删掉子部门后同样立刻消失
  store.deleteDepartment(kid.id);
  assert.deepEqual(names(role), ["SC Renamed"]);
});

test("环形 parentId 不死循环（含自己指自己）", () => {
  const a = store.ensureDepartment("SC Cycle A");
  const b = store.ensureDepartment("SC Cycle B", null);
  store.updateDepartment(b.id, { parentId: a.id });
  store.updateDepartment(a.id, { parentId: b.id }); // a → b → a
  const role = mkRole({ departments: [{ id: a.id, includeChildren: true }] });
  assert.deepEqual(names(role), ["SC Cycle A", "SC Cycle B"]);
  const z = store.ensureDepartment("SC Self Loop");
  store.updateDepartment(z.id, { parentId: z.id });
  const self = mkRole({ departments: [{ id: z.id, includeChildren: true }] });
  assert.deepEqual(names(self), ["SC Self Loop"]);
});

test("性能口径：名称集合每个 epoch 只展开一次，逐人判定 O(1)", () => {
  const role = mkRole({ departments: [{ id: RD.id, includeChildren: true }] }, "Perf Probe");
  const before = store.scopeCacheStats().builds;
  store.resolveScopeDepartmentNames(role);
  const afterFirst = store.scopeCacheStats().builds;
  assert.equal(afterFirst, before + 1, "首次解析展开一次子树");
  // roster 规模（实测 925 人）的逐人判定不应再展开任何子树
  const roster = [];
  for (let i = 0; i < 925; i++) roster.push({ id: "u" + i, department: i % 2 ? "SC Leaf" : "SC Outside" });
  let visible = 0;
  for (const u of roster) if (store.scopeAllowsUser(role, u)) visible++;
  assert.equal(visible, 462);
  assert.equal(store.scopeCacheStats().builds, afterFirst, "925 次判定必须 0 次子树展开");
  // 缓存键随失效基线变化；改一个部门就应该重算
  store.updateDepartment(SIB.id, { sort: (SIB.sort || 0) + 1 });
  store.resolveScopeDepartmentNames(role);
  assert.equal(store.scopeCacheStats().builds, afterFirst + 1, "部门写之后应重新展开一次");
});

test("导出面：四个函数都在 module.exports 上", () => {
  for (const fn of ["parseScope", "resolveScopeDepartmentNames", "scopeAllowsDepartment", "scopeAllowsUser", "scopeCacheStats"])
    assert.equal(typeof store[fn], "function", "store.js 应导出 " + fn);
});
