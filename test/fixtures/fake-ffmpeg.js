// 测试替身：冒充 ffmpeg（第三批 5.7）。本机和 CI 都不必装 ffmpeg。
// 用法：LMS_DISABLE_VIDEO_TRANSCODE=0 + LMS_FFMPEG=<本文件>。modules/learning/video-transcode.js 看到 .js 结尾的
// 可执行文件就用 process.execPath 运行它（Node 22 不能不经 shell 运行 .cmd，所以替身必须是 node 脚本）。
//
//   -hide_banner -version     输出 "ffmpeg version 6.1-test-double …"
//   -hide_banner -encoders    列出 libx264 与 aac；环境变量 FAKE_FFMPEG_MODE=no_encoder 时不列
//   … -i file:<src>           （没有输出文件 = 探测）loglevel 为 info 及以上时打印 Duration 与流信息，退出码 1（与真 ffmpeg 一样）：
//                             源文件含 FAKE_FFMPEG_H264 → "Input #0, mov,mp4,…" + h264 / aac；否则 asf + wmv2 / wmav2；
//                             含 FAKE_FFMPEG_LONG → Duration 05:00:00.00
//   … -i file:<src> … <out>   转码 / 复制封装，按源文件内容决定：
//       FAKE_FFMPEG_FAIL      退出码 1 + "Invalid data found when processing input"
//       FAKE_FFMPEG_NOMP4     退出码 0，不产出文件
//       FAKE_FFMPEG_BADMP4    退出码 0，产出一个没有 ftyp 的文件
//       FAKE_FFMPEG_COPYFAIL  -c copy 时退出码 1（引擎应回退到完整转码）
//       FAKE_FFMPEG_HANG      挂住；起一个孙进程一起挂（测「杀整棵进程树」）；30 秒后自己退出
//       其它                  写出一个以 ftyp 盒开头的小 MP4
//   安全标志：缺 -nostdin 或缺 "-protocol_whitelist file" 时退出码 3。
//   FAKE_FFMPEG_LOG=<文件>：每次调用追加一行 JSON { pid, args, mode, childPid? }，测试据此核对参数与进程。
"use strict";
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const args = process.argv.slice(2);
const logFile = process.env.FAKE_FFMPEG_LOG;
function logLine(extra) {
  if (!logFile) return;
  try { fs.appendFileSync(logFile, JSON.stringify({ pid: process.pid, args, ...extra }) + "\n"); } catch { /* ignore */ }
}
const stripFile = (p) => (String(p || "").startsWith("file:") ? String(p).slice(5) : String(p || ""));

function main() {
  if (args.includes("--grandchild-hang")) {
    setInterval(() => {}, 1000);
    setTimeout(() => process.exit(0), 30000);
    return;
  }
  if (args.includes("-version")) {
    logLine({ mode: "version" });
    process.stdout.write("ffmpeg version 6.1-test-double Copyright (c) 2000-2026 the FFmpeg developers\nbuilt with node\n");
    return process.exit(0);
  }
  if (args.includes("-encoders")) {
    logLine({ mode: "encoders" });
    let out = "Encoders:\n V..... = Video\n A..... = Audio\n ------\n V....D mpeg4                MPEG-4 part 2\n";
    if (process.env.FAKE_FFMPEG_MODE !== "no_encoder") out += " V....D libx264              libx264 H.264 / AVC / MPEG-4 AVC (codec h264)\n A....D aac                  AAC (Advanced Audio Coding)\n";
    process.stdout.write(out);
    return process.exit(0);
  }
  const at = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; };
  if (!args.includes("-nostdin") || at("-protocol_whitelist") !== "file") {
    logLine({ mode: "unsafe" });
    process.stderr.write("fake-ffmpeg: refusing to run without -nostdin and -protocol_whitelist file\n");
    return process.exit(3);
  }
  const iIdx = args.indexOf("-i");
  const src = stripFile(args[iIdx + 1]);
  let raw = "";
  try { raw = fs.readFileSync(src).toString("latin1"); } catch (e) {
    process.stderr.write(src + ": No such file or directory\n");
    logLine({ mode: "nosrc" });
    return process.exit(1);
  }
  const outArg = args.length - 1 > iIdx + 1 ? args[args.length - 1] : null;
  if (!outArg) {
    // 探测：与真 ffmpeg 一样，只有 loglevel ≥ info 才打印流信息（安全评审 #11）
    logLine({ mode: "probe" });
    const lvl = at("-loglevel") || "info";
    if (["info", "verbose", "debug", "trace"].includes(lvl)) {
      const h264 = raw.includes("FAKE_FFMPEG_H264");
      const dur = raw.includes("FAKE_FFMPEG_LONG") ? "05:00:00.00" : "00:00:05.00";
      process.stderr.write(h264
        ? `Input #0, mov,mp4,m4a,3gp,3g2,mj2, from '${args[iIdx + 1]}':\n  Duration: ${dur}, start: 0.000000, bitrate: 900 kb/s\n  Stream #0:0[0x1](und): Video: h264 (High) (avc1 / 0x31637661), yuv420p, 640x360, 800 kb/s, 25 fps\n  Stream #0:1[0x2](und): Audio: aac (LC) (mp4a / 0x6134706D), 44100 Hz, stereo, fltp, 96 kb/s\n`
        : `Input #0, asf, from '${args[iIdx + 1]}':\n  Duration: ${dur}, start: 0.000000, bitrate: 900 kb/s\n  Stream #0:0: Video: wmv2 (WMV2 / 0x32564D57), yuv420p, 640x360, 800 kb/s, 25 fps\n  Stream #0:1: Audio: wmav2 (a[1][0][0] / 0x0161), 44100 Hz, stereo, fltp, 96 kb/s\n`);
    }
    process.stderr.write("At least one output file must be specified\n");
    return process.exit(1);
  }
  const out = stripFile(outArg);
  const copy = at("-c") === "copy";
  if (raw.includes("FAKE_FFMPEG_HANG")) {
    const gc = spawn(process.execPath, [__filename, "--grandchild-hang"], { stdio: "ignore", windowsHide: true });
    logLine({ mode: copy ? "copy" : "transcode", hang: true, childPid: gc.pid });
    setInterval(() => {}, 1000);
    setTimeout(() => process.exit(0), 30000);
    return;
  }
  logLine({ mode: copy ? "copy" : "transcode" });
  if (raw.includes("FAKE_FFMPEG_FAIL") || (copy && raw.includes("FAKE_FFMPEG_COPYFAIL"))) {
    process.stderr.write(`[in#0 @ 0x55] Error opening input: Invalid data found when processing input\nError opening input file ${args[iIdx + 1]}.\n`);
    return process.exit(1);
  }
  if (raw.includes("FAKE_FFMPEG_NOMP4")) return process.exit(0);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  if (raw.includes("FAKE_FFMPEG_BADMP4")) { fs.writeFileSync(out, "not an mp4 at all"); return process.exit(0); }
  const ftyp = Buffer.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0x00, 0x00, 0x02, 0x00, 0x69, 0x73, 0x6f, 0x6d, 0x69, 0x73, 0x6f, 0x32]);
  fs.writeFileSync(out, Buffer.concat([ftyp, Buffer.from(copy ? "fake-mp4-copy" : "fake-mp4-transcode")]));
  return process.exit(0);
}
main();
