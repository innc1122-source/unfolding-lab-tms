// 登录回跳与整页链接的站内路径白名单（modules/culture/CONTRACT.md 9.5）。
//
// 模块自带的页面（例如行为实践的学员端 /culture/）由服务端静态挂载，不在本 SPA 的 HashRouter 路由里：
// 去那里只能整页跳转（location.assign），不能 nav()。登录页的 next、通知铃的整页链接都先过这里。
//
// 规则与服务端 kernel/module-host.js 的 pageLink（pageLinkIn + 开启中的挂载）逐条一致（服务端是最终裁决：密码登录应答里的
// next、Lark 回跳、通知的 fullPage 都由它核过；这里是前端的第二道闸，挡住手改地址栏带进来的 next）：
//   · 字符串，1–512 个字符，只含可打印 ASCII（0x21–0x7e），不含反斜杠与百分号（浏览器会把 %2e%2e 当成 ..）；
//   · 以 "/" 开头且不含 "//"（协议相对地址）；
//   · 路径部分（? 与 # 之前）不含 "." 与 ".." 段；
//   · modulePage 另要求路径落在某个**开启中的**模块的页面前缀之下（前缀 + "/"，区分大小写）。
// 模块开关（2026-09-28 负责人拍板）：模块关闭时服务端的挂载回 404、不再接受指向它的 next（落回 TMS 首页），前端同口径 ——
// 调用方传入 /api/env（登录页，登录之前）或 /api/me（登录之后）的 modules 块，只有 modules[<模块>] === true 才算开启。
// 服务端对每个可售模块都给布尔值；老服务端没有这个键（那时还没有这个模块）、或没有传 modules，一律读成关闭。
// 服务端的前缀与模块来自各模块 manifest 的 static（注册表 STATIC_MOUNTS 的 prefix / module）；前端没有注册表，写在下面。
// 新模块挂了自己的页面时，在 MODULE_PAGES 里加一项（test/culture-web.test.js 核对两边一致）。
export const MODULE_PAGES = Object.freeze([
  Object.freeze({ prefix: '/culture', module: 'culture' }),
]);
export const MODULE_PAGE_PREFIXES = Object.freeze(MODULE_PAGES.map((m) => m.prefix));

/** 通用的站内相对路径判定（不看前缀）。合格返回原串，否则 null。 */
export function sitePath(v) {
  if (typeof v !== 'string' || v.length === 0 || v.length > 512) return null;
  if (!/^[\x21-\x7e]+$/.test(v) || /[\\%]/.test(v)) return null;
  if (v.charAt(0) !== '/' || v.indexOf('//') >= 0) return null;
  const cut = v.search(/[?#]/);
  const p = cut < 0 ? v : v.slice(0, cut);
  if (p.split('/').some((s) => s === '.' || s === '..')) return null;
  return v;
}

// 站内相对路径（已过 sitePath）落在哪个模块页面前缀之下；不在任何前缀之下为 null。
function pageOf(ok) {
  const cut = ok.search(/[?#]/);
  const p = cut < 0 ? ok : ok.slice(0, cut);
  return MODULE_PAGES.find((m) => p.startsWith(m.prefix + '/')) || null;
}

/** 模块是否开启：只认 modules[id] === true（/api/env 或 /api/me 的 modules 块）。 */
export function moduleOn(modules, id) {
  return !!(modules && typeof modules === 'object' && modules[id] === true);
}

/**
 * 模块页面（整页跳转目标）判定：站内相对路径，且落在某个开启中的模块的页面前缀之下。合格返回原串，否则 null。
 * modules：/api/env 或 /api/me 的 modules 块；不传即没有模块开启。
 */
export function modulePage(v, modules) {
  const ok = sitePath(v);
  if (!ok) return null;
  const m = pageOf(ok);
  return m && moduleOn(modules, m.module) ? ok : null;
}

/** 站内相对路径是否落在某个模块页面前缀之下（不看开关）：通知铃据此把指向已关闭模块页面的旧链接送回首页。 */
export function isModulePath(v) {
  const ok = sitePath(v);
  return !!(ok && pageOf(ok));
}

/** 从 HashRouter 的查询串（useLocation().search，形如 "?next=%2Fculture%2F"）里取合格的 next；没有、不合格或模块未开启为 null。 */
export function nextFromSearch(search, modules) {
  let raw = null;
  try { raw = new URLSearchParams(search || '').get('next'); } catch (e) { raw = null; }
  return modulePage(raw, modules);
}
