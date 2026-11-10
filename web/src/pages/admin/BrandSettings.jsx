// Brand settings 品牌设置 — the white-label console page. Customers upload
// their own logo/favicon, rewrite the login-page copy and recolor the core
// CSS tokens without touching config.json by hand. Everything here rides the
// brand-config API pair:
//   GET  /api/admin/brand-config  → { brand: merged effective, configured: raw }
//   PUT  /api/admin/brand-config  → the brand block to write (server sanitizes,
//                                    audits as brand.update, config is live-read
//                                    so a save takes effect immediately)
//   POST /api/admin/brand-assets?slot=logo|logoLight|favicon → { url }
// Form state mirrors `configured` (what is actually written); placeholders show
// the merged effective value, so an empty box always reads as "use the default".
// The preview panel is pure local state — it never sends a request.
import { useEffect, useRef, useState } from 'react';
import {
  Button, Input, TextArea, Toast, Banner, Spin, RadioGroup, Radio,
} from '@douyinfe/semi-ui';
import { IconUpload, IconDelete } from '@douyinfe/semi-icons';
import { api, useAsync } from '../../api.js';
import { useAuth } from '../../auth.jsx';
import { useI18n } from '../../i18n.jsx';
import { SettingsWorkspace } from '../../v2.jsx';
import { applyBrand } from '../../brand.js';
import { canWriteDomain } from '../../rbac.js';

const T = {
  zh: {
    title: '品牌设置',
    lead: '登录页文案、logo、favicon 与界面配色都在这里自定义——保存立即生效，改动写入审计日志。留空 = 用产品默认。',
    secText: '登录页文案', secTextLead: '每项中英成对，输入框留空 = 用默认文案（灰色提示即当前生效值）。',
    labels: {
      tagline: '标语（登录页大标题）', heroLine: '副标题', welcome: '登录框标题',
      subtitle: '登录框副题', footer: '页脚', pillA: '登录页标签一', pillB: '登录页标签二',
      brandSub: 'Logo 旁小字', console: '后台名', name: '品牌名（页签与文字字标）',
    },
    zhPh: '中文', enPh: 'English',
    secAssets: '品牌资产', secAssetsLead: '支持 PNG / JPG / SVG，单个文件不超过 512KB。不配 logo 时用品牌名渲染文字字标。',
    slots: { logo: 'Logo（深底版）', logoLight: 'Logo（浅底版）', favicon: 'Favicon（页签图标）' },
    logoLightHint: '深底版（浅色字）用在桌面左侧栏顶部和登录页；浅底版（深色字）用在手机顶栏和重置密码页这些白底处。上传了浅底版、且品牌颜色里没有指定药丸底色时，白底处直接显示浅底版；没有浅底版时，白底处仍用深色药丸底衬托深底版。',
    upload: '上传', clear: '清除', noAsset: '未设置 · 用默认',
    uploadOk: '已上传', tooLarge: '文件超过 512KB 上限', uploadFail: '上传失败',
    secColors: '界面配色', secColorsLead: '六个核心颜色变量决定全站主色；更细的变量可在下方高级区直接编辑完整的 colors 表。',
    tokens: {
      '--brand': '主色', '--brand-hover': '主色 · 悬停', '--brand-active': '主色 · 按下',
      '--gold': '点缀色', '--navy': '深底色', '--surface': '页面底色',
    },
    reset: '恢复默认',
    chipTitle: '顶栏品牌底', chipNavy: '默认深色底', chipTrans: '透明融入', chipCustom: '自定义色',
    chipHint: '顶栏 logo 背后那块底色。透明融入 = 与白色顶栏一色，文字改用品牌色；自定义深色底沿用白字。',
    advOpen: '高级：直接编辑完整 colors 表（JSON）', advClose: '收起高级区',
    jsonBad: 'JSON 无法解析，改动未应用', jsonHint: '键须形如 --xxx，值只收 #hex、rgb()/hsl()、颜色名；非法项服务端会直接丢弃。',
    secPreview: '预览', secPreviewLead: '输入即时反映（仅本页缩样），点保存才对全站生效。',
    pvLogin: '登录页', pvBar: '顶栏', pvSignIn: '登录', pvNavA: '工作台', pvNavB: '员工档案',
    save: '保存', saved: '已保存，立即生效', loadFail: '加载失败，请刷新页面重试。',
    /* 只读档(brand=read):PUT /brand-config 与 POST /brand-assets 在服务端都会
       吃 403,所以编辑控件一律禁用而不是留着骗人点。 */
    readOnly: '你的角色对品牌设置是只读权限 —— 可以查看当前配置，但不能上传资产、改配色或保存。需要修改请找超级管理员。',
  },
  en: {
    title: 'Brand settings',
    lead: 'Login-page copy, logo, favicon and UI colors are customized here — saving takes effect immediately and is written to the audit log. Empty = product default.',
    secText: 'Login page copy', secTextLead: 'Each item is a zh/en pair; an empty box means the default copy (the grey hint shows the current effective value).',
    labels: {
      tagline: 'Tagline (login hero title)', heroLine: 'Hero line', welcome: 'Sign-in title',
      subtitle: 'Sign-in subtitle', footer: 'Footer', pillA: 'Login Badge 1', pillB: 'Login Badge 2',
      brandSub: 'Logo sub-label', console: 'Console name', name: 'Brand name (tab title & wordmark)',
    },
    zhPh: '中文', enPh: 'English',
    secAssets: 'Brand assets', secAssetsLead: 'PNG / JPG / SVG, max 512KB per file. Without a logo the brand name renders as a text wordmark.',
    slots: { logo: 'Logo (for dark backgrounds)', logoLight: 'Logo (for light backgrounds)', favicon: 'Favicon (tab icon)' },
    logoLightHint: 'The dark-background logo (pale glyphs) is used at the top of the desktop sidebar and on the sign-in page; the light-background logo (dark glyphs) is used on white surfaces such as the phone top bar and the password reset page. When a light-background logo is uploaded and no brand chip colour is set, white surfaces show it directly; without one, white surfaces keep the dark chip behind the dark-background logo.',
    upload: 'Upload', clear: 'Clear', noAsset: 'Not set · default',
    uploadOk: 'Uploaded', tooLarge: 'File exceeds the 512KB limit', uploadFail: 'Upload failed',
    secColors: 'UI colors', secColorsLead: 'Six core color variables set the main colors across the app; finer variables can be edited in the advanced JSON editor below.',
    tokens: {
      '--brand': 'Primary', '--brand-hover': 'Primary · hover', '--brand-active': 'Primary · active',
      '--gold': 'Accent', '--navy': 'Dark base', '--surface': 'Page background',
    },
    reset: 'Reset to default',
    chipTitle: 'Top-bar brand chip', chipNavy: 'Default dark background', chipTrans: 'Blend in (transparent)', chipCustom: 'Custom color',
    chipHint: 'The backing behind the top-bar logo. Blend in = same color as the white bar, text switches to the brand color; a custom dark chip keeps white text.',
    advOpen: 'Advanced: edit the full colors table (JSON)', advClose: 'Hide advanced',
    jsonBad: 'Invalid JSON — changes not applied', jsonHint: 'Keys must look like --xxx; values accept #hex, rgb()/hsl() or color keywords. Anything else is dropped server-side.',
    secPreview: 'Preview', secPreviewLead: 'Reflects your edits instantly (this page only) — Save applies them app-wide.',
    pvLogin: 'Login page', pvBar: 'Top bar', pvSignIn: 'Sign in', pvNavA: 'Dashboard', pvNavB: 'Employee Profiles',
    save: 'Save', saved: 'Saved — live now', loadFail: 'Couldn’t load. Refresh the page to try again.',
    readOnly: 'Your role has read-only access to brand settings — you can review the current configuration, but not upload assets, recolor the UI or save. Ask a super-admin to make changes.',
  },
};

// Section order mirrors the login page top-to-bottom, then the chrome bits.
const TEXT_KEYS = ['tagline', 'heroLine', 'welcome', 'subtitle', 'footer', 'pillA', 'pillB', 'brandSub', 'console', 'name'];
const ASSET_SLOTS = ['logo', 'logoLight', 'favicon'];
// Stock values of the six core tokens (mirror web/src/app.css :root). Needed
// because GET's merged brand only carries CONFIGURED colors — the un-overridden
// default lives in the stylesheet, and the pickers/preview still have to show it.
const STOCK = {
  '--brand': '#23304a', '--brand-hover': '#33466b', '--brand-active': '#172236',
  '--gold': '#eab048', '--navy': '#1b2438', '--surface': '#f2f4f8',
};
const CORE_TOKENS = Object.keys(STOCK);
const HEX6 = /^#[0-9a-fA-F]{6}$/;

export default function BrandSettings() {
  const { lang } = useI18n();
  const s = T[lang];
  /* 「只读档全站生效」的本页那一份。这一页整页都在 brand 域里:GET 只需 >=read
     (能进这一页就已经过了),但 PUT /api/admin/brand-config 与 POST
     /api/admin/brand-assets 都是 brand 写 —— read 档发过去必然 403。所以写控件
     统一走禁用态 + 一行说明,而不是留着让人点了才知道。
     老服务(/api/me 无 grants)与超管 → canWriteDomain 为 true,与改动前完全一致。 */
  const { user } = useAuth();
  const canEdit = canWriteDomain(user, 'brand');
  const q = useAsync(() => api.get('/api/admin/brand-config'), []);

  // Draft = what will be written into config.brand. null until the GET lands.
  const [texts, setTexts] = useState(null); // { tagline, tagline_zh, … } all strings
  const [assets, setAssets] = useState({ logo: '', logoLight: '', favicon: '' });
  const [colors, setColors] = useState({}); // only explicitly configured keys
  const [jsonText, setJsonText] = useState(null); // null = advanced area closed
  const [jsonErr, setJsonErr] = useState('');
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(''); // slot mid-upload
  const fileRefs = { logo: useRef(null), logoLight: useRef(null), favicon: useRef(null) };

  // (Re)seed the drafts from the server's raw `configured` block — on first
  // load and after every save-triggered reload, so the form always shows the
  // sanitized round-trip rather than whatever was typed.
  useEffect(() => {
    if (!q.data) return;
    const cfg = q.data.configured && typeof q.data.configured === 'object' && !Array.isArray(q.data.configured) ? q.data.configured : {};
    const t = {};
    for (const k of TEXT_KEYS) {
      t[k] = typeof cfg[k] === 'string' ? cfg[k] : '';
      t[k + '_zh'] = typeof cfg[k + '_zh'] === 'string' ? cfg[k + '_zh'] : '';
    }
    setTexts(t);
    setAssets({
      logo: typeof cfg.logo === 'string' ? cfg.logo : '',
      logoLight: typeof cfg.logoLight === 'string' ? cfg.logoLight : '',
      favicon: typeof cfg.favicon === 'string' ? cfg.favicon : '',
    });
    const c = cfg.colors && typeof cfg.colors === 'object' && !Array.isArray(cfg.colors) ? { ...cfg.colors } : {};
    setColors(c);
    setJsonText((open) => (open == null ? null : JSON.stringify(c, null, 2)));
    setJsonErr('');
  }, [q.data]);

  if (q.error) return <div className="wrap tset-wrap"><Banner type="danger" closeIcon={null} description={`${s.loadFail} · ${q.error.message}`} /></div>;
  if (!q.data || !texts) return <div className="wrap tset-wrap" style={{ textAlign: 'center', paddingTop: 80 }}><Spin size="large" /></div>;

  const eff = q.data.brand && typeof q.data.brand === 'object' ? q.data.brand : {};
  // Effective text in the CURRENT language — the preview's fallback when the
  // draft box is empty (same zh→en preference brandText() uses at render time).
  const effText = (key) => {
    const en = typeof eff[key] === 'string' ? eff[key] : '';
    const zh = typeof eff[key + '_zh'] === 'string' ? eff[key + '_zh'] : '';
    return (lang === 'zh' ? (zh || en) : en) || '';
  };

  /* ---------- colors ---------- */
  const tokenVal = (k) => colors[k] || STOCK[k] || '#000000';
  // <input type="color"> only speaks #rrggbb; a keyword/rgb() override still
  // previews correctly, the picker just opens on the stock hex instead.
  const pickerVal = (k) => (HEX6.test(tokenVal(k)) ? tokenVal(k) : (STOCK[k] || '#000000'));
  const updateColors = (next) => {
    setColors(next);
    // Keep the advanced JSON in step when it is open and the change came from
    // a picker (typing in the textarea itself goes through onJson instead, so
    // the cursor never jumps).
    if (jsonText != null) { setJsonText(JSON.stringify(next, null, 2)); setJsonErr(''); }
  };
  const setToken = (k, v) => updateColors({ ...colors, [k]: v });
  const clearToken = (k) => { const next = { ...colors }; delete next[k]; updateColors(next); };

  // Top-bar brand chip: the three --brand-chip* variables as one 3-way choice.
  // Mode is DERIVED from the colors map (no second source of truth), so a JSON
  // edit in the advanced area moves the radio automatically.
  const chip = typeof colors['--brand-chip'] === 'string' ? colors['--brand-chip'] : '';
  const chipMode = !chip ? 'navy' : (chip === 'transparent' ? 'trans' : 'custom');
  const setChipMode = (mode) => {
    const next = { ...colors };
    if (mode === 'navy') {
      delete next['--brand-chip']; delete next['--brand-chip-sub']; delete next['--brand-chip-ink'];
    } else if (mode === 'trans') {
      // Blending into the white bar drops the text onto a light surface — use
      // the brand color for legibility (same move as the UL preset).
      const ink = HEX6.test(tokenVal('--brand')) ? tokenVal('--brand') : STOCK['--brand'];
      next['--brand-chip'] = 'transparent'; next['--brand-chip-sub'] = ink; next['--brand-chip-ink'] = ink;
    } else {
      next['--brand-chip'] = HEX6.test(chip) ? chip : tokenVal('--navy');
      next['--brand-chip-sub'] = 'rgba(255,255,255,0.65)'; next['--brand-chip-ink'] = '#ffffff';
    }
    updateColors(next);
  };

  const onJson = (v) => {
    setJsonText(v);
    try {
      const o = JSON.parse(v);
      if (!o || typeof o !== 'object' || Array.isArray(o)) throw new Error('not an object');
      const next = {};
      for (const k of Object.keys(o)) { if (typeof o[k] === 'string') next[k] = o[k]; }
      setColors(next);
      setJsonErr('');
    } catch { setJsonErr(s.jsonBad); }
  };

  /* ---------- assets ---------- */
  const pickFile = (slot) => { const r = fileRefs[slot]; if (r && r.current) r.current.click(); };
  const onFile = async (slot, e) => {
    const f = e.target.files && e.target.files[0];
    e.target.value = ''; // so re-picking the same file fires change again
    if (!f) return;
    if (f.size > 512 * 1024) { Toast.error(s.tooLarge); return; }
    setUploading(slot);
    try {
      // Raw body, filename never sent — the server names the file from the slot
      // (same raw-upload pattern as /api/admin/upload-video) and type-checks by
      // content, so nothing client-side is trusted.
      const r = await api.upload('/api/admin/brand-assets?slot=' + encodeURIComponent(slot), f);
      if (r && typeof r.url === 'string' && r.url) {
        setAssets((a) => ({ ...a, [slot]: r.url }));
        Toast.success(s.uploadOk);
      } else { Toast.error(s.uploadFail); }
    } catch (err) { Toast.error(err.message || s.uploadFail); }
    setUploading('');
  };

  /* ---------- save ---------- */
  const save = async () => {
    // Only explicitly set values are written; empty boxes stay out of the
    // config so they keep tracking the product default.
    const brand = {};
    for (const k of Object.keys(texts)) { const v = String(texts[k] || '').trim(); if (v) brand[k] = v; }
    for (const slot of ASSET_SLOTS) { if (assets[slot]) brand[slot] = assets[slot]; }
    if (Object.keys(colors).length) brand.colors = colors;
    // brand.legal (login-page legal links) has no editor on this page yet —
    // it is configured in config.json. PUT replaces the whole brand block, so
    // carry the configured value through untouched or a save would wipe it.
    const cfgLegal = q.data && q.data.configured && q.data.configured.legal;
    if (cfgLegal && typeof cfgLegal === 'object' && !Array.isArray(cfgLegal)) brand.legal = cfgLegal;
    setSaving(true);
    try {
      await api.put('/api/admin/brand-config', brand);
      // Re-GET rather than trusting local state: what applies to the live page
      // must be the server-sanitized effective block, identical to what /api/env
      // and /api/me will serve from now on.
      const fresh = await api.get('/api/admin/brand-config');
      // applyBrand only overrides, never un-sets — clear the previous round's
      // inline variables first so a removed color actually falls back to the
      // stylesheet. applyBrand is the only writer of inline custom properties
      // on <html>, so sweeping all of them is safe.
      const st = document.documentElement.style;
      for (let i = st.length - 1; i >= 0; i--) { const p = st[i]; if (p && p.indexOf('--') === 0) st.removeProperty(p); }
      if (fresh && fresh.brand) applyBrand(fresh.brand);
      Toast.success(s.saved);
      q.reload(); // placeholders and drafts re-seed from the sanitized config
    } catch (err) { Toast.error(err.message); }
    setSaving(false);
  };

  /* ---------- preview (local state only, no requests) ---------- */
  const pv = (key) => {
    const zh = texts[key + '_zh'] || '';
    const en = texts[key] || '';
    return (lang === 'zh' ? (zh || en) : (en || zh)) || effText(key);
  };
  const pvLogo = assets.logo || '';
  const pvLogoLight = assets.logoLight || assets.logo || '';
  // 与 brand.js brandChipOnLight 同一判定：没有明确配置药丸底色、又上传了浅底 logo 时，顶栏品牌区直接放在白底上
  // CX-081：「透明融入」时品牌区坐在白底上，与浅底版同一判定（brand.js brandChipOnLight）
  const onLight = (chipMode === 'navy' && !!assets.logoLight) || chipMode === 'trans';
  const pvImg = chipMode === 'trans' ? (assets.logoLight || '') : pvLogoLight;   // 透明时只用浅底版；没有就显示深色文字
  const chipBg = onLight ? 'transparent' : chipMode === 'navy' ? tokenVal('--navy') : (chipMode === 'trans' ? 'transparent' : chip);
  const chipInk = onLight ? 'var(--ink)' : chipMode === 'navy' ? '#fff' : (colors['--brand-chip-ink'] || '#fff');
  const chipSub = onLight ? 'var(--ink-2)' : chipMode === 'navy' ? 'rgba(255,255,255,.6)' : (colors['--brand-chip-sub'] || 'rgba(255,255,255,.6)');

  /* ---------- layout helpers (inline — app.css is out of scope here) ---------- */
  const ROW = { display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', marginBottom: 8 };
  const LBL = { flex: '0 0 190px', fontSize: 13, color: 'var(--ink-2)', fontWeight: 500 };
  const BOX = { flex: '1 1 200px', minWidth: 160 };

  const saveBtn = (
    <Button theme="solid" type="primary" loading={saving} disabled={!canEdit}
      title={canEdit ? undefined : s.readOnly} onClick={save}>{s.save}</Button>
  );

  return (
    // `brandset-wrap` is deliberately ONLY on the loaded branch (the Spin/error
    // guards above return a plain `wrap tset-wrap`), so it marks "the config
    // arrived and the form rendered" — the smoke manifest keys on it.
    <div className="wrap tset-wrap brandset-wrap">
      <div className="tset-head">
        <div><h1 className="tset-title">{s.title}</h1><div className="tset-lead">{s.lead}</div></div>
        {/* 验收修正（2026-10-06）：保存按钮只保留面板底部一处（SettingsWorkspace footer），页头不再重复放一个 */}
      </div>

      {/* 只读档:说一句为什么所有编辑控件都是灰的，而不是让人以为页面坏了。 */}
      {!canEdit && <Banner type="info" closeIcon={null} description={s.readOnly} style={{ marginBottom: 12 }} />}

      {/* Layout v2：四个分节改成左页签右面板，保存按钮落在面板底部（SettingsWorkspace footer） */}
      <SettingsWorkspace footer={<div className="v2-settings-save">{saveBtn}</div>}>
      {/* ---- login page copy ---- */}
      <div className="ppl-card" data-section={s.secText}>
        <div className="ppl-sec-h"><div><h2>{s.secText}</h2><div className="tset-lead">{s.secTextLead}</div></div></div>
        {TEXT_KEYS.map((k) => (
          <div key={k} style={ROW}>
            <span style={LBL}>{s.labels[k]}</span>
            {/* `lang-pair`: 中英成对编辑器，两个框各自展示自己语言的生效文案 ——
                和登录页的 lang-toggle 一样，是「串语言」冒烟检查的正当例外
                （scripts/smoke-checks.js 按这个类跳过）。 */}
            <span className="lang-pair" style={BOX}>
              <Input value={texts[k + '_zh']} placeholder={eff[k + '_zh'] || s.zhPh}
                aria-label={`${s.labels[k]} · ${s.zhPh}`} disabled={!canEdit}
                onChange={(v) => setTexts({ ...texts, [k + '_zh']: v })} />
            </span>
            <span className="lang-pair" style={BOX}>
              <Input value={texts[k]} placeholder={eff[k] || s.enPh}
                aria-label={`${s.labels[k]} · ${s.enPh}`} disabled={!canEdit}
                onChange={(v) => setTexts({ ...texts, [k]: v })} />
            </span>
          </div>
        ))}
      </div>

      {/* ---- brand assets ---- */}
      <div className="ppl-card" data-section={s.secAssets}>
        <div className="ppl-sec-h"><div><h2>{s.secAssets}</h2><div className="tset-lead">{s.secAssetsLead}</div></div></div>
        {ASSET_SLOTS.map((slot) => (
          <div key={slot} style={ROW}>
            <span style={LBL}>{s.slots[slot]}</span>
            {/* logo is usually drawn for dark surfaces → preview it on navy;
                logoLight/favicon live on white chrome → preview on white. */}
            <span style={{
              flex: '0 0 auto', display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              minWidth: 120, height: 44, padding: '0 12px', borderRadius: 8, border: '1px solid var(--line)',
              background: slot === 'logo' ? tokenVal('--navy') : '#fff',
            }}>
              {assets[slot]
                ? <img src={assets[slot]} alt={s.slots[slot]} style={{ maxHeight: slot === 'favicon' ? 20 : 28, maxWidth: 160, display: 'block' }} />
                : <span style={{ fontSize: 12, color: slot === 'logo' ? 'rgba(255,255,255,.55)' : 'var(--ink-3)' }}>{s.noAsset}</span>}
            </span>
            <input ref={fileRefs[slot]} type="file" accept=".png,.jpg,.jpeg,.svg" style={{ display: 'none' }}
              onChange={(e) => onFile(slot, e)} />
            {/* POST /api/admin/brand-assets 是 brand 写 —— 只读档禁用,免得上传成功
                却在保存那一步吃 403(资产 URL 只有 PUT brand-config 才落库)。 */}
            <Button size="small" theme="light" icon={<IconUpload />} loading={uploading === slot}
              disabled={!canEdit} title={canEdit ? undefined : s.readOnly}
              onClick={() => pickFile(slot)}>{s.upload}</Button>
            {assets[slot] && canEdit && (
              <Button size="small" theme="borderless" type="danger" icon={<IconDelete />}
                onClick={() => setAssets((a) => ({ ...a, [slot]: '' }))}>{s.clear}</Button>
            )}
            {assets[slot] && <span className="tnum" style={{ fontSize: 12, color: 'var(--ink-3)', wordBreak: 'break-all' }}>{assets[slot]}</span>}
          </div>
        ))}
        <div className="tset-renamehint">{s.logoLightHint}</div>
      </div>

      {/* ---- colors ---- */}
      <div className="ppl-card" data-section={s.secColors}>
        <div className="ppl-sec-h"><div><h2>{s.secColors}</h2><div className="tset-lead">{s.secColorsLead}</div></div></div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px 22px' }}>
          {CORE_TOKENS.map((k) => (
            <div key={k} style={{ display: 'flex', alignItems: 'center', gap: 8, flex: '0 0 auto', marginBottom: 4 }}>
              <input type="color" className="tset-color" value={pickerVal(k)} disabled={!canEdit}
                aria-label={s.tokens[k]} onChange={(e) => setToken(k, e.target.value)} />
              <span style={{ fontSize: 13, color: 'var(--ink)' }}>{s.tokens[k]}</span>
              <span className="tnum" style={{ fontSize: 12, color: 'var(--ink-3)' }}>{tokenVal(k)}</span>
              {colors[k] != null && canEdit && (
                <Button size="small" theme="borderless" onClick={() => clearToken(k)} aria-label={`${s.tokens[k]} · ${s.reset}`}>{s.reset}</Button>
              )}
            </div>
          ))}
        </div>

        <div style={{ marginTop: 14 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--ink)', marginBottom: 6 }}>{s.chipTitle}</div>
          <RadioGroup type="button" value={chipMode} disabled={!canEdit} onChange={(e) => setChipMode(e.target.value)}>
            <Radio value="navy">{s.chipNavy}</Radio>
            <Radio value="trans">{s.chipTrans}</Radio>
            <Radio value="custom">{s.chipCustom}</Radio>
          </RadioGroup>
          {chipMode === 'custom' && (
            <input type="color" className="tset-color" style={{ marginLeft: 10, verticalAlign: 'middle' }}
              value={HEX6.test(chip) ? chip : pickerVal('--navy')} disabled={!canEdit}
              aria-label={s.chipCustom}
              onChange={(e) => updateColors({
                ...colors,
                '--brand-chip': e.target.value,
                '--brand-chip-sub': colors['--brand-chip-sub'] || 'rgba(255,255,255,0.65)',
                '--brand-chip-ink': colors['--brand-chip-ink'] || '#ffffff',
              })} />
          )}
          <div className="tset-renamehint">{s.chipHint}</div>
        </div>

        <div style={{ marginTop: 14 }}>
          <Button theme="borderless" size="small"
            onClick={() => { setJsonErr(''); setJsonText(jsonText == null ? JSON.stringify(colors, null, 2) : null); }}>
            {jsonText == null ? s.advOpen : s.advClose}
          </Button>
          {jsonText != null && (
            <div style={{ marginTop: 8 }}>
              {/* 只读档仍能展开看完整 colors 表(纯前端展开,不发请求),只是不能改。 */}
              <TextArea value={jsonText} onChange={onJson} rows={8} disabled={!canEdit}
                style={{ fontFamily: 'ui-monospace, Consolas, monospace', fontSize: 12.5 }} />
              <div className="tset-renamehint">{s.jsonHint}</div>
              {jsonErr && <Banner type="warning" closeIcon={null} description={jsonErr} style={{ marginTop: 6 }} />}
            </div>
          )}
        </div>
      </div>

      {/* ---- live preview (local only) ---- */}
      <div className="ppl-card" data-section={s.secPreview}>
        <div className="ppl-sec-h"><div><h2>{s.secPreview}</h2><div className="tset-lead">{s.secPreviewLead}</div></div></div>
        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'flex-start', background: tokenVal('--surface'), borderRadius: 10, padding: 14 }}>

          {/* login hero + form miniature */}
          <div style={{ flex: '1 1 300px', maxWidth: 430 }}>
            <div style={{ fontSize: 12, color: 'var(--ink-3)', marginBottom: 6 }}>{s.pvLogin}</div>
            <div style={{ borderRadius: 10, overflow: 'hidden', border: '1px solid var(--line)', boxShadow: 'var(--shadow-1)' }}>
              <div style={{
                position: 'relative', padding: '24px 22px', color: '#fff', overflow: 'hidden',
                background: `linear-gradient(150deg, ${tokenVal('--navy')} 0%, ${tokenVal('--brand-active')} 58%, ${tokenVal('--brand-hover')} 115%)`,
              }}>
                {pvLogo
                  ? <img src={pvLogo} alt="" style={{ height: 26, display: 'block', marginBottom: 10, position: 'relative', zIndex: 1 }} />
                  : <div style={{ fontWeight: 800, fontSize: 17, letterSpacing: '.5px', marginBottom: 10, position: 'relative', zIndex: 1 }}>{pv('name')}</div>}
                <div style={{ fontSize: 15, fontWeight: 600, lineHeight: 1.4, position: 'relative', zIndex: 1 }}>{pv('tagline')}</div>
                <div style={{ fontSize: 12, color: '#c3cbe8', marginTop: 6, position: 'relative', zIndex: 1 }}>{pv('heroLine')}</div>
                <div style={{ display: 'flex', gap: 6, marginTop: 12, flexWrap: 'wrap', position: 'relative', zIndex: 1 }}>
                  {[pv('pillA'), pv('pillB')].map((p, i) => (
                    <span key={i} style={{
                      fontSize: 10.5, fontWeight: 600, color: 'rgba(255,255,255,.9)', background: 'rgba(255,255,255,.12)',
                      border: '1px solid rgba(255,255,255,.18)', padding: '3px 9px', borderRadius: 99, whiteSpace: 'nowrap',
                    }}>{p}</span>
                  ))}
                </div>
                <div aria-hidden="true" style={{
                  position: 'absolute', width: 180, height: 180, right: -60, bottom: -80, borderRadius: '50%',
                  background: `radial-gradient(circle, ${tokenVal('--gold')}, transparent 70%)`, opacity: .3, zIndex: 0,
                }} />
              </div>
              <div style={{ background: '#fff', padding: '14px 16px' }}>
                <div style={{ fontWeight: 600, fontSize: 14, color: 'var(--ink)' }}>{pv('welcome')}</div>
                <div style={{ fontSize: 11.5, color: 'var(--ink-2)', marginTop: 2 }}>{pv('subtitle')}</div>
                <div style={{
                  marginTop: 10, borderRadius: 6, background: tokenVal('--brand'), color: '#fff',
                  textAlign: 'center', fontSize: 12, fontWeight: 600, padding: '7px 0',
                }}>{s.pvSignIn}</div>
                <div style={{ marginTop: 10, textAlign: 'center', fontSize: 10.5, color: 'var(--ink-3)' }}>{pv('footer')}</div>
              </div>
            </div>
          </div>

          {/* top bar miniature */}
          <div style={{ flex: '1 1 300px', minWidth: 260 }}>
            <div style={{ fontSize: 12, color: 'var(--ink-3)', marginBottom: 6 }}>{s.pvBar}</div>
            {/* The miniature is a real flex row of nowrap parts (brand chip, two
                nav labels, avatar pinned right), so at 390px its min-content
                width exceeded the card and pushed the whole DOCUMENT sideways
                (8px in zh, 95px in en). Letting it wrap keeps every part
                visible and costs nothing on a wide screen, where it never wraps. */}
            <div style={{
              border: '1px solid var(--line)', borderRadius: 10, background: '#fff', padding: '9px 14px',
              display: 'flex', alignItems: 'center', gap: 12, rowGap: 8, flexWrap: 'wrap', boxShadow: 'var(--shadow-1)',
            }}>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, padding: '5px 10px', borderRadius: 9, background: chipBg, flex: 'none' }}>
                {pvImg
                  ? <img src={pvImg} alt="" style={{ height: 20, display: 'block' }} />
                  : <span style={{ fontWeight: 800, fontSize: 13, letterSpacing: '.5px', whiteSpace: 'nowrap', color: chipInk }}>{pv('name')}</span>}
                <span style={{ fontSize: 10.5, fontWeight: 600, letterSpacing: 1, whiteSpace: 'nowrap', color: chipSub }}>{pv('console')}</span>
              </span>
              <span style={{ fontSize: 12, color: tokenVal('--brand'), fontWeight: 600, whiteSpace: 'nowrap' }}>{s.pvNavA}</span>
              <span style={{ fontSize: 12, color: 'var(--ink-2)', whiteSpace: 'nowrap' }}>{s.pvNavB}</span>
              <span style={{
                marginLeft: 'auto', width: 26, height: 26, borderRadius: '50%', background: tokenVal('--brand'),
                color: '#fff', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, fontWeight: 600, flex: 'none',
              }} aria-hidden="true">A</span>
            </div>
          </div>
        </div>
      </div>

      </SettingsWorkspace>
    </div>
  );
}
