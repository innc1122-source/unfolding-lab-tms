/*
 * 打交接包：把「同事解压就能跑」的东西装进一个 zip，把不该跟着走的东西挡在外面。
 *
 *   runtime\node.exe scripts\package-handover.js              带便携版 Node（解压即可运行）
 *   runtime\node.exe scripts\package-handover.js --no-runtime  不带（对方自己装 Node 22+）
 *
 * 用 Windows 自带的 tar.exe（bsdtar，Win10+）压缩，不引入任何依赖。
 * 不用 PowerShell 的 Compress-Archive：它在 PowerShell 5.1 下把条目名写成反斜杠
 * （web\src\App.jsx），不合 ZIP 规范 —— Windows 能开，Linux 上解出来是一堆带反斜杠的
 * 平铺文件名。交接包必须在对方的任何环境里都能正常展开。
 *
 * 排除清单不是按体积排的，是按「跟着走会出事」排的：
 *   backups/          里面有 lms-2026xxxx-REAL-ROSTER-*.db —— 3,419 名真实员工的完整档案。
 *                     交接包是会被转发的东西，真名单不能在里面。这是隐私要求，不是体积问题。
 *   lms.db / -wal/-shm 数据库本身单独交付（IT 文档里有还原步骤），不塞进压缩包，
 *                     免得有人拿到一份过期数据当生产库用。
 *   config.json       含 AI key 等密钥。只给模板 config.json.example。
 *   data/attachments  员工上传的附件，属于业务数据。
 *   web/node_modules  241MB，且只在重新构建前端时需要（npm install 可重建）。
 *   .git              历史里有真名单时代的提交。
 *   docs/HANDOVER-EMAIL.md  那是发件人自己用的草稿，收件人不需要看到。
 *   smoke-report.json / dist-handover  跑出来的产物。
 *   scripts/go-online.sh 与 stop-online.sh
 *                     一键把服务挂到 lms.unfolding-lab.com —— 另一个项目的公网域名。
 *                     双击一下就把装着员工档案的系统发布到了公网上。包里最危险的文件。
 *   scripts/wipe-to-clean.js 等  破坏性清库脚本（只留 ADMIN / 清演示数据）。SSC 手上不该有。
 *   scripts/seed-demo.js 等      造演示数据；seed-demo 用固定弱口令 learn1234 批量建号。
 *   start.bat         不设环境变量 → 端口 8765（文档写 8767），且空库首启会造出
 *                     DEMO-ADMIN/manage2026 这个管理员账号。只留 start-tms.bat 一条路。
 *   ONLINE-TEST.md    整篇讲旧项目的线上环境，并且写着它的口令。
 */
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const OUT_DIR = path.join(ROOT, "dist-handover");
const WITH_RUNTIME = !process.argv.includes("--no-runtime");

// 必须是 Windows 自带的 bsdtar（System32\tar.exe）。不能写成 "tar" 让 PATH 决定：
// 在 Git Bash 里排在前面的是 Git 自带的 GNU tar，它不支持 --format zip，而 -a 遇到
// .zip 会静默退化成一个不压缩的普通 tar —— 产出一个「叫 .zip 的 tar」，对方双击打不开。
const TAR = (() => {
  const sys = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe");
  if (fs.existsSync(sys)) return sys;
  console.log("  · 找不到 System32\\tar.exe，退回 PATH 里的 tar —— 若产出不是 zip 会被自检拦下");
  return "tar";
})();

// scripts/ 不整个收：里面混着破坏性脚本、造演示数据的脚本，和一个会把服务发布到
// 另一个项目公网域名的 go-online.sh（理由见文件头）。只收「运维真的要用」的那几个。
const SHIPPED_SCRIPTS = [
  "scripts/backup.js",                     // 备份（VACUUM INTO；--prune 按保留策略列出可清理的）
  "scripts/notify-due.js",                 // 逾期提醒定时任务
  "scripts/convert-office-attachments.js", // 存量 office 附件转 PDF（一次性迁移）
  "scripts/reset-for-uat.js",              // UAT 前重置 —— **破坏性**，HANDOVER-IT 里有警告
  "scripts/smoke.js", "scripts/smoke-checks.js",
  "scripts/smoke-routes.js", "scripts/smoke-selftest.js",
  "scripts/package-handover.js",           // 让对方以后能自己重打一个包
  "scripts/run-tests.js",                  // npm test 与 test.bat 的入口：三步先后跑（TMS、模块、规模冒烟单独），合并退出码
  "scripts/ai-check.js",                   // AI 连通性检查（HANDOVER-IT §10.5 第 4 步；--service 读服务环境变量）
  "scripts/make-demo-db.js",               // 演示库生成（start-demo.bat 第一次运行时调用）
  "scripts/demo-enrich.js",                // 演示库补数据：经接口跑 v2 绩效、申诉、组织绩效、发展项目等（make-demo-db.js 调用）
  "scripts/samples",                       // 附件上传的样例文件，test/ 依赖它们
];
// 白名单式：只有列出来的才进包。黑名单容易漏（新加一个含密钥的文件就跟着走了）。
const INCLUDE = [
  "server.js", "store.js", "notify.js", "content.js", "package.json",
  // M0 模块化：server.js 启动时从 kernel/registry.js 加载 modules/*/manifest.js 生成路由与
  // 权限表 —— 缺了这两个目录，解压后的服务直接拒绝启动。
  "kernel", "modules",
  "README.md", "config.json.example", "config.demo.json",
  "start-tms.bat", "start-demo.bat", "backup.bat", "test.bat", "smoke.bat",
  ...SHIPPED_SCRIPTS, "test",
  // 文档只带接手的人要读的六份（负责人 10/10「不需要的旧的都清理下」）。需求单、方案、QA 记录、会话交接等开发过程文档
  // 留在源码仓库的 docs/，不随包 —— 测试都不读文档（只在注释里提到），去掉不影响 test.bat。
  "docs/GO-LIVE-CHECKLIST.md", "docs/HANDOVER-OVERVIEW.md", "docs/HANDOVER-SSC.md", "docs/HANDOVER-IT.md",
  "docs/HANDOVER-STATUS.md", "docs/BASELINE.md", "docs/EMPLOYEE-QUICKSTART.md",
  "web/src", "web/index.html", "web/vite.config.js", "web/package.json",
  // web/public：vite 的 publicDir，构建时原样拷进 public/dist（导入模板 templates/*.xlsx 的源文件）；
  // web/scripts：生成题库导入模板的脚本（question-template.mjs）。缺了它们，重新构建会丢模板。
  "web/public", "web/scripts",
  "public/dist", "public/vendor", "public/assets",
];
const EXCLUDE_PATHS = new Set(["docs/HANDOVER-EMAIL.md"]);   // 目录整体收入时仍排除的路径（docs 现在按文件列，这条留作保险）

// START-HERE.txt 里要报的两个数字，现算出来。require 冒烟路由清单是安全的：
// 那个模块只是导出数据，不启动任何东西。
const TEST_FILES = (() => {
  try { return fs.readdirSync(path.join(ROOT, "test")).filter((f) => f.endsWith(".test.js")).length; }
  catch { return "?"; }
})();
// 模块自带的测试（modules/<id>/test/*.test.js，目前只有 culture）随 modules/ 整目录进包，test.bat 第二步跑它们。
const MODULE_TEST_FILES = (() => {
  try {
    let n = 0;
    for (const id of fs.readdirSync(path.join(ROOT, "modules"))) {
      const dir = path.join(ROOT, "modules", id, "test");
      if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) n += fs.readdirSync(dir).filter((f) => f.endsWith(".test.js")).length;
    }
    return n;
  } catch { return "?"; }
})();
const SMOKE_CASES = (() => {
  try { return require(path.join(ROOT, "scripts", "smoke-routes.js")).ROUTES.length; }
  catch { return "?"; }
})();

const stamp = (() => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
})();
const stage = path.join(OUT_DIR, `unfolding-lab-tms-handover-${stamp}`);
const zip = `${stage}.zip`;

function copyInto(rel) {
  const src = path.join(ROOT, rel);
  if (!fs.existsSync(src)) { console.log(`  · 跳过（不存在）: ${rel}`); return 0; }
  const dest = path.join(stage, rel);
  const st = fs.statSync(src);
  if (st.isDirectory()) {
    let n = 0;
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src)) {
      const childRel = `${rel}/${entry}`;
      if (EXCLUDE_PATHS.has(childRel)) { console.log(`  · 排除: ${childRel}`); continue; }
      n += copyInto(childRel);
    }
    return n;
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
  return 1;
}

function dirSize(p) {
  let total = 0;
  for (const e of fs.readdirSync(p, { withFileTypes: true })) {
    const full = path.join(p, e.name);
    total += e.isDirectory() ? dirSize(full) : fs.statSync(full).size;
  }
  return total;
}

console.log(`交接包 → ${zip}\n`);
fs.rmSync(OUT_DIR, { recursive: true, force: true });
fs.mkdirSync(stage, { recursive: true });

let files = 0;
for (const rel of INCLUDE) files += copyInto(rel);
if (WITH_RUNTIME) {
  console.log("  · 带上 runtime/（便携版 Node，解压即可运行）");
  files += copyInto("runtime");
} else {
  console.log("  · --no-runtime：不带便携版 Node，对方需要自备 Node 22+");
}

// 收件人第一眼看到的东西
// 文件名用 ASCII：zip 对非 ASCII 条目名没有统一编码，不同解压工具下会乱码，
// 而这恰好是收件人第一个要打开的文件。内容仍然是中文。
fs.writeFileSync(path.join(stage, "START-HERE.txt"), [
  "其间 Unfolding Lab 人才管理系统（TMS）交接包",
  "",
  "（这份说明的文件名用英文，是因为压缩包里的中文文件名在某些解压工具下会乱码。）",
  "",
  "先看演示：双击 start-demo.bat（第一次运行会自动生成 100 名虚构员工的演示数据，约 30 秒）",
  "  浏览器打开 http://localhost:8790",
  "  全功能测试账号 UL-TEST / Demo1234：前台全部功能都有数据，同时是后台超级管理员（「进入后台」）",
  "  另有：管理员 ADMIN / unfolding888；员工工号 UL-1001～UL-1100，密码 Demo1234",
  "  主角三人：UL-1032 绩优、UL-1053 新人、UL-1065 待改进",
  "",
  "正式使用：双击 start-tms.bat（空库，只有 ADMIN），浏览器打开 http://localhost:8780",
  "  正式环境请先照 config.json.example 建 config.json（production: true，首次启动会随机生成 ADMIN 密码并打印在窗口里）。",
  "",
  "文档在 docs/ 目录（先读 HANDOVER-OVERVIEW.md）：",
  "  HANDOVER-OVERVIEW.md 交接总览：这个版本是什么、包里有什么、怎么开始",
  "  GO-LIVE-CHECKLIST.md 上线清单：部署、配置、导入人员与课程、验收",
  "  HANDOVER-IT.md      给 IT：部署、配置、备份恢复、升级回滚、安全、接入 AI",
  "  HANDOVER-SSC.md     给 HR 运营：按日常工作组织的操作说明",
  "  HANDOVER-STATUS.md  版本说明：本版本相对来源版本的改动",
  "  EMPLOYEE-QUICKSTART.md  员工快速上手（中英）",
  "",
  "包里**没有**数据库和 config.json：",
  "  · 数据库：首次启动自建；演示库由 start-demo.bat 生成在 data/demo-unfolding.db。",
  "  · config.json 含密钥（AI key、邮件密码），请照 config.json.example 自己建。",
  "",
  // 数字现算，不写死：改了代码就过期了 —— 而这是收件人读到的第一份说明。
  `两个自检工具：test.bat（${TEST_FILES} 个测试文件；分两步先后跑，计时用例单独一步）、smoke.bat（${SMOKE_CASES} 条用例逐页体检，中英各跑一遍）。`,
  "",
  "服务器建议安装两个外部组件（不随包，见 HANDOVER-IT.md 2.6 / 2.7）：",
  "  · LibreOffice —— PPT / Word / Excel 课件转 PDF；没装时这三类上传被拒。",
  "  · ffmpeg      —— PPT 内嵌视频转网页可播放的 MP4；没装时课件照常上传，视频等转码。",
  "",].join("\r\n"));
files += 1;

const rawSize = dirSize(stage);
console.log(`\n暂存 ${files} 个文件，${(rawSize / 1048576).toFixed(1)} MB，正在压缩…`);

// -a 按扩展名自动选压缩格式（.zip → deflate）。zip 里保留一层顶层目录，
// 解压不会把文件喷进对方的下载目录。
// 注意全部用**相对**路径 + cwd：bsdtar 会把 "C:..." 里的冒号当成 host:path 远程地址，
// 直接报 "Cannot connect to C: resolve failed"。
fs.rmSync(zip, { force: true });
const zipName = path.basename(zip);
// --format zip 必须显式写：只给 -a 的话 bsdtar 只按扩展名挑压缩方式、不换归档格式，
// 产出的是一个**叫 .zip 的 tar**（偏移 257 有 ustar、没有 PK 头）—— 对方双击打不开，
// 而且完全没压缩（90.6MB 进、90.8MB 出）。加上之后：真 PK 头、正斜杠、正常 deflate。
// --options zip:hdrcharset=UTF-8：条目名按 UTF-8 写（并置 UTF-8 标志位）。不写的话 bsdtar 按系统代码页写，
// 中文文件名（docs/第5批-…、HANDOFF-TMS开发会话-… 等）在包里变成「????」，两个不同的文件还会撞成同一个名字（2026-10-10 发现）。
execFileSync(TAR, ["--format", "zip", "--options", "zip:hdrcharset=UTF-8", "-c", "-f", zipName, path.basename(stage)], { cwd: OUT_DIR, stdio: "inherit" });

// 条目名自检：直接读 zip 中央目录按 UTF-8 解码（tar -t 的输出走控制台代码页，看不出乱码），
// 暂存目录里的每个文件都必须原名出现在包里，且不能有重名。
const zipEntryNames = (() => {
  try {
  const buf = fs.readFileSync(zip);
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) return null;
  let total = buf.readUInt16LE(eocd + 10), off = buf.readUInt32LE(eocd + 16);
  // ZIP64：条目数或偏移溢出时从 ZIP64 EOCD 读
  if (total === 0xffff || off === 0xffffffff) {
    const loc = eocd - 20;
    if (loc >= 0 && buf.readUInt32LE(loc) === 0x07064b50) {
      const z64 = Number(buf.readBigUInt64LE(loc + 8));
      total = Number(buf.readBigUInt64LE(z64 + 32)); off = Number(buf.readBigUInt64LE(z64 + 48));
    }
  }
  const names = [];
  for (let k = 0; k < total; k++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) return null;
    const flags = buf.readUInt16LE(off + 8);
    const nl = buf.readUInt16LE(off + 28), el = buf.readUInt16LE(off + 30), cl = buf.readUInt16LE(off + 32);
    const raw = buf.subarray(off + 46, off + 46 + nl);
    // 代码审查 10/11：名字里有非 ASCII 字节时必须置 UTF-8 标志位（bit 11），否则 Windows 资源管理器按代码页解码仍会乱码
    if (raw.some((x) => x > 0x7f) && !(flags & 0x800)) return null;
    names.push(raw.toString("utf8"));
    off += 46 + nl + el + cl;
  }
  return names;
  } catch { return null; }   // 中央目录读不通（截断 / 越界）：当作自检不过，下面删包退出
})();
{
  const staged = [];
  const walk = (dir, rel) => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const r = rel + "/" + e.name; if (e.isDirectory()) walk(path.join(dir, e.name), r); else staged.push(r); } };
  walk(stage, path.basename(stage));
  const inZip = new Set(zipEntryNames || []);
  const missing = zipEntryNames ? staged.filter((n) => !inZip.has(n)) : staged;
  const dup = zipEntryNames ? zipEntryNames.length - inZip.size : 0;
  if (!zipEntryNames || missing.length || dup) {
    console.error(`!! 条目名不对（中文名乱码或重名）：${missing.length} 个文件在包里找不到原名，重名 ${dup} 个，已删除压缩包：`);
    for (const n of missing.slice(0, 10)) console.error("   " + n);
    fs.rmSync(zip, { force: true });
    process.exit(1);
  }
  console.log(`条目名自检：${staged.length} 个文件全部按原名（UTF-8）在包里`);
}

// 出包自检，双向：既拦不该有的，也确认该有的真在。
// （只拦不该有的是不够的 —— 一次分隔符写错就能让检查全部「通过」而包其实是空的。）
const listed = execFileSync(TAR, ["-t", "-f", zipName], { cwd: OUT_DIR, encoding: "utf8" })
  .split(/\r?\n/).map((s) => s.trim().replace(/\\/g, "/")).filter(Boolean);
console.log(`\n包内 ${listed.length} 个条目`);

// 先确认它真的是个 zip。上一版这里只用 tar -t 列内容 —— tar 读自己产的 tar 当然读得通，
// 于是自检「通过」而交付物是个打不开的文件。扩展名不是证据，文件头才是。
const head = Buffer.alloc(4);
const headFd = fs.openSync(zip, "r");
fs.readSync(headFd, head, 0, 4, 0);
fs.closeSync(headFd);
if (!(head[0] === 0x50 && head[1] === 0x4b)) {
  console.error(`!! 产出的不是 zip（文件头 ${head.toString("hex")}），已删除。`);
  fs.rmSync(zip, { force: true });
  process.exit(1);
}

// 备份/临时文件要单独一条：白名单是按**目录**收的（web/src、scripts、docs 整个进包），
// 目录里新长出来的文件没人再看一眼就跟着走了 —— 就地改名的备份
// （app.css.backup-20260817-142001）、编辑器留下的 *~、合并冲突残留的 *.orig / *.rej、
// 误建在子目录里的 node_modules。这些既不是 .db 也不是 config.json，下面那条原来的
// 规则一条都拦不住；而收件人解开包看到两份同名代码，分不清哪份是活的。
const JUNK = /\.backup|\.bak$|\.orig$|\.rej$|~$/i;
// 兜底：即使哪天有人把白名单改回粗粒度，这些也必须被拦下。每一条都是「跟着走会出事」，
// 不是体积问题 —— 理由逐条写在文件头。
const NEVER_SHIP = [
  /\.db($|-)/i,                        // 任何数据库文件（含 -wal / -shm）
  /(^|\/)config\.json$/i,              // 密钥
  /(^|\/)backups\//i,                  // 真名单历史备份
  /(^|\/)(go|stop)-online\.sh$/i,      // 会把服务发布到另一个项目的公网域名
  /(^|\/)(wipe-to-clean|clean-keep-admins|demo-cleanup|archive-junk)\.js$/i, // 破坏性
  /(^|\/)(seed-demo|seed-media|seed-catalog|reseed-onboarding)\.js$/i, // 造演示数据。make-demo-db 例外：Unfolding Lab 版随包交付给 start-demo.bat，它在正式模式下拒绝运行
  /(^|\/)(fix-section-fields|backfill-email)\.js$/i,                        // 跑完的一次性修补
  /(^|\/)start\.bat$/i,                // 8765 + 空库首启会造 DEMO-ADMIN
  /(^|\/)ONLINE-TEST\.md$/i,           // 旧项目线上环境，含其口令
];
// node_modules 单独判，而且要放过 runtime/：官方的 node-vXX-win-x64.zip 自带
// node_modules/npm/**，那是便携版 Node 的合法内容。一条通吃的规则会在有人照 IT 文档
// 刷新 runtime/ 之后，让一次完全正常的打包失败并删掉产物，报错还指向没问题的地方。
// 真正要拦的只有 web/node_modules（241MB，npm install 可重建）和误建在子目录里的。
const relOf = (n) => n.replace(/^[^/]+\//, "");
const isJunk = (n) => {
  const r = relOf(n);
  if (JUNK.test(r)) return true;
  return /(^|\/)node_modules(\/|$)/i.test(r) && !r.startsWith("runtime/");
};
const forbidden = listed.filter((n) => NEVER_SHIP.some((rx) => rx.test(n)) || isJunk(n));
if (forbidden.length) {
  console.error("!! 包里出现了不该有的东西，已删除压缩包：");
  for (const f of forbidden.slice(0, 10)) console.error("   " + f);
  fs.rmSync(zip, { force: true });
  process.exit(1);
}

// 必须在的东西：一个都不在就说明打包逻辑坏了（比打出一个含密钥的包更容易被忽略）。
const MUST = [
  "server.js", "store.js", "notify.js", "README.md", "config.json.example", "config.demo.json", "start-tms.bat", "test.bat",
  // 交接文档（2026-10-10）：START-HERE 列出的五份，缺了对方就不知道从哪开始
  "docs/GO-LIVE-CHECKLIST.md", "docs/HANDOVER-OVERVIEW.md", "docs/HANDOVER-IT.md", "docs/HANDOVER-SSC.md", "docs/HANDOVER-STATUS.md",
  "docs/EMPLOYEE-QUICKSTART.md",
  "scripts/run-tests.js",   // package.json 的 "test" 指向它
  // 内核：注册表、事件总线、定时任务调度、模块宿主（模块迁移、services、路由分发、静态挂载）——
  // server.js 启动时全部 require，缺一个服务就起不来。
  "kernel/registry.js", "kernel/events.js", "kernel/jobs.js", "kernel/module-host.js",
  "modules/index.js", "modules/core/manifest.js", "modules/core/org.js", "modules/core/hooks.js",
  // 简化 10/11：server.js 抽出的纯函数（启动时 require）
  "modules/core/dates.js", "modules/core/http-util.js", "modules/core/text-util.js",
  // 简化 10/11：handleApi 的接口处理按模块拆出（server.js 启动时 require）
  "modules/core/routes.js", "modules/learning/routes.js", "modules/performance/routes.js", "modules/talent/routes.js",
  "modules/learning/manifest.js", "modules/performance/manifest.js", "modules/talent/manifest.js",
  // 培训完成口径（programDone）与提醒资格：server.js 与 scripts/notify-due.js 启动即 require（2026-10-07）
  "modules/learning/completion.js",
  // 课件转换引擎（P0 1.3 / 1.4，2026-10-07）：server.js 与 scripts/convert-office-attachments.js 启动即 require；
  // 测试替身 fake-soffice.js 给转换相关测试用（本机不装 LibreOffice 也能跑）
  "modules/learning/office-convert.js", "test/fixtures/fake-soffice.js",
  // 第三批（2026-10-08）：PPT 内嵌视频（pptx-media.js 解析、video-transcode.js 转码，findFfmpeg 是 ffmpeg 的唯一探测实现）、
  // 培训概览指标引擎与课程类别目录（服务端与前端各一份，test/course-categories 核对）——server.js 启动即 require；
  // 测试替身 fake-ffmpeg.js / make-pptx.js 让本机不装 ffmpeg 也能跑转码测试。
  "modules/learning/pptx-media.js", "modules/learning/video-transcode.js",
  "modules/learning/training-stats.js", "modules/learning/categories.js", "web/src/categories.js",
  "test/fixtures/fake-ffmpeg.js", "test/fixtures/make-pptx.js",
  // 第四批（2026-10-09）：题型引擎（10 种题型各一个文件 + 注册表 / 规格 / 工具；server.js 启动即 require index.js，
  // 缺任一题型文件注册表就加载失败）与公开课程规则（public-courses.js，server.js 启动即 require）；
  // 前端规格副本 web/src/qtypes/spec.js 与旧口径夹具 qtypes-legacy.js 是 qtypes-spec-parity / qtypes-legacy-parity 的比对对象。
  "modules/learning/qtypes/index.js", "modules/learning/qtypes/spec.js", "modules/learning/qtypes/util.js",
  ...["mcq", "multi", "fill", "open", "ordering", "matching", "case", "classify", "tf", "cloze"].map((t) => `modules/learning/qtypes/${t}.js`),
  "modules/learning/public-courses.js",
  // 第 5 批（1.50）：人才筛选纯函数库与 AI 条件生成，server.js / store.js 启动即 require
  "modules/talent/filter-model.js",
  "modules/talent/filter-engine.js",
  "modules/talent/succession-import.js",
  "modules/talent/review-scope.js",   // F60：人才盘点页面人群范围（server.js 启动即 require）
  "modules/ai/talent-filter.js",
  "web/src/qtypes/spec.js", "web/src/qtypes/model.js", "test/fixtures/qtypes-legacy.js",
  // AI 辅助（ai）：server.js 启动时 require 服务与功能文件，缺一个服务就起不来（AI 治理方案 2.1.2、附录）
  "modules/ai/manifest.js", "modules/ai/provider.js", "modules/ai/redact.js", "modules/ai/injection.js", "modules/ai/schema.js",
  "modules/ai/prompts.js", "modules/ai/limits.js", "modules/ai/readiness.js", "modules/ai/service.js", "modules/ai/features.js",
  "scripts/ai-check.js", "test/fixtures/fake-ai-server.js",
  // 人员同步代码（modules/core/larksync.js）仍由 server.js 启动时 require；本版本不配置、不运行它（见 HANDOVER-STATUS.md）
  "modules/core/larksync.js", "test/lark-sync.test.js",
  // Unfolding Lab 版（2026-10-12）：行为实践（culture / 3+3）模块已删除，不再列必需文件
  "START-HERE.txt", "scripts/smoke.js", "web/src/App.jsx", "web/src/profileTabs.js",
  "web/vite.config.js", "start-demo.bat", "config.demo.json", "scripts/make-demo-db.js", "scripts/demo-enrich.js",
  "public/dist/index.html", "public/vendor/pdfjs/pdf.min.js",
];
const rel = new Set(listed.map(relOf));
const missing = MUST.filter((m) => !rel.has(m));
if (missing.length) {
  console.error("!! 包里缺少必需文件，已删除压缩包：");
  for (const m of missing) console.error("   " + m);
  fs.rmSync(zip, { force: true });
  process.exit(1);
}

// ffmpeg 探测（第三批 5.7）：包里的 video-transcode.js 必须能加载并导出唯一的探测函数 findFfmpeg ——
// server.js、scripts/convert-office-attachments.js 与测试都靠它找 ffmpeg，加载失败服务就起不来。
// 顺带报告打包这台机器上找不找得到 ffmpeg（只是提示：ffmpeg 不随包，目标服务器另装，HANDOVER-IT 2.7）。
const ffmpegCheck = (() => {
  try {
    const vt = require(path.join(stage, "modules", "learning", "video-transcode.js"));
    if (typeof vt.findFfmpeg !== "function") return { ok: false, msg: "video-transcode.js 没有导出 findFfmpeg" };
    let here = null;
    try { here = vt.findFfmpeg({ env: process.env }); } catch { here = null; }
    const p = here && typeof here === "object" ? here.path : here;
    return { ok: true, msg: p ? `打包机上找到 ffmpeg：${p}` : "打包机上没找到 ffmpeg（不影响打包；目标服务器按 HANDOVER-IT 2.7 安装）" };
  } catch (e) { return { ok: false, msg: `无法加载包内的 video-transcode.js：${e.message}` }; }
})();
if (!ffmpegCheck.ok) {
  console.error("!! " + ffmpegCheck.msg + "，已删除压缩包");
  fs.rmSync(zip, { force: true });
  process.exit(1);
}
console.log("  · " + ffmpegCheck.msg);

// 模块的服务端内容（culture 的 content/3plus3-content.json 含测评答案与解析）必须随包 —— 服务端要读它 ——
// 但不能落在任何静态挂载目录里，否则 /culture/… 能直接把答案下载走。按**包里那份**注册表核对：
// 加载暂存目录里的 kernel/registry.js（它按自己旁边的 modules/ 读 manifest），逐个静态挂载目录检查包内条目：
// 挂载目录里不许有 content/ 路径段，也不许有 .json（学员端内容一律经接口下发，CONTRACT.md 9.1）。
const exposed = (() => {
  let mounts;
  try { mounts = require(path.join(stage, "kernel", "registry.js")).load().STATIC_MOUNTS || []; }
  catch (e) { return [`（无法加载包内的注册表：${e.message}）`]; }
  const bad = [];
  for (const m of mounts) {
    if (!m || typeof m.dir !== "string") continue;
    const mountRel = path.relative(stage, m.dir).split(path.sep).join("/");
    if (!mountRel || mountRel.startsWith("..")) { bad.push(`挂载目录不在包内：${m.prefix} → ${m.dir}`); continue; }
    for (const r of rel) {
      if (!r.startsWith(mountRel + "/")) continue;
      const inner = r.slice(mountRel.length + 1);
      if (/(^|\/)content(\/|$)/i.test(inner) || /\.json$/i.test(inner)) bad.push(`${m.prefix}/${inner}（${r}）`);
    }
  }
  return bad;
})();
if (exposed.length) {
  console.error("!! 静态挂载目录里出现了不该经网址访问的文件（内容 JSON / content 目录），已删除压缩包：");
  for (const f of exposed.slice(0, 10)) console.error("   " + f);
  fs.rmSync(zip, { force: true });
  process.exit(1);
}
const slashOk = !listed.some((n) => n.includes("\\"));
console.log(`自检通过：真 zip（PK 头）· 无 .db / 无 config.json / 无 backups/ · 无备份与临时文件 · ${MUST.length} 个必需文件都在 · 模块内容不在静态挂载目录里 · 条目名用正斜杠 ${slashOk ? "是" : "否"}`);

fs.rmSync(stage, { recursive: true, force: true }); // 只留 zip

// 自动归档：本脚本开头会整个清掉 dist-handover/ 再重建，所以上一版 zip 在每次重打包时
// 都会消失 —— 2026-08-20 那一版就是这么没的（交接对象没存,发件方也找不回,两头落空）。
// backups/ 不在打包白名单里、也从不被本脚本清理,归档放这儿既安全又不会跟着进包。
// 同名（同日重打）直接覆盖：一天内的最后一版才是当天的定版。
const ARCHIVE_DIR = path.join(ROOT, "backups", "handover-archive");
fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
fs.copyFileSync(zip, path.join(ARCHIVE_DIR, path.basename(zip)));
console.log(`已归档一份 → backups\\handover-archive\\${path.basename(zip)}`);

const zipSize = fs.statSync(zip).size;
console.log(`\n完成：${zip}`);
console.log(`      ${(zipSize / 1048576).toFixed(1)} MB${WITH_RUNTIME ? "（含便携版 Node）" : "（不含 Node）"}`);
console.log(`\n不在包里：config.json（密钥，照模板自建）。生产库首次启动自建；演示库由 start-demo.bat 生成。`);
