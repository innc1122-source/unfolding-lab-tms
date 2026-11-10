"use strict";
// PPT 内嵌视频 → 浏览器可播放 MP4 的转码引擎（第三批 5.7，2026-10-08）。结构仿 office-convert.js。零依赖。
// Transcode engine for videos embedded in .pptx decks (batch 3, item 5.7). Same shape as office-convert.js.
//
// findFfmpeg() 是 ffmpeg 的唯一探测实现：server.js、脚本、测试都 require 它（test/ffmpeg-single-probe.test.js 盯着）。
//
//   const vtc = require("./modules/learning/video-transcode.js").create({
//     attachDir,                 // 必填：附件目录（server.js 的 ATTACH_DIR）
//     tmpRoot,                   // 缺省 <attachDir>.convert-tmp；本引擎只用 v-* 工作目录（office-convert 启动清理也会扫这里）
//     store,                     // 见下「store 契约」
//     log(msg),
//     probe(force),              // 缺省 (force) => findFfmpeg({ env })
//     disabled(),                // 缺省 env.LMS_DISABLE_VIDEO_TRANSCODE === "1" → 状态 "disabled"
//     env, now, runInContext(ctx, fn),
//     timeoutMs,                 // 每段视频；环境变量 LMS_VIDEO_TRANSCODE_TIMEOUT_MS，缺省 30 分钟，限 1 分钟–3 小时
//     concurrency,               // LMS_VIDEO_TRANSCODE_CONCURRENCY，缺省 1，最多 2
//     autoStart,                 // 缺省 true；离线脚本传 false（只抽取、不转码，行留 pending 等服务转）
//     hooks: { audit(action, targetId, before, after, by), notifyFailures({ attachment, items, by, message }) },
//   });
//
// 入口 / API used by server.js (G1):
//   vtc.ingestDeck({ attachment, srcPath, pdfPath })  异步，不抛业务错误。上传 .pptx（或批量补转）成功之后调用：
//        子进程里解析 + 流式抽取（120 s 超时、512 MB 堆）→ 一个事务插入 attachment_media 行 → 再把源视频挪进附件目录
//        （<am-id>.src.<ext>）→ kick()。同一个附件已有行时什么也不做，直接返回已有行（幂等）。
//        → { total, ready, pending, transcoding, failed, external, skipped, mapping, pdfPages, visibleSlides,
//            transcoder, items:[行], reused?, error? }    error ∈ pptx_unreadable | zip64_unsupported（整份读不了）
//   vtc.state()                       同步："ok" | "missing" | "disabled" | "no_encoder"（首次探测完成前是 "missing"）
//   vtc.ready()                       Promise：首次探测完成
//   vtc.available()                   同步：ffmpeg 路径 | null
//   vtc.status({ refresh, includePath })  异步 → { state, path, version, encoder, probedAt, lastTranscode }；refresh 至少间隔 10 秒
//   vtc.startJob(ids|null, { by:{id,name}, requestId, auto })  → job 快照；ids 为 null 或 [] = 全部可重试的行
//        （auto:true 只取 pending；手动取 pending + failed）。抛 Error .code ∈ unavailable | running(.job) | unknown_media(.ids) | nothing_to_transcode
//   vtc.job()                         → { running, startedAt, finishedAt, total, done, ready, failed, by, auto, aborted, currentIds, interrupted }
//   vtc.kick()                        autoStart 且 ffmpeg 可用、没有任务在跑、有 pending 行 → 起一个自动任务（by:null）。从不抛错
//   vtc.startupRecover()              同步、不抛错：杀上次遗留的 ffmpeg（按 pid + 映像名核对）→ resetTranscodingMedia()
//        → 清理已转码的源文件（不再被任何行引用的才删）→ 清 1 小时前的 v-* → 开 60 秒重探测与每日清理定时器 → 探测完后 kick()
//   vtc.shutdown()                    同步杀掉所有在跑的进程（process.on("exit") 里调），停定时器
//   vtc.mappingOf(attachmentId)       → { mapping, pdfPages, visibleSlides } | null（抽取时记在 meta）
//   vtc.isRetryable(row) / vtc.summarize(rows) / vtc.cleanOrphans() / vtc.cleanTmp()
//
// store 契约（G1 在 store.js 实现，迁移 72 attachment_media）：
//   createAttachmentMedia(rows)  一个事务；行里已给 id（am-<12 hex>）、createdAt、updatedAt；slides 是数组（store 负责 JSON 化）
//   listAttachmentMedia({ attachmentId, attachmentIds, statuses })  → 解析后的行（slides 为数组），按 attachmentId, seq 排序；
//                                三个条件都可省（只给 statuses 也要能查）
//   getAttachmentMedia(id)       → 行 | null
//   updateAttachmentMedia(id, patch, { expectStatus })  → 改动行数 0/1；自动写 updatedAt。
//                                patch 字段：status, reason, detail, storageKey, size, durationSec, srcKey, attempts
//   claimAttachmentMedia(id)     原子地 pending|failed → transcoding，attempts+1 → bool
//   resetTranscodingMedia()      transcoding → pending → 行数
//   listMediaFileKeys()          → { srcKeys:Set, storageKeys:Set }（所有行的非空 srcKey / storageKey）
//   getAttachment(id), getMeta(key), setMeta(key, value)
//
// 存储：源视频 <am-id>.src.<ext>、产物 <am-id>.mp4，平铺在附件目录（03:00 备份会带上）。转码成功后行的 srcKey 置空，
// 源文件记进 meta video.transcode.orphans，在下次启动或每天中午（LMS_VIDEO_SRC_SWEEP_HOUR，缺省 12 点，避开 03:00 备份）删除，
// 删之前确认已没有任何行引用它（安全评审 #4，H5 的本意是「不在备份复制时删」）。
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { spawn, execFile, execFileSync } = require("child_process");

const PPTX_MEDIA = path.join(__dirname, "pptx-media.js");
const GB = 1024 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
const MIN_ENV_TIMEOUT_MS = 60 * 1000;
const MAX_TIMEOUT_MS = 3 * 60 * 60 * 1000;
const PROBE_TIMEOUT_MS = 30000;
const VERSION_TIMEOUT_MS = 15000;
const INGEST_TIMEOUT_MS = 120000;
const REPROBE_MS = 60000;
const REFRESH_MIN_MS = 10000;
const TMP_MAX_AGE_MS = 60 * 60 * 1000;
const ABORT_AFTER_TIMEOUTS = 3;
const MAX_ORPHANS = 5000;
const MAX_MAPPINGS = 5000;
const STDERR_KEEP = 4000;
const DETAIL_MAX = 1000;
const MAX_DURATION_SEC = 4 * 60 * 60;       // 安全评审 #5：-t 14400
const MAX_OUTPUT_BYTES = 2 * GB;            // -fs 2147483648
const MAX_PIXELS = 8294400;                 // ≤ 4K 输入帧
const DISK_RESERVE_BYTES = 5 * GB;          // 安全评审 #4：剩余空间 ≥ 2 × 计划抽取量 + 5 GB
const DEFAULT_SRC_MAX_BYTES = 20 * GB;      // LMS_VIDEO_SRC_MAX_BYTES：等待转码的源视频总量上限
const DEFAULT_SWEEP_HOUR = 12;
const FORMAT_WHITELIST = "mov,mp4,m4a,3gp,3g2,mj2,avi,asf,matroska,webm,mpeg,mpegts,mpegvideo,flv";
const STALE_IMAGES = ["ffmpeg", "ffmpeg.exe"];
const META = {
  lastJob: "video.transcode.lastJob",
  last: "video.transcode.last",
  orphans: "video.transcode.orphans",
  running: "video.transcode.running",
  mapping: "video.transcode.mapping",
  lastSweep: "video.transcode.lastSweep",
};
const STATUSES = ["pending", "transcoding", "ready", "failed", "external", "skipped"];
const RETRY_CODES = new Set(["EPERM", "EBUSY", "EACCES", "ENOTEMPTY", "EMFILE", "ENFILE"]);
const RETRY_DELAYS = [100, 150, 200, 300];

// 管理员看到的原因文案（设计稿 §13.4 + 安全评审 #4/#5 新增 too_long / disk_full / storage_limit）。
// 前端 web/src/mediareasons.js（G4）保持同一套键与文字。{m} = 超时分钟数，{ext} = 扩展名（≤10 字符）。
const UNREADABLE = { zh: "无法从 PPT 中读取这段视频，请把视频另存为 MP4，作为小节视频上传", en: "This video couldn't be read from the deck; save it as MP4 and upload it as the section video" };
const REASONS = Object.freeze({
  unavailable: { zh: "服务器未安装视频转码组件（ffmpeg），装好后会自动转码", en: "The video transcoder (ffmpeg) is not installed; videos will be converted automatically once it is" },
  no_encoder: { zh: "已安装的 ffmpeg 缺少 H.264 / AAC 编码器", en: "The installed ffmpeg lacks the H.264 / AAC encoders" },
  timeout: { zh: "转码超时（超过 {m} 分钟）", en: "Conversion timed out (over {m} minutes)" },
  error: { zh: "视频文件已损坏或格式无法识别", en: "The video file is damaged or its format isn't recognised" },
  no_mp4: { zh: "转码没有生成可播放的文件", en: "Conversion didn't produce a playable file" },
  source_missing: { zh: "原始视频文件丢失，请重新上传课件", en: "The original video file is missing; upload the deck again" },
  too_large: { zh: "视频超过 500 MB 上限", en: "The video is over the 500 MB limit" },
  too_long: { zh: "视频时长超过 4 小时上限", en: "The video is longer than the 4-hour limit" },
  unsupported_format: { zh: "不支持的视频格式（.{ext}）", en: "Unsupported video format (.{ext})" },
  unsupported_compression: UNREADABLE,
  pptx_unreadable: UNREADABLE,
  zip64_unsupported: UNREADABLE,
  linked_file: { zh: "视频只是链接到电脑上的文件，没有嵌入 PPT；请在 PowerPoint 中改为嵌入后重新上传", en: "The video is linked to a file on a computer, not embedded; embed it in PowerPoint and upload again" },
  hidden_slide: { zh: "视频在隐藏的幻灯片上，学员看不到，已跳过", en: "The video is on a hidden slide that learners can't see, so it was skipped" },
  audio_not_supported: { zh: "音频暂不随课件播放，已跳过", en: "Audio is not played with courseware yet, so it was skipped" },
  too_many_media: { zh: "一份课件最多处理 50 段视频，其余已跳过", en: "Up to 50 videos per deck are processed; the rest were skipped" },
  disk_full: { zh: "服务器磁盘空间不足，这段视频没有保存；请联系 IT 清理空间后重新上传课件", en: "The server is low on disk space, so this video wasn't saved; ask IT to free up space, then upload the deck again" },
  storage_limit: { zh: "等待转码的视频已达存储上限，这段视频没有保存；请在已有视频转码完成后重新上传课件", en: "Videos waiting for conversion have reached the storage limit, so this video wasn't saved; upload the deck again once the waiting videos are converted" },
  cancelled: { zh: "转码已取消（服务重启），会自动重新排队", en: "Conversion was cancelled (server restart) and will be queued again" },
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function sleepSync(ms) { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { /* ignore */ } }
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
function clampInt(v, lo, hi, dflt) {
  if (v === undefined || v === null || v === "") return dflt;
  const n = Math.floor(Number(v));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
}
function isInside(parent, child) {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return !!rel && !rel.startsWith("..") && !path.isAbsolute(rel);
}
function codeError(code, extra) {
  const e = new Error(code);
  e.code = code;
  if (extra) Object.assign(e, extra);
  return e;
}
const isScript = (bin) => /\.(c?js|mjs)$/i.test(String(bin || "")); // 测试替身 test/fixtures/fake-ffmpeg.js 用 node 执行
const newMediaId = () => "am-" + crypto.randomBytes(6).toString("hex");

// ---------------------------------------------------------------- probe (the single authority)
// 顺序：LMS_FFMPEG → PATH（只认绝对路径）→ Windows 常见安装位置（由环境变量推出，不写死盘符）→ posix 常见位置。
// Windows 上 LMS_FFMPEG 必须是 .exe（测试替身 .js 例外）：.cmd / .bat 需要 shell，本引擎从不用 shell（安全评审 #16）。
function findFfmpeg(opts) {
  const o = opts || {};
  const env = o.env || process.env;
  const platform = o.platform || process.platform;
  const exists = typeof o.exists === "function" ? o.exists : (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };
  const win = platform === "win32";
  const P = win ? path.win32 : path.posix;
  const get = (k) => {
    if (env[k] !== undefined) return env[k];
    if (!win) return undefined;
    const hit = Object.keys(env).find((x) => x.toLowerCase() === k.toLowerCase());
    return hit ? env[hit] : undefined;
  };
  const cands = [];
  const explicit = get("LMS_FFMPEG");
  if (explicit && (!win || /\.(exe|c?js|mjs)$/i.test(explicit))) cands.push(explicit);
  const exe = win ? "ffmpeg.exe" : "ffmpeg";
  for (const raw of String(get("PATH") || "").split(win ? ";" : ":")) {
    const d = raw.trim().replace(/^"(.*)"$/, "$1");
    if (d && P.isAbsolute(d)) cands.push(P.join(d, exe));
  }
  if (win) {
    const pf = get("ProgramFiles"), pd = get("ProgramData"), la = get("LOCALAPPDATA");
    if (pf) cands.push(P.join(pf, "ffmpeg", "bin", "ffmpeg.exe"), P.join(pf, "WinGet", "Links", "ffmpeg.exe"));
    if (pd) cands.push(P.join(pd, "chocolatey", "bin", "ffmpeg.exe"));
    if (la) cands.push(P.join(la, "Microsoft", "WinGet", "Links", "ffmpeg.exe"));
  } else {
    cands.push("/usr/bin/ffmpeg", "/usr/local/bin/ffmpeg", "/opt/homebrew/bin/ffmpeg");
  }
  return cands.find((p) => { try { return exists(p); } catch { return false; } }) || null;
}

// ---------------------------------------------------------------- texts
function fill(s, vars) {
  return String(s).replace(/\{(\w+)\}/g, (m, k) => (vars && vars[k] != null ? String(vars[k]) : m));
}
function reasonText(reason, lang, vars) {
  const r = REASONS[reason] || REASONS.error;
  return fill(r[lang === "en" ? "en" : "zh"], vars);
}
// 幻灯片号用 PowerPoint 里的编号（slideNo，含隐藏页）：HR 要回 PowerPoint 里改
function slidesLabel(slides, lang) {
  const list = Array.isArray(slides) ? slides : [];
  const nums = list.map((s) => s && s.slideNo).filter((n) => Number.isFinite(n));
  const anyVisible = list.some((s) => s && s.pageNo != null);
  if (!nums.length) return lang === "en" ? "slide ?" : "第 ? 页";
  if (!anyVisible) return lang === "en" ? "hidden slide" : "隐藏页";
  return lang === "en" ? (nums.length > 1 ? "slides " : "slide ") + nums.join(", ") : "第 " + nums.join("、") + " 页";
}
function lineFor(deck, item, lang, vars) {
  const text = reasonText(item.reason, lang, { ext: item.srcExt || "?", ...(vars || {}) });
  return lang === "en"
    ? `"${deck}" ${slidesLabel(item.slides, "en")} "${item.name}": ${text}`
    : `「${deck}」${slidesLabel(item.slides, "zh")}「${item.name}」：${text}`;
}
function failureMessage(deck, items, vars) {
  const out = {};
  for (const lang of ["zh", "en"]) {
    const lines = items.slice(0, 3).map((it) => lineFor(deck, it, lang, vars));
    if (items.length > 3) lines.push(lang === "en" ? `and ${items.length - 3} more` : `等 ${items.length - 3} 段`);
    out[lang] = { title: lang === "en" ? "Courseware video could not be converted" : "课件视频转码失败", body: lines.join("\n") };
  }
  return out;
}

function summarize(rows) {
  const s = { total: 0, ready: 0, pending: 0, transcoding: 0, failed: 0, external: 0, skipped: 0 };
  for (const r of rows || []) { s.total++; if (s[r.status] !== undefined) s[r.status]++; }
  return s;
}
function isRetryable(row) {
  return !!row && row.kind === "video" && row.source === "embedded" && !!row.srcKey && (row.status === "pending" || row.status === "failed");
}
// ffmpeg -i 的 stderr（loglevel info）
function parseProbe(text) {
  const s = String(text || "");
  const out = { durationSec: null, container: null, video: null, audio: null };
  const d = /Duration:\s*(\d+):(\d\d):(\d\d(?:\.\d+)?)/.exec(s);
  if (d) out.durationSec = Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3]);
  const c = /Input #0,\s*(.+?),?\s+from\s/.exec(s);
  if (c) out.container = c[1];
  const v = /Stream #\d+:\d+[^\n]*?:\s*Video:\s*([\w-]+)/.exec(s);
  if (v) out.video = v[1].toLowerCase();
  const a = /Stream #\d+:\d+[^\n]*?:\s*Audio:\s*([\w-]+)/.exec(s);
  if (a) out.audio = a[1].toLowerCase();
  return out;
}
function canCopy(info) {
  return !!info && /(^|,)(mov|mp4)(,|$)/.test(String(info.container || "")) && info.video === "h264" && (info.audio == null || info.audio === "aac");
}
function hasFtyp(file) {
  let fd;
  try {
    fd = fs.openSync(file, "r");
    const b = Buffer.alloc(12);
    const n = fs.readSync(fd, b, 0, 12, 0);
    return n >= 12 && b.toString("latin1", 4, 8) === "ftyp";
  } catch { return false; } finally { if (fd !== undefined) try { fs.closeSync(fd); } catch { /* ignore */ } }
}

function create(opts) {
  const o = opts || {};
  if (!o.attachDir) throw new Error("video-transcode: attachDir is required");
  const attachDir = path.resolve(o.attachDir);
  const tmpRoot = path.resolve(o.tmpRoot || attachDir + ".convert-tmp");
  const store = o.store || null;
  const log = typeof o.log === "function" ? o.log : () => {};
  const env = o.env || process.env;
  const probeFn = typeof o.probe === "function" ? o.probe : () => findFfmpeg({ env });
  const disabledFn = typeof o.disabled === "function" ? o.disabled : () => env.LMS_DISABLE_VIDEO_TRANSCODE === "1";
  const now = typeof o.now === "function" ? o.now : () => Date.now();
  const runInContext = typeof o.runInContext === "function" ? o.runInContext : (ctx, fn) => fn();
  const hooks = o.hooks || {};
  // 环境变量限 1 分钟–3 小时；代码直接传入（测试）只限下限 200 ms
  const timeoutMs = o.timeoutMs !== undefined
    ? clampInt(o.timeoutMs, 200, MAX_TIMEOUT_MS, DEFAULT_TIMEOUT_MS)
    : clampInt(env.LMS_VIDEO_TRANSCODE_TIMEOUT_MS, MIN_ENV_TIMEOUT_MS, MAX_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
  const concurrency = clampInt(o.concurrency !== undefined ? o.concurrency : env.LMS_VIDEO_TRANSCODE_CONCURRENCY, 1, 2, 1);
  const autoStart = o.autoStart !== false;
  const probeTimeoutMs = clampInt(o.probeTimeoutMs, 200, PROBE_TIMEOUT_MS, PROBE_TIMEOUT_MS);
  const ingestTimeoutMs = clampInt(o.ingestTimeoutMs, 1000, 600000, INGEST_TIMEOUT_MS);
  const reprobeMs = clampInt(o.reprobeMs, 50, 3600000, REPROBE_MS);
  const srcMaxBytes = clampInt(o.srcMaxBytes !== undefined ? o.srcMaxBytes : env.LMS_VIDEO_SRC_MAX_BYTES, 0, Number.MAX_SAFE_INTEGER, DEFAULT_SRC_MAX_BYTES);
  const diskReserveBytes = clampInt(o.diskReserveBytes, 0, Number.MAX_SAFE_INTEGER, DISK_RESERVE_BYTES);
  const sweepHour = clampInt(o.sweepHour !== undefined ? o.sweepHour : env.LMS_VIDEO_SRC_SWEEP_HOUR, 0, 23, DEFAULT_SWEEP_HOUR);
  const statfs = typeof o.statfs === "function" ? o.statfs : (p) => fs.statfsSync(p);
  const staleImages = (o.staleImages || STALE_IMAGES).map((s) => String(s).toLowerCase());
  const pptxLimits = o.pptxLimits || null; // 测试用：缩小 pptx-media 的上限
  const iso = () => new Date(now()).toISOString();
  const timelimitSec = Math.ceil(timeoutMs / 1000) + 60; // ffmpeg 自我了断的兜底（安全评审 #6）

  // ---------- meta ----------
  function readMeta(key, dflt) {
    if (!store || typeof store.getMeta !== "function") return dflt;
    try { const v = store.getMeta(key); return v == null ? dflt : (JSON.parse(v) ?? dflt); } catch { return dflt; }
  }
  function writeMeta(key, value) {
    if (!store || typeof store.setMeta !== "function") return;
    try { store.setMeta(key, JSON.stringify(value)); } catch (e) { log("could not save " + key + ": " + ((e && e.message) || e)); }
  }
  function safeHook(fn, ...args) {
    if (typeof fn !== "function") return;
    try { const r = fn(...args); if (r && typeof r.catch === "function") r.catch((e) => log("hook failed: " + ((e && e.message) || e))); }
    catch (e) { log("hook failed: " + ((e && e.message) || e)); }
  }

  // ---------- probe / state ----------
  let probe = { state: "missing", path: null, version: null, encoder: null, probedAt: null };
  let probing = null, everProbed = false, lastForcedMs = -Infinity;
  function runForOutput(bin, args, ms) {
    return new Promise((resolve) => {
      const exe = isScript(bin) ? process.execPath : bin;
      const argv = isScript(bin) ? [bin, ...args] : args;
      try {
        execFile(exe, argv, { timeout: ms, windowsHide: true, encoding: "utf8", maxBuffer: 1024 * 1024, shell: false }, (err, stdout, stderr) => {
          if (err && (err.code === "ENOENT" || err.code === "EACCES")) return resolve(null);
          resolve(String(stdout || "") + "\n" + String(stderr || ""));
        });
      } catch { resolve(null); }
    });
  }
  async function doProbe(force) {
    if (disabledFn()) { probe = { state: "disabled", path: null, version: null, encoder: null, probedAt: null }; return probe; }
    let bin = null;
    try { bin = probeFn(!!force) || null; } catch (e) { log("probe failed: " + ((e && e.message) || e)); }
    const at = iso();
    if (!bin) { probe = { state: "missing", path: null, version: null, encoder: null, probedAt: at }; return probe; }
    bin = String(bin);
    const [vOut, eOut] = await Promise.all([
      runForOutput(bin, ["-hide_banner", "-version"], VERSION_TIMEOUT_MS),
      runForOutput(bin, ["-hide_banner", "-encoders"], VERSION_TIMEOUT_MS),
    ]);
    if (vOut == null || eOut == null) { probe = { state: "missing", path: null, version: null, encoder: null, probedAt: at }; return probe; }
    const vm = /ffmpeg version (\S+)/.exec(vOut);
    const encoder = /^\s*V\S*\s+libx264\b/m.test(eOut) ? "libx264" : /^\s*V\S*\s+h264_mf\b/m.test(eOut) ? "h264_mf" : null;
    const aac = /^\s*A\S*\s+aac\b/m.test(eOut);
    probe = { state: encoder && aac ? "ok" : "no_encoder", path: bin, version: vm ? vm[1] : null, encoder: encoder && aac ? encoder : null, probedAt: at };
    return probe;
  }
  function ensureProbe(force) {
    if (probing) return probing;
    probing = doProbe(force)
      .catch((e) => { log("probe failed: " + ((e && e.message) || e)); return probe; })
      .finally(() => { everProbed = true; probing = null; });
    return probing;
  }
  function state() {
    if (disabledFn()) return "disabled";
    if (!everProbed && !probing) ensureProbe(false);
    return probe.state;
  }
  function available() { return state() === "ok" ? probe.path : null; }
  function ready() { if (disabledFn()) return Promise.resolve(); if (!everProbed) return ensureProbe(false).then(() => undefined); return probing ? probing.then(() => undefined) : Promise.resolve(); }
  const lastTranscode = () => readMeta(META.last, null);
  async function status(opts2) {
    const so = opts2 || {};
    if (so.refresh && !disabledFn() && now() - lastForcedMs >= REFRESH_MIN_MS) {
      lastForcedMs = now();
      await ensureProbe(true);
      kick();
    } else if (!disabledFn() && (!everProbed || probing)) await ensureProbe(false);
    const st = state();
    return {
      state: st,
      path: st === "ok" && so.includePath !== false ? probe.path : null,
      version: st === "ok" || st === "no_encoder" ? probe.version : null,
      encoder: st === "ok" ? probe.encoder : null,
      probedAt: st === "disabled" ? null : probe.probedAt,
      lastTranscode: lastTranscode(),
    };
  }
  // 60 秒重探测（没装 / 缺编码器时）：一旦变成 ok 且有 pending 行，自动开始转码，不用重启服务
  async function checkAvailability() {
    if (disabledFn()) return state();
    await ensureProbe(true);
    if (probe.state === "ok") kick();
    return probe.state;
  }

  // ---------- temp dirs / files ----------
  function makeWorkDir() {
    fs.mkdirSync(tmpRoot, { recursive: true });
    return fs.mkdtempSync(path.join(tmpRoot, "v-"));
  }
  function rmWorkDir(dir) {
    if (!dir || !isInside(tmpRoot, dir)) return false;
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); return true; }
    catch (e) { log("could not remove " + dir + ": " + ((e && e.code) || e)); return false; }
  }
  function storagePath(key) {
    const k = String(key || "");
    if (!k || k !== path.basename(k)) throw new Error("invalid storage key");
    const p = path.join(attachDir, k);
    if (!isInside(attachDir, p)) throw new Error("invalid storage key");
    return p;
  }
  async function place(file, key) {
    const dest = storagePath(key);
    fs.mkdirSync(attachDir, { recursive: true });
    try { await withRetry(() => fs.renameSync(file, dest)); }
    catch (e) {
      if (!e || e.code !== "EXDEV") throw e;
      await withRetry(() => fs.copyFileSync(file, dest));
      try { await withRetry(() => fs.unlinkSync(file)); } catch { /* 工作目录整个会删 */ }
    }
    return fs.statSync(dest).size;
  }
  function redact(text) {
    let s = String(text || "");
    for (const [dir, label] of [[attachDir, "<attachments>"], [tmpRoot, "<tmp>"]]) {
      for (const v of new Set([dir, dir.replace(/\\/g, "/"), dir.replace(/\//g, "\\")])) {
        if (!v) continue;
        s = s.split(v).join(label);
        if (process.platform === "win32") s = s.replace(new RegExp(v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), label);
      }
    }
    return s.trim().slice(-DETAIL_MAX);
  }

  // ---------- processes ----------
  const running = new Set();
  let stopping = false;
  function killPidTree(pid, sync) {
    if (!pid) return;
    if (process.platform === "win32") {
      const args = ["/PID", String(pid), "/T", "/F"];
      if (sync) { try { execFileSync("taskkill", args, { stdio: "ignore", windowsHide: true, timeout: 5000 }); } catch { /* gone */ } }
      else execFile("taskkill", args, { windowsHide: true, timeout: 5000 }, () => {});
      return;
    }
    try { process.kill(-pid, "SIGKILL"); } catch { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
  }
  function killTree(child, sync) {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    killPidTree(child.pid, sync);
    if (process.platform === "win32" && !sync) setTimeout(() => { try { if (child.exitCode === null) child.kill(); } catch { /* ignore */ } }, 5000).unref();
  }
  // 正在跑的 ffmpeg 记进 meta：硬停机 / 崩溃后，下次启动按 pid + 映像名核对后杀掉（安全评审 #6）
  function recordRunning(pid, mediaId, image) {
    const list = (readMeta(META.running, []) || []).filter((r) => r && r.pid !== pid);
    list.push({ pid, mediaId, image: String(image || "").toLowerCase(), startedAt: iso() });
    writeMeta(META.running, list.slice(-20));
  }
  function clearRunning(pid) {
    const list = readMeta(META.running, []) || [];
    const next = list.filter((r) => r && r.pid !== pid);
    if (next.length !== list.length) writeMeta(META.running, next);
  }
  function runFfmpeg(bin, args, ms, mediaId) {
    return new Promise((resolve) => {
      const exe = isScript(bin) ? process.execPath : bin;
      const argv = isScript(bin) ? [bin, ...args] : args;
      let child;
      try {
        child = spawn(exe, argv, { windowsHide: true, stdio: ["ignore", "ignore", "pipe"], detached: process.platform !== "win32", shell: false });
      } catch (e) {
        return resolve({ code: null, stderr: "", timedOut: false, spawnError: (e && (e.code === "ENOENT" || e.code === "EACCES")) ? "unavailable" : "error" });
      }
      if (child.pid) {
        try { os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch { /* not permitted */ }
        if (mediaId) recordRunning(child.pid, mediaId, path.basename(exe));
      }
      running.add(child);
      let stderr = "", timedOut = false, settled = false, hard = null, drain = null;
      if (child.stderr) child.stderr.on("data", (d) => { stderr += d; if (stderr.length > STDERR_KEEP * 2) stderr = stderr.slice(-STDERR_KEEP); });
      const settle = (r) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (hard) clearTimeout(hard);
        if (drain) clearTimeout(drain);
        running.delete(child);
        if (mediaId && child.pid) clearRunning(child.pid);
        if (child.stderr) try { child.stderr.destroy(); } catch { /* ignore */ }
        resolve({ code: null, spawnError: null, ...r, stderr: stderr.slice(-STDERR_KEEP), timedOut });
      };
      const timer = setTimeout(() => {
        timedOut = true;
        killTree(child, false);
        hard = setTimeout(() => settle({ code: null }), 10000); // 杀不掉也不能一直挂着
      }, ms);
      child.on("error", (e) => settle({ code: null, spawnError: (e && (e.code === "ENOENT" || e.code === "EACCES")) ? "unavailable" : "error" }));
      child.on("exit", (code) => { drain = setTimeout(() => settle({ code }), 2000); }); // stderr 收尾最多再等 2 秒
      child.on("close", (code) => settle({ code }));
    });
  }
  function inputArgs(loglevel) {
    return ["-nostdin", "-hide_banner", "-loglevel", loglevel, "-timelimit", String(timelimitSec),
      "-protocol_whitelist", "file", "-format_whitelist", FORMAT_WHITELIST, "-max_pixels", String(MAX_PIXELS)];
  }
  const outputLimits = () => ["-t", String(MAX_DURATION_SEC), "-fs", String(MAX_OUTPUT_BYTES), "-movflags", "+faststart"];
  function probeArgs(input) { return [...inputArgs("info"), "-i", input]; }
  function copyArgs(input, out) {
    return [...inputArgs("error"), "-y", "-i", input, "-map", "0:v:0", "-map", "0:a:0?", "-c", "copy", ...outputLimits(), "file:" + out];
  }
  function fullArgs(input, out, encoder) {
    const v = encoder === "h264_mf" ? ["-c:v", "h264_mf", "-b:v", "3M"] : ["-c:v", "libx264", "-preset", "veryfast", "-crf", "23"];
    return [...inputArgs("error"), "-y", "-i", input, "-map", "0:v:0", "-map", "0:a:0?", ...v,
      "-pix_fmt", "yuv420p", "-vf", "scale='min(1920,trunc(iw/2)*2)':-2", "-c:a", "aac", "-b:a", "128k", "-threads", "2",
      ...outputLimits(), "file:" + out];
  }

  // ---------- ingest (upload / batch conversion of a .pptx) ----------
  function readMappings() { const m = readMeta(META.mapping, {}); return m && typeof m === "object" && !Array.isArray(m) ? m : {}; }
  function saveMapping(attId, info) {
    const all = readMappings();
    all[attId] = { ...info, at: iso() };
    const keys = Object.keys(all);
    if (keys.length > MAX_MAPPINGS) {
      keys.sort((a, b) => String(all[a].at).localeCompare(String(all[b].at)));
      for (const k of keys.slice(0, keys.length - MAX_MAPPINGS)) delete all[k];
    }
    writeMeta(META.mapping, all);
  }
  function mappingOf(attId) {
    const m = readMappings()[attId];
    return m ? { mapping: m.mapping || null, pdfPages: m.pdfPages ?? null, visibleSlides: m.visibleSlides ?? null } : null;
  }
  function diskBudget() {
    try {
      fs.mkdirSync(attachDir, { recursive: true });
      const s = statfs(attachDir);
      const free = Number(s.bavail) * Number(s.bsize);
      if (!Number.isFinite(free)) return null;
      return Math.max(0, Math.floor((free - diskReserveBytes) / 2));
    } catch { return null; }
  }
  function srcBudget() {
    try {
      let used = 0;
      for (const r of store.listAttachmentMedia({ statuses: ["pending", "transcoding", "failed"] }) || []) if (r.srcKey) used += Number(r.srcSize) || 0;
      return Math.max(0, srcMaxBytes - used);
    } catch { return null; }
  }
  function runIngestChild(src, workDir, pdfPath, childOpts) {
    return new Promise((resolve) => {
      let child;
      try {
        child = execFile(process.execPath, ["--max-old-space-size=512", PPTX_MEDIA, "--ingest", src, workDir, pdfPath || "", JSON.stringify(childOpts)],
          { timeout: ingestTimeoutMs, windowsHide: true, encoding: "utf8", maxBuffer: 8 * 1024 * 1024, shell: false },
          (err, stdout) => {
            running.delete(child);
            if (err) { log("pptx inspection failed: " + ((err && (err.killed ? "timeout" : err.message)) || err)); return resolve({ ok: false, error: "pptx_unreadable", media: [] }); }
            try { resolve(JSON.parse(stdout)); } catch { resolve({ ok: false, error: "pptx_unreadable", media: [] }); }
          });
        running.add(child);
      } catch (e) {
        log("could not start the pptx inspector: " + ((e && e.message) || e));
        resolve({ ok: false, error: "pptx_unreadable", media: [] });
      }
    });
  }
  function result(rows, extra) {
    return { ...summarize(rows), mapping: null, pdfPages: null, visibleSlides: null, transcoder: state(), items: rows, ...(extra || {}) };
  }
  async function ingestDeck(args) {
    const a = args || {};
    const att = a.attachment;
    if (!att || !att.id) throw new Error("video-transcode: ingestDeck needs { attachment }");
    if (!store) throw new Error("video-transcode: ingestDeck needs a store");
    const probed = ready().catch(() => {}); // 回执里的 transcoder 状态要等首次探测完成（与抽取并行）
    const existing = store.listAttachmentMedia({ attachmentId: att.id }) || [];
    if (existing.length) { await probed; return result(existing, { ...(mappingOf(att.id) || {}), reused: true }); }
    let workDir = null;
    try {
      workDir = makeWorkDir();
      const childOpts = { diskBudgetBytes: diskBudget(), srcBudgetBytes: srcBudget() };
      if (pptxLimits) childOpts.limits = pptxLimits;
      const r = await runIngestChild(path.resolve(String(a.srcPath)), workDir, a.pdfPath ? path.resolve(String(a.pdfPath)) : "", childOpts);
      const info = { mapping: r.mapping || null, pdfPages: r.pdfPages ?? null, visibleSlides: r.ok ? r.visibleCount : null };
      await probed;
      if (!r.ok) return result([], { ...info, error: r.error || "pptx_unreadable" });
      const at = iso();
      const rows = [];
      const moves = [];
      for (const m of r.media || []) {
        const id = newMediaId();
        let srcKey = null;
        if (m.status === "pending" && m.file && isInside(workDir, m.file) && m.srcExt) {
          srcKey = id + ".src." + m.srcExt;
          moves.push({ id, from: m.file, key: srcKey });
        }
        rows.push({
          id, attachmentId: att.id, seq: m.seq, kind: m.kind === "audio" ? "audio" : "video", source: m.source,
          name: String(m.name || "").slice(0, 120) || "video", url: m.source === "external" ? m.url || null : null,
          slides: (m.slides || []).map((s) => ({ slideNo: s.slideNo, pageNo: s.pageNo == null ? null : s.pageNo })),
          srcKey, srcExt: m.srcExt || null, srcSize: m.srcSize == null ? null : m.srcSize,
          storageKey: null, size: null, durationSec: null,
          status: m.status === "pending" && !srcKey ? "failed" : m.status, reason: m.status === "pending" && !srcKey ? "pptx_unreadable" : (m.reason || null),
          detail: null, attempts: 0, createdAt: at, updatedAt: at,
        });
      }
      if (rows.length) {
        try { store.createAttachmentMedia(rows); }
        catch (e) {
          // 并发的第二次抽取撞上唯一约束：返回先到的那份
          const again = store.listAttachmentMedia({ attachmentId: att.id }) || [];
          if (again.length) return result(again, { ...(mappingOf(att.id) || {}), reused: true });
          throw e;
        }
      }
      saveMapping(att.id, info);
      // 行已落库，再把源视频挪进附件目录；挪不进去的那一行标 source_missing（附件目录里不会出现没有行引用的文件）
      for (const mv of moves) {
        try { await place(mv.from, mv.key); }
        catch (e) {
          log("could not store " + mv.key + ": " + ((e && e.code) || e));
          try { store.updateAttachmentMedia(mv.id, { status: "failed", reason: "source_missing", srcKey: null }, { expectStatus: "pending" }); } catch { /* ignore */ }
        }
      }
      const fresh = store.listAttachmentMedia({ attachmentId: att.id }) || rows;
      kick();
      return result(fresh, info);
    } finally {
      if (workDir) rmWorkDir(workDir);
    }
  }

  // ---------- orphans (transcoded sources) ----------
  function addOrphans(keys) {
    const list = readMeta(META.orphans, []);
    const arr = Array.isArray(list) ? list : [];
    for (const k of keys) if (k && !arr.includes(k)) arr.push(k);
    writeMeta(META.orphans, arr.slice(-MAX_ORPHANS));
  }
  function cleanOrphans() {
    const list = readMeta(META.orphans, []);
    if (!Array.isArray(list) || !list.length || !store) return { removed: 0, kept: 0 };
    let referenced;
    try {
      const k = store.listMediaFileKeys();
      referenced = new Set([...(k && k.srcKeys ? k.srcKeys : []), ...(k && k.storageKeys ? k.storageKeys : [])]);
    } catch (e) { log("orphan check failed: " + ((e && e.message) || e)); return { removed: 0, kept: list.length }; }
    const keep = [];
    let removed = 0;
    for (const raw of list) {
      const key = String(raw || "");
      let p;
      try { p = storagePath(key); } catch { continue; }
      if (referenced.has(key)) continue; // 又被引用：不删，也不再记
      try { withRetrySync(() => fs.unlinkSync(p)); removed++; }
      catch (e) { if (e && e.code === "ENOENT") continue; keep.push(key); log("could not remove " + key + ": " + ((e && e.code) || e)); }
    }
    writeMeta(META.orphans, keep);
    return { removed, kept: keep.length };
  }
  function cleanTmp(opts2) {
    const maxAge = opts2 && opts2.maxAgeMs !== undefined ? opts2.maxAgeMs : TMP_MAX_AGE_MS;
    let removed = 0, names = [];
    try { names = fs.readdirSync(tmpRoot); } catch { return 0; }
    for (const n of names) {
      if (!n.startsWith("v-")) continue;
      const p = path.join(tmpRoot, n);
      try {
        if (now() - fs.statSync(p).mtimeMs < maxAge) continue;
        fs.rmSync(p, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
        removed++;
      } catch (e) { log("could not clean " + p + ": " + ((e && e.code) || e)); }
    }
    return removed;
  }

  // ---------- jobs ----------
  const emptyJob = () => ({
    running: false, startedAt: null, finishedAt: null, by: null, auto: false,
    total: 0, done: 0, ready: 0, failed: 0, currentIds: [], interrupted: false, aborted: null,
  });
  let current = null;
  const snapshot = (j) => ({ ...j, by: j.by ? { ...j.by } : null, currentIds: [...(j.currentIds || [])] });
  function saveJob() { if (current) writeMeta(META.lastJob, current); }
  function job() {
    if (current) return snapshot(current);
    const saved = readMeta(META.lastJob, null);
    if (!saved || typeof saved !== "object") return emptyJob();
    if (saved.running) return { ...emptyJob(), ...saved, running: false, currentIds: [], interrupted: true };
    return { ...emptyJob(), ...saved };
  }
  function recordLast(entry) {
    writeMeta(META.last, { at: iso(), ok: !!entry.ok, ms: Math.max(0, Math.round(entry.ms || 0)), reason: entry.reason || null, mediaId: entry.mediaId || null });
  }
  function unclaim(row) {
    try { store.updateAttachmentMedia(row.id, { status: row.status === "failed" ? "failed" : "pending", attempts: Math.max(0, (Number(row.attempts) || 1) - 1) }, { expectStatus: "transcoding" }); }
    catch (e) { log("could not release " + row.id + ": " + ((e && e.message) || e)); }
  }
  async function transcodeOne(id, ctx) {
    const before = store.getAttachmentMedia(id);
    if (!before || !isRetryable(before)) return { status: "skipped" };
    if (!store.claimAttachmentMedia(id)) return { status: "skipped" };
    const claimed = store.getAttachmentMedia(id) || { ...before, status: "transcoding" };
    // unclaim() 要放回认领前的状态（pending / failed）与次数
    const row = { ...claimed, status: before.status, attempts: claimed.attempts };
    const t0 = now();
    const deck = () => { try { const a = store.getAttachment(row.attachmentId); return (a && a.originalName) || row.attachmentId; } catch { return row.attachmentId; } };
    const fail = (reason, stderrText) => {
      const detail = stderrText ? redact(stderrText) || null : null;
      try { store.updateAttachmentMedia(id, { status: "failed", reason, detail }, { expectStatus: "transcoding" }); }
      catch (e) { log("could not mark " + id + " failed: " + ((e && e.message) || e)); }
      const item = { ...row, status: "failed", reason, detail };
      ctx.failures.push(item);
      recordLast({ ok: false, ms: now() - t0, reason, mediaId: id });
      safeHook(hooks.audit, "attachment.media.transcode.fail", id, null,
        { attachmentId: row.attachmentId, deck: deck(), name: row.name, slides: row.slides, reason }, ctx.by);
      if (reason !== "source_missing") log("transcode failed (" + reason + "): " + id + " " + JSON.stringify(row.name));
      return { status: "failed", reason };
    };
    let src;
    try { src = storagePath(row.srcKey); } catch { return fail("source_missing"); }
    if (!fs.existsSync(src)) return fail("source_missing");
    const bin = available();
    if (!bin) { unclaim(row); return { status: "abort", reason: state() === "no_encoder" ? "no_encoder" : "unavailable" }; }
    let workDir = null;
    try {
      workDir = makeWorkDir();
      const input = "file:" + src;
      const pr = await runFfmpeg(bin, probeArgs(input), probeTimeoutMs, id);
      if (pr.spawnError === "unavailable") { unclaim(row); ensureProbe(true); return { status: "abort", reason: "unavailable" }; }
      if (stopping) { unclaim(row); return { status: "abort", reason: "shutdown" }; }
      if (pr.timedOut) return fail("timeout", pr.stderr);
      const info = parseProbe(pr.stderr);
      if (info.durationSec != null && info.durationSec > MAX_DURATION_SEC) return fail("too_long");
      const out = path.join(workDir, "out.mp4");
      let mode = canCopy(info) ? "copy" : "transcode";
      let r = await runFfmpeg(bin, mode === "copy" ? copyArgs(input, out) : fullArgs(input, out, probe.encoder), timeoutMs, id);
      if (mode === "copy" && !r.timedOut && !r.spawnError && !stopping && (r.code !== 0 || !hasFtyp(out))) {
        try { fs.rmSync(out, { force: true }); } catch { /* ignore */ }
        mode = "transcode";
        r = await runFfmpeg(bin, fullArgs(input, out, probe.encoder), timeoutMs, id);
      }
      if (r.spawnError === "unavailable") { unclaim(row); ensureProbe(true); return { status: "abort", reason: "unavailable" }; }
      if (stopping) { unclaim(row); return { status: "abort", reason: "shutdown" }; }
      if (r.timedOut) return fail("timeout", r.stderr);
      if (r.code !== 0) return fail("error", r.stderr);
      let size = 0;
      try { size = fs.statSync(out).size; } catch { return fail("no_mp4", r.stderr); }
      if (size >= MAX_OUTPUT_BYTES * 0.99) return fail("too_large");
      if (!hasFtyp(out)) return fail("no_mp4", r.stderr);
      const storageKey = id + ".mp4";
      await place(out, storageKey);
      let ok = 0;
      try {
        ok = store.updateAttachmentMedia(id, { status: "ready", storageKey, size, durationSec: info.durationSec, reason: null, detail: null, srcKey: null }, { expectStatus: "transcoding" });
      } catch (e) { log("could not update " + id + ": " + ((e && e.message) || e)); }
      if (!ok) { addOrphans([storageKey]); return { status: "changed" }; } // 行被别处改了：产物等下次清理
      addOrphans([row.srcKey]); // 源视频：不在服务运行中立刻删（备份可能正在复制附件目录）
      const ms = now() - t0;
      recordLast({ ok: true, ms, reason: null, mediaId: id });
      safeHook(hooks.audit, "attachment.media.transcode", id, null,
        { attachmentId: row.attachmentId, name: row.name, slides: row.slides, size, ms, mode }, ctx.by);
      return { status: "ready", mode };
    } catch (e) {
      log("transcode of " + id + " crashed: " + ((e && e.message) || e));
      return fail("error", (e && e.message) || String(e));
    } finally {
      if (workDir) rmWorkDir(workDir);
    }
  }
  async function runJob(ids, ctx) {
    await null; // 先把 202 的快照交回去
    let timeouts = 0, next = 0;
    const worker = async () => {
      while (next < ids.length) {
        if (stopping) { current.aborted = current.aborted || "shutdown"; return; }
        if (current.aborted) return;
        const id = ids[next++];
        current.currentIds.push(id);
        saveJob();
        let r;
        try { r = await transcodeOne(id, ctx); } catch (e) { log("transcode crashed: " + ((e && e.message) || e)); r = { status: "failed", reason: "error" }; }
        current.currentIds = current.currentIds.filter((x) => x !== id);
        if (r.status === "abort") { current.aborted = current.aborted || r.reason || "unavailable"; return; }
        current.done++;
        if (r.status === "ready") { current.ready++; timeouts = 0; }
        else if (r.status === "failed") {
          current.failed++;
          timeouts = r.reason === "timeout" ? timeouts + 1 : 0;
          if (timeouts >= ABORT_AFTER_TIMEOUTS) { current.aborted = "timeouts"; return; }
        }
        saveJob();
      }
    };
    try {
      await Promise.all(Array.from({ length: Math.min(concurrency, ids.length) }, worker));
    } catch (e) {
      log("transcode job failed: " + ((e && e.message) || e));
      current.aborted = current.aborted || "error";
    } finally {
      // 每份课件一条通知（发给上传人；server.js 的钩子负责找人、判断是否在职）
      const byDeck = new Map();
      for (const it of ctx.failures) {
        if (!byDeck.has(it.attachmentId)) byDeck.set(it.attachmentId, []);
        byDeck.get(it.attachmentId).push(it);
      }
      for (const [attId, items] of byDeck) {
        let attachment = null;
        try { attachment = store.getAttachment(attId); } catch { /* ignore */ }
        const deckName = (attachment && attachment.originalName) || attId;
        safeHook(hooks.notifyFailures, { attachment, items, by: ctx.by, message: failureMessage(deckName, items, { m: Math.round(timeoutMs / 60000) }) });
      }
      const aborted = current.aborted;
      current.running = false;
      current.currentIds = [];
      current.finishedAt = iso();
      saveJob();
      current = null;
      // 任务期间又有新上传：自动接着转（只在本轮处理过的行之外还有 pending 时，避免空转）
      if (!stopping && !aborted && autoStart) {
        try {
          const done = new Set(ids);
          const more = (store.listAttachmentMedia({ statuses: ["pending"] }) || []).some((r) => isRetryable(r) && !done.has(r.id));
          if (more) setImmediate(kick);
        } catch { /* ignore */ }
      }
    }
  }
  function startJob(ids, opts2) {
    const h = opts2 || {};
    if (!store) throw new Error("video-transcode: startJob needs a store");
    if (current && current.running) throw codeError("running", { job: snapshot(current) });
    if (state() !== "ok") throw codeError("unavailable", { state: state() });
    const auto = !!h.auto;
    let list;
    if (ids == null || (Array.isArray(ids) && ids.length === 0)) {
      list = (store.listAttachmentMedia({ statuses: auto ? ["pending"] : ["pending", "failed"] }) || []).filter(isRetryable);
    } else {
      const uniq = [...new Set((Array.isArray(ids) ? ids : [ids]).map(String))];
      const bad = [];
      list = [];
      for (const id of uniq) {
        const r = store.getAttachmentMedia(id);
        if (!isRetryable(r)) bad.push(id); else list.push(r);
      }
      if (bad.length) throw codeError("unknown_media", { ids: bad });
    }
    if (!list.length) throw codeError("nothing_to_transcode");
    // 上传先后（createdAt）→ 课件 → 序号
    list.sort((x, y) => String(x.createdAt || "").localeCompare(String(y.createdAt || "")) || String(x.attachmentId).localeCompare(String(y.attachmentId)) || (x.seq - y.seq));
    const by = h.by && h.by.id ? { id: String(h.by.id), name: h.by.name == null ? null : String(h.by.name) } : null;
    current = { ...emptyJob(), running: true, startedAt: iso(), by, auto, total: list.length };
    saveJob();
    const ctx = { by, failures: [] };
    const ids2 = list.map((r) => r.id);
    Promise.resolve(runInContext({ actorId: by ? by.id : null, requestId: h.requestId || null }, () => runJob(ids2, ctx)))
      .catch((e) => log("transcode job crashed: " + ((e && e.message) || e)));
    return snapshot(current);
  }
  function kick() {
    try {
      if (!autoStart || stopping || !store || disabledFn() || (current && current.running)) return false;
      Promise.resolve(everProbed && !probing ? null : ensureProbe(false)).then(() => {
        if (stopping || probe.state !== "ok" || (current && current.running)) return;
        let pending = [];
        try { pending = (store.listAttachmentMedia({ statuses: ["pending"] }) || []).filter(isRetryable); } catch { return; }
        if (!pending.length) return;
        try { startJob(null, { auto: true }); } catch (e) { if (e && e.code !== "running" && e.code !== "nothing_to_transcode") log("auto transcode not started: " + (e.code || e.message)); }
      }).catch((e) => log("kick failed: " + ((e && e.message) || e)));
      return true;
    } catch (e) { log("kick failed: " + ((e && e.message) || e)); return false; }
  }

  // ---------- startup / timers / shutdown ----------
  function isAlive(pid) {
    try { process.kill(pid, 0); return true; } catch (e) { return !!e && e.code === "EPERM"; }
  }
  function imageOf(pid) {
    try {
      if (process.platform === "win32") {
        const out = execFileSync("tasklist", ["/FI", "PID eq " + pid, "/FO", "CSV", "/NH"], { encoding: "utf8", windowsHide: true, timeout: 5000, stdio: ["ignore", "pipe", "ignore"] });
        const m = /^"([^"]+)","(\d+)"/m.exec(out);
        return m && Number(m[2]) === pid ? m[1].toLowerCase() : null;
      }
      return fs.readFileSync("/proc/" + pid + "/comm", "utf8").trim().toLowerCase();
    } catch { return null; }
  }
  function killStale() {
    const list = readMeta(META.running, []) || [];
    let killed = 0;
    for (const r of Array.isArray(list) ? list : []) {
      const pid = Number(r && r.pid);
      if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid || !isAlive(pid)) continue;
      const img = imageOf(pid);
      const want = String((r && r.image) || "").toLowerCase();
      // 只杀映像名对得上、且是 ffmpeg 的进程：pid 可能已被别的程序复用
      if (!img || !want || img !== want || !staleImages.includes(img)) continue;
      killPidTree(pid, true);
      killed++;
    }
    if (list.length) writeMeta(META.running, []);
    return killed;
  }
  let reprobeTimer = null, sweepTimer = null;
  function localDay(ms) { const d = new Date(ms); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); }
  function sweepIfDue() {
    const t = now();
    if (new Date(t).getHours() !== sweepHour) return false;
    const day = localDay(t);
    if (readMeta(META.lastSweep, null) === day) return false;
    writeMeta(META.lastSweep, day);
    try { const r = cleanOrphans(); if (r.removed) log("removed " + r.removed + " transcoded source file(s)"); } catch (e) { log("daily cleanup failed: " + ((e && e.message) || e)); }
    return true;
  }
  function startTimers() {
    if (!autoStart || disabledFn()) return;
    if (!reprobeTimer) {
      reprobeTimer = setInterval(() => { if (probe.state !== "ok" && !probing) checkAvailability().catch(() => {}); }, reprobeMs);
      if (reprobeTimer.unref) reprobeTimer.unref();
    }
    if (!sweepTimer) {
      sweepTimer = setInterval(sweepIfDue, 10 * 60 * 1000);
      if (sweepTimer.unref) sweepTimer.unref();
    }
  }
  function startupRecover() {
    const out = { killed: 0, reset: 0, orphansRemoved: 0, orphansKept: 0, tmpRemoved: 0, interrupted: false };
    try { out.killed = killStale(); } catch (e) { log("stale process check failed: " + ((e && e.message) || e)); }
    if (store) {
      try { out.reset = Number(store.resetTranscodingMedia()) || 0; } catch (e) { log("could not reset transcoding rows: " + ((e && e.message) || e)); }
      try { const r = cleanOrphans(); out.orphansRemoved = r.removed; out.orphansKept = r.kept; } catch (e) { log("orphan cleanup failed: " + ((e && e.message) || e)); }
      try {
        const saved = readMeta(META.lastJob, null);
        if (!current && saved && saved.running) { writeMeta(META.lastJob, { ...saved, running: false, currentIds: [], interrupted: true }); out.interrupted = true; }
      } catch { /* only a marker */ }
    }
    try { out.tmpRemoved = cleanTmp(); } catch (e) { log("temp cleanup failed: " + ((e && e.message) || e)); }
    startTimers();
    if (!disabledFn()) ensureProbe(false).then(() => kick()).catch(() => {});
    return out;
  }
  function shutdown() {
    stopping = true;
    if (reprobeTimer) { clearInterval(reprobeTimer); reprobeTimer = null; }
    if (sweepTimer) { clearInterval(sweepTimer); sweepTimer = null; }
    for (const child of [...running]) killTree(child, true);
    running.clear();
  }

  return {
    attachDir, tmpRoot, timeoutMs, concurrency, autoStart,
    state, available, ready, status, checkAvailability,
    ingestDeck, mappingOf,
    startJob, job, kick,
    startupRecover, shutdown, cleanOrphans, cleanTmp, sweepIfDue,
    isRetryable, summarize, makeWorkDir, rmWorkDir,
  };
}

module.exports = {
  create, findFfmpeg, REASONS, META, STATUSES, FORMAT_WHITELIST,
  reasonText, lineFor, failureMessage, summarize, isRetryable, parseProbe, canCopy,
};
