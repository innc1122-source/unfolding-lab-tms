/*
 * 冒烟脚本的自检：在真实页面上逐个注入已知缺陷，确认每条检查都真的会响。
 *
 *   runtime\node.exe scripts\smoke-selftest.js --boot                       起一次性服务自检（推荐）
 *   runtime\node.exe scripts\smoke-selftest.js --base=http://127.0.0.1:<端口>  对已在跑的服务自检
 *
 * 和 smoke.js 一样必须显式指定服务（也认环境变量 SMOKE_BASE）；不再默认连 8767。
 * 负责人与 QA 的常驻端口（8767/8812/5173/8797/8931）要加 --live-ok —— 自检会登录，写会话与登录审计。
 * 管理员账号缺省 ADMIN / unfolding888，可用 --accounts=<json>（只读其中的 admin）覆盖。
 *
 * 为什么需要它：smoke.js 报「干净」有两种可能 —— 系统真的干净，或者检查根本没在看。
 * 这两种在报告上长得一模一样。第一次跑自检就抓到了后者的一个变体：latin-in-zh 看起来
 * 不响，其实是**注入与检查分成了两次求值**，React 在中间重渲染、把注入的英文表头撤回成
 * 「姓名」。所以下面每个用例都把「注入 + 跑检查」放进同一次 Runtime.evaluate。
 *
 * 第二批 3.2 起加了版面检查（smoke-checks.js 的 layoutChecks）的用例：每条版面检查各注入
 * 一个缺陷。真实页面本身可能就有版面 warn，所以版面用例不看「有没有这一类」，而看「有没有
 * 命中我注入的那个元素」（结果的 sig 里带注入元素自己的类名）。字体先单独等一次，注入与检查
 * 仍在同一次同步求值里完成。
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
const CHECKS_MOD = require("./smoke-checks.js");
const CHECKS = CHECKS_MOD.source;
const LAYOUT_SYNC = CHECKS_MOD.layoutSyncExpr({});
const BOOT = !!flag("boot", false);
let BASE = String(flag("base", "") === true ? "" : flag("base", "") || process.env.SMOKE_BASE || "").replace(/\/$/, "");
const PROTECTED_PORTS = ["8767", "8812", "5173", "8797", "8931"];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const BROWSERS = [
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  process.env.SMOKE_BROWSER || "",
];

function adminCreds() {
  let a = { employeeId: "ADMIN", password: "unfolding888" };
  const file = flag("accounts", "");
  if (file) {
    try {
      const t = JSON.parse(fs.readFileSync(path.resolve(String(file)), "utf8"));
      if (t.admin && t.admin.employeeId && t.admin.password) a = { employeeId: t.admin.employeeId, password: t.admin.password };
    } catch (e) { console.error(`读不了 --accounts=${file}：${e.message}`); process.exit(2); }
  }
  return a;
}

// 每个用例：在页面里改一处 DOM，然后**在同一次求值里**跑检查，最后自己撤回。
// expect = 期望出现的 finding kind。
const CASES = [
  {
    kind: "literal-null",
    setup: "const d = document.createElement('div'); d.id='__st'; d.textContent='部门: null'; document.querySelector('.wrap').appendChild(d);",
    teardown: "const e = document.getElementById('__st'); if (e) e.remove();",
  },
  {
    kind: "latin-in-zh",
    // 表头是 React 管的，所以注入后必须立刻检查 —— 分两次就会被重渲染撤回。
    setup: `const ths = [...document.querySelectorAll('.semi-table-thead th')];
      const th = ths.find((x) => (x.innerText || '').trim()) || ths[0];
      window.__stTh = th; window.__stWas = th ? th.innerHTML : null;
      if (th) th.textContent = 'Employee Department Status';`,
    teardown: "if (window.__stTh && window.__stWas != null) { window.__stTh.innerHTML = window.__stWas; } delete window.__stTh; delete window.__stWas;",
  },
  {
    kind: "page-overflow",
    setup: "const d = document.createElement('div'); d.id='__st2'; d.style.cssText='width:3000px;height:8px'; document.body.appendChild(d);",
    teardown: "const e = document.getElementById('__st2'); if (e) e.remove();",
  },
  {
    kind: "error-boundary",
    setup: "const d = document.createElement('div'); d.id='__st3'; d.textContent='页面出错了 / Something went wrong'; document.body.appendChild(d);",
    teardown: "const e = document.getElementById('__st3'); if (e) e.remove();",
  },
];

// 版面用例：html 放进一个绝对定位的白底容器（不挤动页面本身），mark = 注入元素自己的类名，
// 结果的 sig 里必须出现它。类名放在 class 的第一位：签名只取前两个类。
const CJK = (n) => "版面检查自检用的一段中文正文".repeat(Math.ceil(n / 14)).slice(0, n);
const CARD = "border:1px solid #d8dbe6;border-radius:10px;background:#fff";
const LAYOUT_CASES = [
  { kind: "text-overflow", mark: "st-of", label: "自身裁切", html: `<div class="st-of" style="width:80px;overflow:hidden;white-space:nowrap">这是一段放不下的很长的标签文字</div>` },
  { kind: "text-overflow", mark: "st-sp", label: "溢出自身框", html: `<div class="st-sp" style="width:60px;white-space:nowrap">溢出自身框的一段文字</div>` },
  { kind: "text-overflow", mark: "st-ac", label: "被祖先裁掉（§15 V1）", html: `<div style="width:120px;overflow:hidden;display:flex"><span class="st-ac" style="flex:none;white-space:nowrap">自评 100% · HR 确认 1/1</span></div>` },
  { kind: "ellipsis-no-title", mark: "st-el", html: `<div class="st-el" style="width:80px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis">被省略号截断的一段长文字</div>` },
  { kind: "token-split", mark: "st-ts", label: "§15 V2", html: `<div class="st-ts" style="width:44px;overflow-wrap:anywhere">Ana (T-00858)</div>` },
  { kind: "off-center-x", mark: "st-ox", label: "F4", html: `<button class="st-ox btn" style="display:inline-flex;align-items:center;justify-content:normal;width:200px;height:36px;padding:0 10px">开始学习</button>` },
  { kind: "off-center-y", mark: "st-oy", html: `<span class="st-oy pill" style="display:inline-flex;align-items:flex-start;justify-content:center;height:44px;width:80px;padding:0 6px">标签</span>` },
  { kind: "label-wrapped", mark: "st-lw", html: `<button class="st-lw btn" style="display:inline-block;width:44px;height:auto;white-space:normal;padding:4px;line-height:1.4">提交审批</button>` },
  { kind: "line-too-long", mark: "st-ll", html: `<p class="st-ll" style="width:1000px;font-size:14px;margin:0">${CJK(160)}</p>` },
  { kind: "line-too-short", mark: "st-ls", html: `<p class="st-ls" style="width:70px;font-size:14px;margin:0">${CJK(60)}</p>` },
  { kind: "column-imbalance", mark: "st-ci", html: `<div class="st-ci" style="display:grid;grid-template-columns:1fr 1fr;gap:16px;width:1000px"><div><div style="height:600px">左栏</div></div><div><div style="height:100px">右栏</div></div></div>` },
  { kind: "uneven-row", mark: "st-ur", label: "F3", html: `<div class="st-ur" style="display:flex;gap:16px;width:1000px;align-items:flex-start"><div style="flex:1;height:400px;${CARD}">甲</div><div style="flex:1;height:250px;${CARD}">乙</div></div>` },
  { kind: "narrow-centered", mark: "st-nc", label: "F1", html: `<div style="width:1000px"><div class="st-nc" style="width:400px;margin:0 auto;height:120px;${CARD}">居中窄条</div></div>` },
  { kind: "narrow-content", mark: "st-nw", label: "F2", html: `<div class="st-nw" style="width:1000px;box-sizing:border-box;padding:20px;${CARD}"><p style="width:300px;margin:0;font-size:14px">${CJK(240)}</p></div>` },
  { kind: "card-in-card", mark: "st-cc", label: "F1", html: `<div style="width:600px;padding:16px;border-radius:12px;${CARD}"><div class="st-cc" style="padding:16px;height:80px;border:1px solid #d8dbe6;border-radius:12px;background:#fafafa">内层卡片</div></div>` },
];
const layoutCaseExpr = (html) => `(() => {
  const box = document.createElement('div');
  box.id = '__stl';
  box.style.cssText = 'position:absolute;left:240px;top:120px;width:1100px;z-index:9999;background:#fff';
  box.innerHTML = ${JSON.stringify(html)};
  document.body.appendChild(box);
  let res;
  try { res = ${LAYOUT_SYNC}; } finally { box.remove(); }
  return (res.findings || []).map((f) => ({ kind: f.kind, severity: f.severity, sig: f.sig }));
})()`;
// text-offscreen 单独注入到 body 右缘之外；手机宽度下应为 fail，桌面宽度下为 warn。
const OFFSCREEN_EXPR = `(() => {
  const d = document.createElement('div');
  d.className = 'st-os';
  d.style.cssText = 'position:absolute;top:300px;left:calc(100vw - 50px);white-space:nowrap;background:#fff';
  d.textContent = '超出视口的一段文字 offscreen';
  document.body.appendChild(d);
  let res;
  try { res = ${LAYOUT_SYNC}; } finally { d.remove(); }
  return (res.findings || []).map((f) => ({ kind: f.kind, severity: f.severity, sig: f.sig }));
})()`;

// 关浏览器并删临时 profile：先等进程退出（最多 5 秒）再带重试删除（与 smoke.js 同一写法；原先 kill 后立刻删，常删不掉）
async function stopBrowser(child, profile) {
  if (child && child.exitCode === null && child.signalCode === null) {
    const gone = new Promise((r) => child.once("exit", r));
    try { child.kill(); } catch { /* 已经退了 */ }
    await Promise.race([gone, sleep(5000)]);
  }
  try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 }); } catch { /* 仍被占用：留给系统清理 */ }
}

(async () => {
  if (BOOT && BASE) { console.error("--boot 与 --base（或 SMOKE_BASE）只能二选一。"); process.exit(2); }
  if (!BOOT && !BASE) {
    console.error("必须指定服务：--boot（一次性服务，推荐）或 --base=http://127.0.0.1:<端口>（也认 SMOKE_BASE）。不再默认连 8767。");
    process.exit(2);
  }
  if (BASE) {
    let port = "";
    try { const u = new URL(BASE); port = u.port || (u.protocol === "https:" ? "443" : "80"); } catch { console.error(`不是合法地址：${BASE}`); process.exit(2); }
    if (PROTECTED_PORTS.includes(port) && !flag("live-ok", false)) {
      console.error(`拒绝：${BASE} 是常驻服务。自检会登录（写会话与登录审计）；确实要跑加 --live-ok，否则用 --boot。`);
      process.exit(2);
    }
  }
  const exe = BROWSERS.find((p) => p && fs.existsSync(p));
  if (!exe) { console.error("找不到 Edge / Chrome（可用 SMOKE_BROWSER 指定）"); process.exit(2); }
  if (BOOT) {
    // test/helpers.js：随机端口 + 临时库，进程退出时自己杀子进程、删临时目录
    const H = require(path.join(ROOT, "test", "helpers.js"));
    const srv = await H.startServer();
    BASE = srv.base;
    console.log(`一次性服务: ${BASE}`);
  }
  try {
    const r = await fetch(`${BASE}/next/`);
    if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
  } catch (e) { console.error(`连不上 ${BASE}（${e.message}）。`); process.exit(2); }

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "tms-selftest-"));
  const port = 9500 + Math.floor((Date.now() / 1000) % 400);
  const child = spawn(exe, ["--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
    "--no-first-run", "--no-default-browser-check", "--disable-gpu", "--window-size=1440,900", "about:blank"], { stdio: "ignore" });

  let version = null;
  for (let i = 0; i < 60 && !version; i++) {
    await sleep(250);
    try { version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json(); } catch { /* 还没起 */ }
  }
  if (!version) { await stopBrowser(child, profile); console.error("CDP 端口没响应"); process.exit(2); }

  const ws = new WebSocket(version.webSocketDebuggerUrl);
  let id = 0; const pend = new Map();
  ws.addEventListener("message", (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } });
  await new Promise((r) => ws.addEventListener("open", r));
  const send = (method, params, sid) => new Promise((res) => {
    const i = ++id; pend.set(i, res);
    ws.send(JSON.stringify({ id: i, method, params: params || {}, ...(sid ? { sessionId: sid } : {}) }));
  });
  const t = await send("Target.getTargets");
  const page = t.result.targetInfos.find((x) => x.type === "page");
  const { sessionId } = (await send("Target.attachToTarget", { targetId: page.targetId, flatten: true })).result;
  for (const d of ["Page", "Runtime"]) await send(`${d}.enable`, {}, sessionId);
  await send("Page.addScriptToEvaluateOnNewDocument", { source: "try{localStorage.setItem('lms-lang','zh')}catch(e){}" }, sessionId);
  const viewport = (w, h) => send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile: w < 768 }, sessionId);
  await viewport(1440, 900);

  const ev = async (expr) => {
    const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }, sessionId);
    if (r.result && r.result.exceptionDetails) {
      const x = r.result.exceptionDetails.exception;
      return { __threw: String((x && (x.description || x.value)) || "?").slice(0, 200) };
    }
    return r.result.result.value;
  };

  // 一个内容丰富、有表格的管理页；整文档加载，SPA 才认 fetch 登录的会话。
  await send("Page.navigate", { url: `${BASE}/next/?st=1#/login` }, sessionId);
  await sleep(2200);
  const status = await ev(`fetch('/api/auth/login',{method:'POST',credentials:'include',headers:{'Content-Type':'application/json'},body:${JSON.stringify(JSON.stringify(adminCreds()))}}).then(r=>r.status)`);
  if (status !== 200) console.log(`（管理员登录返回 ${status}，下面的用例多半都会失败）`);
  const openEmployees = async (n) => {
    await send("Page.navigate", { url: `${BASE}/next/?st=${n}#/admin/employees` }, sessionId);
    await sleep(3200);
  };
  await openEmployees(2);

  const results = [];
  const base = await ev(CHECKS);
  const baseKinds = ((base && base.findings) || []).map((f) => f.kind);
  // 基线只要求「下面要注入的那几类本来不在」—— 否则注入用例会白白通过。页面原有的其他 warn
  // （例如全新库里名册表格比滚动框宽的 table-overflow）照列出来，不算自检失败。
  const injected = CASES.map((c) => c.kind);
  results.push({ label: "基线（要注入的几类本来不在）", ok: !baseKinds.some((k) => injected.includes(k)), detail: baseKinds.join(",") || "无 finding",
    extra: `扫了 ${base && base.stats ? base.stats.chromeNodesScanned : "?"} 个界面节点` });

  for (const c of CASES) {
    // 注入 → 检查 → 撤回，一次求值内完成
    const out = await ev(`(() => {
      ${c.setup}
      const res = ${CHECKS};
      ${c.teardown}
      return (res.findings || []).map((f) => f.kind);
    })()`);
    const kinds = Array.isArray(out) ? out : [];
    results.push({ label: `注入 ${c.kind}`, ok: kinds.includes(c.kind), detail: kinds.join(",") || (out && out.__threw) || "无 finding" });
  }

  // 空白页单独验：真实页面清空会破坏 React，换一张空文档
  await send("Page.navigate", { url: "data:text/html,<body>ok</body>" }, sessionId);
  await sleep(400);
  const blank = await ev(CHECKS);
  const blankKinds = ((blank && blank.findings) || []).map((f) => f.kind);
  results.push({ label: "空白页", ok: blankKinds.includes("blank-page"), detail: blankKinds.join(",") || "无 finding" });

  // ---- 版面检查 ----
  await openEmployees(3);
  await ev("Promise.race([document.fonts ? document.fonts.ready.then(() => true) : true, new Promise((r) => setTimeout(r, 3000))])");
  const layoutBase = await ev(LAYOUT_SYNC);
  results.push({ label: "版面：真实页面能跑完", ok: !!(layoutBase && Array.isArray(layoutBase.findings)), detail: layoutBase && layoutBase.__threw ? layoutBase.__threw : `本页原有 ${(layoutBase && layoutBase.findings || []).length} 组版面 finding（不要求为 0）`,
    extra: layoutBase && layoutBase.stats ? `扫了 ${layoutBase.stats.layoutTextNodes} 个文字元素` : "" });
  for (const c of LAYOUT_CASES) {
    const out = await ev(layoutCaseExpr(c.html));
    const mine = Array.isArray(out) ? out.filter((f) => String(f.sig || "").includes(c.mark)) : [];
    results.push({ label: `版面注入 ${c.kind}${c.label ? `（${c.label}）` : ""}`, ok: mine.some((f) => f.kind === c.kind),
      detail: mine.map((f) => f.kind).join(",") || (out && out.__threw) || "没有命中注入的元素" });
  }
  const offDesk = await ev(OFFSCREEN_EXPR);
  const deskHit = Array.isArray(offDesk) ? offDesk.find((f) => f.kind === "text-offscreen" && String(f.sig).includes("st-os")) : null;
  results.push({ label: "版面注入 text-offscreen（1440 记 warn）", ok: !!deskHit && deskHit.severity === "warn", detail: deskHit ? deskHit.severity : ((offDesk && offDesk.__threw) || "没有命中") });
  await viewport(390, 844);
  await sleep(600);
  const offPhone = await ev(OFFSCREEN_EXPR);
  const phoneHit = Array.isArray(offPhone) ? offPhone.find((f) => f.kind === "text-offscreen" && String(f.sig).includes("st-os")) : null;
  results.push({ label: "版面注入 text-offscreen（390 记 fail）", ok: !!phoneHit && phoneHit.severity === "fail", detail: phoneHit ? phoneHit.severity : ((offPhone && offPhone.__threw) || "没有命中") });

  ws.close();
  await stopBrowser(child, profile);

  let bad = 0;
  for (const r of results) {
    if (!r.ok) bad++;
    console.log(`${r.ok ? " ok " : "FAIL"} ${r.label.padEnd(34)} ${r.detail}${r.extra ? "  · " + r.extra : ""}`);
  }
  console.log(bad ? `\n${bad} 项自检没通过 —— 对应的检查等于不存在，先修它再相信 smoke 的「干净」。` : `\n全部通过（${results.length} 项）：每条检查都能逮到它该逮的东西。`);
  process.exit(bad ? 1 : 0);
})().catch((e) => { console.error("自检脚本自己挂了:", e.stack || e.message); process.exit(2); });
