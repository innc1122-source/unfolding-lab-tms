import { useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useI18n } from '../i18n.jsx';
import { api } from '../api.js';
import { applyBrand, brandText } from '../brand.js';
import BrandMark, { brandMarkClass } from '../components/BrandMark.jsx';
import PasswordField from '../components/PasswordField.jsx';

const T = {
  zh: {
    title: '设置新密码',
    // 页面刻意不显示工号:令牌是不透明的,服务端也不回工号 —— 拿到链接的人本来
    // 就知道自己是谁,页面上多印一个工号只是把它暴露给旁边的人。
    intro: '通过邮件里的链接重置密码。设置成功后，该账号在其他设备上的登录会全部退出。',
    neu: '新密码', confirm: '确认新密码',
    // 与服务端 /api/auth/reset、/api/auth/change-password 同一规则（D-25 ①）。本页只有重置令牌、不知道工号，
    // 「不能与工号 / 原密码相同」由服务端校验，按 code 显示。
    rule: '至少 8 位，须同时包含字母和数字，不能与工号或原密码相同。',
    submit: '设置新密码', submitting: '提交中…',
    mismatch: '两次输入的新密码不一致。',
    tooShort: '新密码至少 8 位。',
    tooWeak: '新密码须同时包含字母和数字。', sameAsId: '新密码不能与工号相同。', sameAsOld: '新密码不能与原密码相同。',
    // 服务端把「不存在 / 已过期 / 已使用 / 账号已停用」合并成同一句,前端照抄,
    // 不要分情况解释 —— 那等于替攻击者判断令牌状态。
    invalid: '重置链接无效或已过期。请回到登录页重新申请一封邮件。',
    tooMany: '请求过于频繁，请稍后再试。',
    tooManyMin: (m) => `请求过于频繁，请约 ${m} 分钟后再试。`,
    fail: '提交失败，请稍后再试。',
    okTitle: '密码已更新',
    okBody: '请用新密码登录。为了安全，该账号在其他设备上的登录已全部退出。',
    toLogin: '前往登录', backToLogin: '返回登录页',
    // 与 server.js BRAND_DEFAULTS / 登录页逐字一致:白标客户没配文案时两页同款。
    footer: '仅供授权用户使用 · 访问受监控', brandSub: '人才管理',
  },
  en: {
    title: 'Set a new password',
    // The page deliberately never shows an employee ID: the token is opaque and
    // the server does not return one. Whoever holds the link already knows who
    // they are; printing the ID would only show it to whoever is next to them.
    intro: 'Reset your password using the link from your email. Once it is set, every other device signed in to this account is signed out.',
    neu: 'New password', confirm: 'Confirm new password',
    rule: 'At least 8 characters, with both letters and digits, and different from your employee ID and your current password.',
    submit: 'Set new password', submitting: 'Submitting…',
    mismatch: 'The new passwords do not match.',
    tooShort: 'New password must be at least 8 characters.',
    tooWeak: 'New password must contain both letters and digits.', sameAsId: 'New password must not be your employee ID.', sameAsOld: 'New password must be different from the current one.',
    // The server collapses unknown / expired / already-used / deactivated into
    // one sentence. Repeat it as-is: explaining which one would tell an attacker
    // the state of the token.
    invalid: 'This reset link is invalid or has expired. Go back to the sign-in page and request a new email.',
    tooMany: 'Too many requests. Please try again later.',
    tooManyMin: (m) => `Too many requests — try again in about ${m} minute${m === 1 ? '' : 's'}.`,
    fail: 'Could not submit that. Please try again later.',
    okTitle: 'Password updated',
    okBody: 'Sign in with your new password. For your security, every other device signed in to this account has been signed out.',
    toLogin: 'Go to sign-in', backToLogin: 'Back to sign-in',
    // Character-for-character the same fallbacks as server.js BRAND_DEFAULTS and
    // the login page, so both pre-auth screens look identical when unbranded.
    footer: 'Authorized users only · Access is monitored', brandSub: 'Talent Management',
  },
};

/* Mail links land here as /#/reset-password?token=… (hash routing, same shape as
   #/login?sso=…). The page is PRE-AUTH by design — it exists for people who
   cannot sign in — so App.jsx's auth gate lets it through and the mailed token is
   the only thing that authorizes the change. Everything about the token is
   checked server-side; this page just carries it. */
export default function ResetPassword() {
  const { lang, toggle, t } = useI18n();
  const s = T[lang];
  const nav = useNavigate();
  const [params, setParams] = useSearchParams();

  // The token is read ONCE into state and then wiped out of the address bar with
  // a replace() — a reset link sitting in the browser history (or in a
  // screenshot of the URL bar) is exactly what we don't want on a shared
  // machine. Cost: a manual page refresh loses it, and the user re-opens the
  // mail — cheap, since a fresh request voids the old link anyway.
  const [token] = useState(() => params.get('token') || '');
  const stripped = useRef(false);
  useEffect(() => {
    if (stripped.current || !params.get('token')) return;
    stripped.current = true;
    setParams({}, { replace: true });
  }, [params, setParams]);

  // Brand block from /api/env: this page is pre-auth, so like the login page it
  // applies the white-label colors/title itself. Old server / no brand = no-op.
  const [brand, setBrand] = useState(null);
  useEffect(() => {
    api.get('/api/env').then((e) => {
      if (e && e.brand) { setBrand(e.brand); applyBrand(e.brand); }
    }).catch(() => {});
  }, []);

  const [neu, setNeu] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  // dead = the server refused the token itself (unknown / expired / used /
  // account deactivated). The form is pointless from then on, so it is replaced
  // by the one generic message plus a way back. A too_short / too_weak refusal
  // does NOT burn the token, so those keep the form.
  const [dead, setDead] = useState(!params.get('token'));
  // Errors are held as a dictionary KEY, never as finished text: a language
  // switch has to re-render the message, and a string frozen at submit time
  // cannot follow.
  const [err, setErr] = useState(null); // null | { k: <T key>, n?: <arg> }
  const errText = (e) => {
    if (!e || !e.k) return '';
    const v = s[e.k];
    return typeof v === 'function' ? v(e.n) : (v || '');
  };

  // After a successful reset: a full reload rather than nav(). The reset revokes
  // EVERY session of that account, so a tab that still holds a stale in-memory
  // `user` (someone who was signed in when they opened the link) would be sent
  // straight back into the app by App.jsx's /login guard. Reloading drops that
  // state, and the hash is set instead of a hard-coded URL so the /next/ mount
  // and any sub-path keep working.
  const reloadToLogin = () => {
    window.location.hash = '#/login';
    window.location.reload();
  };

  const submit = async (e) => {
    e.preventDefault();
    if (neu.length < 8) { setErr({ k: 'tooShort' }); return; }
    if (!/[A-Za-z]/.test(neu) || !/\d/.test(neu)) { setErr({ k: 'tooWeak' }); return; }
    if (neu !== confirm) { setErr({ k: 'mismatch' }); return; }
    setErr(null); setBusy(true);
    try {
      await api.post('/api/auth/reset', { token, newPassword: neu });
      // No cookie comes back and every session of that account is revoked, so
      // there is nothing to navigate into — send the user to sign in.
      setDone(true);
    } catch (ex) {
      const code = ex && ex.data && typeof ex.data === 'object' ? ex.data.code : null;
      const minutes = ex && ex.data && typeof ex.data === 'object' ? ex.data.minutes : null;
      if (ex && ex.status === 429) setErr({ k: minutes ? 'tooManyMin' : 'tooMany', n: minutes });
      else if (code === 'too_short') setErr({ k: 'tooShort' });
      else if (code === 'too_weak') setErr({ k: 'tooWeak' });
      else if (code === 'same_as_employee_id') setErr({ k: 'sameAsId' });
      else if (code === 'same_as_current') setErr({ k: 'sameAsOld' });
      else if (code === 'invalid_token') { setErr({ k: 'invalid' }); setDead(true); }
      else setErr({ k: 'fail' });
      setBusy(false);
    }
  };

  return (
    <div className="login-page">
      {/* lang-toggle：语言按钮「中 / EN」（与登录页、顶栏、学员端同一写法）两种语言都写出来，
          串语言检查按这个类跳过它；当前语言加粗并用品牌色。 */}
      <button className="login-lang icon-btn lang-toggle lang-pick" onClick={toggle} aria-label={t('switchLang')}>
        <span className={lang === 'zh' ? 'on' : undefined}>中</span><span className="sep" aria-hidden="true">/</span><span className={lang === 'en' ? 'on' : undefined}>EN</span>
      </button>

      {/* Single-column variant of the login card (no hero): the sign-in visual
          language, narrower because this screen is one short task. */}
      <div className="login-card" style={{ maxWidth: 420, gridTemplateColumns: '1fr' }}>
        <form className="login-form" onSubmit={submit}>
          {/* alignSelf: .login-form is a flex column, so the brand chip would
              otherwise stretch across the whole card instead of staying a pill. */}
          {/* 白色卡片：上传了浅底版时直接放浅底版、不要深色药丸底（BrandMark.jsx） */}
          <div className={['brand', brandMarkClass(brand, 'light')].filter(Boolean).join(' ')} style={{ alignSelf: 'flex-start', marginBottom: 14 }}>
            <BrandMark brand={brand} lang={lang} surface="light" style={{ height: 28 }} />
            <span className="sub">{brandText(brand, 'brandSub', lang, s.brandSub)}</span>
          </div>

          {done ? (
            <>
              <h1>{s.okTitle}</h1>
              <div className="login-sub" role="status" style={{ lineHeight: 1.6 }}>{s.okBody}</div>
              <button type="button" className="btn login-submit" onClick={reloadToLogin}>
                {s.toLogin}
                <svg className="ic sm" viewBox="0 0 24 24"><path d="M5 12h14M13 6l6 6-6 6" /></svg>
              </button>
            </>
          ) : dead ? (
            <>
              <h1>{s.title}</h1>
              <div className="cp-err" role="alert" style={{ lineHeight: 1.6, marginTop: 10 }}>{s.invalid}</div>
              <button type="button" className="btn ghost login-submit" onClick={() => nav('/login', { replace: true })}>
                {s.backToLogin}
              </button>
            </>
          ) : (
            <>
              <h1>{s.title}</h1>
              <div className="login-sub" style={{ lineHeight: 1.6 }}>{s.intro}</div>

              <label className="login-field">
                <span className="login-lbl">{s.neu}</span>
                <PasswordField value={neu} onChange={(e) => setNeu(e.target.value)} autoComplete="new-password" autoFocus />
              </label>
              <label className="login-field">
                <span className="login-lbl">{s.confirm}</span>
                <PasswordField value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" />
              </label>

              <div className="cp-rule">{s.rule}</div>
              {err && <div className="cp-err" role="alert">{errText(err)}</div>}

              <button type="submit" className="btn login-submit" disabled={busy}>
                {busy ? s.submitting : s.submit}
              </button>
              <button type="button" className="login-forgot" onClick={() => nav('/login', { replace: true })} style={{ marginTop: 14, alignSelf: 'center' }}>
                {s.backToLogin}
              </button>
            </>
          )}

          <div className="login-foot">{brandText(brand, 'footer', lang, s.footer)}</div>
        </form>
      </div>
    </div>
  );
}
