// 第三批 5.7：ffmpeg 只有一份探测实现 —— modules/learning/video-transcode.js 的 findFfmpeg()。
// LibreOffice 的探测曾经有三份拷贝，只好另写 soffice-parity 盯着它们逐字一致；ffmpeg 从一开始就只许一份：
// server.js、脚本都 require 它，不许各自再写候选路径。（静态检查，不启动服务。）
"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const AUTHORITY = path.join("modules", "learning", "video-transcode.js");
const SKIP_DIRS = new Set(["node_modules", "runtime", "data", "backups", "dist", ".git", "test", "web"]);

function jsFiles(dir, out = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.isDirectory()) { if (!SKIP_DIRS.has(ent.name)) jsFiles(path.join(dir, ent.name), out); }
    else if (/\.(c?js|mjs)$/.test(ent.name)) out.push(path.join(dir, ent.name));
  }
  return out;
}
const rel = (f) => path.relative(ROOT, f);

test("findFfmpeg is defined only in video-transcode.js, and no other server-side file carries ffmpeg candidate paths", () => {
  const files = jsFiles(ROOT);
  assert.ok(files.some((f) => rel(f) === AUTHORITY));
  const definers = [], candidates = [];
  for (const f of files) {
    const src = fs.readFileSync(f, "utf8");
    if (/function\s+findFfmpeg\s*\(|findFfmpeg\s*=\s*(async\s*)?(\(|function)/.test(src)) definers.push(rel(f));
    if (rel(f) !== AUTHORITY && /(WinGet[\\/]+Links|chocolatey[\\/]+bin|\/usr\/(local\/)?bin\/ffmpeg|ffmpeg[\\/]+bin[\\/]+ffmpeg|"ffmpeg\.exe")/i.test(src)) candidates.push(rel(f));
  }
  assert.deepEqual(definers, [AUTHORITY]);
  assert.deepEqual(candidates, [], "ffmpeg locations belong in findFfmpeg only");
  const mod = require("../modules/learning/video-transcode.js");
  assert.equal(typeof mod.findFfmpeg, "function");
});

test("the offline conversion script uses the module (create + findFfmpeg), not a copy", () => {
  const src = fs.readFileSync(path.join(ROOT, "scripts", "convert-office-attachments.js"), "utf8");
  assert.match(src, /require\(path\.join\(ROOT, "modules", "learning", "video-transcode\.js"\)\)/);
  assert.match(src, /videoLib\.findFfmpeg\(\)/);
  assert.match(src, /autoStart: false/);
});

// server.js 的接线由 G1 完成；接线之前跳过（输出里能看到 skip 原因），接线之后必须成立
const SERVER = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");
const wired = SERVER.includes("video-transcode.js");
test("server.js requires video-transcode.js and does not probe ffmpeg itself", { skip: wired ? false : "server.js is not wired to video-transcode.js yet (G1)" }, () => {
  assert.match(SERVER, /require\("\.\/modules\/learning\/video-transcode\.js"\)/);
  assert.doesNotMatch(SERVER, /function\s+findFfmpeg\s*\(/);
  assert.doesNotMatch(SERVER, /LMS_FFMPEG\s*[,|)]/, "LMS_FFMPEG is read by findFfmpeg, not by server.js");
});
