// test/data-consistency.test.js — 商业化 audit P0 第一条:数据一致性闭环。
//
// 病灶:server.js 把课程/项目常驻内存(PROGRAMS/COURSES/TPROJECTS/COURSE_PROGRAMS),
// 服务端写点手动 refreshContent(),但随包脚本绕过服务直写库 —— 库变了服务看不见,
// 客户实例上表现为「课程库 3 门草稿,员工端却在学第 4 门」这类灵异。本文件钉四道闸:
//
//   1) 跨进程缓存失效 —— SQLite PRAGMA data_version:别的连接一提交就 +1,server 在
//      handleApi 入口廉价检查,变了就 refreshContent()。测法:起服务后用 node:sqlite
//      直连同一个库插一门课,不重启立刻打 /api/catalog,新课必须出现。
//   2) 引用完整性 —— store.checkReferences() 核五类悬空引用(assignments→program、
//      program.courseIds→course、exam_courses→course、attempts→exam、
//      review_items→cycle),GET /api/admin/integrity 按需重跑返回明细。测法:
//      干净库无任何 count>0 的类目;直连库种一条指向不存在 program 的 assignment,
//      assignments→program 类目 count>=1 且 sample 点名悬空 id。
//   3) 实例标识 —— /api/env 的 instance = sha256(解析后的 DB_PATH).slice(0,8):
//      排障第一问「你连的是哪个库」一眼可辨。同库重启指纹不变,异库指纹不同;
//      GET /api/admin/instance 返回全量(dbPath/schemaVersion/bootedAt/node/
//      cacheRefreshedAt)。
//   4) 写库脚本护栏 —— server 启动时在库文件旁写 <db>.server.lock(JSON:
//      pid/port/bootedAt),锁在且 pid 活着时随包写库脚本拒绝运行。测法:运行中
//      锁在且 pid 正确;停服后锁释放(删除或 pid 已死,两种都算 —— 见该测试内注释)。
//
// 【与服务端并行改动的时序】本文件与服务端实现并行动笔。曾在未合入的旧版服务端上
// 实测:四项各红在预期断言上(catalog 看不到直写的新课 / integrity 与 instance 404 /
// /api/env 无 instance 字段 / 找不到锁文件)—— 红点即旧行为本身,证明断言钉在病灶上。
// 服务端分工于本文件完稿前落地(server.js/store.js,2026-08-27),现五项全绿。
// 测试 5(员工 403)在旧版服务端上也绿:/api/admin/* 有总闸(「Admin only」),
// 钉住防止将来新端点绕过总闸。
//
// 【本文件即契约】响应形状上,以下几点是与服务端对齐后的机制合同,动一处这里就红:
//   · /api/env.instance:8 位小写 hex(sha256 hex digest 的前 8 位天然小写);
//   · /api/admin/instance:instance、dbPath、schemaVersion(=MAX(schema_migrations
//     .version))、bootedAt、node 版本(键名 node 或 nodeVersion 均可,断言写宽容)、
//     cacheRefreshedAt;
//   · /api/admin/integrity:{ issues: [{kind, count, sample(≤3 个 id)}], checkedAt }。
//     干净库判据 = issues 里没有任何 count>0 的类目(全类目报 count=0 与只列出
//     count>0 的类目、干净时为空数组,两种实现都算对齐 —— 断言按此写宽容);
//     「确实查过而不是没查」由 checkedAt 作证;悬空时 sample 必须点名悬空的 id 本身;
//   · 锁文件:与库同目录、文件名以 .server.lock 结尾,JSON 至少含 pid/port/bootedAt;
//   · 两个新端点归 core:全模块关门(LMS_MODULES_OFF)下照常应答 —— MODULES.md 的教训。

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { ADMIN, EMPLOYEE, startServer, loginAs } = require("./helpers.js");

// ---------- 小工具 ----------

// 直连测试服自己的库 —— 模拟「绕过服务直写库的脚本」这个角色。store.js 用 WAL,
// 第二个连接读写都不受服务端连接阻塞;提交即 bump data_version,无需任何等待。
function openDb(dbPath) {
  return new DatabaseSync(dbPath);
}

// 库文件旁所有 *.server.lock。按后缀找而不写死文件名:契约只说「库文件旁的
// <db>.server.lock」,test.db.server.lock / test.server.lock 都算对齐;每个测试库
// 独占一个 mkdtemp 临时目录,不会误捡别人的锁。
function lockFilesBeside(dbPath) {
  const dir = path.dirname(dbPath);
  return fs.readdirSync(dir).filter((f) => f.endsWith(".server.lock")).map((f) => path.join(dir, f));
}

// process.kill(pid, 0):不发信号,只探活。Windows 上同样可用(打不开进程句柄即抛)。
function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

// 等子进程真正退出。注意调用时机:先拿到这个 promise 再 stop(),监听器注册在
// kill 之前,不会漏掉 exit 事件;已退出则立即返回。10 秒兜底防挂死。
function waitExit(child) {
  if (child.exitCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const t = setTimeout(resolve, 10000);
    child.once("exit", () => { clearTimeout(t); resolve(); });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Windows 路径比较:大小写不敏感、分隔符不敏感 —— 只要指向同一个文件就算同一个库。
function normPath(p) {
  return path.resolve(String(p)).replace(/\\/g, "/").toLowerCase();
}

// 一台共享测试服跑测试 1/2/3/5(测试写入互不干扰:测试 1 写的是引用完好的内容,
// 不会污染测试 2 的完整性判定 —— 这本身也是断言的一部分,见测试 2 注释)。
// 测试 3 的重启对照与测试 4 的停服各自另起专用服务。
let srv, admin, emp;
before(async () => {
  srv = await startServer();
  admin = await loginAs(srv.base, ADMIN);
  emp = await loginAs(srv.base, EMPLOYEE);
});
after(() => srv.stop());

// ---------- 1) 跨进程缓存失效 ----------

test("跨进程缓存失效:别的进程直写库加一门课,服务不重启,员工 /api/catalog 必须立刻看到 —— 防「课程库 3 门草稿,员工端在学第 4 门」", async () => {
  const now = new Date().toISOString();
  // 目录页展示的是 program(单课包装即课程本身),所以课 + 包装包一起插 ——
  // 断言里同时核 courseCount/moduleCount,证明 COURSES 缓存也刷了,不只 PROGRAMS。
  const course = {
    id: "xp-course-1",
    title: "Cross-Process Probe Course",
    title_zh: "跨进程探针课程",
    modules: [{ id: "m1", title: "Probe Module", title_zh: "探针模块", minutes: 5, sections: [] }],
  };
  const program = {
    id: "xp-prog-1",
    title: "Cross-Process Probe Program",
    title_zh: "跨进程探针项目",
    status: "published",
    courseIds: ["xp-course-1"],
    passingScore: 80,
    enrollType: "elective",
  };
  const db = openDb(srv.dbPath);
  const ins = db.prepare("INSERT INTO content (kind, id, json, updatedAt) VALUES (?, ?, ?, ?)");
  ins.run("course", course.id, JSON.stringify(course), now);
  ins.run("program", program.id, JSON.stringify(program), now);
  db.close(); // 提交已落库;data_version 在别的连接看来已 +1

  const r = await emp.get("/api/catalog");
  assert.equal(r.status, 200, `/api/catalog 应答异常: ${JSON.stringify(r.data)}`);
  const hit = r.data.find((p) => p.id === program.id);
  assert.ok(
    hit,
    "直写库新增的已发布课程没有出现在 /api/catalog —— PROGRAMS 内存缓存没有因别的连接提交而失效(PRAGMA data_version 检查缺失或没接进 handleApi 入口),这正是客户实例「库和界面各说各话」的根因"
  );
  assert.equal(hit.courseCount, 1, "catalog 卡片 courseCount 应为 1 —— COURSES 缓存(不只 PROGRAMS)也必须一并刷新,否则包里的课解析不出来");
  assert.equal(hit.moduleCount, 1, "catalog 卡片 moduleCount 应为 1 —— 课程模块要能从刷新后的 COURSES 缓存里解析出来");
});

// ---------- 2) 引用完整性 ----------

test("引用完整性:干净库无任何 count>0 的类目且 checkedAt 作证「确实查过」;直写一条指向不存在 program 的 assignment 后,assignments→program 类目 count>=1 且 sample 点名悬空 id —— 让「员工被指派了不存在的课」自我暴露而不是靠客户报灵异", async () => {
  // 先核干净库(种子数据 + 测试 1 刚写入的引用完好的内容)——「合法的跨进程写入
  // 不该被误报」与「干净库不报问题」在这里是同一条断言。
  const clean = await admin.get("/api/admin/integrity");
  assert.equal(clean.status, 200, `GET /api/admin/integrity 应答异常: ${JSON.stringify(clean.data)}`);
  assert.ok(Array.isArray(clean.data.issues), "integrity 响应必须带 issues 数组: " + JSON.stringify(clean.data));
  // 干净库判据写宽容:全类目报 count=0 与「只列 count>0、干净时为空数组」两种实现
  // 都算对齐,判定标准只有一条 —— 没有任何类目 count>0。
  for (const i of clean.data.issues)
    assert.equal(
      i.count, 0,
      `干净库不该报任何悬空引用 —— ${i.kind} 报了 count=${i.count},即误报(若是种子数据本身悬空,这正是该检查要抓的): ` + JSON.stringify(clean.data.issues)
    );
  assert.ok(
    !Number.isNaN(Date.parse(clean.data.checkedAt)),
    "checkedAt 必须是可解析的时间串 —— 它是「查过了、确实没问题」与「压根没查」的区别,界面/巡检就靠它分辨: " + JSON.stringify(clean.data.checkedAt)
  );

  // 种一条悬空 assignment:真实存在的员工 u-1001 被指向一个不存在的 program ——
  // 与 audit 观测到的客户症状同构。
  const GHOST = "ghost-prog-p0-audit";
  const db = openDb(srv.dbPath);
  db.prepare("INSERT INTO assignments (userId, programId, dueAt, assignedAt) VALUES (?, ?, NULL, ?)")
    .run("u-1001", GHOST, new Date().toISOString());
  db.close();

  // 「按需重跑」:同一端点第二次调用要反映刚写入的新状态,不能回放启动时的结论。
  const dirty = await admin.get("/api/admin/integrity");
  assert.equal(dirty.status, 200);
  const entry = (dirty.data.issues || []).find((i) => /assignment/i.test(String(i && i.kind)));
  assert.ok(
    entry,
    "种下悬空 assignment 后 issues 里必须出现 assignments→program 类目 —— 否则检查没有真的去核这张表: " + JSON.stringify(dirty.data)
  );
  assert.ok(entry.count >= 1, `assignments→program 的 count 应 >=1,实际 ${entry.count}`);
  assert.ok(
    JSON.stringify(entry.sample || []).includes(GHOST),
    `sample 必须点名悬空的 programId(${GHOST})—— 只给数字不给 id,排障还是要人肉翻库: ${JSON.stringify(entry)}`
  );
});

// ---------- 3) 实例标识 ----------

test("实例标识:/api/env.instance 是 8 位小写 hex;/api/admin/instance 给全量;同库重启指纹不变、异库指纹必不同 —— 排障第一问「你连的是哪个库」一眼可辨", async () => {
  // /api/env 是公开端点:只放 8 位指纹,不放路径(路径是敏感信息,只进 admin 端点)。
  const envRes = await fetch(srv.base + "/api/env");
  assert.equal(envRes.status, 200);
  const env = await envRes.json();
  assert.match(
    String(env.instance || ""),
    /^[0-9a-f]{8}$/,
    "/api/env.instance 应为 sha256(解析后的 DB_PATH) 的前 8 位小写 hex,实际: " + JSON.stringify(env.instance)
  );

  // admin 全量端点:字段齐、值对得上。
  const info = await admin.get("/api/admin/instance");
  assert.equal(info.status, 200, `GET /api/admin/instance 应答异常: ${JSON.stringify(info.data)}`);
  assert.equal(
    normPath(info.data.dbPath), normPath(srv.dbPath),
    `instance.dbPath 必须指向本服务真正打开的库(排障就靠它对质),期望 ${srv.dbPath},实际 ${info.data.dbPath}`
  );
  // schemaVersion 直查 schema_migrations 对表 —— 不是「一个像版本号的数」,是那个数。
  const db = openDb(srv.dbPath);
  const maxVer = db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get().v;
  db.close();
  assert.equal(info.data.schemaVersion, maxVer, `instance.schemaVersion 应等于 MAX(schema_migrations.version)=${maxVer},实际 ${info.data.schemaVersion}`);
  assert.ok(!Number.isNaN(Date.parse(info.data.bootedAt)), "instance.bootedAt 应为可解析的时间串,实际: " + JSON.stringify(info.data.bootedAt));
  const nodeVer = info.data.node || info.data.nodeVersion; // 键名 node/nodeVersion 均可(契约允许,断言写宽容)
  assert.ok(typeof nodeVer === "string" && nodeVer.length > 0, "instance 应报 node 版本(键 node 或 nodeVersion): " + JSON.stringify(info.data));
  assert.ok(info.data.cacheRefreshedAt, "instance.cacheRefreshedAt 缺失 —— 「缓存最后一次刷新是什么时候」正是排查缓存陈旧问题的第一手证据");
  if (info.data.instance !== undefined)
    assert.equal(info.data.instance, env.instance, "admin 全量端点若带 instance 指纹,必须与 /api/env 的一致");

  // 指纹的两条性质,各起专用服务对照:
  //   同库重启 → 指纹不变(指纹认库,不认进程);异库 → 指纹必不同。
  const a = await startServer();
  const fp1 = (await (await fetch(a.base + "/api/env")).json()).instance;
  const aExited = waitExit(a.child);
  a.stop();
  await aExited;
  const b = await startServer({ dbPath: a.dbPath }); // 同一个库文件再起一台
  const fp2 = (await (await fetch(b.base + "/api/env")).json()).instance;
  const bExited = waitExit(b.child);
  b.stop();
  await bExited;
  assert.equal(fp2, fp1, "同一库文件重启后指纹变了 —— 指纹里混进了随机量(如 bootedAt/pid),它必须只由解析后的库路径决定");
  assert.notEqual(env.instance, fp1, "两台连着不同库文件的服务指纹相同 —— 指纹没把库路径哈希进去,失去「你连的是哪个库」的辨别力");
});

// ---------- 4) 写库锁护栏(+ 新端点归 core) ----------

test("写库锁护栏:运行中库旁有 *.server.lock 且 pid/port 正确;全模块关门下 integrity/instance 照常应答(新端点归 core);停服后锁释放(删除或 pid 已死均算)", async () => {
  // 这台专用服务顺便肩负 MODULES.md 的教训:LMS_MODULES_OFF 关掉全部三个模块,
  // 两个新端点和 /api/env 必须照常应答 —— 它们是排障基础设施,归 core,
  // 不进模块关门清单。
  const s = await startServer({ env: { LMS_MODULES_OFF: "learning,performance,talent" } });
  try {
    const locks = lockFilesBeside(s.dbPath);
    assert.equal(
      locks.length, 1,
      "服务运行中,库文件旁应恰有一个 *.server.lock(随包写库脚本靠它拒绝在服务运行时直写库),目录内容: " + fs.readdirSync(path.dirname(s.dbPath)).join(", ")
    );
    const lock = JSON.parse(fs.readFileSync(locks[0], "utf8"));
    assert.equal(lock.pid, s.child.pid, `锁文件 pid 应为服务进程 pid(${s.child.pid}),实际 ${lock.pid} —— pid 错了,护栏的探活判断会放行不该放行的脚本`);
    assert.equal(String(lock.port), new URL(s.base).port, `锁文件 port 应为服务端口(${new URL(s.base).port}),实际 ${lock.port}`);
    assert.ok(lock.bootedAt, "锁文件应含 bootedAt —— 人看一眼就知道这把锁是哪次启动留下的");
    assert.ok(pidAlive(lock.pid), "锁里的 pid 此刻应当活着(服务还在跑)—— 探活手段与脚本护栏同款 process.kill(pid, 0)");

    const adminC = await loginAs(s.base, ADMIN);
    const ri = await adminC.get("/api/admin/integrity");
    assert.equal(ri.status, 200, "全模块关门下 /api/admin/integrity 不该 404 —— 新端点必须归 core,别再犯 MODULES.md 里记过的那次错");
    const rs = await adminC.get("/api/admin/instance");
    assert.equal(rs.status, 200, "全模块关门下 /api/admin/instance 不该 404 —— 同上,归 core");
    const envOff = await (await fetch(s.base + "/api/env")).json();
    assert.match(String(envOff.instance || ""), /^[0-9a-f]{8}$/, "全模块关门下 /api/env 仍要带 instance 指纹(公开 core 端点)");
  } finally {
    const exited = waitExit(s.child);
    s.stop();
    await exited;
  }

  // 停服后的释放断言故意写宽容:helpers.stop() 是 child.kill() 硬终止,Windows 上
  // 进程没有机会跑退出钩子,「尽力删除」大概率删不掉 —— 这不是缺陷:护栏的判定是
  // 「锁在 且 pid 活着」才拒绝,pid 死了脚本照样放行,所以「锁删掉了」与「锁残留但
  // pid 已死」两种结局对护栏语义完全等价,都算过。轮询 2 秒容忍文件系统/句柄迟滞。
  const deadline = Date.now() + 2000;
  let released = false;
  let last = "";
  while (Date.now() < deadline) {
    const ls = lockFilesBeside(s.dbPath);
    if (ls.length === 0) { released = true; break; }
    let lockedPid = null;
    try { lockedPid = JSON.parse(fs.readFileSync(ls[0], "utf8")).pid; } catch { /* 半删除瞬间读不到也算在途 */ }
    if (lockedPid != null && !pidAlive(lockedPid)) { released = true; break; }
    last = `锁仍在(${ls[0]})且 pid=${lockedPid} 仍活着`;
    await sleep(100);
  }
  assert.ok(released, "停服后锁必须失效(文件删除或 pid 已死),否则脚本护栏死锁——服务停了脚本还是不肯跑。最后状态: " + last);
});

// ---------- 5) 越权防线 ----------

test("越权防线:员工打 /api/admin/integrity 与 /api/admin/instance 必须 403 —— dbPath 等实例信息只给管理员;此断言在旧版服务端也绿(/api/admin/* 总闸),钉住防新端点绕闸回归", async () => {
  const r1 = await emp.get("/api/admin/integrity");
  assert.equal(r1.status, 403, `员工访问 /api/admin/integrity 应 403,实际 ${r1.status}: ${JSON.stringify(r1.data)}`);
  const r2 = await emp.get("/api/admin/instance");
  assert.equal(r2.status, 403, `员工访问 /api/admin/instance 应 403(响应含 dbPath,泄给员工即泄服务器文件系统布局),实际 ${r2.status}: ${JSON.stringify(r2.data)}`);
});
