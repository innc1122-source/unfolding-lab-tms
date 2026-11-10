// Convert EXISTING office attachments (PPT/Word/Excel) that are still stored as
// originals into view-only PDFs. Office originals are never offered as downloads
// (P0 1.3, 2026-10-07): until it is converted, such an attachment shows as
// "pending conversion" and cannot be opened at all.
//
// 服务运行中请用后台课程库的「课件转换」（在线补转，不用停服，逐条留审计）。
// 本脚本是离线用途：服务停着、或者后台打不开的时候用。
// While the server is running, use Course Library → "File converter" in the admin
// instead; this script is for offline use.
//
// Requires LibreOffice (`soffice`). Run with the server STOPPED (it writes to the
// same SQLite file and attachment dir):
//
//     node scripts/convert-office-attachments.js
//
// Idempotent: attachments already stored as PDFs are skipped, so it is safe to
// re-run. If soffice isn't installed it exits without touching anything.
// The conversion itself (timeout, process-tree kill, PDF check, conditional DB
// update) is the same code the server uses: modules/learning/office-convert.js.
// Converted originals and their cached text (<file>.txt) are deleted here (the
// server is stopped); originals the server converted online and left for its next
// start (meta office.convert.orphans) are cleaned up as well.
// 「服务必须停」不再只是注释里的一句话：下面的 refuseIfServerLive 护栏会检测
// <db>.server.lock + pid 存活，服务还开着就拒绝运行（LMS_ALLOW_LIVE_DB=1 可强制）。
// seed-media.js 借用本文件导出的 findSoffice()（require 本文件不会运行下面的 main）。
// 第三批 5.7：.pptx 转换成功后、删原文件之前，先用 modules/learning/video-transcode.js 抽出内嵌视频
// （autoStart:false —— 本脚本只抽取不转码，视频行留在「等待转码」，服务下次启动且装了 ffmpeg 时自动转码）。
// Before a converted .pptx original is deleted, its embedded videos are extracted (rows stay pending; the server
// transcodes them on its next start when ffmpeg is installed). ffmpeg itself is not needed here.
"use strict";
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");

// store.init seeds default accounts if the DB is empty; it needs a hasher. This
// migration only reads/updates attachments, but we pass one to satisfy init.
function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString("hex");
  return salt + ":" + crypto.scryptSync(pw, salt, 32).toString("hex");
}

const ROOT = path.join(__dirname, "..");
const ATTACH_DIR = process.env.LMS_ATTACH_DIR
  ? path.resolve(process.env.LMS_ATTACH_DIR)
  : path.join(ROOT, "data", "attachments");
const OFFICE_EXT = new Set([".ppt", ".pptx", ".doc", ".docx", ".xls", ".xlsx"]);

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
// 库路径按 store.js 的同一套规则解析（LMS_DB_PATH 优先，缺省 = 根目录 lms.db），
// 保证护栏看的锁和 store 打开的库永远是同一个文件。
// （护栏在 main() 开头调用：seed-media.js 只 require 本文件借用 findSoffice，不该被它拦下。）

function findSoffice() {
  // 与 server.js 的 findSoffice() **逐字一致**（那边是权威实现）。不一致会造出一个
  // 什么都没坏的红测试：WOW64 下（32 位进程 / 64 位 Windows）ProgramFiles 与
  // ProgramFiles(x86) 都指向 (x86)，若这里多留一条无条件的 C:\Program Files 字面值，
  // 就会在 server.js 找不到 soffice 的环境里判定「有转换器」，于是测试不跳过、然后失败。
  // 字面值只在两个环境变量都缺失时兜底，而且必须是两条（含 (x86)）。
  const progDirs = [process.env.ProgramFiles, process.env["ProgramFiles(x86)"]].filter(Boolean);
  const winDirs = progDirs.length ? progDirs : ["C:\\Program Files", "C:\\Program Files (x86)"];
  const candidates = [
    process.env.LMS_SOFFICE, // explicit configuration outranks any guess
    ...winDirs.map((d) => path.join(d, "LibreOffice", "program", "soffice.exe")),
    "/usr/bin/soffice", "/usr/bin/libreoffice", "/opt/libreoffice/program/soffice",
    "/opt/homebrew/bin/soffice", "/Applications/LibreOffice.app/Contents/MacOS/soffice",
  ].filter(Boolean);
  return candidates.find((p) => { try { return fs.existsSync(p); } catch { return false; } }) || null;
}

async function main() {
  refuseIfServerLive(process.env.LMS_DB_PATH ? path.resolve(process.env.LMS_DB_PATH) : path.join(ROOT, "lms.db"));

  const soffice = findSoffice();
  if (!soffice) {
    console.error("LibreOffice (soffice) not found — install it and re-run. Nothing changed.");
    console.error("  Windows: libreoffice.org/download, or: winget install TheDocumentFoundation.LibreOffice");
    console.error("  macOS:   brew install --cask libreoffice");
    console.error("  Ubuntu:  sudo apt-get install -y libreoffice");
    console.error("  Installed somewhere else? Point LMS_SOFFICE at the soffice binary.");
    process.exit(1);
  }
  console.log("Using converter:", soffice);
  console.log("Attachment dir:", ATTACH_DIR);

  const store = require(path.join(ROOT, "store.js"));
  store.init({ hashPassword });
  // 脚本自己的临时目录放在系统临时目录（不碰服务的 <附件目录>.convert-tmp，服务启动时会清那里）
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "lms-office-convert-"));
  const office = require(path.join(ROOT, "modules", "learning", "office-convert.js")).create({
    attachDir: ATTACH_DIR, tmpRoot, officeExt: OFFICE_EXT, store,
    probe: () => soffice,
    log: (m) => console.warn("  [office] " + m),
  });
  // PPT 内嵌视频：只抽取（ffmpeg 的唯一探测实现 findFfmpeg 在 video-transcode.js 里，这里只用来提示）
  const videoLib = require(path.join(ROOT, "modules", "learning", "video-transcode.js"));
  const mediaReady = typeof store.createAttachmentMedia === "function" && typeof store.listAttachmentMedia === "function";
  const video = mediaReady ? videoLib.create({
    attachDir: ATTACH_DIR, tmpRoot, store, autoStart: false,
    disabled: () => true, // 本脚本从不转码
    log: (m) => console.warn("  [video] " + m),
  }) : null;
  const ffmpeg = videoLib.findFfmpeg();
  console.log("Video transcoder (ffmpeg):", ffmpeg || "not found — embedded videos are kept and converted once the server finds ffmpeg");
  if (!mediaReady) console.warn("  [video] this database has no attachment_media table yet — embedded PPT videos will NOT be extracted");
  let converted = 0, skipped = 0, missing = 0, failed = 0, videos = 0;
  try {
    for (const a of store.listAllAttachments()) {
      if (!office.isOfficeAttachment(a)) { skipped++; continue; }
      const src = path.join(ATTACH_DIR, a.storageKey);
      if (!fs.existsSync(src)) { console.warn("  missing file, skip:", a.id, a.storageKey); missing++; continue; }
      const workDir = office.makeWorkDir();
      try {
        const r = await office.convertFile(src, { workDir, priority: "batch" });
        const pdfKey = a.id + ".pdf";
        const placed = await office.storePdf(r.pdfPath, pdfKey);
        // 条件更新：附件行仍指向这个原文件才改
        if (!store.convertAttachmentToPdf(a.id, a.storageKey, { storageKey: pdfKey, size: placed.size })) {
          const row = store.getAttachment(a.id);
          if (!row || row.storageKey !== pdfKey) await office.discardStored(pdfKey);
          throw new Error("the attachment changed while it was being converted");
        }
        // 第三批 5.7：删原文件之前先抽内嵌视频（失败只记日志，不影响转换结果）
        if (video && path.extname(a.storageKey).toLowerCase() === ".pptx") {
          try {
            const m = await video.ingestDeck({ attachment: store.getAttachment(a.id), srcPath: src, pdfPath: placed.path });
            if (m.total) videos += m.total;
            console.log("  slide media:", a.id, m.error ? "error=" + m.error : `total=${m.total} pending=${m.pending} external=${m.external} skipped=${m.skipped} failed=${m.failed} mapping=${m.mapping}`);
          } catch (e) { console.warn("  [video] could not extract slide media from", a.id, "-", (e && e.message) || e); }
        }
        // 服务停着：原文件和它的文字缓存（<原文件>.txt，AI 出题读附件时生成）直接删
        for (const file of [src, src + ".txt"]) { try { fs.unlinkSync(file); } catch { /* 不在或被占用：不影响结果 */ } }
        console.log("  converted:", a.id, JSON.stringify(a.originalName), "->", pdfKey, "(" + placed.size + " bytes, " + r.ms + " ms)");
        converted++;
      } catch (e) {
        console.error("  FAILED:", a.id, JSON.stringify(a.originalName), "-", (e.reason ? e.reason + ": " : "") + e.message);
        failed++;
      } finally {
        office.rmWorkDir(workDir);
      }
    }
    // 服务在线补转后留到下次启动再删的原文件：服务停着，这里一并清掉
    const o = office.cleanOrphans();
    if (o.removed || o.kept) console.log("Originals left by online conversion: removed=" + o.removed + " kept=" + o.kept);
    // 服务转码成功后留到下次启动再删的源视频：服务停着，这里一并清掉（仍被任何视频行引用的不删）
    if (video) {
      const v = video.cleanOrphans();
      if (v.removed || v.kept) console.log("Video sources left by transcoding: removed=" + v.removed + " kept=" + v.kept);
    }
  } finally {
    try { fs.rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); } catch { /* 系统临时目录，留下也无妨 */ }
    try { store.close(); } catch { /* ignore */ }
  }
  console.log(`Done. converted=${converted} skipped=${skipped} missing=${missing} failed=${failed} slideMedia=${videos}`);
}

module.exports = { findSoffice };
if (require.main === module) {
  main().catch((e) => {
    console.error("FAILED:", (e && e.stack) || e);
    process.exit(1);
  });
}
