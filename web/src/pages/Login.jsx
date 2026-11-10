import { useState, useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { useI18n } from '../i18n.jsx';
import { useAuth } from '../auth.jsx';
import { api } from '../api.js';
import { applyBrand, brandText, brandWordmark, brandLegal } from '../brand.js';
import BrandMark from '../components/BrandMark.jsx';
import { nextFromSearch } from '../nextpath.js';

const T = {
  zh: {
    welcome: '欢迎回来', subtitle: '请登录以继续',
    empId: '工号', empIdPh: '000000', password: '密码', passwordPh: '请输入密码',
    signIn: '登录', signingIn: '登录中…', forgot: '忘记密码？', demoLabel: '演示测试账号',
    forgotHint: '请联系你的 HR 管理员重置密码。', showPw: '显示密码', hidePw: '隐藏密码',
    // —— 自助重置密码。只有 /api/env 的 passwordResetEnabled 为 true(服务端配好
    //    邮件)时才出现;否则上面那句「联系 HR」原样保留 —— 不做「已发送」的空承诺。
    resetTitle: '自助重置密码',
    resetIntro: '输入工号，我们会把重置链接发到该账号登记的邮箱。',
    resetSend: '发送重置链接', resetSending: '发送中…',
    // 提交结果一律显示这一句:存在 / 不存在 / 无邮箱 / 已停用,服务端的响应体逐字节
    // 相同,前端同样不能靠文案差异暗示工号是否存在(防枚举)。「30 分钟」与 server.js
    // 的 RESET_TOKEN_TTL_MS 及邮件正文一致,改那边记得改这里。
    resetSent: '如果该工号存在且已登记邮箱，重置链接已发送到该邮箱。请查看收件箱（也看一下垃圾邮件），链接 30 分钟内有效。',
    resetNeedId: '请输入工号。',
    resetTooMany: '请求过于频繁，请稍后再试。',
    resetTooManyMin: (m) => `请求过于频繁，请约 ${m} 分钟后再试。`,
    resetFail: '暂时无法发送，请稍后再试。',
    // 回落文案与 server.js BRAND_DEFAULTS 逐字一致（双保险：旧服务端不发
    // brand 块时,这里就是登录页实际显示的产品向定稿文案）。
    footer: '仅供授权用户使用 · 访问受监控', tagline: '让每位员工的成长清晰可见', heroLine: '员工档案、绩效评估、培训与人才盘点，集中在一个平台',
    pillA: '员工档案 · 组织 · 绩效', pillB: '培训 · 考试 · 人才盘点', brandSub: '人才管理',
    // 法务链接：只有 brand.legal 配了对应 URL 才出现（见 brand.js brandLegal）。
    legalNav: '法务信息', privacy: '隐私政策', terms: '服务条款',
    needBoth: '请输入工号和密码。', errAuth: '工号或密码错误。',
    errLocked: '失败次数过多，请稍后再试。', errLockedMin: (m) => `失败次数过多，请约 ${m} 分钟后再试。`,
    errDisabled: '该账号已停用，请联系 HR。', errGeneric: '登录失败，请重试。',
    larkBtn: '使用 Lark 登录', orPwd: '或使用工号密码',
    ssoFailed: 'Lark 登录失败，请重试或改用工号密码。', ssoDisabled: '该账号已停用，请联系 HR。',
    ssoNotAllowed: '你的 Lark 账号不在在职员工名单中，无法登录。如有疑问请联系 HR。',
  },
  en: {
    welcome: 'Welcome back', subtitle: 'Sign in to continue',
    empId: 'Employee ID', empIdPh: '000000', password: 'Password', passwordPh: 'Enter your password',
    signIn: 'Sign in', signingIn: 'Signing in…', forgot: 'Forgot password?', demoLabel: 'Demo test account',
    forgotHint: 'Contact your HR administrator to reset your password.', showPw: 'Show password', hidePw: 'Hide password',
    // —— Self-service reset. Only shown when /api/env says passwordResetEnabled
    //    (a mailer is configured); otherwise the "contact HR" line above stays,
    //    so we never promise a mail that can never be sent.
    resetTitle: 'Reset your password',
    resetIntro: 'Enter your employee ID and we will email a reset link to the address on file.',
    resetSend: 'Send reset link', resetSending: 'Sending…',
    // One reply for every outcome — exists / unknown / no email / deactivated.
    // The server's response body is byte-identical across those branches and the
    // UI must not reintroduce the difference in wording (anti-enumeration).
    // The 30 minutes matches server.js RESET_TOKEN_TTL_MS and the mail body.
    resetSent: 'If that employee ID exists and has an email address on file, a reset link has been sent to it. Check your inbox (and your spam folder) — the link is valid for 30 minutes.',
    resetNeedId: 'Enter your employee ID.',
    resetTooMany: 'Too many requests. Please try again later.',
    resetTooManyMin: (m) => `Too many requests — try again in about ${m} minute${m === 1 ? '' : 's'}.`,
    resetFail: 'Could not send it right now. Please try again later.',
    // Fallbacks match server.js BRAND_DEFAULTS character for character (second
    // belt: an old server sending no brand block still shows the final copy).
    footer: 'Authorized users only · Access is monitored', tagline: 'Making every employee’s growth visible', heroLine: 'Employee profiles, performance reviews, learning and talent review in one platform',
    pillA: 'Profiles · Organization · Performance', pillB: 'Learning · Exams · Talent Review', brandSub: 'Talent Management',
    // Legal links: rendered only when brand.legal configures the URL (brand.js brandLegal).
    legalNav: 'Legal', privacy: 'Privacy Policy', terms: 'Terms of Service',
    needBoth: 'Enter your employee ID and password.', errAuth: 'Wrong employee ID or password.',
    errLocked: 'Too many failed attempts. Please try again later.', errLockedMin: (m) => `Too many failed attempts — try again in about ${m} minute${m === 1 ? '' : 's'}.`,
    errDisabled: 'This account has been deactivated. Please contact HR.', errGeneric: 'Sign-in failed. Please try again.',
    larkBtn: 'Sign in with Lark', orPwd: 'or use employee ID & password',
    ssoFailed: 'Lark sign-in failed — try again or use your employee ID.', ssoDisabled: 'This account has been deactivated. Contact HR.',
    ssoNotAllowed: 'Your Lark account is not on the current employee list, so it cannot sign in here. Contact HR if you think this is wrong.',
  },
};

export default function Login() {
  const { lang, toggle, t } = useI18n();
  const { login } = useAuth();
  const s = T[lang];
  // Sign-in bounce-back (modules/culture/CONTRACT.md 9.5): a module page that
  // sent the user here — /culture/ redirects to /#/login?next=%2Fculture%2F —
  // gets them back after signing in. Only in-site pages of a switched-ON module
  // pass nextFromSearch (same whitelist as the server's kernel/module-host.js
  // pageLink); anything else is dropped and sign-in lands on home as before.
  // Which modules are on comes from /api/env (this page is pre-auth): null until
  // it loads, and no module page is a valid next until then — a module that is
  // switched off serves a 404, so its next falls back to home, same as the server.
  const { search } = useLocation();
  const [envMods, setEnvMods] = useState(null);
  const next = nextFromSearch(search, envMods);
  // Resolve a stored { k, n } error against the CURRENT language.
  const errText = (e) => {
    if (!e || !e.k) return '';
    const v = s[e.k];
    return typeof v === 'function' ? v(e.n) : (v || '');
  };

  const [empId, setEmpId] = useState('');
  const [password, setPassword] = useState('');
  // The error is kept as a dictionary KEY (plus its one argument), never as
  // finished text: switching the language has to re-render the message, and a
  // string captured in state at submit time cannot follow. errText() resolves
  // it in whatever language is active at RENDER time.
  const [err, setErr] = useState(null); // null | { k: <T key>, n?: <arg> }
  const [busy, setBusy] = useState(false);
  const [demo, setDemo] = useState(false);
  const [lark, setLark] = useState(false);
  const [showPw, setShowPw] = useState(false);
  const [showForgot, setShowForgot] = useState(false);
  // Self-service reset. `resetOn` is the GLOBAL capability flag from /api/env
  // (is a mailer configured at all) — it says nothing about any employee ID, so
  // it is not an enumeration surface. false / old server → the panel never
  // renders and 「忘记密码？」 keeps showing the contact-HR line.
  const [resetOn, setResetOn] = useState(false);
  const [fId, setFId] = useState('');
  const [fBusy, setFBusy] = useState(false);
  const [fSent, setFSent] = useState(false); // true = show the one generic notice
  const [fErr, setFErr] = useState(null); // null | { k: <T key>, n?: <arg> } — same key-not-text rule as `err`
  // White-label brand block from /api/env (this page is pre-auth, so it can't
  // use /api/me). null = not loaded / old server → every read below falls
  // back to the T dictionary + text wordmark, i.e. the generic look.
  const [brand, setBrand] = useState(null);
  const legal = brandLegal(brand);

  useEffect(() => {
    api.get('/api/env').then((e) => {
      // demo：非正式环境时为登录框下方展示的演示账号文字（服务器可用 demoHint 指定，公开试用站用它换成员工账号）
      setDemo(e && e.demo ? (typeof e.demoHint === 'string' && e.demoHint ? e.demoHint : 'UL-TEST / Demo1234') : false); setLark(!!(e && e.lark));
      setResetOn(!!(e && e.passwordResetEnabled));
      setEnvMods(e && e.modules && typeof e.modules === 'object' ? e.modules : {});
      // Colors/tab title must land here too — the login page is the first
      // thing a customer sees, before any session exists.
      if (e && e.brand) { setBrand(e.brand); applyBrand(e.brand); }
    }).catch(() => {});
    // The SSO callback bounces failures back here as /#/login?sso=<reason>.
    const m = window.location.hash.match(/sso=([a-z]+)/);
    if (m) setErr({ k: m[1] === 'disabled' ? 'ssoDisabled' : m[1] === 'notallowed' ? 'ssoNotAllowed' : 'ssoFailed' });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const submit = async (e) => {
    e.preventDefault();
    if (!empId.trim() || !password) { setErr({ k: 'needBoth' }); return; }
    setErr(null); setBusy(true);
    try {
      await login(empId.trim(), password, next, envMods);
      // On success the auth gate redirects (to / or forced change-password);
      // with a valid next, login() leaves for that module page with a full load.
    } catch (ex) {
      // Always show a message in the CURRENT language — the server sends a
      // machine `code` (auth / disabled / locked) instead of dictating copy.
      const code = ex && ex.data && typeof ex.data === 'object' ? ex.data.code : null;
      const minutes = ex && ex.data && typeof ex.data === 'object' ? ex.data.minutes : null;
      let key;
      if (ex && ex.status === 429) key = minutes ? 'errLockedMin' : 'errLocked';
      else if (code === 'disabled') key = 'errDisabled';
      else if (ex && ex.status === 401) key = 'errAuth';
      else key = 'errGeneric';
      setErr({ k: key, n: minutes });
      setBusy(false);
    }
  };

  // Ask for a reset mail. NOT an onSubmit: this panel lives inside the sign-in
  // <form>, and a nested <form> is invalid HTML — the button is type="button"
  // and Enter in the field is handled by hand so it can never submit the login
  // form by accident.
  const sendReset = async () => {
    if (fBusy) return;
    if (!fId.trim()) { setFErr({ k: 'resetNeedId' }); return; }
    setFErr(null); setFBusy(true);
    try {
      await api.post('/api/auth/forgot', { employeeId: fId.trim() });
      // The 200 body is a frozen constant on the server; nothing in it is worth
      // branching on. Swap the form for the one generic notice — same screen for
      // a real account, an unknown ID, a mailbox-less account and a deactivated
      // one, so this page cannot be used to test whether an ID exists.
      setFSent(true);
    } catch (ex) {
      const minutes = ex && ex.data && typeof ex.data === 'object' ? ex.data.minutes : null;
      // 429 is a request-count fact, not an account fact; anything else is a
      // transport/server problem. Neither answer says whether the ID exists.
      setFErr(ex && ex.status === 429
        ? { k: minutes ? 'resetTooManyMin' : 'resetTooMany', n: minutes }
        : { k: 'resetFail' });
    }
    setFBusy(false);
  };

  return (
    <div className="login-page">
      {/* lang-toggle：语言按钮「中 / EN」（2026-09-28 负责人决定，与顶栏、学员端同一写法）两种语言都写出来，
          串语言检查按这个类跳过它；当前语言加粗并用品牌色。 */}
      <button className="login-lang icon-btn lang-toggle lang-pick" onClick={toggle} aria-label={t('switchLang')}>
        <span className={lang === 'zh' ? 'on' : undefined}>中</span><span className="sep" aria-hidden="true">/</span><span className={lang === 'en' ? 'on' : undefined}>EN</span>
      </button>

      <div className="login-card">
        <aside className="login-hero">
          <div className="brand">
            {/* 登录页左侧大图是深底：只用深底版（BrandMark.jsx） */}
            <BrandMark brand={brand} lang={lang} surface="dark" />
            <span className="sub">{brandText(brand, 'brandSub', lang, s.brandSub)}</span>
          </div>
          <h2>{brandText(brand, 'tagline', lang, s.tagline)}</h2>
          <p>{brandText(brand, 'heroLine', lang, s.heroLine)}</p>
          {/* What the system covers. Deliberately NOT headcount or course
              counts: this page is pre-auth, and org size is not public. */}
          <div className="login-hero-pills">
            <span className="login-hero-pill">{brandText(brand, 'pillA', lang, s.pillA)}</span>
            <span className="login-hero-pill">{brandText(brand, 'pillB', lang, s.pillB)}</span>
          </div>
          <div className="login-hero-glow" aria-hidden="true" />
        </aside>

        <form className="login-form" onSubmit={submit}>
          <h1>{brandText(brand, 'welcome', lang, s.welcome)}</h1>
          <div className="login-sub">{brandText(brand, 'subtitle', lang, s.subtitle)}</div>

          {lark && (
            <>
              {/* The server keeps next with the SSO state and bounces there after the callback. */}
              <button type="button" className="btn login-lark" onClick={() => { window.location.href = '/api/auth/lark/start' + (next ? '?next=' + encodeURIComponent(next) : ''); }}>
                <svg className="ic sm" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 5h11l7 7-7 7H3l7-7-7-7z" fill="currentColor" stroke="none" /></svg>
                {s.larkBtn}
              </button>
              <div className="login-or"><span>{s.orPwd}</span></div>
            </>
          )}

          <label className="login-field">
            <span className="login-lbl">{s.empId}</span>
            <div className="login-input">
              <svg className="ic sm" viewBox="0 0 24 24"><path d="M20 21a8 8 0 10-16 0" /><circle cx="12" cy="7" r="4" /></svg>
              <input type="text" value={empId} onChange={(e) => setEmpId(e.target.value)} placeholder={s.empIdPh} autoComplete="username" autoFocus />
            </div>
          </label>

          <label className="login-field">
            <span className="login-lbl">{s.password}</span>
            <div className="login-input">
              <svg className="ic sm" viewBox="0 0 24 24"><rect x="3" y="11" width="18" height="11" rx="2" /><path d="M7 11V7a5 5 0 0110 0v4" /></svg>
              <input type={showPw ? 'text' : 'password'} value={password} onChange={(e) => setPassword(e.target.value)} placeholder={s.passwordPh} autoComplete="current-password" />
              <button type="button" className="pwf-eye" onClick={() => setShowPw((v) => !v)} aria-label={showPw ? s.hidePw : s.showPw} aria-pressed={showPw}>
                {showPw
                  ? <svg className="ic sm" viewBox="0 0 24 24"><path d="M3 3l18 18" /><path d="M10.6 10.6a3 3 0 004.24 4.24" /><path d="M9.4 5.1A10.6 10.6 0 0112 4.9c6.4 0 10 7.1 10 7.1a18 18 0 01-3.2 4.1M6.2 6.2A17.7 17.7 0 002 12s3.6 7.1 10 7.1a10 10 0 004.3-.95" /></svg>
                  : <svg className="ic sm" viewBox="0 0 24 24"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7z" /><circle cx="12" cy="12" r="3" /></svg>}
              </button>
            </div>
          </label>

          <div className="login-row">
            {demo ? (
              <span className="login-demo">
                <span className="pill muted">{s.demoLabel}</span>
                <span className="tnum">{demo}</span>
              </span>
            ) : <span />}
            <button type="button" className="login-forgot" onClick={() => { setShowForgot((v) => !v); setFErr(null); }} aria-expanded={showForgot}>{s.forgot}</button>
          </div>
          {/* Two shapes behind the same 「忘记密码？」: the self-service panel when
              the server can actually send mail, otherwise the untouched
              contact-HR line. No mailer = no promise. */}
          {showForgot && (resetOn ? (
            <div className="login-forgot-hint" role="group" aria-label={s.resetTitle}>
              <div style={{ fontWeight: 600, color: 'var(--ink-2)', marginBottom: 4 }}>{s.resetTitle}</div>
              {fSent ? (
                <div role="status" style={{ lineHeight: 1.6 }}>{s.resetSent}</div>
              ) : (
                <>
                  <div style={{ marginBottom: 8, lineHeight: 1.6 }}>{s.resetIntro}</div>
                  {/* autoComplete="off", not "username": a second username field
                      inside the sign-in form makes browsers autofill it and offer
                      to save the wrong pair. Enter is handled by hand because this
                      panel sits INSIDE the sign-in <form> (a nested <form> is
                      invalid HTML) and must never submit it. */}
                  <div className="login-input" style={{ marginBottom: 8 }}>
                    <svg className="ic sm" viewBox="0 0 24 24"><path d="M20 21a8 8 0 10-16 0" /><circle cx="12" cy="7" r="4" /></svg>
                    <input
                      type="text" value={fId} onChange={(e) => setFId(e.target.value)}
                      placeholder={s.empIdPh} aria-label={s.empId} autoComplete="off"
                      onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); sendReset(); } }}
                    />
                  </div>
                  {fErr && <div className="cp-err" role="alert">{errText(fErr)}</div>}
                  <button type="button" className="btn" onClick={sendReset} disabled={fBusy} style={{ width: '100%', justifyContent: 'center' }}>
                    {fBusy ? s.resetSending : s.resetSend}
                  </button>
                </>
              )}
            </div>
          ) : (
            <div className="login-forgot-hint" role="note">{s.forgotHint}</div>
          ))}

          {err && <div className="cp-err" role="alert">{errText(err)}</div>}

          <button type="submit" className="btn login-submit" disabled={busy}>
            {busy ? s.signingIn : s.signIn}
            {!busy && <svg className="ic sm" viewBox="0 0 24 24"><path d="M5 12h14M13 6l6 6-6 6" /></svg>}
          </button>

          <div className="login-foot">{brandText(brand, 'footer', lang, s.footer)}</div>
          {/* Optional legal links. Nothing configured = no element at all, so the
              unconfigured page stays pixel-identical to before. */}
          {legal && (
            <nav className="login-legal" aria-label={s.legalNav}>
              {legal.privacyUrl && <a href={legal.privacyUrl} target="_blank" rel="noopener noreferrer">{s.privacy}</a>}
              {legal.privacyUrl && legal.termsUrl && <span className="login-legal-sep" aria-hidden="true">/</span>}
              {legal.termsUrl && <a href={legal.termsUrl} target="_blank" rel="noopener noreferrer">{s.terms}</a>}
            </nav>
          )}
        </form>
      </div>
    </div>
  );
}
