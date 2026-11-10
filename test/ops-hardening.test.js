// test/ops-hardening.test.js — 上线加固回归(清偿两周前清单审计查出的 E3 / A5a / B4)
//
// 覆盖三块,每个测试名都写明"防什么":
//
//   1) 批量重置上限(审计 E3):/api/admin/employees/bulk-reset 原先 slice(0, 3000)
//      静默截断 —— 名单 3,419 人(2 个管理员 + 3,417 名员工;审计 A4/E3 实测),跨页累加
//      全选 3,417 名员工再一键打下去,有 417 人被悄悄丢掉,响应不报错、弹窗只显示前
//      3,000 条,HR 以为发完了。修复后的口径:选中数 > 上限 → 整单 400(错误体同时给出
//      选中数与上限两个数字 + 中文分批建议),零副作用;选中数 == 上限 → 200 全量处理。
//      为什么用 LMS_RESET_CAP 环境旋钮:上限存在的理由是 scrypt 性能(几千次同步
//      scrypt 会长时间卡住事件循环),测试造不起 3001 个真用户;把上限旋到 5,用 6 个
//      用户就能验证同一条守卫逻辑。
//
//   2) 培训项目删除死锁(审计 A5a):DELETE /api/admin/tprojects/:id 的守卫原先数
//      所有 learner 行(含 withdrawn),而成员唯一的退出路径是软退出(state='withdrawn'),
//      导致凡是进过学员的项目永远删不掉(前端 memberCount==0 显示删除按钮,点了必 400)。
//      修复后的口径:守卫只数 state=='active' 的学员 —— 全部退出后可删;仍有 active
//      学员时照旧 400(守卫还在,只是口径修对了)。
//
//   3) 通知通路(审计 B4):scripts/notify-due.js 原先直调 store.createNotification,
//      绕过 notify() 的 email 挂钩 —— 定时提醒永远只有站内信,配好 email 也不发。
//      修复后必须走共享的 notify 模块(notify.js),且 sendEmail 在无 email 配置时
//      安全跳过({skipped:true}),绝不抛异常拖垮主流程。
//      notify.js 的约定(与服务端并行改动对齐):仓库根 notify.js,
//      module.exports = { notify, sendEmail },内部自行 require ./store.js,
//      配置读 LMS_CONFIG_PATH(未设则 config.json)。
//
// 【与服务端并行改动的时序】本文件动笔时服务端修复尚未合入(旧行为:超限 200 静默
// 截断且无 count 字段;学员退净后 DELETE 仍 400;notify-due.js 直调 createNotification;
// notify.js 不存在)—— 并行修复在本文件完稿前已落地,五项现应全绿。若在旧版服务端上
// 跑到红,红点即上述旧行为,属预期;这些断言就是钉死回归面用的。
// 注意:test/projects.test.js 原先钉的是旧口径(withdraw 后 DELETE 仍 400),已由
// 服务端分工同步改为新口径(退净后 200),与本文件互不冲突;那份文件不归本文件动。

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { ROOT, ADMIN, startServer, loginAs, makeClient } = require("./helpers.js");

// 一台共享测试服,LMS_RESET_CAP=5。这个旋钮只被 bulk-reset 的守卫消费,不影响
// 项目删除等其它路由,所以三组接口测试共用一次启动,少起一台服务器省几秒。
let srv, admin;
before(async () => {
  srv = await startServer({ env: { LMS_RESET_CAP: "5" } });
  admin = await loginAs(srv.base, ADMIN);
});
after(() => srv.stop());

// 建 n 个可登录的真员工(POST /api/admin/employees 返回初始密码),再从 roster
// 反查内部 user id(创建接口只回 employeeId,bulk-reset 按内部 id 寻址)。
async function createEmployees(n, prefix) {
  const out = [];
  for (let i = 1; i <= n; i++) {
    const employeeId = `${prefix}-${String(i).padStart(3, "0")}`;
    const r = await admin.post("/api/admin/employees", { name: `Ops Probe ${prefix} ${i}`, employeeId });
    assert.equal(r.status, 200, `建测试员工 ${employeeId} 失败: ${JSON.stringify(r.data)}`);
    out.push({ employeeId, password: r.data.password });
  }
  const roster = await admin.get("/api/admin/roster");
  assert.equal(roster.status, 200);
  for (const e of out) {
    const row = roster.data.find((u) => u.employeeId === e.employeeId);
    assert.ok(row, `roster 里找不到刚建的 ${e.employeeId}`);
    e.id = row.id;
  }
  return out;
}

async function canLogin(employeeId, password) {
  const c = makeClient(srv.base);
  const r = await c.login({ employeeId, password });
  return r.status === 200;
}

test("防 E3 静默截断:LMS_RESET_CAP=5 时全选 6 人 bulk-reset 必须整单 400(错误体含 6 与 5 两个数字和中文分批建议),且 6 人旧密码原样可登录 —— 绝不是 200 带部分结果", async () => {
  const emps = await createEmployees(6, "OPS-RCA");

  const refused = await admin.post("/api/admin/employees/bulk-reset", { userIds: emps.map((e) => e.id) });
  // 【预期转绿】旧服务端无 LMS_RESET_CAP,这里会拿到 200(slice 静默截断的口径)。
  assert.equal(refused.status, 400,
    `选中 6 > 上限 5 必须整单 400,不得部分处理(旧行为 200 静默截断即 E3)。实际: ${refused.status} ${JSON.stringify(refused.data)}`);
  const msg = String((refused.data && refused.data.error) || "");
  assert.ok(msg.includes("6"), `错误体应含选中数「6」,让 HR 知道选了多少。实际: ${msg}`);
  assert.ok(msg.includes("5"), `错误体应含上限「5」,让 HR 知道每批最多多少。实际: ${msg}`);
  assert.ok(msg.includes("分批"), `错误体应含中文分批建议(「分批」字样)。实际: ${msg}`);
  // 400 不得夹带部分结果:不能有任何 issued 行。
  assert.ok(!(refused.data && Array.isArray(refused.data.issued) && refused.data.issued.length),
    `400 响应绝不能带部分 issued 结果: ${JSON.stringify(refused.data)}`);

  // 零副作用:整单被拒后 6 人的原密码必须一个都没被动过。
  for (const e of emps) {
    assert.ok(await canLogin(e.employeeId, e.password),
      `${e.employeeId} 的旧密码应仍可登录 —— 超限 400 必须零副作用,不允许"拒了却重置了前几个"`);
  }
});

test("防 E3 回归的另一半:选中数 == 上限(5 人)→ 200 全量处理,响应 count=5,5 人新密码都能登录", async () => {
  const emps = await createEmployees(5, "OPS-RCB");

  const ok = await admin.post("/api/admin/employees/bulk-reset", { userIds: emps.map((e) => e.id) });
  assert.equal(ok.status, 200, `等于上限必须放行: ${JSON.stringify(ok.data)}`);
  // 【预期转绿】旧响应体只有 {ok, issued, skipped},没有 count 字段。
  assert.equal(ok.data.count, 5, `响应应带 count=5(全量处理的明账)。实际: ${JSON.stringify(ok.data)}`);
  assert.ok(Array.isArray(ok.data.issued) && ok.data.issued.length === 5,
    `issued 应恰好 5 行(一人一密码): ${JSON.stringify(ok.data)}`);

  // 5 人新密码全部真实可用 —— 防"报了 200 但有人实际没被重置"。
  for (const row of ok.data.issued) {
    assert.ok(row.employeeId && row.password, `issued 行应带 employeeId 与新密码: ${JSON.stringify(row)}`);
    assert.ok(await canLogin(row.employeeId, row.password), `${row.employeeId} 的新密码应能登录`);
  }
});

test("防 A5a 删除死锁:2 学员逐个软退出(state='withdrawn')后 DELETE 项目 → 200;仍有 active 学员时 DELETE 仍 400(守卫只是把口径从「所有 learner 行」修成「active 学员」,不是拆掉)", async () => {
  const created = await admin.post("/api/admin/tprojects", { title: "Ops Delete Probe", title_zh: "运维删除探针" });
  assert.equal(created.status, 200);
  const pid = created.data.id;
  const cohorts = [{
    id: "cohort-ops", name: "Ops Cohort", startAt: "2026-08-01", endAt: "2026-09-01",
    capacity: 10, classes: [], phases: [],
  }];
  assert.equal((await admin.put("/api/admin/tprojects/" + pid, { cohorts })).status, 200);

  const emps = await createEmployees(2, "OPS-TPD");
  const added = await admin.post(`/api/admin/tprojects/${pid}/members`, {
    cohortId: "cohort-ops", userIds: emps.map((e) => e.id),
  });
  assert.equal(added.status, 200);
  assert.equal(added.data.count, 2);

  // 守卫还在:有 active 学员时删除必须被拒,且项目原样保留。
  const refused = await admin.del("/api/admin/tprojects/" + pid);
  assert.equal(refused.status, 400, `有 2 名 active 学员时 DELETE 必须 400: ${JSON.stringify(refused.data)}`);
  assert.equal((await admin.get("/api/admin/tprojects/" + pid)).status, 200, "被拒的删除不得顺手删掉任何东西");

  // 逐个软退出 —— 这是成员唯一的退出路径(members/update action=withdraw,写 state='withdrawn')。
  for (const e of emps) {
    const w = await admin.post(`/api/admin/tprojects/${pid}/members/update`, { userId: e.id, action: "withdraw" });
    assert.equal(w.status, 200, `退出 ${e.employeeId} 失败: ${JSON.stringify(w.data)}`);
  }

  // 【预期转绿】旧守卫数所有 learner 行(withdrawn 也算),这里会 400 死锁。
  const gone = await admin.del("/api/admin/tprojects/" + pid);
  assert.equal(gone.status, 200,
    `学员全部退出且无出勤记录后 DELETE 应 200 —— 旧守卫把 withdrawn 也算进去导致永远删不掉(A5a)。实际: ${gone.status} ${JSON.stringify(gone.data)}`);
  assert.equal((await admin.get("/api/admin/tprojects/" + pid)).status, 404, "删除后项目应真的不存在");
});

test("防 B4 旁路回归(静态):scripts/notify-due.js 不得直调 store.createNotification(绕过 email 挂钩),必须引用共享的 notify()", () => {
  const src = fs.readFileSync(path.join(ROOT, "scripts", "notify-due.js"), "utf8");
  // 只禁真实调用,不禁注释:修复后的脚本头注释里合法地提到了旧旁路
  // ("It used to call store.createNotification() directly")。先剥注释再断言。
  // 该脚本没有含 // 或 /* 的字符串字面量,行级剥离是安全的;(^|[^:"'`]) 护住 "://"。
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
  assert.ok(!/store\s*\.\s*createNotification\s*\(/.test(code),
    "scripts/notify-due.js 直调了 store.createNotification —— 这正是 B4 的旁路:站内信落了,email 挂钩永远不触发。应改走 notify()");
  // 文件名自身就叫 notify-due.js,先剥掉再找引用,防止自指蒙混过关。
  const stripped = code.replace(/notify-due/g, "");
  assert.ok(/\bnotify\s*\(/.test(stripped) && /require\([^)]*notify[^)]*\)/.test(stripped),
    "scripts/notify-due.js 应引用共享通知模块(require notify.js 并调用 notify())—— 防止将来有人又改回直写库的旁路");
});

test("notify.js 单元:notify(userId,{title…}) 在临时库落 notifications 表一行;无 email 配置时 sendEmail 解析为 {skipped:true} 且不抛", async () => {
  // 全部指到临时目录:库、附件目录、config 都不碰仓库(config 指向不存在的文件
  // == 无 email 配置)。这些 env 在 require store.js/notify.js 之前设置才生效。
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lms-ops-notify-"));
  process.env.LMS_DB_PATH = path.join(dir, "unit.db");
  process.env.LMS_ATTACH_DIR = path.join(dir, "attachments");
  process.env.LMS_CONFIG_PATH = path.join(dir, "config-that-does-not-exist.json");
  process.env.LMS_DISABLE_AI = "1";

  const notifyPath = path.join(ROOT, "notify.js");
  // 【预期转绿】notify.js 由服务端分工从 server.js 抽出(约定见文件头)。
  assert.ok(fs.existsSync(notifyPath),
    "仓库根应有 notify.js(server.js 与 scripts/notify-due.js 共用的通知模块)—— 服务端并行改动落地后转绿");
  const mod = require(notifyPath);
  const notifyFn = typeof mod === "function" ? mod : mod.notify;
  const sendEmailFn = mod.sendEmail;
  assert.equal(typeof notifyFn, "function", "notify.js 应导出 notify(userId, n)");
  assert.equal(typeof sendEmailFn, "function", "notify.js 应导出 sendEmail(to, subject, html)");

  // 与 scripts/notify-due.js 相同的初始化方式:格式必须是 salt:scrypt。
  const store = require(path.join(ROOT, "store.js"));
  const hashPassword = (pw) => {
    const salt = crypto.randomBytes(16).toString("hex");
    return salt + ":" + crypto.scryptSync(pw, salt, 32).toString("hex");
  };
  store.init({ hashPassword });

  const uid = "u-ops-ntf1";
  store.createUser({ id: uid, employeeId: "OPS-NTF-001", name: "Notify Probe", role: "employee", passwordHash: hashPassword("x") });

  // 无 email 的用户:notify() 只应落站内信,不应碰 email 通路。
  await Promise.resolve(notifyFn(uid, {
    type: "ops-probe",
    title: "Ops probe", title_zh: "运维探针",
    body: "probe body", body_zh: "探针正文",
    link: "#/ops",
  }));
  const rows = store.listNotifications(uid, 10);
  assert.equal(rows.length, 1, "notify() 应在 notifications 表恰好落一行");
  assert.equal(rows[0].type, "ops-probe");
  assert.equal(rows[0].title, "Ops probe");
  assert.equal(rows[0].title_zh, "运维探针");
  assert.equal(rows[0].link, "#/ops");

  // 无 email 配置:sendEmail 必须安全跳过 —— 不抛(await 正常返回)、明确说明 skipped,
  // 且不需要任何网络。这是 notify-due 定时任务在裸机上也能安全跑的前提。
  const r = await sendEmailFn("nobody@example.com", "Ops subject", "<p>hi</p>");
  assert.ok(r && r.skipped === true,
    `无 email 配置时 sendEmail 应解析为 {skipped:true},实际: ${JSON.stringify(r)}`);
  // 临时库由本进程打开:先关连接再删目录(Windows 上打开着的库文件删不掉),不留残余目录
  store.close();
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 });
});
