// Fresh-start reset for user acceptance testing. Run with the server STOPPED,
// after scripts/backup.js. KEEPS: accounts, courses/packages/exams/questions,
// uploaded files, manager links. CLEARS: every transactional record — learning
// progress, attempts, notifications, approvals (enroll + nominations),
// training-project docs & memberships & attendance, audit log, content
// versions, sessions, the domain-event outbox, and every module-owned table
// (Behavior Practice / culture: programs, participants and all their records —
// module_migrations stays). Assignments are re-issued fresh: every active
// non-admin employee gets each published MANDATORY package with a new due date.
//   Usage:  node scripts/reset-for-uat.js
// 「服务必须停」不再只是注释里的一句话：下面的 refuseIfServerLive 护栏会检测
// <db>.server.lock + pid 存活，服务还开着就拒绝运行（LMS_ALLOW_LIVE_DB=1 可强制）。
const path = require("path");
const { DatabaseSync } = require("node:sqlite");

// ---------- 护栏：服务运行中拒绝直写数据库 live-server write guard ----------
// server.js 启动时在库文件旁写 <db>.server.lock（JSON: {pid, port, bootedAt}），退出
// 钩子尽力删除。锁在且 pid 仍活着（process.kill(pid, 0) 零信号探测，Windows 同样可用）
// 说明服务正开着这个库：本脚本绕过服务直写 SQLite，服务的常驻内存缓存要等下一个请求
// 才会追上，写坏引用则要等启动体检才暴露 —— 所以默认拒绝。kill -9 / 断电留下的孤锁
// pid 已死，探测失败即放行，不误伤。明知故犯的口子：LMS_ALLOW_LIVE_DB=1 强制放行。
// 这段守卫在每个随包交付的写库脚本里各自内联一份（脚本零依赖原则，二十行不值得共享
// 模块），但各份必须**逐字一致** —— 改这里必须同步改其它脚本里的同名函数。
function refuseIfServerLive(dbPath) {
  const lockPath = dbPath + ".server.lock";
  let lock;
  try { lock = JSON.parse(require("fs").readFileSync(lockPath, "utf8")); } catch { return; } // 无锁/坏锁 = 没有活服务
  const pid = Number(lock && lock.pid);
  if (!Number.isFinite(pid) || pid <= 0) return;
  let alive = false;
  try { process.kill(pid, 0); alive = true; } catch (e) { alive = !!e && e.code === "EPERM"; } // EPERM = 进程在，只是没权限碰它
  if (!alive) return; // 孤锁：pid 已死，放行
  if (process.env.LMS_ALLOW_LIVE_DB === "1") {
    console.warn(`[guard] LMS_ALLOW_LIVE_DB=1 —— 服务仍在运行（pid ${pid}），强制继续。 Forcing on while the server is live.`);
    return;
  }
  console.error(`服务好像正在运行（pid ${pid}${lock.port ? "，端口 " + lock.port : ""}，锁 ${lockPath}），本脚本直写数据库，已拒绝运行。`);
  console.error(`The server appears to be RUNNING (pid ${pid}${lock.port ? ", port " + lock.port : ""}, lock ${lockPath}); this script writes the database directly, so it refused to run.`);
  console.error(`请先停掉服务再运行；确要带着运行中的服务硬写，设 LMS_ALLOW_LIVE_DB=1。 Stop the server first, or set LMS_ALLOW_LIVE_DB=1 to force through.`);
  process.exit(1);
}
// 本脚本一向只重置根目录的 lms.db（不读 LMS_DB_PATH）—— 护栏看的也是同一个文件。
const DB_PATH = path.join(__dirname, "..", "lms.db");
refuseIfServerLive(DB_PATH);

const db = new DatabaseSync(DB_PATH);
db.exec("PRAGMA foreign_keys=OFF");

// ---------- 模块自带迁移建的表 module-owned tables ----------
// manifest 写了 migrations 的模块（目前是 culture 行为实践：modules/culture/migrations/ 建的 20 张 p33_ 表）
// 的表不在 store.js 里，清单从 modules/<id>/manifest.js 的 tables 读，以后模块加表不会漏清。
// module_migrations（模块迁移的执行记录）**不清**：表结构还在、只清数据时不必动它；清掉会让下次启动把已执行的
// 迁移文件当成待执行再跑一遍（建表语句带 IF NOT EXISTS，结果不变，但会多做一次迁移前备份）。
// 这段在每个清库脚本里各自内联一份（脚本零依赖、各自独立），改这里记得同步 wipe-to-clean、clean-keep-admins。
function moduleOwnedTables() {
  const dir = path.join(__dirname, "..", "modules");
  const out = [];
  try {
    for (const id of require(path.join(dir, "index.js"))) {
      const m = require(path.join(dir, id, "manifest.js"));
      if (m && m.migrations && Array.isArray(m.tables)) out.push(...m.tables.filter((t) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(t)));
    }
  } catch (e) { console.log("skip: module tables -", e.message); }
  return out;
}

const wipe = [
  "attempts", "progress", "notifications", "activity_state",
  "project_members", "approvals", "enrollment_requests",
  "audit_logs", "content_versions", "sessions",
  // 领域事件发件箱（迁移 49）同属事务记录：UAT 从干净的事件流开始。
  // The domain-event outbox (migration 49) is transactional history too.
  "event_outbox",
  // 行为实践（culture）的项目、参与名单与全部过程数据（p33_*）：UAT 从没有项目的状态开始，
  // 与上面「培训项目整体移除」同一口径；HR 重新建项目、导入名单。module_migrations 保留（见上）。
  // Behavior Practice programs and everything under them go too; module_migrations stays.
  ...moduleOwnedTables(),
];
for (const t of wipe) {
  try { db.exec(`DELETE FROM ${t}`); console.log("cleared:", t); }
  catch (e) { console.log("skip:", t, "-", e.message); }
}

// demo/test training projects go away entirely
const tp = db.prepare("SELECT id FROM content WHERE kind = 'tproject'").all();
db.exec("DELETE FROM content WHERE kind = 'tproject'");
console.log("removed tprojects:", tp.map((x) => x.id).join(", ") || "(none)");

// re-issue assignments: mandatory published packages → all active non-admin users
db.exec("DELETE FROM assignments");
const programs = db.prepare("SELECT json FROM content WHERE kind = 'program'").all()
  .map((r) => JSON.parse(r.json))
  .filter((p) => (p.status || "published") === "published" && (p.enrollType || "mandatory") !== "elective");
const users = db.prepare("SELECT id, role, active FROM users").all()
  .filter((u) => u.active !== 0 && u.role !== "admin");
const now = new Date().toISOString();
const ins = db.prepare("INSERT OR IGNORE INTO assignments (userId, programId, dueAt, assignedAt) VALUES (?, ?, ?, ?)");
let n = 0;
for (const u of users) {
  for (const p of programs) {
    const due = new Date(Date.now() + (p.defaultDueDays || 30) * 864e5).toISOString().slice(0, 10);
    ins.run(u.id, p.id, due, now);
    n++;
  }
}
console.log(`assignments re-issued: ${n} (users ${users.length} × mandatory packages ${programs.length})`);

db.exec("VACUUM");
db.close();
console.log("reset done — restart the server and hard-refresh browsers.");
