// One-shot database backup for DigiPlus Talent (TMS).
//
// Usage:  runtime\node.exe scripts\backup.js                备份一次
//         runtime\node.exe scripts\backup.js --prune        顺便列出可清理的旧备份（只列不删）
//         runtime\node.exe scripts\backup.js --prune --yes  真的删
//         node scripts/backup.js                          (Mac/Linux)
//
// 保留策略（--prune 用的）：
//   · 名字带里程碑字样的永久保留（REAL-ROSTER / pre-fake / premerge / pre-upstream）
//   · 最近 14 天内的备份全部保留
//   · pre-migration 快照：只保留版本号最高的 3 个版本
//   · 模块迁移前的快照（pre-migration-vmodules-…，没有 TMS 版本号）：只保留最新的 3 份
//   · 其余（14 天前的普通备份、早期低版本 pre-migration、更早的模块迁移快照）可清理
//   · lms-<时间戳>-files\ 目录与同时间戳的 .db 配对：.db 保留它就保留，
//     .db 被删时连带删掉它，不留孤儿
// 意思是：能回退到「最近两周任意一天」和「最近三次结构变更之前」；更早的快照对应的是
// 已经迁移过去很多版的旧结构，留着只占地方。
//
// Uses SQLite's VACUUM INTO, which takes a consistent snapshot even while the
// server is running (WAL mode) — no need to stop the service first. Backups
// land in backups/lms-YYYYMMDD-HHMMSS.db next to the live database.
//
// After the DB snapshot, uploaded files that live OUTSIDE the database are
// copied too — only when they actually contain files (empty/missing dirs are
// skipped with a note, no empty shells; a copy that errors out mid-way is
// removed again and reported, never left as a half backup):
//   data/attachments (LMS_ATTACH_DIR overrides) → backups/lms-<stamp>-files/attachments/
//   public/videos                               → backups/lms-<stamp>-files/videos/
//
// To RESTORE a backup:
//   1. Stop the server.
//   2. Delete lms.db, lms.db-wal and lms.db-shm.
//   3. Copy the backup file to lms.db.
//   4. If the backup has a matching lms-<stamp>-files/ directory, copy
//      attachments/ back to data/attachments (or LMS_ATTACH_DIR) and
//      videos/ back to public/videos.
//   5. Start the server again.

const fs = require("fs");
const path = require("path");

const _emitWarning = process.emitWarning;
process.emitWarning = function (warning, ...args) {
  const type = args[0] && (typeof args[0] === "string" ? args[0] : args[0].type);
  if (type === "ExperimentalWarning" && String(warning).includes("SQLite")) return;
  return _emitWarning.call(process, warning, ...args);
};
const { DatabaseSync } = require("node:sqlite");

const ROOT = path.join(__dirname, "..");
const DB_PATH = process.env.LMS_DB_PATH ? path.resolve(process.env.LMS_DB_PATH) : path.join(ROOT, "lms.db");
const BACKUP_DIR = path.join(ROOT, "backups");

if (!fs.existsSync(DB_PATH)) {
  console.error(`No database found at ${DB_PATH} — nothing to back up.`);
  process.exit(1);
}
fs.mkdirSync(BACKUP_DIR, { recursive: true });

// Local time in the filename — matches the clock HR sees on the machine.
const now = new Date();
const pad = (n) => String(n).padStart(2, "0");
const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
const dest = path.join(BACKUP_DIR, `lms-${stamp}.db`);

const db = new DatabaseSync(DB_PATH, { readOnly: true });
try {
  db.exec(`VACUUM INTO '${dest.replace(/'/g, "''")}'`);
} finally {
  db.close();
}

const size = fs.statSync(dest).size;
console.log(`Backup OK: ${dest} (${(size / 1024).toFixed(0)} KB)`);
console.log("To restore: stop the server, delete lms.db / lms.db-wal / lms.db-shm, copy this file to lms.db, restart.");

// ---------------- 附件与视频（库外文件） ----------------
// data/attachments 与 public/videos 不在 lms.db 里，只备库等于课件全丢。
// 有内容才拷；空目录/不存在的只提示一行，不造空壳。
function countTree(dir) {
  let files = 0, bytes = 0, entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return { files, bytes }; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) { const sub = countTree(full); files += sub.files; bytes += sub.bytes; }
    else if (e.isFile()) { files += 1; bytes += fs.statSync(full).size; }
  }
  return { files, bytes };
}

const ATTACH_DIR = process.env.LMS_ATTACH_DIR
  ? path.resolve(process.env.LMS_ATTACH_DIR)
  : path.join(ROOT, "data", "attachments");
const FILE_SETS = [
  { label: "attachments", src: ATTACH_DIR },
  { label: "videos", src: path.join(ROOT, "public", "videos") },
];
const filesDest = path.join(BACKUP_DIR, `lms-${stamp}-files`);
const copiedSets = [];
for (const { label, src } of FILE_SETS) {
  const destDir = path.join(filesDest, label);
  try {
    const { files, bytes } = countTree(src);
    if (!files) {
      console.log(`Files skipped: ${src} 为空或不存在，未拷贝。`);
      continue;
    }
    fs.cpSync(src, destDir, { recursive: true });
    console.log(`Files OK: ${destDir} (${files} 个文件, ${(bytes / 1024).toFixed(0)} KB)`);
    copiedSets.push({ label, src });
  } catch (err) {
    // 拷了一半的副本比没有更危险：恢复步骤是 robocopy /MIR 拷回原位，半份会把原位删空。
    // 所以拷贝出错就删掉这份残留，只留一行报错；数据库快照本身已经成功，下面的 --prune 照跑。
    try { fs.rmSync(destDir, { recursive: true, force: true }); } catch {}
    console.error(`Files FAILED: ${src} 拷贝出错，未产出副本（残留已清掉）—— ${err.message}`);
    console.error("  数据库快照本身已完成、可以照常用；文件副本请排查后重跑（常见原因：磁盘满、文件被占用）。");
    process.exitCode = 1;
  }
}
// 一份都没拷成时不留空壳目录（父目录可能已被 cpSync 建出来了）
if (!copiedSets.length) { try { fs.rmdirSync(filesDest); } catch {} }
if (copiedSets.length) {
  console.log(`To restore files: ${copiedSets.map((s) => `copy ${path.join(filesDest, s.label)} back to ${s.src}`).join("; ")}.`);
}

// ---------------- 清理旧备份（可选） ----------------
const args = process.argv.slice(2);
if (args.includes("--prune")) {
  const KEEP_DAYS = 14;
  const KEEP_MIGRATION_VERSIONS = 3;
  const KEEP_MODULE_MIGRATIONS = 3;
  const MILESTONE = /real-roster|pre-fake|premerge|pre-upstream/i;
  const cutoff = Date.now() - KEEP_DAYS * 86400000;

  const files = fs.readdirSync(BACKUP_DIR)
    .filter((f) => f.endsWith(".db"))
    .map((f) => {
      const full = path.join(BACKUP_DIR, f);
      const st = fs.statSync(full);
      // pre-migration-v37 / pre-migration-v8-9-10 → 取里面最大的版本号
      const vs = (f.match(/pre-migration-v([\d-]+)/) || [])[1];
      const version = vs ? Math.max(...vs.split("-").filter(Boolean).map(Number)) : null;
      // pre-migration-vmodules-culture-0001：模块迁移前的快照（store.js runModuleMigrations），没有 TMS 版本号，单独归类
      const moduleMigration = /pre-migration-vmodules-/.test(f);
      // 同时间戳的 -files 目录（附件/视频副本）与这个 .db 配对，去留一起算
      const filesDirPath = full.replace(/\.db$/, "-files");
      const filesDir = fs.existsSync(filesDirPath) ? filesDirPath : null;
      const filesSize = filesDir ? countTree(filesDir).bytes : 0;
      return { f, full, mtime: st.mtimeMs, size: st.size, version, moduleMigration, filesDir, filesSize };
    });

  const topVersions = [...new Set(files.filter((x) => x.version !== null).map((x) => x.version))]
    .sort((a, b) => b - a).slice(0, KEEP_MIGRATION_VERSIONS);
  // 模块迁移前的快照按时间取最新的 3 份（文件名里的时间戳与修改时间一致；同一时刻按文件名）
  const topModule = new Set(files.filter((x) => x.moduleMigration)
    .sort((a, b) => b.mtime - a.mtime || (a.f < b.f ? 1 : -1)).slice(0, KEEP_MODULE_MIGRATIONS).map((x) => x.full));

  const verdict = files.map((x) => {
    if (x.full === dest) return { ...x, keep: "刚刚生成" };
    if (MILESTONE.test(x.f)) return { ...x, keep: "里程碑" };
    if (x.mtime >= cutoff) return { ...x, keep: `最近 ${KEEP_DAYS} 天` };
    if (x.version !== null && topVersions.includes(x.version)) return { ...x, keep: `最近 ${KEEP_MIGRATION_VERSIONS} 次结构变更` };
    if (topModule.has(x.full)) return { ...x, keep: `最近 ${KEEP_MODULE_MIGRATIONS} 次模块迁移` };
    return { ...x, keep: null };
  });

  const drop = verdict.filter((x) => !x.keep);
  const freed = drop.reduce((a, x) => a + x.size + x.filesSize, 0);
  console.log(`\n保留 ${verdict.length - drop.length} 个，可清理 ${drop.length} 个（约 ${(freed / 1048576).toFixed(1)} MB）`);
  for (const x of drop) console.log(`  - ${x.f}${x.filesDir ? `（连带 ${path.basename(x.filesDir)}\\）` : ""}`);
  if (drop.length && args.includes("--yes")) {
    for (const x of drop) {
      fs.rmSync(x.full);
      if (x.filesDir) fs.rmSync(x.filesDir, { recursive: true, force: true });
    }
    console.log("已删除。");
  } else if (drop.length) {
    console.log("加 --yes 才会真的删除。");
  }
}
