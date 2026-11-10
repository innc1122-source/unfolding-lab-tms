// npm test 的入口（package.json "test"），与 test.bat 同一口径，分三步先后执行：
//   [1/3] TMS 测试                  test/*.test.js，SERIAL 里的文件除外
//   [2/3] 模块测试                  modules/*/test/*.test.js，SERIAL 里的文件除外
//   [3/3] Serial（单独运行）        SERIAL（计时用例 test/office-convert.test.js）
// TMS 测试会并行起很多服务进程；模块测试里的 4,000 人规模冒烟带计时上限，和其它测试文件并行跑时会因本机负载超时
// （2026-09-29 负责人决定：规模测试单独运行），所以放在最后单独一步，前后都没有别的测试进程。
// 任一步失败也照跑后面各步（所有结果都要看到）；任一步失败，本脚本以退出码 1 结束，全部通过为 0。
// 用运行本脚本的同一个 node（process.execPath）执行；第 1 步的 glob 由 node --test 自己展开（Windows 的 cmd 不展开通配符），
// 第 2、3 步由本脚本列出文件。某一步没有文件时跳过（按通过计）。
// 测试跑在系统临时目录的一次性数据库上，不打开、不修改根目录的 lms.db 与 config.json（规模冒烟只在 lms.db 是 925 人
// 假名测试集、且 -wal 为空时复制一份到临时目录，见 test/culture-scale.test.js 与 modules/culture/test/scale.js）。
"use strict";
const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
// 单独运行的测试文件（相对仓库根目录，正斜杠）
// 2026-10-10：office-convert 的超时 / 杀进程用例按真实耗时断言，和几十个测试进程并行时会因机器负载超出计时窗口（验收全量 #750），单独跑
const SERIAL = ["test/office-convert.test.js"];   // Unfolding Lab 版：culture 规模冒烟随模块删除

function moduleTestFiles() {
  const dir = path.join(ROOT, "modules");
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const m of fs.readdirSync(dir).sort()) {
    const t = path.join(dir, m, "test");
    if (!fs.existsSync(t) || !fs.statSync(t).isDirectory()) continue;
    for (const f of fs.readdirSync(t).sort()) if (f.endsWith(".test.js")) out.push("modules/" + m + "/test/" + f);
  }
  return out;
}

const mods = moduleTestFiles();
// TMS 测试由本脚本列出（不再交给 node --test 展开 glob），这样能把 SERIAL 里的 TMS 文件挪到最后一步单独跑
const tms = fs.readdirSync(path.join(ROOT, "test")).filter((f) => f.endsWith(".test.js")).sort().map((f) => "test/" + f);
const GROUPS = [
  { label: "TMS tests", pattern: "test/*.test.js (serial files run separately)", args: tms.filter((f) => !SERIAL.includes(f)) },
  { label: "Module tests", pattern: "modules/*/test/*.test.js (serial files run separately)", args: mods.filter((f) => !SERIAL.includes(f)) },
  { label: "Serial", pattern: SERIAL.join(", ") + " (run alone)", args: SERIAL.filter((f) => fs.existsSync(path.join(ROOT, f))) },
];

const codes = GROUPS.map((g, i) => {
  console.log(`[${i + 1}/${GROUPS.length}] ${g.label}: ${g.pattern}`);
  if (!g.args.length) { console.log(`${g.label}: no files, skipped`); return 0; }
  const r = spawnSync(process.execPath, ["--test", ...g.args], { cwd: ROOT, stdio: "inherit" });
  if (r.error) console.error(`${g.label}: could not start node (${r.error.message})`);
  return r.status === 0 ? 0 : (r.status || 1);
});
const failed = codes.some((c) => c !== 0);
console.log(failed
  ? `Some tests FAILED - ${GROUPS.map((g, i) => `${g.label.toLowerCase()} exit code ${codes[i]}`).join(", ")}.`
  : "All tests passed.");
process.exitCode = failed ? 1 : 0;
