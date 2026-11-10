// 运维入口的行为（2026-09-26 评审修复）：
//   1. npm test（scripts/run-tests.js）分三步先后跑：TMS 测试、模块测试（不含规模冒烟）、规模冒烟单独一步（2026-09-29
//      负责人决定）；前一步失败照跑后面各步，任一步失败退出码为 1；
//   2. test.bat 调用同一个 run-tests.js，按它的结果设退出码（0 = 全通过，1 = 有失败），不再恒为 0；
//   3. scripts/backup.js --prune 把模块迁移前的快照（pre-migration-vmodules-…）单独归类，保留最新 3 份，
//      不再当成普通备份 14 天后清掉。
// 全部在系统临时目录的副本里跑（脚本按自己所在目录找 ROOT），不碰仓库的 backups/、lms.db 与 config.json。
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { DatabaseSync } = require("node:sqlite");
const { ROOT, tempDir } = require("./helpers.js");

// 子进程里的 node --test 不能继承本进程的测试运行器上下文（否则它按「子测试」方式汇报给不存在的父进程）
const cleanEnv = () => { const e = { ...process.env }; delete e.NODE_TEST_CONTEXT; return e; };

test("npm test (scripts/run-tests.js) runs the TMS group, the module group and then the serial step (scale smoke + office-convert) alone — a failing step does not skip the next — and exits 1 when any fails", () => {
  const dir = tempDir("ops-runtests-");
  fs.mkdirSync(path.join(dir, "scripts"));
  fs.copyFileSync(path.join(ROOT, "scripts", "run-tests.js"), path.join(dir, "scripts", "run-tests.js"));
  fs.mkdirSync(path.join(dir, "test"));
  fs.mkdirSync(path.join(dir, "modules", "m1", "test"), { recursive: true });
  const unit = (name, ok) => `"use strict";\nrequire("node:test")(${JSON.stringify(name)}, () => { require("node:assert").equal(${ok ? 1 : 0}, 1); });\n`;
  const run = () => spawnSync(process.execPath, [path.join(dir, "scripts", "run-tests.js")], { cwd: dir, env: cleanEnv(), encoding: "utf8", timeout: 120000 });
  // Unfolding Lab 版（2026-10-12）：culture 规模冒烟随模块删除，串行一步只剩 office-convert —— 用它做「单独一步」的标记文件
  const scale = path.join(dir, "test", "office-convert.test.js");
  // 第一组失败、后两步通过：三步都跑了，退出码 1；规模冒烟不在模块组里，单独一步
  fs.writeFileSync(path.join(dir, "test", "a.test.js"), unit("tms-group-marker", false));
  fs.writeFileSync(path.join(dir, "modules", "m1", "test", "b.test.js"), unit("module-group-marker", true));
  fs.writeFileSync(scale, unit("scale-smoke-marker", true));
  let r = run();
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /\[1\/3\] TMS tests: test\/\*\.test\.js/);
  assert.match(r.stdout, /not ok \d+ - tms-group-marker/);
  assert.match(r.stdout, /\[2\/3\] Module tests: modules\/\*\/test\/\*\.test\.js/);
  assert.match(r.stdout, /ok \d+ - module-group-marker/, "the module group still ran");
  assert.match(r.stdout, /\[3\/3\] Serial: test\/office-convert\.test\.js \(run alone\)/);
  const mod = r.stdout.slice(r.stdout.indexOf("[2/3]"), r.stdout.indexOf("[3/3]"));
  const alone = r.stdout.slice(r.stdout.indexOf("[3/3]"));
  assert.doesNotMatch(mod, /scale-smoke-marker/, "the scale smoke is not part of the parallel module run");
  assert.match(alone, /ok \d+ - scale-smoke-marker/, "it runs in its own step");
  assert.doesNotMatch(r.stdout.slice(r.stdout.indexOf("[1/3]"), r.stdout.indexOf("[2/3]")), /scale-smoke-marker/, "office-convert is not part of the parallel TMS run");
  assert.match(r.stdout, /Some tests FAILED - tms tests exit code 1, module tests exit code 0, serial exit code 0\./);
  // 规模冒烟失败：退出码 1
  fs.writeFileSync(path.join(dir, "test", "a.test.js"), unit("tms-group-marker", true));
  fs.writeFileSync(scale, unit("scale-smoke-marker", false));
  r = run();
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /serial exit code 1\./);
  fs.writeFileSync(scale, unit("scale-smoke-marker", true));
  // 第一组通过、第二组失败：退出码 1
  fs.writeFileSync(path.join(dir, "test", "a.test.js"), unit("tms-group-marker", true));
  fs.writeFileSync(path.join(dir, "modules", "m1", "test", "b.test.js"), unit("module-group-marker", false));
  r = run();
  assert.equal(r.status, 1, r.stdout + r.stderr);
  // 全部通过：退出码 0
  fs.writeFileSync(path.join(dir, "modules", "m1", "test", "b.test.js"), unit("module-group-marker", true));
  r = run();
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /All tests passed\./);
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  assert.equal(pkg.scripts.test, "node scripts/run-tests.js");
});

test("test.bat runs the same steps as npm test (scripts/run-tests.js) and derives its exit code from it (0 = all passed, 1 = a failure) instead of always 0", { skip: process.platform !== "win32" && "cmd.exe only" }, () => {
  const src = fs.readFileSync(path.join(ROOT, "test.bat"), "utf8");
  assert.match(src, /\r\nexit \/b %RC%\r\n$/, "the script ends with exit /b %RC%");
  const lines = src.split("\r\n");
  const runLine = /^"%~dp0runtime\\node\.exe" "%~dp0scripts\\run-tests\.js"$/;
  assert.equal(lines.filter((l) => runLine.test(l)).length, 1, "one call into run-tests.js");
  assert.equal(lines.filter((l) => /--test /.test(l)).length, 0, "no second copy of the steps in the batch file");
  const dir = tempDir("ops-testbat-");
  const variant = (code) => {
    const out = lines.map((l) => (runLine.test(l) ? `cmd /c exit ${code}` : l)).join("\r\n");
    const f = path.join(dir, `t${code}.bat`);
    fs.writeFileSync(f, out);
    return f;
  };
  for (const [code, want, text] of [[0, 0, /All tests passed\./], [1, 1, /Some tests FAILED/], [3, 1, /Some tests FAILED/]]) {
    const r = spawnSync("cmd.exe", ["/d", "/c", variant(code)], { cwd: dir, input: "", encoding: "utf8", timeout: 60000 });
    assert.equal(r.status, want, `run-tests exit ${code}: ${r.stdout}`);
    assert.match(r.stdout, text);
  }
});

test("backup.js --prune keeps the newest 3 module pre-migration snapshots (pre-migration-vmodules-…) and lists only the older ones", () => {
  const dir = tempDir("ops-backup-");
  fs.mkdirSync(path.join(dir, "scripts"));
  fs.copyFileSync(path.join(ROOT, "scripts", "backup.js"), path.join(dir, "scripts", "backup.js"));
  const dbPath = path.join(dir, "lms.db");
  const db = new DatabaseSync(dbPath);
  db.exec("CREATE TABLE t (x INTEGER); INSERT INTO t VALUES (1);");
  db.close();
  const B = path.join(dir, "backups");
  fs.mkdirSync(B);
  const DAY = 86400000;
  const put = (name, ageDays) => { const f = path.join(B, name); fs.writeFileSync(f, "x"); const t = new Date(Date.now() - ageDays * DAY); fs.utimesSync(f, t, t); };
  put("lms-20260101-090000-pre-migration-v47-48-49-50.db", 60);
  put("lms-20260101-090001-pre-migration-v51-52.db", 60);
  put("lms-20250901-090000-pre-migration-vmodules-culture-0001.db", 70);
  put("lms-20250911-090000-pre-migration-vmodules-culture-0002.db", 60);
  put("lms-20250921-090000-pre-migration-vmodules-culture-0003.db", 50);
  put("lms-20251001-090000-pre-migration-vmodules-culture-0004.db", 40);
  put("lms-20251011-090000-pre-migration-vmodules-culture-0005.db", 30);
  put("lms-20250801-090000.db", 90);
  const r = spawnSync(process.execPath, [path.join(dir, "scripts", "backup.js"), "--prune"], {
    cwd: dir, encoding: "utf8", timeout: 60000,
    env: { ...cleanEnv(), LMS_DB_PATH: dbPath, LMS_ATTACH_DIR: path.join(dir, "no-attachments") },
  });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const listed = r.stdout.split(/\r?\n/).filter((l) => l.startsWith("  - ")).map((l) => l.slice(4).trim()).sort();
  assert.deepEqual(listed, [
    "lms-20250801-090000.db",
    "lms-20250901-090000-pre-migration-vmodules-culture-0001.db",
    "lms-20250911-090000-pre-migration-vmodules-culture-0002.db",
  ]);
  assert.match(r.stdout, /加 --yes 才会真的删除/);
  assert.equal(fs.readdirSync(B).length, 9, "nothing deleted without --yes (8 old files + today's backup)");
});
