// demo-start.js — 公开试用站启动器（Dockerfile 的 CMD；Render、Railway 都用它）
//
// 做这几件事：
//   1. 演示库：打包镜像时（Dockerfile 的 RUN … --build-seed）先造好一份种子库放在 data/seed/，
//      启动时复制一份来用 —— 免费托管会休眠，每次唤醒都是冷启动，现造要多等约 30 秒。
//      种子超过 SEED_MAX_DAYS 天就改为现造（演示数据里的「近 30 天」「本季度」等按造库日算，放久了会走样）。
//      每次部署 / 重启都从干净的一份开始，访客改过的数据都会复原。
//   2. 把所有带后台权限的账号（role=admin 或 adminRoleId 非空：ADMIN、UL-TEST 等）
//      的密码换成环境变量 DEMO_ADMIN_PASSWORD。演示库里的默认密码写在交接文档里，
//      公网上不换等于后台公开。没设这个变量就随机生成一个，只在日志里打印一次。
//      普通员工（UL-1001～UL-1100）保持 Demo1234，供访客试用。
//   3. 一直在线的托管上，每天北京时间 04:00 现造一份新库并切换过去（切换时停顿一两秒）。
//   另外给 server.js 设 LMS_DEMO_LOCK_PASSWORDS=1：员工演示账号是大家共用的，不许改密码，
//   否则一位访客改了密码，后面的人就都登录不了。
//
// 只用于演示：make-demo-db.js 在正式模式下拒绝运行。正式部署用 start-tms.bat / config.json。

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawn, spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const DATA = path.resolve(process.env.DEMO_DATA_DIR || path.join(ROOT, "data", "public-demo"));
const CONFIG = path.join(ROOT, "config.demo.json");
const SEED = path.join(ROOT, "data", "seed");   // 打包时造好的种子库（Dockerfile）
const SEED_MAX_DAYS = 7;
const RESET_HOUR_CST = 4; // 每日重置时间（北京时间）

function log(msg) { console.log(`[demo-start] ${msg}`); }

let adminPw = null;
function adminPassword() {
  if (adminPw) return adminPw;
  const pw = process.env.DEMO_ADMIN_PASSWORD || "";
  if (pw.length >= 8) return (adminPw = pw);
  adminPw = crypto.randomBytes(9).toString("base64url");
  log(pw ? "DEMO_ADMIN_PASSWORD 少于 8 位，已忽略。" : "没有设置 DEMO_ADMIN_PASSWORD。");
  log(`本次启动的后台密码（ADMIN / UL-TEST 等）：${adminPw} —— 重启后会变，建议在托管平台的环境变量里固定一个。`);
  return adminPw;
}

// 与 server.js 的 hashPassword 同一格式：16 字节盐 hex + ":" + scrypt 32 字节 hex
function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString("hex");
  return salt + ":" + crypto.scryptSync(pw, salt, 32).toString("hex");
}

function newGenDir() { return path.join(DATA, "gen-" + Date.now()); }

// 在 dir 里现造一份库（库文件、附件、迁移快照都在里面，换代时整目录删除）
function generate(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const dbPath = path.join(dir, "demo.db");
  log(`生成演示库 → ${dbPath}`);
  const r = spawnSync(process.execPath, [path.join(ROOT, "scripts", "make-demo-db.js")], {
    cwd: ROOT,
    stdio: "inherit",
    env: { ...process.env, ...genEnv(dir), PORT: "" },
  });
  if (r.status !== 0) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw new Error("make-demo-db.js 失败，退出码 " + r.status);
  }
}

// 现造一份可直接上线的库，返回目录
function buildGeneration() {
  const dir = newGenDir();
  generate(dir);
  lockAdmins(path.join(dir, "demo.db"));
  return dir;
}

// 优先复制种子库（秒级）；没有种子或种子太旧就现造
function firstGeneration() {
  const seedDb = path.join(SEED, "demo.db");
  if (fs.existsSync(seedDb)) {
    const ageDays = (Date.now() - fs.statSync(seedDb).mtimeMs) / 86400e3;
    if (ageDays <= SEED_MAX_DAYS) {
      const dir = newGenDir();
      fs.cpSync(SEED, dir, { recursive: true });
      lockAdmins(path.join(dir, "demo.db"));
      log(`用打包时造好的种子库（${ageDays.toFixed(1)} 天前）。`);
      return dir;
    }
    log(`种子库已有 ${ageDays.toFixed(0)} 天，改为现造。`);
  }
  return buildGeneration();
}

function genEnv(dir) {
  return {
    LMS_DB_PATH: path.join(dir, "demo.db"),
    LMS_ATTACH_DIR: path.join(dir, "attachments"),
    LMS_CONFIG_PATH: CONFIG,
    LMS_DISABLE_OFFICE_CONVERT: "1",
  };
}

function lockAdmins(dbPath) {
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(dbPath);
  const rows = db.prepare("SELECT id, employeeId FROM users WHERE role = 'admin' OR adminRoleId IS NOT NULL").all();
  const up = db.prepare("UPDATE users SET passwordHash = ?, mustChangePassword = 0 WHERE id = ?");
  for (const u of rows) up.run(hashPassword(adminPassword()), u.id);
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  db.close();
  log(`已更换 ${rows.length} 个后台账号的密码：${rows.map((u) => u.employeeId).join(", ")}`);
}

let child = null;
let current = null;
let switching = false;

function startServer(dir) {
  const env = {
    ...process.env,
    ...genEnv(dir),
    PORT: process.env.PORT || "8790",
    LMS_HOST: "0.0.0.0",
    LMS_DEMO_LOCK_PASSWORDS: "1", // 共用的员工演示账号不许改密（modules/core/routes.js）
    LMS_DEMO_HINT: "UL-1032 / Demo1234", // 登录框下方的演示账号提示（默认是 UL-TEST，它在试用站上已换成私有密码）
  };
  child = spawn(process.execPath, [path.join(ROOT, "server.js")], { cwd: ROOT, env, stdio: "inherit" });
  child.on("exit", (code, signal) => {
    if (switching) return;
    log(`server.js 意外退出（code=${code}, signal=${signal}），交给托管平台重启。`);
    process.exit(code || 1);
  });
  current = dir;
}

function stopServer() {
  return new Promise((resolve) => {
    if (!child || child.exitCode !== null) return resolve();
    const t = setTimeout(() => child.kill("SIGKILL"), 10000);
    child.once("exit", () => { clearTimeout(t); resolve(); });
    child.kill("SIGTERM");
  });
}

function msUntilNextReset() {
  // 北京时间 = UTC+8，没有夏令时
  const now = Date.now();
  const d = new Date(now + 8 * 3600e3);
  d.setUTCHours(RESET_HOUR_CST, 0, 0, 0);
  let next = d.getTime() - 8 * 3600e3;
  if (next <= now) next += 24 * 3600e3;
  return next - now;
}

function scheduleReset() {
  setTimeout(async () => {
    try {
      const fresh = buildGeneration(); // 旧服务照常在线，新库造好再切
      switching = true;
      await stopServer();
      const old = current;
      startServer(fresh);
      switching = false;
      fs.rmSync(old, { recursive: true, force: true });
      log("每日重置完成。");
    } catch (e) {
      switching = false;
      log("每日重置失败，继续用旧库：" + e.message);
      if (!child || child.exitCode !== null) startServer(current);
    }
    scheduleReset();
  }, msUntilNextReset());
}

for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, async () => { switching = true; await stopServer(); process.exit(0); });
}

if (process.argv.includes("--build-seed")) {
  // 打包镜像时运行（Dockerfile）：只造种子库，不启动服务
  fs.rmSync(SEED, { recursive: true, force: true });
  generate(SEED);
  log(`种子库已生成 → ${SEED}`);
} else {
  // 启动：清掉上一次留下的库，换一份干净的
  fs.rmSync(DATA, { recursive: true, force: true });
  startServer(firstGeneration());
  scheduleReset();
}
