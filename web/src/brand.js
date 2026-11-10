// brand.js — consume the white-label brand block the server merges into
// GET /api/env (pre-auth login page) and GET /api/me (post-auth shells).
// Every field is optional. The unconfigured default is the GENERIC brand
// ("Talent Platform" / 「人才管理平台」 — no vendor marks): a new server with
// no brand configured sends the generic BRAND_DEFAULTS, and an old server
// sends no block at all — both must render the same generic look, so every
// read here falls back to the caller's existing copy (the per-file T
// dictionaries) or, for the logo slot, to a styled text wordmark
// (.brand-wordmark) instead of any bundled logo image.

// The server's default brand name (BRAND_DEFAULTS.name / name_zh). Used to
// fall back to when no brand block is known yet (tab title, wordmark) — e.g.
// against an old server that sends no brand block at all.
const DEFAULT_NAME = 'Talent Platform';
const DEFAULT_NAME_ZH = '人才管理平台';

// Per-language read of one brand field: zh prefers `<key>_zh`, then the
// base (English) value — so a single-language config still white-labels
// instead of leaking another brand's copy — then the caller's fallback (the
// generic T-dictionary value).
export function brandText(brand, key, lang, fallback) {
  if (!brand || typeof brand !== 'object') return fallback;
  const en = typeof brand[key] === 'string' && brand[key] ? brand[key] : '';
  const zh = typeof brand[key + '_zh'] === 'string' && brand[key + '_zh'] ? brand[key + '_zh'] : '';
  return (lang === 'zh' ? (zh || en) : en) || fallback;
}

// The configured logo URL, or '' — no logo configured means the brand slots
// render the text wordmark below, so the generic bundle ships no logo asset.
export function brandLogo(brand) {
  return brand && typeof brand.logo === 'string' && brand.logo ? brand.logo : '';
}

// 浅底版 logo（给白色背景画的，如深色字）；没有上传时为 ''，不回落深底版（深底版放在白底上通常看不见）
export function brandLogoLight(brand) {
  return brand && typeof brand.logoLight === 'string' && brand.logoLight ? brand.logoLight : '';
}

// 顶栏品牌区是否直接放在白色栏上（不要深色药丸底）：配了浅底专用的 logoLight、且没有在 colors 里明确设置
// --brand-chip 时为真。logoLight 按定义是为浅底画的（如 DigiPlus 的深色字 logo），放在默认的深色药丸上会看不见；
// 明确配置了药丸底色的品牌仍按配置显示。品牌设置页的预览用同一判定。
// CX-081（10/11）：品牌颜色里把药丸底设成透明（「透明融入」）时，品牌区直接坐在白底上 —— 同样按浅底处理（深底版白字会看不见）
export function brandChipTransparent(brand) {
  const chip = brand && brand.colors && typeof brand.colors === 'object' ? brand.colors['--brand-chip'] : '';
  return typeof chip === 'string' && /^\s*transparent\s*$/i.test(chip);
}
export function brandChipOnLight(brand) {
  if (brandChipTransparent(brand)) return true;
  if (!brand || typeof brand.logoLight !== 'string' || !brand.logoLight) return false;
  const chip = brand.colors && typeof brand.colors === 'object' ? brand.colors['--brand-chip'] : '';
  return !(typeof chip === 'string' && chip);
}

// Text to render in a brand slot when no logo image is configured (logo:null
// is the generic default): the brand name in the current language. Callers
// wrap it in <span className="brand-wordmark">.
export function brandWordmark(brand, lang) {
  return brandText(brand, 'name', lang, lang === 'zh' ? DEFAULT_NAME_ZH : DEFAULT_NAME);
}

// Tab title follows the interface language, like every other piece of chrome.
// It used to be written once (brand.name, English) by applyBrand and never
// again, so a language toggle left the tab on the other language — and the
// unbranded default stayed on index.html's 「人才管理平台」 in the English UI.
// Now: the last brand block applyBrand saw + the current language (pushed by
// I18nProvider on every change) → brandWordmark(), i.e. name_zh / name with
// the generic default as fallback. Chinese UI + unbranded default is still
// 「人才管理平台」, identical to index.html.
let titleBrand = null;
let titleLang = null;
export function setTitleLang(lang) {
  titleLang = lang === 'zh' ? 'zh' : 'en';
  syncTitle();
}
function syncTitle() {
  if (!titleLang || typeof document === 'undefined') return;
  const name = brandWordmark(titleBrand, titleLang);
  if (name && document.title !== name) document.title = name;
}

// Optional login-page legal links (brand.legal: { privacyUrl, termsUrl }).
// The server already drops anything that is not an http(s) URL or a
// site-relative path and omits the key when nothing valid is configured;
// the same shape check is repeated here as a second belt. Returns null when
// there is nothing to show — the caller then renders no element at all.
function legalUrl(v) {
  if (typeof v !== 'string') return '';
  const u = v.trim();
  if (!u || /[\s\\<>"'`]/.test(u)) return '';
  return /^https?:\/\/[^/]/i.test(u) || (u[0] === '/' && u[1] !== '/') ? u : '';
}
export function brandLegal(brand) {
  const l = brand && typeof brand === 'object' ? brand.legal : null;
  if (!l || typeof l !== 'object') return null;
  const privacyUrl = legalUrl(l.privacyUrl);
  const termsUrl = legalUrl(l.termsUrl);
  return privacyUrl || termsUrl ? { privacyUrl, termsUrl } : null;
}

// Side effects shared by both surfaces (Login applies /api/env's block, App
// applies /api/me's once a session exists): CSS variable overrides, the tab
// title and the favicon. The server already sanitized `colors` (keys
// ^--[a-z][a-z0-9-]*$, values in safe color forms only); the same shape check
// is repeated here as a second belt, never as the primary defense.
export function applyBrand(brand) {
  if (!brand || typeof brand !== 'object') return;
  if (brand.colors && typeof brand.colors === 'object') {
    for (const k of Object.keys(brand.colors)) {
      const v = brand.colors[k];
      if (/^--[a-z][a-z0-9-]*$/.test(k) && typeof v === 'string' && v && !/[;{}]|url\s*\(/i.test(v)) {
        document.documentElement.style.setProperty(k, v);
      }
    }
  }
  // Tab title: remembered here and rendered per language by syncTitle().
  titleBrand = brand;
  syncTitle();
  // Favicon: a configured brand.favicon wins outright; otherwise a configured
  // logo doubles as the tab icon, but only when it is a path a favicon can
  // actually use (.svg/.png). Neither → index.html's built-in generic
  // geometric mark stays.
  const fav = (typeof brand.favicon === 'string' && brand.favicon)
    ? brand.favicon
    : (typeof brand.logo === 'string' && /\.(svg|png)([?#].*)?$/i.test(brand.logo) ? brand.logo : '');
  if (fav) {
    const link = document.querySelector('link[rel="icon"]');
    if (link) link.setAttribute('href', fav);
  }
}
