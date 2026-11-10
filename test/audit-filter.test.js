// F1：GET /api/admin/audit 的服务端筛选 + offset 分页。
//
// 为什么要有这一层：本端点原先**只有 limit**（默认 2000、上限 5000），筛选全在
// Audit.jsx 里做，于是「最近 2000/5000 行」就是可见性的天花板。P3 起
// manager.view_profile 变成高频行（经理每翻一个下属就落一行，与 auth.* 同级），
// 足以把 auth.login_failed（撞密码）与 employee.update（档案变更）挤出窗口——
// 「谁看过谁」查得到了，别的反而更难查。所以 action / actor / since / until 都下推到
// 服务端，在**全表**上筛，limit+offset 只决定取哪一段。
//
// 本文件钉住五件事（前两件是最容易做错的）：
//  ① 范围过滤（D7）与新筛选**叠加**且顺序正确——任何 action/actor/时间参数都只能让
//    结果更少，绝不能让范围受限角色多看到一行范围外的记录；
//  ② total 是「筛过 + 范围过」的真实可见总数（不是取回条数），否则「共 N 条」又变谎话；
//  ③ offset 分页翻页不重不漏；④ action 前缀/精确两种口径；⑤ 不带新参数时行为一字不变。
//
// 起真服务（helpers.startServer，一次性库，永不碰 lms.db）。
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { ADMIN, startServer, loginAs, makeClient } = require("./helpers.js");

let srv, admin, scopedAuditor, plainAuditor;
const dept = {};

async function makeAdminUser(empId, adminRoleId) {
  const created = await admin.post("/api/admin/employees", { name: empId, employeeId: empId });
  assert.equal(created.status, 200, "create " + empId);
  const roster = await admin.get("/api/admin/roster");
  const u = roster.data.find((x) => x.employeeId === empId);
  assert.ok(u, "find " + empId);
  const r = await admin.put("/api/admin/employees/" + u.id, { adminRoleId });
  assert.equal(r.status, 200, "assign role to " + empId);
  const c = await loginAs(srv.base, { employeeId: empId, password: created.data.password });
  const cp = await c.post("/api/auth/change-password", { currentPassword: created.data.password, newPassword: empId + "-pw-2026" });
  assert.equal(cp.status, 200, "clear mustChangePassword for " + empId);
  return c;
}

async function makeEmployee(empId, department) {
  const created = await admin.post("/api/admin/employees", { name: empId, employeeId: empId });
  assert.equal(created.status, 200, "create employee " + empId);
  const roster = await admin.get("/api/admin/roster");
  const u = roster.data.find((x) => x.employeeId === empId);
  assert.ok(u, "find employee " + empId);
  const put = await admin.put("/api/admin/employees/" + u.id, { department, jobLevel: "P5" });
  assert.equal(put.status, 200, "set department of " + empId);
  return u.id;
}

// 一次失败登录 = 一行 auth.login_failed（target = 提交的工号）。锁定是
// 「工号 + IP」计数、5 次才锁，所以每个工号最多敲 3 下，永不触发 429。
async function failLogin(employeeId) {
  const c = makeClient(srv.base);
  const r = await c.login({ employeeId, password: "definitely-wrong-pw" });
  assert.equal(r.status, 401, "failed login for " + employeeId + " should be 401, got " + r.status);
}

const ALL = "?limit=5000";
const get = (c, qs) => c.get("/api/admin/audit" + qs);

before(async () => {
  srv = await startServer();
  admin = await loginAs(srv.base, ADMIN);
  // 部门树：FIL Root → FIL Child（含下级）在范围内，FIL Other 在范围外。
  for (const [name, parent] of [["FIL Root", null], ["FIL Child", "FIL Root"], ["FIL Other", null]]) {
    const body = parent ? { name, parentId: dept[parent] } : { name };
    const r = await admin.post("/api/admin/departments", body);
    assert.equal(r.status, 200, "create department " + name);
    dept[name] = r.data.department.id;
  }
  // 每个员工产 employee.create + employee.update 两行 → 足够做 5 行一页的翻页。
  for (let i = 1; i <= 4; i++) await makeEmployee("FIL-IN-" + i, "FIL Root");
  for (let i = 1; i <= 2; i++) await makeEmployee("FIL-KID-" + i, "FIL Child");
  for (let i = 1; i <= 4; i++) await makeEmployee("FIL-OUT-" + i, "FIL Other");
  const scope = { departments: [{ id: dept["FIL Root"], includeChildren: true }] };
  const mkRole = async (name, grants, sc) => {
    const r = await admin.post("/api/admin/roles", { name, name_zh: name, grants, ...(sc ? { scope: sc } : {}) });
    assert.equal(r.status, 200, "create role " + name);
    return r.data.role.id;
  };
  scopedAuditor = await makeAdminUser("FIL-A-SCOPED", await mkRole("Filter Scoped Auditor", { audit: "manage" }, scope));
  plainAuditor = await makeAdminUser("FIL-A-PLAIN", await mkRole("Filter Plain Auditor", { audit: "manage" }));
  // auth.login_failed 三类主体：范围内员工 / 范围外员工 / 根本不存在的工号
  // （无员工主体 → 对范围受限角色必须隐藏）。
  for (const id of ["FIL-IN-1", "FIL-IN-2", "FIL-KID-1"]) { await failLogin(id); await failLogin(id); }
  for (const id of ["FIL-OUT-1", "FIL-OUT-2"]) { await failLogin(id); await failLogin(id); }
  for (const id of ["FIL-GHOST-1", "FIL-GHOST-2", "FIL-GHOST-3"]) await failLogin(id);
});
after(() => srv.stop());

/* ---------- ⑤ 兼容：不带新参数时行为一字不变 ---------- */
test("不带参数：契约与默认 limit 不变，total = 库内真实总数", async () => {
  const bare = await get(admin, "");
  assert.equal(bare.status, 200);
  assert.equal(bare.data.limit, 2000, "默认窗口仍是 2000");
  assert.equal(bare.data.offset, 0);
  assert.ok(Array.isArray(bare.data.rows) && bare.data.rows.length > 20, "有足量审计行");
  // 数据量远小于窗口 → total = 取回条数，且未截断（与改动前同一算法）。
  assert.equal(bare.data.total, bare.data.rows.length);
  assert.equal(bare.data.truncated, false);
  // 显式 limit=2000 与不带参数必须逐行相同（走的是同一条老路径）。
  const same = await get(admin, "?limit=2000");
  assert.deepEqual(same.data.rows.map((x) => x.id), bare.data.rows.map((x) => x.id));
  // 老路径仍然返回解析好的双语对象名（labelForTarget 没被绕过）。
  const emp = bare.data.rows.find((x) => x.action === "employee.create" && x.target === "FIL-IN-1");
  assert.ok(emp, "找得到 FIL-IN-1 的 employee.create 行");
  assert.ok(emp.targetLabel && emp.targetLabel.includes("FIL-IN-1"), "对象列仍解析出姓名(工号)");
});

test("limit 仍被夹在 1..5000；offset 非法值退化为 0", async () => {
  assert.equal((await get(admin, "?limit=99999")).data.limit, 5000);
  assert.equal((await get(admin, "?limit=-3")).data.limit, 1);
  assert.equal((await get(admin, "?offset=-10")).data.offset, 0);
  assert.equal((await get(admin, "?offset=abc")).data.offset, 0);
});

/* ---------- ④ action：精确值与点分段前缀 ---------- */
test("action 精确过滤：只回该动作的行，total = 该动作的真实条数", async () => {
  const all = await get(admin, ALL);
  const want = all.data.rows.filter((x) => x.action === "auth.login_failed");
  assert.ok(want.length >= 9, "造了足够多的失败登录行，实际 " + want.length);
  const r = await get(admin, "?action=auth.login_failed&limit=5000");
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.rows.map((x) => x.id), want.map((x) => x.id), "行与顺序都与全量筛一致");
  assert.equal(r.data.total, want.length, "total 是过滤后的真实值");
  assert.ok(r.data.total < all.data.total, "严格少于全量");
});

test("action 前缀过滤：action=auth 命中所有 auth.*，且不误伤别的域", async () => {
  const all = await get(admin, ALL);
  const want = all.data.rows.filter((x) => String(x.action).startsWith("auth."));
  const kinds = new Set(want.map((x) => x.action));
  assert.ok(kinds.size >= 2, "auth.* 至少两种动作（登录 + 登录失败），实际 " + [...kinds].join(","));
  const r = await get(admin, "?action=auth&limit=5000");
  assert.deepEqual(r.data.rows.map((x) => x.id), want.map((x) => x.id));
  assert.equal(r.data.total, want.length);
  for (const x of r.data.rows) assert.ok(String(x.action).startsWith("auth."), "不该混进 " + x.action);
  // 前缀是**按点分段**的：employee 命中 employee.*，但 auth 不该命中 employee.*，
  // 反之亦然（两个集合不相交，加起来也不等于全量——还有 department/role 等）。
  const e = await get(admin, "?action=employee&limit=5000");
  for (const x of e.data.rows) assert.ok(String(x.action).startsWith("employee."), "不该混进 " + x.action);
  const overlap = new Set(r.data.rows.map((x) => x.id));
  for (const x of e.data.rows) assert.ok(!overlap.has(x.id), "两个前缀不得重叠");
  // 不存在的动作 → 空结果 + total 0（不是「退化成全量」）。
  const none = await get(admin, "?action=nosuchdomain&limit=5000");
  assert.equal(none.data.rows.length, 0);
  assert.equal(none.data.total, 0);
});

/* ---------- ③ offset 分页：不重不漏 ---------- */
test("offset 分页：逐页拼起来 = 一次拉全，不重不漏；每页 total 都是过滤后总数", async () => {
  const base = await get(admin, "?action=employee&limit=5000");
  const ids = base.data.rows.map((x) => x.id);
  assert.ok(ids.length >= 12, "employee.* 行足够翻页，实际 " + ids.length);
  const P = 5;
  const seen = [];
  for (let off = 0; off < ids.length; off += P) {
    const p = await get(admin, `?action=employee&limit=${P}&offset=${off}`);
    assert.equal(p.status, 200);
    assert.equal(p.data.offset, off);
    assert.equal(p.data.limit, P);
    assert.equal(p.data.total, base.data.total, "每一页报的 total 都必须是过滤后的真实总数");
    assert.ok(p.data.rows.length <= P);
    seen.push(...p.data.rows.map((x) => x.id));
  }
  assert.deepEqual(seen, ids, "翻页序列必须与一次拉全逐行相同（不重不漏、顺序不乱）");
  assert.equal(new Set(seen).size, seen.length, "没有任何一行被翻到两次");
  // truncated 的语义：还有 offset+已取 之后的行才为真。
  const first = await get(admin, "?action=employee&limit=5&offset=0");
  assert.equal(first.data.truncated, true, "第一页之后还有行 → truncated");
  const lastOff = Math.max(0, ids.length - 3);
  const last = await get(admin, `?action=employee&limit=5&offset=${lastOff}`);
  assert.equal(last.data.truncated, false, "已取到尾 → 不再 truncated");
  // 越界 offset → 空页，但 total 不变（「共 N 条」不因翻过头而缩水）。
  const over = await get(admin, `?action=employee&limit=5&offset=${ids.length + 50}`);
  assert.equal(over.data.rows.length, 0);
  assert.equal(over.data.total, base.data.total);
  assert.equal(over.data.truncated, false);
  // 不带过滤时的 offset 走的是 SQL OFFSET 那条老路径 —— 同样不重不漏。
  const raw = await get(admin, "?limit=10&offset=0");
  const raw2 = await get(admin, "?limit=10&offset=10");
  const rawAll = await get(admin, "?limit=20&offset=0");
  assert.deepEqual([...raw.data.rows, ...raw2.data.rows].map((x) => x.id), rawAll.data.rows.map((x) => x.id));
  assert.equal(raw2.data.total, rawAll.data.total, "无过滤时 total 恒为库内总数");
});

/* ---------- actor 与时间 ---------- */
test("actor 过滤：actorId 精确 + 操作人姓名子串(不分大小写)，total 随之", async () => {
  const all = await get(admin, ALL);
  const byId = all.data.rows.filter((x) => x.actorId === "u-admin");
  assert.ok(byId.length > 10, "超管做了足够多的操作");
  const r1 = await get(admin, "?actor=u-admin&limit=5000");
  assert.deepEqual(r1.data.rows.map((x) => x.id), byId.map((x) => x.id));
  assert.equal(r1.data.total, byId.length);
  // 姓名子串：ADMIN 的姓名是 "Administrator"。
  const r2 = await get(admin, "?actor=ADMINISTRAT&limit=5000");
  assert.equal(r2.data.total, byId.length, "大小写不敏感的姓名子串命中同一批");
  // 失败登录是系统行（无 actor）→ 不该被 actor 筛命中。
  for (const x of r1.data.rows) assert.notEqual(x.action, "auth.login_failed");
  const none = await get(admin, "?actor=nobody-at-all&limit=5000");
  assert.equal(none.data.total, 0);
});

test("since / until：时间窗在服务端筛，total 是窗内真实条数", async () => {
  const all = await get(admin, ALL);
  const future = new Date(Date.now() + 86400000).toISOString();
  const f = await get(admin, "?since=" + encodeURIComponent(future) + "&limit=5000");
  assert.equal(f.data.total, 0, "since 在将来 → 一行都没有");
  assert.equal(f.data.rows.length, 0);
  const p = await get(admin, "?since=2000-01-01T00:00:00.000Z&limit=5000");
  assert.equal(p.data.total, all.data.total, "since 在远古 → 全量");
  // until 只给日期时要含当天整日：until=<今天> 必须仍然看得到今天写的行。
  const today = new Date().toISOString().slice(0, 10);
  const u = await get(admin, "?until=" + today + "&limit=5000");
  assert.equal(u.data.total, all.data.total, "until=今天 必须含今天整日（含头不含尾的老坑）");
  const uOld = await get(admin, "?until=2000-01-01&limit=5000");
  assert.equal(uOld.data.total, 0);
  // action + since 组合 = 两个条件的交集。
  const combo = await get(admin, "?action=auth.login_failed&since=2000-01-01T00:00:00.000Z&limit=5000");
  const want = all.data.rows.filter((x) => x.action === "auth.login_failed");
  assert.equal(combo.data.total, want.length);
});

/* ---------- ①② 两层叠加：范围过滤 + 新筛选 ---------- */
test("范围受限角色 + action：两层叠加正确，且 action 绝不放大可见面", async () => {
  // 无 action 时的可见集合（D7 那层）。
  const sAll = await get(scopedAuditor, ALL);
  assert.equal(sAll.status, 200, "scoped auditor 可读 audit");
  const visible = sAll.data.rows;
  assert.ok(visible.length > 0);
  // 叠加 action=employee：必须恰好等于「可见集合 ∩ employee.*」。
  const s = await get(scopedAuditor, "?action=employee&limit=5000");
  const expect = visible.filter((x) => String(x.action).startsWith("employee.")).map((x) => x.id);
  assert.ok(expect.length > 0, "范围内员工有 employee.* 行");
  assert.deepEqual(s.data.rows.map((x) => x.id), expect, "= 范围可见 ∩ action 前缀");
  assert.equal(s.data.total, expect.length, "total 是「筛过 + 范围过」的真实可见总数");
  // 红线：受限角色的结果必须是超管同 action 结果的**真子集** —— 加了参数不得越界。
  const a = await get(admin, "?action=employee&limit=5000");
  const aIds = new Set(a.data.rows.map((x) => x.id));
  for (const x of s.data.rows) assert.ok(aIds.has(x.id), "受限结果必须落在超管结果内");
  assert.ok(s.data.total < a.data.total, "受限总数必须严格少于超管");
  const targets = new Set(s.data.rows.map((x) => x.target));
  assert.ok(targets.has("FIL-IN-1"), "看得到本部门");
  assert.ok(targets.has("FIL-KID-1"), "看得到子部门（含下级）");
  for (let i = 1; i <= 4; i++) assert.ok(!targets.has("FIL-OUT-" + i), "看不到范围外员工 FIL-OUT-" + i);
  assert.ok(!targets.has("FIL-A-SCOPED") && !targets.has("FIL-A-PLAIN"), "无部门的后台账号仍隐藏");
});

test("范围受限角色 + action=auth：只见范围内员工的失败登录；幽灵工号与范围外全隐藏", async () => {
  const s = await get(scopedAuditor, "?action=auth&limit=5000");
  assert.equal(s.status, 200);
  const targets = s.data.rows.map((x) => x.target);
  assert.ok(targets.includes("FIL-IN-1"), "范围内员工的 auth.* 行可见");
  for (const bad of ["FIL-OUT-1", "FIL-OUT-2", "FIL-GHOST-1", "FIL-GHOST-2", "FIL-GHOST-3"]) {
    assert.ok(!targets.includes(bad), "不该看到 " + bad + " 的 auth 行（范围外或无员工主体）");
  }
  for (const x of s.data.rows) assert.ok(String(x.action).startsWith("auth."));
  assert.equal(s.data.total, s.data.rows.length);
  // 无员工主体的动作域（部门/角色）即便被显式点名，也一行都不该出现 ——
  // 「筛出来」不是「看得见」的理由。
  for (const kind of ["department", "role", "brand", "config"]) {
    const r = await get(scopedAuditor, "?action=" + kind + "&limit=5000");
    assert.equal(r.data.rows.length, 0, kind + ".* 无员工主体，受限角色不得看到");
    assert.equal(r.data.total, 0, kind + ".* 的 total 也必须是 0");
    // 同一参数超管是看得到的 —— 证明上面那 0 是范围闸挡下来的，不是筛错了。
    if (kind === "department" || kind === "role") {
      const a = await get(admin, "?action=" + kind + "&limit=5000");
      assert.ok(a.data.total > 0, "超管看得到 " + kind + ".*（对照）");
    }
  }
});

test("范围受限角色 + offset 分页：翻页不重不漏，每页 total 都是范围内真实总数", async () => {
  const base = await get(scopedAuditor, ALL);
  const ids = base.data.rows.map((x) => x.id);
  assert.ok(ids.length >= 6, "范围内可见行足够翻页，实际 " + ids.length);
  const P = 3;
  const seen = [];
  for (let off = 0; off < ids.length; off += P) {
    const p = await get(scopedAuditor, `?limit=${P}&offset=${off}`);
    assert.equal(p.data.total, base.data.total, "范围受限时每页 total 也必须是过滤后总数");
    seen.push(...p.data.rows.map((x) => x.id));
  }
  assert.deepEqual(seen, ids, "范围过滤下的翻页同样不重不漏");
  assert.equal(new Set(seen).size, seen.length);
});

test("空范围角色：加了筛选也与超管一字不差（向后兼容红线）", async () => {
  for (const qs of ["", ALL, "?action=employee&limit=5000", "?action=auth&limit=5000", "?actor=u-admin&limit=5000"]) {
    const a = await get(admin, qs);
    const p = await get(plainAuditor, qs);
    assert.equal(p.status, 200, "空范围审计员可读 " + qs);
    assert.equal(p.data.total, a.data.total, "空范围角色 total 必须与超管一致：" + qs);
    assert.deepEqual(p.data.rows.map((x) => x.id), a.data.rows.map((x) => x.id), "逐行一致：" + qs);
  }
});


/* 读不出来的时间参数：必须当作**没给**，既不能 500 也不能静悄悄筛空。
   两个都是真踩过的坑：
    · 500 —— since 的「提前收尾」余量曾经无条件求值 new Date(since).getTime()-86400000
      再 toISOString()，而 new Date("garbage") 是 NaN、new Date(NaN).toISOString() 抛
      RangeError("Invalid time value")。于是 ?since=garbage 这种手敲/收藏的 URL 直接打出
      五百，而 since 只是个可选筛选参数。
    · 静悄悄筛空 —— createdAt 是 "2026-…" 开头，拿它跟 "garbage" 比字节序，
      "2026…" < "garbage" 恒成立，所以一旦让坏串参与比较就会把**每一行**都筛掉，
      页面看起来就像「这段时间没有任何审计记录」。审计页上这是最坏的失败方式。
   正确行为：解析不出 → 该参数失效，结果与完全不带它一模一样。 */
test("读不出来的 since/until：不 500、不筛空，等价于没带这个参数", async () => {
  const baseline = await get(admin, ALL);
  assert.equal(baseline.status, 200);
  for (const bad of ["garbage", "2026-13-45", "hello world", "0000abc", "NaN", "-"]) {
    for (const key of ["since", "until"]) {
      const r = await get(admin, `${ALL}&${key}=${encodeURIComponent(bad)}`);
      assert.equal(r.status, 200, `${key}=${bad} 必须 200，不能是 500`);
      assert.equal(r.data.total, baseline.data.total, `${key}=${bad} 应等价于没带该参数（total）`);
      assert.deepEqual(r.data.rows.map((x) => x.id), baseline.data.rows.map((x) => x.id),
        `${key}=${bad} 应等价于没带该参数（逐行）`);
    }
  }
});

/* 反面对照：**读得出**的时间参数照旧真的筛。上面那条只保证坏串失效，
   不能顺手把整个时间筛选都变成 no-op —— 这条钉住它还活着。 */
test("能解析的 since 照旧生效，且带时区偏移的写法与 Z 等价", async () => {
  const all = await get(admin, ALL);
  const future = new Date(Date.now() + 3600000).toISOString();
  const none = await get(admin, `${ALL}&since=${encodeURIComponent(future)}`);
  assert.equal(none.status, 200);
  assert.equal(none.data.total, 0, "since 在未来 → 一行都不该有（证明 since 真的在筛）");
  const past = new Date(Date.now() - 30 * 86400000);
  const z = await get(admin, `${ALL}&since=${encodeURIComponent(past.toISOString())}`);
  const off = await get(admin, `${ALL}&since=${encodeURIComponent(past.toISOString().replace("Z", "+00:00"))}`);
  assert.equal(z.data.total, all.data.total, "30 天前的 since 应涵盖这个一次性库的全部行");
  assert.equal(off.data.total, z.data.total, "+00:00 与 Z 归一后必须同结果");
});
