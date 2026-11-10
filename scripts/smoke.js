/*
 * 冒烟脚本：把「逐页点一遍」里机器能做的部分自动化。
 *
 * 必须显式指定跑哪个服务（第二批 3.2 起不再默认连 8767 —— 那是负责人在用的服务，
 * 每跑一次都会写登录会话和登录审计）：
 *
 *   runtime\node.exe scripts\smoke.js --boot                       起一次性服务（全新库 + v2 夹具），跑完即删
 *   runtime\node.exe scripts\smoke.js --boot=D:\demo\lms-demo.db    用这个库的「副本」起一次性服务，原文件不动
 *   runtime\node.exe scripts\smoke.js --base=http://127.0.0.1:18080 连一个已经在跑的服务
 *
 * 常用参数：
 *   --lang=both                       中英各跑一遍（默认只跑中文）
 *   --only=admin                      只跑 hash 或名称里含 "admin" 的路由
 *   --include-side-effects            连会写数据的路由一起跑（--boot 时放心开）
 *   --headful                         想亲眼看它点的时候
 *   --json=out.json                   明细写成 JSON（基线比对、归并都用它）
 *   --timeout=12000                   每条路由等 ready 的毫秒数
 *
 * 版面检查（第二批 3.2）：
 *   --layout                          加跑版面检查（smoke-checks.js 的 layoutChecks，先等字体加载完）
 *   --viewport=1440x900,390x844       逐个视口跑；宽 <768 按手机模拟（mobile:true）
 *   --as=admin,employee,hod           逐个账号跑（账号表见下）；缺省 admin,employee。--boot 的 v2 夹具提供
 *                                     employee（有下属的上级 SMK-1002）、staff（普通员工 SMK-1003）、hod（SMK-1001）
 *   --shots=<目录>                    每条路由 × 语言 × 视口 × 账号截一张整页图，版面命中的元素加红框
 *   --baseline=<上次的 json>          只报与上次相比新增的问题；有新增即退出码 1
 *   --seed=v2|none                    --boot 时种不种 v2 夹具（全新库缺省 v2，库副本缺省 none）
 *   --accounts=<json 文件>            账号表，覆盖缺省值：{"hod":{"employeeId":"DP-1002","password":"Demo1234"}}
 *                                     side 缺省按名字推断（admin、*-admin 为 console，其余为 employee）；
 *                                     也可以用环境变量 SMOKE_ACCOUNTS 传同样的 JSON
 *   --live-ok                         明确同意连负责人或 QA 的常驻端口（8767/8812/5173/8797/8931）
 *
 *   基线示例（演示库 + 中英 × 两种宽度 × 三种身份）：
 *     runtime\node.exe scripts\smoke.js --boot=D:\demo\lms-demo.db --seed=v2 --layout --lang=both ^
 *       --viewport=1440x900,390x844 --as=admin,employee,hod --shots=D:\demo\shots --json=D:\demo\layout.json
 *
 * 为什么要有它：过去三批人工发现的 bug 高度同质 —— 错误边界白屏、渲染出字面 "null"、
 * 中文界面冒出英文串、表格横向溢出。这四类全都能被机器逮住，人就可以只看版面与措辞。
 * --layout 把版面里机器能量的那部分（溢出、居中、行宽、留白、卡片嵌套）也接了过来。
 *
 * 为什么是 CDP 而不是 Playwright：这个项目是零依赖的（运行时只有自带的 runtime\node.exe），
 * 装一个浏览器自动化框架会破坏这一点。系统自带 Edge + Node 22 内置的 WebSocket 已经够了：
 * --headless=new 起一个临时 profile，说 CDP，跑完删掉。
 */
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const args = process.argv.slice(2);
const flag = (k, d) => {
  const hit = args.find((a) => a === `--${k}` || a.startsWith(`--${k}=`));
  if (!hit) return d;
  return hit.includes("=") ? hit.slice(k.length + 3) : true;
};
const list = (v) => String(v).split(",").map((x) => x.trim()).filter(Boolean);

const BOOT = flag("boot", false);
let BASE = flag("base", "") === true ? "" : String(flag("base", "")).replace(/\/$/, "");
const LANGS = flag("lang", "zh") === "both" ? ["zh", "en"] : [String(flag("lang", "zh"))];
const ONLY = flag("only", "");
const WITH_SIDE_EFFECTS = !!flag("include-side-effects", false);
const HEADFUL = !!flag("headful", false);
const JSON_OUT = flag("json", "");
const ROUTE_TIMEOUT = Number(flag("timeout", 12000));
const LAYOUT = !!flag("layout", false);
const SHOTS = flag("shots", "");
const BASELINE = flag("baseline", "");
const LIVE_OK = !!flag("live-ok", false);
const AS = list(flag("as", "admin,employee"));
const VIEWPORTS = list(flag("viewport", "1440x900")).map((v) => {
  const m = v.match(/^(\d{3,4})x(\d{3,4})$/);
  if (!m) { console.error(`--viewport 写法不对：${v}（例：1440x900,390x844）`); process.exit(2); }
  return { w: Number(m[1]), h: Number(m[2]), label: v };
});
// 负责人与 QA 的常驻端口：只读跑也会登录（写会话 + 登录审计），/team/:id 还会写一条 manager.view_profile。
const PROTECTED_PORTS = ["8767", "8812", "5173", "8797", "8931"];

const USAGE = [
  "必须指定要跑的服务（不再默认连 8767）：",
  "  runtime\\node.exe scripts\\smoke.js --boot                       一次性服务：全新库 + v2 夹具",
  "  runtime\\node.exe scripts\\smoke.js --boot=<演示库.db>            一次性服务：该库的副本",
  "  runtime\\node.exe scripts\\smoke.js --base=http://127.0.0.1:<端口>  已经在跑的服务",
  "其余参数见脚本开头的注释。",
].join("\n");

/* ---------------- 账号表 ---------------- */
// 缺省值是假数据测试集（lms.db 的 T-xxxxx，密码 Test1234）；--boot 的 v2 夹具、SMOKE_ACCOUNTS、
// --accounts 依次覆盖。密码只在这里用，不写进报告或 JSON。
const DEFAULT_ACCOUNTS = {
  admin: { employeeId: "ADMIN", password: "unfolding888", side: "console" },
  // 假数据测试集里 T-00229 是记录最全的那个（绩效/培训/考试/下属都有）。
  employee: { employeeId: "T-00229", password: "Test1234", side: "employee" },
};
function buildAccounts(fixtureAccounts) {
  const out = JSON.parse(JSON.stringify(DEFAULT_ACCOUNTS));
  const layers = [fixtureAccounts || {}];
  if (process.env.SMOKE_ACCOUNTS) {
    try { layers.push(JSON.parse(process.env.SMOKE_ACCOUNTS)); } catch (e) { console.error(`SMOKE_ACCOUNTS 不是合法 JSON：${e.message}`); process.exit(2); }
  }
  const file = flag("accounts", "");
  if (file) {
    try { layers.push(JSON.parse(fs.readFileSync(path.resolve(String(file)), "utf8"))); } catch (e) { console.error(`读不了 --accounts=${file}：${e.message}`); process.exit(2); }
  }
  for (const layer of layers) {
    for (const [name, a] of Object.entries(layer)) {
      if (!a || !a.employeeId || !a.password) { console.error(`账号 ${name} 缺 employeeId 或 password`); process.exit(2); }
      out[name] = { employeeId: String(a.employeeId), password: String(a.password), side: a.side || (out[name] && out[name].side) || (/(^|-)admin$/.test(name) ? "console" : "employee") };
    }
  }
  return out;
}

/* ---------------- 浏览器 ---------------- */
// 只找系统自带的，不下载任何东西。Edge 在 Windows 上一定存在。
const BROWSERS = [
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  process.env.SMOKE_BROWSER || "",
];
function findBrowser() {
  const hit = BROWSERS.find((p) => p && fs.existsSync(p));
  if (!hit) {
    console.error("找不到 Edge 或 Chrome。装了浏览器但路径不同的话，用 SMOKE_BROWSER 指过来：");
    console.error('  set SMOKE_BROWSER=D:\\path\\to\\msedge.exe');
    process.exit(2);
  }
  return hit;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------- CDP（走 Node 22 内置的 WebSocket，无依赖） ---------------- */
class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.listeners = [];
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(`${msg.error.message} (${msg.error.code})`));
        else resolve(msg.result);
      } else if (msg.method) {
        for (const fn of this.listeners) fn(msg);
      }
    });
  }
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
      ws.addEventListener("open", resolve, { once: true });
      ws.addEventListener("error", () => reject(new Error("WebSocket 连不上 CDP")), { once: true });
    });
    return new Cdp(ws);
  }
  on(fn) { this.listeners.push(fn); }
  send(method, params, sessionId) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params: params || {}, ...(sessionId ? { sessionId } : {}) }));
      // 单条命令卡死不该拖垮整轮，超时就当失败往下走。
      setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(`CDP 超时: ${method}`)); }
      }, 20000);
    });
  }
  close() { try { this.ws.close(); } catch { /* 已经关了 */ } }
}

async function launch() {
  const exe = findBrowser();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "tms-smoke-"));
  const port = 9200 + Math.floor((Date.now() / 1000) % 700); // 避开固定端口，多次运行不互撞
  const child = spawn(exe, [
    ...(HEADFUL ? [] : ["--headless=new"]),
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    "--no-first-run", "--no-default-browser-check", "--disable-gpu",
    "--window-size=1440,900",
    "about:blank",
  ], { stdio: "ignore" });

  let version = null;
  for (let i = 0; i < 60 && !version; i++) {
    await sleep(250);
    try { version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json(); } catch { /* 还没起 */ }
  }
  if (!version) { await stopBrowser(child, profile); throw new Error("浏览器起来了但 CDP 端口没响应"); }

  const cdp = await Cdp.connect(version.webSocketDebuggerUrl);
  const { targetInfos } = await cdp.send("Target.getTargets");
  const page = targetInfos.find((t) => t.type === "page");
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId: page.targetId, flatten: true });
  for (const d of ["Page", "Runtime", "Log", "Network"]) await cdp.send(`${d}.enable`, {}, sessionId);
  return { cdp, sessionId, child, profile, browser: version.Browser };
}

// 关浏览器并删临时 profile：先等进程真正退出（最多 5 秒），再带重试删除 —— 原先 kill 之后立刻删，Edge 还占着文件，
// 删除失败被吞掉，%TEMP% 里每跑一次留下一个 tms-smoke-*（审查）
async function stopBrowser(child, profile) {
  if (child && child.exitCode === null && child.signalCode === null) {
    const gone = new Promise((r) => child.once("exit", r));
    try { child.kill(); } catch { /* 已经退了 */ }
    await Promise.race([gone, sleep(5000)]);
  }
  if (profile) {
    try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 }); } catch { /* 仍被占用：留给系统清理 */ }
  }
}

/* ---------------- 一次性服务（--boot） ---------------- */
// 用 test/helpers.js 的 startServer：随机端口、临时库、AI 关闭、配置不落到仓库根；进程退出时
// helpers 自己杀子进程、删临时目录。给了库路径时先复制一份再起，原文件只读不动。
async function boot(H) {
  let dbPath;
  if (BOOT !== true) {
    const src = path.resolve(String(BOOT));
    // lms.db 是负责人的正式库：连复制也不做（复制等于打开它的 -wal/-shm 边界状态）。
    // 目录比较用真实路径、Windows 下不分大小写（审查：c:\users\… 小写写法原先能绕过）
    const realDir = (p) => {
      let r = path.resolve(p);
      try { r = fs.realpathSync.native(r); } catch { /* 不存在：按字面 */ }
      return process.platform === "win32" ? r.toLowerCase() : r;
    };
    if (path.basename(src).toLowerCase().startsWith("lms.db") && realDir(path.dirname(src)) === realDir(ROOT)) {
      console.error("拒绝：--boot 不接受仓库根的 lms.db。用 make-demo-db.js 生成的演示库，或不带路径起全新库。");
      process.exit(2);
    }
    if (!fs.existsSync(src)) { console.error(`--boot 指定的库不存在：${src}`); process.exit(2); }
    const dir = H.tempDir("tms-smoke-db-");
    dbPath = path.join(dir, "smoke.db");
    fs.copyFileSync(src, dbPath);
    for (const ext of ["-wal", "-shm"]) if (fs.existsSync(src + ext)) fs.copyFileSync(src + ext, dbPath + ext);
  }
  return H.startServer(dbPath ? { dbPath } : {});
}

/* ---------------- 页面操作 ---------------- */
async function evaluate(ctx, expression) {
  const r = await ctx.cdp.send("Runtime.evaluate", {
    expression, returnByValue: true, awaitPromise: true,
  }, ctx.sessionId);
  if (r.exceptionDetails) {
    const t = r.exceptionDetails.exception && (r.exceptionDetails.exception.description || r.exceptionDetails.exception.value);
    throw new Error(`页面内求值抛错: ${String(t).slice(0, 200)}`);
  }
  return r.result.value;
}

// A hash-only Page.navigate is a SAME-DOCUMENT jump: the SPA does not re-boot, so
// it never learns about a session established by fetch() and its route guard bounces
// every route back to /login. The symptom is maddening — the page has content, the
// checks report nothing, only the ready selector never matches. A changing query
// forces a real document load, which also gives every route a clean slate.
let navSeq = 0;
async function navigate(ctx, hash) {
  const url = `${BASE}/next/?r=${++navSeq}${hash || ""}`;
  await ctx.cdp.send("Page.navigate", { url }, ctx.sessionId);
  // 等 DOM 可用即可，具体「渲染完成」由每条路由自己的 ready 选择器判定。
  for (let i = 0; i < 60; i++) {
    await sleep(100);
    try {
      const st = await evaluate(ctx, "document.readyState");
      if (st === "interactive" || st === "complete") return;
    } catch { /* 导航中途求值会失败，重试 */ }
  }
}

// 语言必须在应用启动**之前**写进 localStorage，否则第一屏是上一次的语言，
// 而 latin-in-zh 这条检查依赖语言正确。
async function setLangOnNewDocument(ctx, lang) {
  if (ctx.langScriptId) {
    await ctx.cdp.send("Page.removeScriptToEvaluateOnNewDocument", { identifier: ctx.langScriptId }, ctx.sessionId);
  }
  const { identifier } = await ctx.cdp.send("Page.addScriptToEvaluateOnNewDocument", {
    source: `try { localStorage.setItem('lms-lang', ${JSON.stringify(lang)}); } catch (e) {}`,
  }, ctx.sessionId);
  ctx.langScriptId = identifier;
}

// 视口：宽 <768 按手机模拟（mobile:true），与 v2.css 的 ≤900 / ≤640 断点对得上。
async function setViewport(ctx, vp) {
  await ctx.cdp.send("Emulation.setDeviceMetricsOverride", {
    width: vp.w, height: vp.h, deviceScaleFactor: 1, mobile: vp.w < 768,
  }, ctx.sessionId);
}

async function login(ctx, who, accounts) {
  if (ctx.loggedAs === who) return true;
  await navigate(ctx, "#/login");
  if (who === "anon") {
    await evaluate(ctx, `fetch('/api/auth/logout',{method:'POST',credentials:'include'}).then(()=>true).catch(()=>false)`);
    ctx.loggedAs = "anon";
    return true;
  }
  const a = accounts[who];
  if (!a) return false;
  const creds = { employeeId: a.employeeId, password: a.password };
  const ok = await evaluate(ctx, `
    fetch('/api/auth/login', { method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: ${JSON.stringify(JSON.stringify(creds))} }).then((r) => r.status === 200).catch(() => false)`);
  if (ok) ctx.loggedAs = who;
  return ok;
  // 注意：这里不需要额外 reload —— 每条路由的 navigate() 都是整文档加载，
  // 下一次导航时 SPA 会自己带着 cookie 重新启动。
}

// 管理员会话下的只读取数，给 resolveParams 用（取真实 id 填进带参数的路由）。
async function apiGet(ctx, p) {
  return evaluate(ctx, `fetch(${JSON.stringify(p)}, { credentials: 'include' })
    .then((r) => (r.status === 200 ? r.json() : null)).catch(() => null)`);
}

async function waitReady(ctx, ready, timeout) {
  const sels = Array.isArray(ready) ? ready : [ready];
  const expr = `(${JSON.stringify(sels)}).some((s) => document.querySelector(s))`;
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try { if (await evaluate(ctx, expr)) return true; } catch { /* 渲染中 */ }
    await sleep(150);
  }
  return false;
}

// 整页截图；版面检查打过 data-smoke-layout 的元素先加红框（下一条路由整文档重载，不用撤）。
async function screenshot(ctx, file, vp) {
  try {
    await evaluate(ctx, `(() => { const s = document.createElement('style'); s.textContent = '[data-smoke-layout]{outline:2px solid #e5484d !important;outline-offset:-1px !important}'; document.head.appendChild(s); return true; })()`);
    const m = await ctx.cdp.send("Page.getLayoutMetrics", {}, ctx.sessionId);
    const size = m.cssContentSize || m.contentSize || { height: vp.h };
    const height = Math.max(vp.h, Math.min(Math.ceil(size.height), 12000));
    const shot = await ctx.cdp.send("Page.captureScreenshot", {
      format: "png", captureBeyondViewport: true, clip: { x: 0, y: 0, width: vp.w, height, scale: 1 },
    }, ctx.sessionId);
    fs.writeFileSync(file, Buffer.from(shot.data, "base64"));
    return file;
  } catch (e) {
    return `截图失败：${e.message}`;
  }
}

/* ---------------- 路由 × 账号 ---------------- */
const needsOf = (route) => (Array.isArray(route.needs) ? route.needs
  : (route.needs ? String(route.needs).split(",").map((s) => s.trim()).filter(Boolean) : []));

// 这条路由在账号 who 下跑不跑：本账号的路由照跑；同一侧的其他账号也跑 —— 'admin' 路由给受限后台
// 角色跑（被转回 #/admin 记为「无权访问」跳过），不带参数的 'employee' 路由给 hod/manager 跑。
// 带参数的员工端路由只跑在解析参数时用的那个账号上（换个人 id 就不归他，只会得到 403）。
function runsAs(route, who, accounts) {
  const target = route.as || "admin";
  if (who === "anon" || target === "anon") return who === target;
  if (target === who) return true;
  if (route.crossRun === false) return false; // 渲染结果取决于本账号的数据（例如 /team 要有下属）
  const a = accounts[who];
  if (!a) return false;
  if (target === "admin") return a.side === "console";
  if (target === "employee") return a.side === "employee" && needsOf(route).length === 0;
  return false;
}

const hashPath = (h) => String(h || "").split("?")[0].replace(/\/+$/, "").toLowerCase();
const slug = (s) => String(s || "").replace(/^#\/?/, "").replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "home";
// 基线与归并的键：同一账号、语言、视口、路由（按名称 —— 带参数的 hash 换个库 id 就不同）、检查项与签名。
// 没有签名的旧检查（page-overflow 等）用消息去掉数字代替。控制台报错与请求失败的消息是固定的，具体内容在 sample 里：
// 签名取 sample（请求失败 = 状态码 + 去掉查询串、含数字的段换成 :id 的路径；控制台报错 = 去掉源地址、数字与长十六进制），
// 否则同一路由上新出现的另一个报错会被当成「基线里已有」（审查）。
const sampleSig = (kind, sample) => {
  const s = String(sample || "");
  if (kind === "http-error") {
    const m = s.match(/^(\d{3})\s+(\S*)/);
    if (m) return `${m[1]} ${m[2].split("?")[0].split("/").map((seg) => (/\d/.test(seg) || seg.length > 32 ? ":id" : seg)).join("/")}`;
  }
  return s.replace(/https?:\/\/[^\s/]+/g, "").replace(/\b[0-9a-f]{8,}\b/gi, "#").replace(/\d+(\.\d+)?/g, "#").slice(0, 160);
};
const findingSig = (f) => f.sig || (f.kind === "console-error" || f.kind === "http-error"
  ? `${f.kind}:${sampleSig(f.kind, f.sample)}`
  : String(f.message || "").replace(/\d+(\.\d+)?/g, "#"));
const findingKey = (r, f) => [r.as, r.lang, r.viewport, r.route, f.kind, findingSig(f)].join("|");

/* ---------------- 主流程 ---------------- */
function loadPart(name) {
  const p = path.join(__dirname, name);
  if (!fs.existsSync(p)) return null;
  try { return require(p); } catch (e) {
    console.error(`加载 ${name} 失败: ${e.message}`);
    return null;
  }
}

// checks/routes 拆成两个文件是为了让它们能被单独替换和审阅；缺失时给出可用的降级版本，
// 这样脚本本身永远能跑（哪怕只做最基础的四条断言）。
const FALLBACK_CHECKS = `(() => {
  const findings = [];
  const text = (document.body && document.body.innerText) || '';
  const push = (severity, kind, message, sample) => findings.push({ severity, kind, message, sample: String(sample || '').slice(0, 120) });
  if (/页面出错了|Something went wrong/.test(text)) push('fail', 'error-boundary', '错误边界被触发', text.slice(0, 120));
  const nulls = text.match(/(^|[\\s>（(【「])(null|undefined|NaN)([\\s<，,。）)】」]|$)/);
  if (nulls) push('fail', 'literal-null', '页面上出现字面的 null/undefined/NaN', nulls[0]);
  if (text.replace(/\\s+/g, '').length < 40) push('fail', 'blank-page', '页面几乎没有可见文本', text.slice(0, 60));
  const de = document.documentElement;
  if (de.scrollWidth > de.clientWidth + 2) push('fail', 'page-overflow', '整页横向滚动', de.scrollWidth + ' > ' + de.clientWidth);
  return { findings, stats: { visibleTextLength: text.length } };
})()`;

async function main() {
  if (!BOOT && !BASE) { console.error(USAGE); process.exit(2); }
  if (BOOT && BASE) { console.error("--boot 与 --base 只能二选一。"); process.exit(2); }
  if (BASE) {
    let port = "";
    try { const u = new URL(BASE); port = u.port || (u.protocol === "https:" ? "443" : "80"); } catch { console.error(`--base 不是合法地址：${BASE}`); process.exit(2); }
    if (PROTECTED_PORTS.includes(port) && !LIVE_OK) {
      console.error(`拒绝：${BASE} 是常驻服务（${PROTECTED_PORTS.join("/")} 之一）。冒烟会登录（写会话与登录审计），`
        + "打开 /team/:id 还会写一条 manager.view_profile。确实要跑，加 --live-ok；否则改用 --boot。");
      process.exit(2);
    }
  }
  if (flag("seed", "") && !BOOT) { console.error("--seed 只能配 --boot（夹具会写数据，只种进一次性服务）。"); process.exit(2); }
  const SEED = String(flag("seed", BOOT === true ? "v2" : "none"));
  if (!["v2", "none"].includes(SEED)) { console.error(`--seed 只认 v2 或 none：${SEED}`); process.exit(2); }

  const checksMod = loadPart("smoke-checks.js");
  const routesMod = loadPart("smoke-routes.js");
  const checksSource = (checksMod && checksMod.source) || FALLBACK_CHECKS;
  if (!checksMod) console.log("· smoke-checks.js 不在，使用内置的降级检查（只有四条 fail 级）");
  if (!routesMod) { console.error("缺少 scripts/smoke-routes.js（路由清单），无法继续。"); process.exit(2); }
  if (LAYOUT && !(checksMod && typeof checksMod.layoutExpr === "function")) { console.error("--layout 需要 smoke-checks.js 导出 layoutExpr。"); process.exit(2); }

  let fixture = null;
  if (BOOT) {
    const H = require(path.join(ROOT, "test", "helpers.js"));
    const srv = await boot(H);
    BASE = srv.base;
    console.log(`一次性服务: ${BASE}（库 ${srv.dbPath}，跑完即删）`);
    if (SEED === "v2") {
      if (typeof routesMod.seedFixture !== "function") { console.error("smoke-routes.js 没有 seedFixture，种不了 v2 夹具。"); process.exit(2); }
      fixture = await routesMod.seedFixture(BASE, H, buildAccounts(null).admin);
      console.log(`v2 夹具: 账号 ${Object.keys(fixture.accounts).join(", ") || "（无）"}${fixture.cycleId ? `，周期 ${fixture.cycleId}` : ""}`);
      for (const n of fixture.notes) console.log(`  · ${n}`);
    }
  }
  const ACCOUNTS = buildAccounts(fixture && fixture.accounts);
  const unknown = AS.filter((a) => a !== "anon" && !ACCOUNTS[a]);
  if (unknown.length) { console.error(`--as 里有账号表没有的名字：${unknown.join(", ")}（现有：${Object.keys(ACCOUNTS).join(", ")}；用 --accounts 补）`); process.exit(2); }

  // 服务在不在
  try {
    const r = await fetch(`${BASE}/next/`);
    if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
  } catch (e) {
    console.error(`连不上 ${BASE}（${e.message}）。`);
    process.exit(2);
  }
  if (SHOTS) fs.mkdirSync(path.resolve(String(SHOTS)), { recursive: true });

  const ctx = await launch();
  console.log(`浏览器: ${ctx.browser}${HEADFUL ? "（有头模式）" : ""} · 账号 ${AS.join(", ")} · 视口 ${VIEWPORTS.map((v) => v.label).join(", ")}${LAYOUT ? " · 版面检查" : ""}`);

  // 每条路由自己的 console 错误与失败请求
  let bucket = { console: [], network: [] };
  // 置位时表示当前跑的是匿名路由（登录页），那一页所有 401 都是预期的。
  let ctx401Anon = false;
  ctx.cdp.on((msg) => {
    if (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error") {
      const txt = (msg.params.args || []).map((a) => a.value ?? a.description ?? a.type).join(" ");
      bucket.console.push(String(txt).slice(0, 200));
    } else if (msg.method === "Log.entryAdded" && msg.params.entry.level === "error") {
      const e = msg.params.entry;
      // The console mirror of the same expected 401 handshake filtered below: a
      // logged-out SPA probes /api/me* on boot. Suppressed here too, or the report
      // starts with a line the reader has to learn to ignore.
      const authNoise = /\b(401|403)\b/.test(String(e.text))
        && (ctx401Anon || /\/api\/me/.test(String(e.url || "")));
      if (!authNoise) bucket.console.push(String(e.text).slice(0, 200));
    } else if (msg.method === "Network.responseReceived") {
      const { url, status } = msg.params.response;
      const p = String(url).replace(BASE, "");
      // A logged-out SPA probes /api/me on boot and gets 401 — that is the session
      // handshake, not a defect. Reporting it would put four lines of noise at the
      // top of every run, which is how people learn to ignore a smoke test.
      const expectedAuth = (status === 401 || status === 403)
        && (/^\/api\/me(\?|$)/.test(p) || ctx401Anon);
      if (status >= 400 && !expectedAuth) bucket.network.push(`${status} ${p}`);
    }
  });

  const results = [];
  let params = {};
  let shotSeq = 0;
  try {
    if (await login(ctx, "admin", ACCOUNTS)) {
      if (typeof routesMod.resolveParams === "function") {
        const preferredEmployee = ACCOUNTS.employee && ACCOUNTS.employee.employeeId;
        params = (await routesMod.resolveParams((p) => apiGet(ctx, p), { preferredEmployee })) || {};
        // 参数落到了别人身上（首选员工不在库里）：员工端只属于那个人的 id 不能拿来给登录账号用。
        if (params.employeeId && preferredEmployee && params.employeeId !== preferredEmployee) {
          for (const k of ["attemptId", "reportId", "projectId"]) params[k] = null;
          (params.notes = params.notes || []).push(`登录用的员工账号 ${preferredEmployee} 不在库里，属于个人的 attemptId/reportId/projectId 不用`);
        }
        console.log("路由参数:", JSON.stringify(params));
      }
    } else {
      console.log("· admin 登录失败，带参数的路由会全部跳过");
    }

    const who = ["anon", ...AS.filter((a) => a !== "anon")];
    for (const vp of VIEWPORTS) {
      await setViewport(ctx, vp);
      for (const lang of LANGS) {
        await setLangOnNewDocument(ctx, lang);
        ctx.loggedAs = null; // 语言脚本换了，重新登一次以刷新首屏
        const tag = { lang, viewport: vp.label };
        for (const route of routesMod.ROUTES) {
          if (ONLY && !route.hash.includes(ONLY) && !route.name.includes(ONLY)) continue;
          if (!who.some((w) => runsAs(route, w, ACCOUNTS))) {
            results.push({ ...tag, as: route.as, route: route.name, hash: route.hash, skipped: `没有选中能跑它的账号（--as=${AS.join(",")}）` });
          }
        }
        for (const account of who) {
          for (const route of routesMod.ROUTES) {
            if (ONLY && !route.hash.includes(ONLY) && !route.name.includes(ONLY)) continue;
            if (!runsAs(route, account, ACCOUNTS)) continue;
            const base = { ...tag, as: account, route: route.name };
            if (route.skipByDefault && !WITH_SIDE_EFFECTS) {
              results.push({ ...base, hash: route.hash, skipped: "有副作用，默认跳过（--include-side-effects 可开）" });
              continue;
            }
            let hash = route.hash;
            // needs 可以是数组或逗号串：/exam-prep/:programId/:examId 需要两个。
            const needs = needsOf(route);
            const missing = needs.filter((k) => !params[k]);
            if (missing.length) {
              results.push({ ...base, hash, skipped: `取不到参数 ${missing.join(", ")}` });
              continue;
            }
            for (const k of needs) hash = hash.replace(`:${k}`, encodeURIComponent(params[k]));

            // login() 已登录同一账号时直接返回；失败只报一条，整个账号这一轮跳过。
            if (!(await login(ctx, account, ACCOUNTS))) {
              results.push({ ...base, route: "（登录）", hash: "#/login", findings: [{ severity: "fail", kind: "login-failed", message: `登录 ${account} 失败（账号表见 --accounts）` }] });
              process.stdout.write(`✗ [${lang}·${vp.label}·${account}] 登录失败，跳过这个账号\n`);
              break;
            }

            bucket = { console: [], network: [] };
            ctx401Anon = account === "anon";
            await navigate(ctx, hash);
            // 有些页面不是独立路由，而是在某个路由里点一下才出现（周期详情靠 setOpenId 切换）。
            // 白屏恰恰是从这种页面漏出去的：路由清单走不到，冒烟就永远看不到它。
            const actFindings = [];
            if (route.act) {
              if (route.act.waitFor && !(await waitReady(ctx, route.act.waitFor, ROUTE_TIMEOUT))) {
                actFindings.push({
                  severity: "fail", kind: "act-gate",
                  message: "点击之前要等的列表没渲染出来",
                  sample: String(route.act.waitFor),
                });
              }
              const wants = [].concat(route.act.clickText || []);
              const hit = await evaluate(ctx, `(() => {
                const wants = ${JSON.stringify(wants)};
                const sel = ${JSON.stringify(route.act.click || "")};
                const el = sel
                  ? document.querySelector(sel)
                  : [...document.querySelectorAll("button,a")].find((b) => wants.includes(b.textContent.trim()));
                if (!el) return false;
                el.click();
                return true;
              })()`);
              // 找不到点击目标必须报错。默默跳过的话，按钮一改名这条用例就退化成
              // 「又测了一遍列表页」，而且永远是绿的。
              if (!hit) {
                actFindings.push({
                  severity: "fail", kind: "act-target-missing",
                  message: "找不到要点的元素，这条用例没能进到目标页面",
                  sample: route.act.click || wants.join(" / "),
                });
              }
              await sleep(400); // 让详情组件挂载并发起自己的请求
            }
            const ready = await waitReady(ctx, route.ready || "body", ROUTE_TIMEOUT);
            // 借跑（受限后台角色跑 admin 路由）：被路由守卫转走是「无权访问」，不是缺陷。
            if (!ready && account !== route.as) {
              let now = "";
              try { now = await evaluate(ctx, "location.hash"); } catch { /* 页面没了 */ }
              if (hashPath(now) !== hashPath(hash)) {
                results.push({ ...base, hash, skipped: `该账号无权访问，被转到 ${now || "（空）"}` });
                continue;
              }
            }
            await sleep(350); // 让最后一批异步渲染落定
            let payload = { findings: [], stats: {} };
            try { payload = await evaluate(ctx, checksSource) || payload; } catch (e) {
              payload = { findings: [{ severity: "fail", kind: "checks-threw", message: e.message }], stats: {} };
            }
            const findings = [...actFindings, ...(payload.findings || [])];
            let stats = payload.stats || {};
            if (LAYOUT) {
              try {
                const lay = await evaluate(ctx, checksMod.layoutExpr({ mark: !!SHOTS }));
                findings.push(...((lay && lay.findings) || []));
                stats = { ...stats, ...((lay && lay.stats) || {}) };
              } catch (e) {
                findings.push({ severity: "fail", kind: "layout-threw", message: e.message });
              }
            }
            if (!ready) {
              // 附上页面实际渲染的开头：ready 等不到时，最需要知道的是「那它显示了什么」
              // （被弹回登录页？空态？错误边界？）—— 否则只能靠插桩才能判断。
              let shown = "";
              try { shown = await evaluate(ctx, "(document.body.innerText||'').replace(/\\s+/g,' ').slice(0,80)"); } catch { /* 页面没了 */ }
              findings.push({
                severity: "fail", kind: "not-ready",
                message: `${ROUTE_TIMEOUT}ms 内没等到 ready 选择器`,
                sample: `${String(route.ready)} · 实际显示: ${shown}`,
              });
            }
            for (const c of [...new Set(bucket.console)]) findings.push({ severity: "fail", kind: "console-error", message: "控制台报错", sample: c });
            for (const n of [...new Set(bucket.network)]) findings.push({ severity: "fail", kind: "http-error", message: "请求失败", sample: n });
            const entry = { ...base, hash, findings, stats };
            if (SHOTS) {
              const file = path.join(path.resolve(String(SHOTS)), `${String(++shotSeq).padStart(3, "0")}_${account}_${lang}_${vp.label}_${slug(hash)}.png`);
              entry.shot = await screenshot(ctx, file, vp);
            }
            results.push(entry);

            const f = findings.filter((x) => x.severity === "fail").length;
            const w = findings.filter((x) => x.severity === "warn").length;
            process.stdout.write(`${f ? "✗" : w ? "!" : "·"} [${lang}·${vp.label}·${account}] ${route.name}${f || w ? `  fail ${f} / warn ${w}` : ""}\n`);
          }
        }
      }
    }
  } finally {
    ctx.cdp.close();
    await stopBrowser(ctx.child, ctx.profile);
  }

  /* ---------------- 报告 ---------------- */
  const tagOf = (r) => `[${r.lang}·${r.viewport}·${r.as}]`;
  const fails = results.flatMap((r) => (r.findings || []).filter((f) => f.severity === "fail").map((f) => ({ ...f, r })));
  const warns = results.flatMap((r) => (r.findings || []).filter((f) => f.severity === "warn").map((f) => ({ ...f, r })));
  const skipped = results.filter((r) => r.skipped);

  console.log(`\n${"=".repeat(64)}`);
  console.log(`跑了 ${results.length - skipped.length} 页 · 跳过 ${skipped.length} 页 · fail ${fails.length} · warn ${warns.length}`);
  const group = (items) => {
    const by = new Map();
    for (const x of items) {
      const k = `${x.kind}`;
      if (!by.has(k)) by.set(k, []);
      by.get(k).push(x);
    }
    return [...by.entries()].sort((a, b) => b[1].length - a[1].length);
  };
  if (fails.length) {
    console.log("\n--- 必须修（fail） ---");
    for (const [kind, items] of group(fails)) {
      console.log(`\n[${kind}] ${items.length} 处`);
      for (const x of items.slice(0, 12)) console.log(`  ${tagOf(x.r)} ${x.r.route}  ${x.message}${x.sample ? `\n        ${x.sample}` : ""}`);
      if (items.length > 12) console.log(`  …另外 ${items.length - 12} 处（用 --json 看全部）`);
    }
  }
  if (warns.length) {
    console.log("\n--- 需要人判断（warn） ---");
    for (const [kind, items] of group(warns)) {
      console.log(`\n[${kind}] ${items.length} 处`);
      for (const x of items.slice(0, 8)) console.log(`  ${tagOf(x.r)} ${x.r.route}  ${x.message}${x.sample ? `\n        ${x.sample}` : ""}`);
      if (items.length > 8) console.log(`  …另外 ${items.length - 8} 处（用 --json 看全部）`);
    }
  }

  // 版面问题按「检查项 × 选择器签名」跨路由、跨语言、跨视口归并：同一个签名出现在多页，先改共用样式。
  let merged = [];
  if (LAYOUT) {
    const by = new Map();
    for (const x of [...fails, ...warns]) {
      if (!x.sig) continue;
      const k = `${x.kind}|${x.sig}`;
      if (!by.has(k)) by.set(k, { kind: x.kind, sig: x.sig, severity: x.severity, hits: 0, routes: new Set(), variants: new Set(), sample: x.sample, whitelist: x.whitelist });
      const g = by.get(k);
      g.hits += x.count || 1;
      g.routes.add(x.r.route);
      g.variants.add(`${x.r.lang}·${x.r.viewport}·${x.r.as}`);
      if (x.severity === "fail") g.severity = "fail";
    }
    merged = [...by.values()].map((g) => ({ ...g, routes: [...g.routes], variants: [...g.variants] }))
      .sort((a, b) => b.routes.length - a.routes.length || b.hits - a.hits);
    if (merged.length) {
      console.log("\n--- 版面问题归并（检查项 × 签名；跨页越多越该先改共用样式） ---");
      for (const g of merged.slice(0, 25)) {
        console.log(`  ${g.severity === "fail" ? "✗" : "!"} [${g.kind}] ${g.sig}  · ${g.routes.length} 页 / ${g.variants.length} 种组合 / ${g.hits} 处${g.whitelist ? "  · 白名单候选" : ""}`);
      }
      if (merged.length > 25) console.log(`  …另外 ${merged.length - 25} 组（用 --json 看全部）`);
    }
  }

  if (skipped.length) {
    console.log("\n--- 跳过 ---");
    const by = new Map();
    for (const s of skipped) { const k = s.skipped; if (!by.has(k)) by.set(k, new Set()); by.get(k).add(s.route); }
    for (const [why, routes] of by) console.log(`  ${why}：${[...routes].join("、")}`);
  }
  if (!fails.length && !warns.length) console.log("\n干净。");

  // 基线比对：只看新增。键不含 hash（库换了 id 就不同）和数字（像素差会抖）。
  let baselineDiff = null;
  if (BASELINE) {
    let old;
    try { old = JSON.parse(fs.readFileSync(path.resolve(String(BASELINE)), "utf8")); } catch (e) { console.error(`读不了基线 ${BASELINE}：${e.message}`); process.exit(2); }
    const oldKeys = new Set((old.results || []).flatMap((r) => (r.findings || []).map((f) => findingKey(r, f))));
    const nowKeys = new Set(results.flatMap((r) => (r.findings || []).map((f) => findingKey(r, f))));
    const added = results.flatMap((r) => (r.findings || []).filter((f) => !oldKeys.has(findingKey(r, f))).map((f) => ({ ...f, r })));
    const resolved = [...oldKeys].filter((k) => !nowKeys.has(k));
    baselineDiff = { added: added.map((x) => ({ as: x.r.as, lang: x.r.lang, viewport: x.r.viewport, route: x.r.route, kind: x.kind, severity: x.severity, sig: findingSig(x), message: x.message })), resolved };
    console.log(`\n--- 与基线比较（${BASELINE}） ---\n新增 ${added.length} · 已消失 ${resolved.length}`);
    for (const x of added.slice(0, 30)) console.log(`  + ${tagOf(x.r)} ${x.r.route}  [${x.kind}] ${x.message}`);
    if (added.length > 30) console.log(`  …另外 ${added.length - 30} 条（用 --json 看全部）`);
  }

  if (JSON_OUT) {
    // path.join(ROOT, "C:\…") 会拼出 <repo>\C:\… 然后 ENOENT —— 而这行在 process.exit
    // 之前，于是一次 fail 0 的绿跑会被 catch 兜成 exit 2，按退出码判绿的 CI 会把绿报成红。
    const out = path.isAbsolute(String(JSON_OUT)) ? String(JSON_OUT) : path.join(ROOT, String(JSON_OUT));
    fs.writeFileSync(out, JSON.stringify({
      base: BASE, boot: !!BOOT, seed: BOOT ? SEED : null, langs: LANGS, viewports: VIEWPORTS.map((v) => v.label),
      accounts: Object.fromEntries(AS.map((a) => [a, ACCOUNTS[a] ? ACCOUNTS[a].employeeId : null])),
      layout: LAYOUT, results, merged, baselineDiff,
    }, null, 1));
    console.log(`\n明细写到 ${JSON_OUT}`);
  }
  if (baselineDiff) process.exit(baselineDiff.added.length ? 1 : 0);
  process.exit(fails.length ? 1 : 0);
}

main().catch((e) => { console.error("冒烟脚本自己挂了:", e.stack || e.message); process.exit(2); });
