"use strict";
// Office 课件（PPT / Word / Excel）→ 在线只读 PDF 的转换引擎（P0 1.3 / 1.4，2026-10-07）。
// 规则：Office 原文件永远不提供下载；转换不了就拒绝上传；存量原文件由后台课程库「课件转换」在线补转。
// 服务端（server.js）、离线脚本 scripts/convert-office-attachments.js 与 scripts/seed-media.js 共用。
//
// 零依赖：不 require store.js，也不自己找 LibreOffice —— 探测由调用方注入（server.js 的 findSoffice()
// 是唯一权威实现，test/soffice-parity.test.js 盯着它和另外两份拷贝；本文件不许另写候选路径）。
//
//   const office = require("./modules/learning/office-convert.js").create({
//     attachDir,            // 附件目录（server.js 的 ATTACH_DIR）
//     probe(force),         // → soffice 路径 | null；force=true 时调用方须丢掉缓存重新探测
//     disabled(),           // true = 视同未安装（LMS_DISABLE_OFFICE_CONVERT=1），状态 "disabled"
//     officeExt,            // Set(".ppt", ".pptx", …)
//     store,                // getMeta / setMeta / getAttachment / listAllAttachments / convertAttachmentToPdf
//     log(msg),
//     runInContext(ctx, fn) // 可选：domainEvents.runWithContext —— 批量任务以发起人的身份写库（评审 M3）
//     tmpRoot,              // 可选：临时根目录，缺省 = <attachDir>.convert-tmp（附件目录的兄弟目录）；脚本传 os.tmpdir() 下的目录
//     afterConvert(att, srcPath, pdfPath)  // 可选（第三批 5.7）：批量补转成功、原文件记进待删清单之前 await 调用；
//                           // att = 更新后的附件行（已是 PDF），srcPath = 原文件，pdfPath = 附件目录里的新 PDF。
//                           // server.js 用它对 .pptx 调 VIDEO_TC.ingestDeck 抽取内嵌视频；钩子出错只记日志，不影响转换结果
//   });
//
// 服务端接线（A 组）用到的入口：
//   office.startupCleanup()             同步、不抛错。开始监听端口之前调一次：清 .convert-tmp 里超过 1 小时的条目、
//                                       删掉在线补转留下的原文件（meta office.convert.orphans）、把上次被中断的任务标成 interrupted
//   office.available()                  同步：bin | null。disabled 时直接 null；没找到时最多每 60 秒重新探测一次
//   office.state()                      同步："ok" | "missing" | "disabled"
//   office.status({ refresh, includePath })  异步：状态接口的 converter 对象。refresh 至少间隔 10 秒才真的重测（评审 M4）；
//                                       includePath:false 时 path 为 null（只给培训写权限 / 超级管理员看路径）
//   office.makeWorkDir() / office.rmWorkDir(dir)   上传先写进 workDir（不进附件目录）；413、写盘出错、客户端中途断开、
//                                       转换结束都调 rmWorkDir —— 幂等、不抛错，只删 tmpRoot 里面的目录（评审 M5）
//   office.convertFile(src, { workDir, priority, signal })  → { pdfPath, size, ms }；失败 reject 一个带 .reason 的 Error，
//                                       reason ∈ unavailable | timeout | error | no_pdf | cancelled。priority "upload" 走上传通道，
//                                       不排在批量任务后面（评审 M2：上传有自己的并发位）。signal（AbortSignal，可选）中止时：
//                                       排队中的不启动，转换中的杀掉进程树，都按 cancelled 拒绝，不记 lastConversion
//   office.convertUpload(src, { workDir, storageKey, signal })  convertFile + storePdf 一步完成 → { storageKey, size, ms }；
//                                       放进附件目录前 signal 已中止 → cancelled，什么也不放
//   office.storePdf(pdfPath, storageKey)   把产物挪进附件目录（rename 带重试，跨盘时复制再删，评审 M1）→ { path, size }
//   office.discardStored(storageKey)    删掉附件目录里的一个 PDF，带重试（服务运行中尽量不用：备份可能正在复制附件目录）
//   office.hasPdfMagic(fileOrBuffer, { within })  文件头是不是 %PDF-。默认必须在第 0 字节（转换器产物）；
//                                       上传 .pdf 时传 { within: 1024 }，与 pdf.js 一样在前 1024 字节里找（评审 M6）
//   office.isOfficeAttachment(att)      kind==="doc" 或存储文件扩展名属于 officeExt
//   office.pendingAttachments()         待转换附件行 + fileMissing + lastError + converting
//   office.startJob(ids|null, { by:{id,name}, requestId, onConverted(att,{fromKey,storageKey,size}), onFailed(att,reason) })
//                                       → job 快照；抛 Error，.code ∈ unavailable | running | unknown_attachment(.ids) | nothing_to_convert
//   office.job()                        job 快照（重启后读 meta；上次没跑完的显示 interrupted:true）
//   office.shutdown()                   同步杀掉正在跑的转换进程树（process.on("exit") 里调）
//
// 在线补转不删原文件（评审 H5）：每天 03:00 的 scripts/backup.js 先 VACUUM INTO 再复制附件目录，转换途中删文件
// 会让整份附件备份作废，或者恢复后找不到文件。原文件和它的 .txt 文字缓存记进 meta office.convert.orphans，
// 下次服务启动（startupCleanup）或离线脚本运行时再删，删之前确认已没有任何附件行指向它。
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawn, execFile, execFileSync } = require("child_process");
const { pathToFileURL } = require("url");

const DEFAULT_OFFICE_EXT = new Set([".ppt", ".pptx", ".doc", ".docx", ".xls", ".xlsx"]);
const DEFAULT_TIMEOUT_MS = 120000;
const VERSION_TIMEOUT_MS = 15000;
const REPROBE_MS = 60000;          // 没找到转换器时，最多每 60 秒重新探测一次（IT 装好后不用重启服务）
const REFRESH_MIN_MS = 10000;      // ?refresh=1 至少间隔 10 秒才真的重测（只读角色也能点，评审 M4）
const TMP_MAX_AGE_MS = 60 * 60 * 1000;
const MAX_ERRORS = 500;
const MAX_ORPHANS = 5000;
const ABORT_AFTER_TIMEOUTS = 3;    // 批量任务连续 3 个超时就中止：卡住的 LibreOffice 不让 N 个附件各耗一个超时（评审 M2）
const META = {
  errors: "office.convert.errors",   // { attachmentId: { at, reason } }，最多 500 条
  lastJob: "office.convert.lastJob", // 最近一次批量任务的快照
  last: "office.convert.last",       // 最近一次转换（上传或批量）{ at, ok, ms, reason, source }
  orphans: "office.convert.orphans", // 在线补转后待删的原文件与 .txt 缓存（storageKey 列表）
};
const RETRY_CODES = new Set(["EPERM", "EBUSY", "EACCES", "ENOTEMPTY", "EMFILE", "ENFILE"]);
const RETRY_DELAYS = [100, 150, 200, 300]; // 5 次尝试，间隔 100–300ms 递增（Defender / 索引服务短暂锁住新文件）

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function sleepSync(ms) { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { /* 不支持就不等 */ } }
function clampInt(v, lo, hi, dflt) {
  if (v === undefined || v === null || v === "") return dflt;
  const n = Math.floor(Number(v));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
}
// rename / unlink / copy 的重试：Windows 上 Defender、索引服务会短暂锁住刚生成的文件（评审 M1）
async function withRetry(fn) {
  for (let i = 0; ; i++) {
    try { return fn(); } catch (e) {
      if (i >= RETRY_DELAYS.length || !RETRY_CODES.has(e && e.code)) throw e;
      await sleep(RETRY_DELAYS[i]);
    }
  }
}
function withRetrySync(fn) {
  for (let i = 0; ; i++) {
    try { return fn(); } catch (e) {
      if (i >= RETRY_DELAYS.length || !RETRY_CODES.has(e && e.code)) throw e;
      sleepSync(RETRY_DELAYS[i]);
    }
  }
}
// child 在 parent 里面（不等于 parent 本身）
function isInside(parent, child) {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return !!rel && !rel.startsWith("..") && !path.isAbsolute(rel);
}
// 文件头是 %PDF- 且后面还有内容。默认严格：%PDF- 在第 0 字节（转换器产物，LibreOffice 总是写在开头）；
// { within: 1024 } 与 pdf.js / Acrobat 一样在前 1024 字节里找（上传校验：有的系统导出的 PDF 前面多一个 BOM 或换行，
// 学员端阅读器照样能打开，不能因此拒收 —— 审查）。
function hasPdfMagic(fileOrBuffer, opts) {
  const within = opts && opts.within ? Math.min(Math.max(Math.floor(Number(opts.within)) || 5, 5), 1024) : 5;
  const found = (b, n, total) => { const at = b.subarray(0, n).indexOf("%PDF-", 0, "latin1"); return at !== -1 && total > at + 5; };
  if (Buffer.isBuffer(fileOrBuffer)) return found(fileOrBuffer, Math.min(within, fileOrBuffer.length), fileOrBuffer.length);
  let fd;
  try {
    fd = fs.openSync(fileOrBuffer, "r");
    const b = Buffer.alloc(within);
    const n = fs.readSync(fd, b, 0, within, 0);
    return found(b, n, fs.fstatSync(fd).size);
  } catch { return false; } finally { if (fd !== undefined) try { fs.closeSync(fd); } catch { /* ignore */ } }
}
// LibreOffice 安装目录里的 version.ini（Windows）/ versionrc（Linux；macOS 在 ../Resources/versionrc）
function parseVersionFile(file) {
  let txt;
  try { txt = fs.readFileSync(file, "utf8"); } catch { return null; }
  const kv = {};
  for (const line of txt.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z][\w.]*)\s*=\s*(.*?)\s*$/);
    if (m) kv[m[1]] = m[2];
  }
  const ver = (s) => (/^\d+(?:\.\d+)+$/.test(s || "") ? s : null);
  if (ver(kv.MsiProductVersion)) return kv.MsiProductVersion;
  if (ver(kv.ProductVersion)) return kv.ProductVersion;
  if (/^\d+$/.test(kv.ProductMajor || "") && /^\d+$/.test(kv.ProductMinor || "")) return kv.ProductMajor + "." + kv.ProductMinor;
  return null;
}
function failure(reason, message) {
  const e = new Error(message || reason);
  e.reason = reason;
  return e;
}
function codeError(code, extra) {
  const e = new Error(code);
  e.code = code;
  if (extra) Object.assign(e, extra);
  return e;
}
const isScript = (bin) => /\.(c?js|mjs)$/i.test(bin); // 测试替身 test/fixtures/fake-soffice.js 用 node 执行

function create(opts) {
  const o = opts || {};
  if (!o.attachDir) throw new Error("office-convert: attachDir is required");
  const attachDir = path.resolve(o.attachDir);
  const tmpRoot = path.resolve(o.tmpRoot || attachDir + ".convert-tmp");
  const profilesDir = path.join(tmpRoot, "profiles");
  const officeExt = o.officeExt || DEFAULT_OFFICE_EXT;
  const store = o.store || null;
  const log = typeof o.log === "function" ? o.log : () => {};
  const probeFn = typeof o.probe === "function" ? o.probe : () => null;
  const disabledFn = typeof o.disabled === "function" ? o.disabled : () => false;
  const runInContext = typeof o.runInContext === "function" ? o.runInContext : (ctx, fn) => fn();
  const afterConvert = typeof o.afterConvert === "function" ? o.afterConvert : null;
  const env = o.env || process.env;
  const now = typeof o.now === "function" ? o.now : () => Date.now();
  const timeoutMs = clampInt(o.timeoutMs !== undefined ? o.timeoutMs : env.LMS_OFFICE_CONVERT_TIMEOUT_MS, 1000, 600000, DEFAULT_TIMEOUT_MS);
  const concurrency = clampInt(o.concurrency !== undefined ? o.concurrency : env.LMS_OFFICE_CONVERT_CONCURRENCY, 1, 2, 1);
  const iso = () => new Date(now()).toISOString();

  // ---------- meta（任务记录，不用迁移） ----------
  function readMeta(key, dflt) {
    if (!store || typeof store.getMeta !== "function") return dflt;
    try { const v = store.getMeta(key); return v == null ? dflt : JSON.parse(v); } catch { return dflt; }
  }
  function writeMeta(key, value) {
    if (!store || typeof store.setMeta !== "function") return;
    try { store.setMeta(key, JSON.stringify(value)); } catch (e) { log("could not save " + key + ": " + ((e && e.message) || e)); }
  }

  // ---------- 探测 ----------
  let bin = null, probed = false, probedAt = null, lastProbeMs = 0, lastForcedMs = -Infinity, stale = false;
  function doProbe(force) {
    let r = null;
    try { r = probeFn(!!force) || null; } catch (e) { log("probe failed: " + ((e && e.message) || e)); }
    bin = r ? String(r) : null;
    probed = true;
    stale = false;
    lastProbeMs = now();
    probedAt = new Date(lastProbeMs).toISOString();
    return bin;
  }
  const binExists = (b) => { try { return fs.existsSync(b); } catch { return false; } };
  function available() {
    if (disabledFn()) return null;
    if (!probed) return doProbe(false);
    if (bin && (stale || !binExists(bin))) return doProbe(true); // 卸载了 / 启动失败过：重新找
    if (!bin && now() - lastProbeMs >= REPROBE_MS) return doProbe(true);
    return bin;
  }
  function state() {
    if (disabledFn()) return "disabled";
    return available() ? "ok" : "missing";
  }

  // ---------- 版本号（按 realpath + mtime 缓存，评审 M4） ----------
  const versionCache = new Map();
  function runForOutput(exe, args, ms) {
    return new Promise((resolve) => {
      try {
        execFile(exe, args, { timeout: ms, windowsHide: true, encoding: "utf8", maxBuffer: 256 * 1024 },
          (err, stdout, stderr) => resolve(String(stdout || "") + "\n" + String(stderr || "")));
      } catch { resolve(""); }
    });
  }
  async function detectVersion(b, real) {
    const dir = path.dirname(real);
    for (const f of [path.join(dir, "version.ini"), path.join(dir, "versionrc"), path.join(dir, "..", "Resources", "versionrc")]) {
      const v = parseVersionFile(f);
      if (v) return { version: v, source: path.basename(f) };
    }
    let exe = b, args = ["--version"];
    if (isScript(b)) { exe = process.execPath; args = [b, "--version"]; }
    else if (process.platform === "win32" && binExists(path.join(dir, "soffice.com"))) exe = path.join(dir, "soffice.com"); // soffice.exe 不往控制台输出
    const out = await runForOutput(exe, args, VERSION_TIMEOUT_MS);
    const m = out.match(/LibreOffice\s+(\d+(?:\.\d+)+)/);
    return m ? { version: m[1], source: "--version" } : { version: null, source: null };
  }
  function versionOf(b, force) {
    let real = b, mtime = 0;
    try { real = fs.realpathSync(b); mtime = fs.statSync(real).mtimeMs; } catch { /* 用原路径 */ }
    const key = real + "|" + mtime;
    if (force) versionCache.delete(key);
    if (!versionCache.has(key)) versionCache.set(key, detectVersion(b, real).catch(() => ({ version: null, source: null })));
    return versionCache.get(key);
  }

  // ---------- 最近一次转换 ----------
  let last = null;
  function recordConversion(entry) {
    last = { at: iso(), ok: !!entry.ok, ms: Math.max(0, Math.round(entry.ms || 0)), reason: entry.reason || null, source: entry.source || null };
    writeMeta(META.last, last);
  }
  const lastConversion = () => last || readMeta(META.last, null);

  async function status(opts2) {
    const so = opts2 || {};
    let forceVersion = false;
    if (so.refresh && !disabledFn() && now() - lastForcedMs >= REFRESH_MIN_MS) {
      lastForcedMs = now();
      doProbe(true);
      forceVersion = true;
    }
    const st = state();
    let version = null, versionSource = null;
    if (st === "ok") {
      const v = await versionOf(bin, forceVersion);
      version = v.version;
      versionSource = v.source;
    }
    return {
      state: st,
      path: st === "ok" && so.includePath !== false ? bin : null,
      version, versionSource,
      probedAt: st === "disabled" ? null : probedAt,
      lastConversion: lastConversion(),
    };
  }

  // ---------- 临时目录 ----------
  function makeWorkDir() {
    fs.mkdirSync(tmpRoot, { recursive: true });
    return fs.mkdtempSync(path.join(tmpRoot, "w-"));
  }
  function rmQuiet(p) {
    try { fs.rmSync(p, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); return true; }
    catch (e) { log("could not remove " + p + ": " + ((e && e.code) || (e && e.message) || e)); return false; }
  }
  // 只删 tmpRoot 里面的目录；重复调用无害
  function rmWorkDir(dir) {
    if (!dir || !isInside(tmpRoot, dir)) return false;
    return rmQuiet(dir);
  }

  // ---------- 进程 ----------
  const running = new Set();
  let stopping = false;
  function killTree(child, sync) {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    if (process.platform === "win32" && child.pid) {
      // soffice.exe 只是启动器：只杀它会留下孤儿 soffice.bin 继续占着文件，所以按 pid 杀整棵树
      const args = ["/PID", String(child.pid), "/T", "/F"];
      if (sync) {
        try { execFileSync("taskkill", args, { stdio: "ignore", windowsHide: true, timeout: 5000 }); } catch { try { child.kill(); } catch { /* ignore */ } }
      } else {
        execFile("taskkill", args, { windowsHide: true, timeout: 5000 }, (err) => { if (err) { try { child.kill(); } catch { /* ignore */ } } });
      }
      return;
    }
    try { process.kill(-child.pid, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch { /* ignore */ } }
  }
  // signal（可选，AbortSignal）：上传的客户端断开时中止 —— 杀掉整棵进程树，按 cancelled 了结（审查：断开的上传还占着通道）
  function runSoffice(b, args, signal) {
    return new Promise((resolve, reject) => {
      const exe = isScript(b) ? process.execPath : b;
      const argv = isScript(b) ? [b, ...args] : args;
      let child;
      try {
        child = spawn(exe, argv, { windowsHide: true, stdio: ["ignore", "ignore", "pipe"], detached: process.platform !== "win32" });
      } catch (e) {
        stale = true;
        return reject(failure("unavailable", "could not start the converter: " + ((e && e.message) || e)));
      }
      running.add(child);
      let stderr = "", timedOut = false, cancelled = false, settled = false;
      if (child.stderr) child.stderr.on("data", (d) => { if (stderr.length < 4000) stderr += d; });
      let hardTimer = null;
      // 杀不掉（taskkill 失败、进程不响应）也不能让请求一直挂着：再等 10 秒按超时 / 取消了结
      const stop = () => {
        killTree(child, false);
        if (!hardTimer) hardTimer = setTimeout(() => settle(() => reject(cancelled && !timedOut
          ? failure("cancelled", "the client went away (process did not exit)")
          : failure("timeout", "no result within " + timeoutMs + " ms (process did not exit)"))), 10000);
      };
      const timer = setTimeout(() => { timedOut = true; stop(); }, timeoutMs);
      const onAbort = () => { if (settled || timedOut) return; cancelled = true; stop(); };
      const settle = (fn) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (hardTimer) clearTimeout(hardTimer);
        if (signal) signal.removeEventListener("abort", onAbort);
        running.delete(child);
        // 孙进程可能还拿着 stderr 管道：不等它关，读到的就够了
        if (child.stderr) try { child.stderr.destroy(); } catch { /* ignore */ }
        fn();
      };
      if (signal) { if (signal.aborted) onAbort(); else signal.addEventListener("abort", onAbort, { once: true }); }
      child.on("error", (e) => settle(() => {
        if (e && (e.code === "ENOENT" || e.code === "EACCES")) { stale = true; reject(failure("unavailable", "converter not runnable: " + e.code)); }
        else reject(failure(timedOut ? "timeout" : cancelled ? "cancelled" : "error", (e && e.message) || String(e)));
      }));
      child.on("exit", (code, signal2) => settle(() => {
        if (timedOut) return reject(failure("timeout", "no result within " + timeoutMs + " ms"));
        if (cancelled) return reject(failure("cancelled", "the client went away"));
        if (code !== 0) return reject(failure("error", "converter exited with " + (code === null ? signal2 : code) + (stderr.trim() ? ": " + stderr.trim().slice(-300) : "")));
        resolve();
      }));
    });
  }

  // ---------- 队列：上传与批量各走各的通道（评审 M2） ----------
  // 批量任务本来就逐个串行（一条通道）；上传有自己的 concurrency 条通道，永远不排在批量后面。
  const lanes = { upload: { limit: concurrency, active: 0, wait: [] }, batch: { limit: 1, active: 0, wait: [] } };
  function acquire(kind) {
    const lane = lanes[kind];
    return new Promise((resolve) => {
      const grant = () => {
        lane.active++;
        let released = false;
        resolve(() => {
          if (released) return;
          released = true;
          lane.active--;
          const next = lane.wait.shift();
          if (next) next();
        });
      };
      if (lane.active < lane.limit) grant(); else lane.wait.push(grant);
    });
  }

  async function convertFile(src, opts2) {
    const co = opts2 || {};
    const source = co.priority === "batch" ? "batch" : "upload";
    if (!co.workDir) throw failure("error", "convertFile needs a workDir (office.makeWorkDir())");
    const release = await acquire(source);
    const t0 = now();
    let profileDir = null, attempted = false;
    try {
      // 排队期间客户端已经走了（co.signal 已中止）：不启动转换，把通道让给后面的人（审查）
      if (co.signal && co.signal.aborted) throw failure("cancelled", "the client went away before the conversion started");
      const b = available();
      if (!b) throw failure("unavailable", "LibreOffice is not available");
      attempted = true;
      fs.mkdirSync(profilesDir, { recursive: true });
      // 每次一个独立的配置目录（避免单配置锁）；放在 tmpRoot/profiles 下，泄漏了启动清理也能清掉（评审 H6）
      profileDir = fs.mkdtempSync(path.join(profilesDir, "p-"));
      await runSoffice(b, ["--headless", "--norestore", "-env:UserInstallation=" + pathToFileURL(profileDir).href,
        "--convert-to", "pdf", "--outdir", co.workDir, src], co.signal);
      const pdfPath = path.join(co.workDir, path.basename(src, path.extname(src)) + ".pdf");
      if (!hasPdfMagic(pdfPath)) throw failure("no_pdf", "the converter produced no PDF");
      const size = fs.statSync(pdfPath).size;
      const ms = now() - t0;
      recordConversion({ ok: true, ms, reason: null, source });
      return { pdfPath, size, ms };
    } catch (e) {
      const err = e && e.reason ? e : failure("error", (e && e.message) || String(e));
      // 没装就没有「一次转换」可记；客户端走了被中止的也不算一次失败的转换
      if (attempted && err.reason !== "cancelled") recordConversion({ ok: false, ms: now() - t0, reason: err.reason, source });
      if (err.reason !== "unavailable" && err.reason !== "cancelled") log("conversion failed (" + err.reason + "): " + path.basename(src) + " — " + err.message);
      throw err;
    } finally {
      if (profileDir) rmQuiet(profileDir);
      release();
    }
  }

  function storagePath(storageKey) {
    const p = path.join(attachDir, String(storageKey || ""));
    if (!isInside(attachDir, p)) throw new Error("invalid storage key");
    return p;
  }
  async function storePdf(pdfPath, storageKey) {
    const dest = storagePath(storageKey);
    fs.mkdirSync(attachDir, { recursive: true });
    try {
      await withRetry(() => fs.renameSync(pdfPath, dest));
    } catch (e) {
      if (!e || e.code !== "EXDEV") throw e;
      await withRetry(() => fs.copyFileSync(pdfPath, dest)); // 附件目录在另一块盘上
      try { await withRetry(() => fs.unlinkSync(pdfPath)); } catch { /* 工作目录会整个删掉 */ }
    }
    return { path: dest, size: fs.statSync(dest).size };
  }
  async function discardStored(storageKey) {
    try { await withRetry(() => fs.unlinkSync(storagePath(storageKey))); return true; }
    catch (e) { if (e && e.code === "ENOENT") return true; log("could not remove " + storageKey + ": " + ((e && e.code) || e)); return false; }
  }
  // co.signal（可选）：客户端断开 → 排队中不启动、转换中杀进程，都按 cancelled 拒绝；放进附件目录之前再看一次，
  // 客户端已走就不放 —— 附件目录里不出现「放进去又删掉」的文件（夜间备份正在复制这个目录，审查）
  async function convertUpload(src, opts2) {
    const co = opts2 || {};
    const r = await convertFile(src, { workDir: co.workDir, priority: "upload", signal: co.signal });
    if (co.signal && co.signal.aborted) throw failure("cancelled", "the client went away");
    const placed = await storePdf(r.pdfPath, co.storageKey);
    return { storageKey: co.storageKey, size: placed.size, ms: r.ms };
  }

  // ---------- 附件 ----------
  function isOfficeAttachment(att) {
    if (!att) return false;
    return att.kind === "doc" || officeExt.has(path.extname(String(att.storageKey || "")).toLowerCase());
  }
  function fileExists(storageKey) {
    try { return fs.existsSync(storagePath(storageKey)); } catch { return false; }
  }
  const inflight = new Set();
  function pendingAttachments() {
    if (!store) return [];
    const errors = readMeta(META.errors, {}) || {};
    return store.listAllAttachments().filter(isOfficeAttachment).map((a) => ({
      id: a.id,
      originalName: a.originalName,
      ext: path.extname(String(a.storageKey || "")).toLowerCase(),
      size: a.size,
      createdAt: a.createdAt,
      uploadedBy: a.uploadedBy || null,
      courseId: a.courseId || null,
      ownerKind: a.ownerKind || null,
      ownerId: a.ownerId || null,
      fileMissing: !fileExists(a.storageKey),
      lastError: errors[a.id] || null,
      converting: inflight.has(a.id),
    })).sort((x, y) => String(x.createdAt || "").localeCompare(String(y.createdAt || "")));
  }
  function setError(id, reason) {
    const errors = readMeta(META.errors, {}) || {};
    errors[id] = { at: iso(), reason };
    const keys = Object.keys(errors);
    if (keys.length > MAX_ERRORS) {
      keys.sort((a, b) => String(errors[a].at).localeCompare(String(errors[b].at)));
      for (const k of keys.slice(0, keys.length - MAX_ERRORS)) delete errors[k];
    }
    writeMeta(META.errors, errors);
  }
  function clearError(id) {
    const errors = readMeta(META.errors, null);
    if (errors && errors[id]) { delete errors[id]; writeMeta(META.errors, errors); }
  }
  function addOrphans(keys) {
    const list = readMeta(META.orphans, []);
    const arr = Array.isArray(list) ? list : [];
    for (const k of keys) if (k && !arr.includes(k)) arr.push(k);
    writeMeta(META.orphans, arr.slice(-MAX_ORPHANS));
  }

  // ---------- 批量任务 ----------
  const emptyJob = () => ({
    running: false, startedAt: null, finishedAt: null, by: null,
    total: 0, done: 0, converted: 0, failed: 0, missing: 0, currentId: null, interrupted: false, aborted: null,
  });
  let current = null;
  const snapshot = (j) => ({ ...j, by: j.by ? { ...j.by } : null });
  function saveJob() { if (current) writeMeta(META.lastJob, current); }
  function job() {
    if (current) return snapshot(current);
    const saved = readMeta(META.lastJob, null);
    if (!saved || typeof saved !== "object") return emptyJob();
    // 进程里没有在跑的任务，meta 却写着 running：上次服务退出时任务被中断了
    if (saved.running) return { ...emptyJob(), ...saved, running: false, currentId: null, interrupted: true };
    return { ...emptyJob(), ...saved };
  }
  function safeHook(fn, ...args) {
    if (typeof fn !== "function") return;
    try { fn(...args); } catch (e) { log("job hook failed: " + ((e && e.message) || e)); }
  }
  async function convertOne(id, hooks) {
    const att = store.getAttachment(id);
    if (!att || !isOfficeAttachment(att) || inflight.has(id)) return { status: "skipped" };
    const fromKey = String(att.storageKey || "");
    let src;
    try { src = storagePath(fromKey); } catch { return { status: "missing" }; }
    if (!fs.existsSync(src)) return { status: "missing" };
    if (!available()) return { status: "abort", reason: "unavailable" };
    inflight.add(id);
    let workDir = null;
    const fail = (reason) => {
      setError(id, reason);
      safeHook(hooks.onFailed, { ...att }, reason);
      return { status: "failed", reason };
    };
    try {
      workDir = makeWorkDir();
      const r = await convertFile(src, { workDir, priority: "batch" });
      const storageKey = /^[\w.-]+$/.test(String(att.id)) ? att.id + ".pdf" : "att-" + crypto.randomBytes(8).toString("hex") + ".pdf";
      const placed = await storePdf(r.pdfPath, storageKey);
      let ok = false;
      try { ok = store.convertAttachmentToPdf(id, fromKey, { storageKey, size: placed.size }); }
      catch (e) { log("could not update " + id + ": " + ((e && e.message) || e)); }
      if (!ok) {
        // 期间附件行被别处改了：新 PDF 记进待删清单，下次启动再删（服务运行中不删附件目录里的文件，审查 H5 同理）——
        // 除非那一行现在正指向它；启动清理也会再核对一次有没有附件行引用它
        const now2 = store.getAttachment(id);
        if (!now2 || now2.storageKey !== storageKey) addOrphans([storageKey]);
        return fail("changed");
      }
      // 第三批 5.7：原文件进待删清单之前，先让 afterConvert 从里面抽取内嵌视频（钩子失败不影响转换结果）
      if (afterConvert) {
        try { await afterConvert({ ...(store.getAttachment(id) || att) }, src, storagePath(storageKey)); }
        catch (e) { log("afterConvert failed for " + id + ": " + ((e && e.message) || e)); }
      }
      // 原文件与文字缓存先留着，等下次启动再删（评审 H5）
      addOrphans([fromKey, fromKey + ".txt"]);
      clearError(id);
      safeHook(hooks.onConverted, { ...att }, { fromKey, storageKey, size: placed.size });
      return { status: "converted" };
    } catch (e) {
      const reason = (e && e.reason) || "error";
      if (reason === "unavailable") return { status: "abort", reason };
      if (!(e && e.reason)) log("conversion of " + id + " failed: " + ((e && e.message) || e));
      return fail(reason);
    } finally {
      inflight.delete(id);
      if (workDir) rmWorkDir(workDir);
    }
  }
  async function runJob(ids, hooks) {
    await null; // 先把 202 的快照交回去
    let timeouts = 0;
    try {
      for (const id of ids) {
        if (stopping) { current.aborted = "shutdown"; break; }
        current.currentId = id;
        saveJob();
        const r = await convertOne(id, hooks);
        if (r.status === "abort") { current.aborted = r.reason || "unavailable"; break; }
        current.done++;
        if (r.status === "converted") { current.converted++; timeouts = 0; }
        else if (r.status === "missing") current.missing++;
        else if (r.status === "failed") {
          current.failed++;
          timeouts = r.reason === "timeout" ? timeouts + 1 : 0;
          if (timeouts >= ABORT_AFTER_TIMEOUTS) { current.aborted = "timeouts"; break; }
        }
      }
    } catch (e) {
      log("conversion job failed: " + ((e && e.message) || e));
      current.aborted = current.aborted || "error";
    } finally {
      current.running = false;
      current.currentId = null;
      current.finishedAt = iso();
      saveJob();
    }
  }
  function startJob(ids, hooks) {
    const h = hooks || {};
    if (!store) throw new Error("office-convert: startJob needs a store");
    if (current && current.running) throw codeError("running");
    if (!available()) throw codeError("unavailable");
    let list;
    if (ids == null) list = store.listAllAttachments().filter(isOfficeAttachment);
    else {
      const uniq = [...new Set((Array.isArray(ids) ? ids : [ids]).map(String))];
      const bad = [];
      list = [];
      for (const id of uniq) {
        const a = store.getAttachment(id);
        if (!a || !isOfficeAttachment(a)) bad.push(id); else list.push(a);
      }
      if (bad.length) throw codeError("unknown_attachment", { ids: bad });
    }
    if (!list.length) throw codeError("nothing_to_convert");
    const by = h.by && h.by.id ? { id: String(h.by.id), name: h.by.name == null ? null : String(h.by.name) } : null;
    current = { ...emptyJob(), running: true, startedAt: iso(), by, total: list.length };
    saveJob();
    const ctx = { actorId: by ? by.id : null, requestId: h.requestId || null };
    const ids2 = list.map((a) => a.id);
    // 批量任务以发起人的身份写库，不沿用触发它的那个请求的上下文（评审 M3）
    Promise.resolve(runInContext(ctx, () => runJob(ids2, h))).catch((e) => log("conversion job crashed: " + ((e && e.message) || e)));
    return snapshot(current);
  }

  // ---------- 清理 ----------
  // .convert-tmp 与 profiles 里超过 maxAgeMs 的条目（崩溃、强杀留下的）；只在服务启动时调用（评审 H6）
  function cleanTmp(opts2) {
    const maxAge = (opts2 && opts2.maxAgeMs !== undefined) ? opts2.maxAgeMs : TMP_MAX_AGE_MS;
    let removed = 0;
    for (const dir of [profilesDir, tmpRoot]) {
      let names = [];
      try { names = fs.readdirSync(dir); } catch { continue; }
      for (const n of names) {
        if (dir === tmpRoot && n === "profiles") continue;
        const p = path.join(dir, n);
        try {
          if (now() - fs.statSync(p).mtimeMs < maxAge) continue;
          fs.rmSync(p, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
          removed++;
        } catch (e) { log("could not clean " + p + ": " + ((e && e.code) || (e && e.message) || e)); }
      }
    }
    return removed;
  }
  // 在线补转留下的原文件：确认没有附件行再指向它才删；删不掉（被占用）的留到下次
  function cleanOrphans() {
    const list = readMeta(META.orphans, []);
    if (!Array.isArray(list) || !list.length) return { removed: 0, kept: 0 };
    const referenced = new Set();
    for (const a of store.listAllAttachments()) if (a.storageKey) { referenced.add(a.storageKey); referenced.add(a.storageKey + ".txt"); }
    const keep = [];
    let removed = 0;
    for (const raw of list) {
      const key = String(raw || "");
      let p;
      try { p = storagePath(key); } catch { continue; }
      if (referenced.has(key)) continue; // 又被引用了：不删，也不再记
      try { withRetrySync(() => fs.unlinkSync(p)); removed++; }
      catch (e) { if (e && e.code === "ENOENT") continue; keep.push(key); log("could not remove " + key + ": " + ((e && e.code) || e)); }
    }
    writeMeta(META.orphans, keep);
    return { removed, kept: keep.length };
  }
  function startupCleanup() {
    const out = { tmpRemoved: 0, orphansRemoved: 0, orphansKept: 0, interrupted: false };
    try { out.tmpRemoved = cleanTmp(); } catch (e) { log("temp cleanup failed: " + ((e && e.message) || e)); }
    if (store) {
      try { const r = cleanOrphans(); out.orphansRemoved = r.removed; out.orphansKept = r.kept; } catch (e) { log("orphan cleanup failed: " + ((e && e.message) || e)); }
      try {
        const saved = readMeta(META.lastJob, null);
        if (!current && saved && saved.running) {
          writeMeta(META.lastJob, { ...saved, running: false, currentId: null, interrupted: true });
          out.interrupted = true;
        }
      } catch { /* 只是标记 */ }
    }
    return out;
  }
  function shutdown() {
    stopping = true;
    for (const child of [...running]) killTree(child, true);
    running.clear();
  }

  return {
    attachDir, tmpRoot, timeoutMs, concurrency,
    available, state, status,
    makeWorkDir, rmWorkDir,
    convertFile, convertUpload, storePdf, discardStored, hasPdfMagic,
    isOfficeAttachment, pendingAttachments,
    startJob, job,
    cleanTmp, cleanOrphans, startupCleanup, shutdown,
  };
}

module.exports = { create, hasPdfMagic, parseVersionFile, isInside, META, DEFAULT_OFFICE_EXT };
