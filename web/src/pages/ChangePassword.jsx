import { useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useI18n } from '../i18n.jsx';
import { useAuth } from '../auth.jsx';
import PasswordField from '../components/PasswordField.jsx';
import { nextFromSearch } from '../nextpath.js';

const T = {
  zh: {
    title: '修改密码', forced: '为了账户安全，首次登录请先设置新密码。',
    old: '原密码', neu: '新密码', confirm: '确认新密码',
    rule: '至少 8 位，须同时包含字母和数字，不能与工号或原密码相同。', save: '保存并继续', saving: '保存中…',
    mismatch: '两次输入的新密码不一致。', tooShort: '新密码至少 8 位。', weak: '新密码须同时包含字母和数字。', sameAsId: '新密码不能与工号相同。', sameAsOld: '新密码不能与原密码相同。', fail: '修改失败，请重试。',
    wrongOld: '原密码不正确。',
  },
  en: {
    title: 'Change Password', forced: 'For your account’s security, please set a new password on first login.',
    old: 'Current password', neu: 'New password', confirm: 'Confirm new password',
    rule: 'At least 8 characters, with both letters and digits, and different from your employee ID and your current password.',
    save: 'Save and continue', saving: 'Saving…',
    mismatch: 'The new passwords do not match.', tooShort: 'New password must be at least 8 characters.', weak: 'New password must contain both letters and digits.', sameAsId: 'New password must not be your employee ID.', sameAsOld: 'New password must be different from the current one.', fail: 'Could not change the password. Please try again.',
    wrongOld: 'Your current password is incorrect.',
  },
};

// /api/auth/change-password 的 400 带 code（与 /api/auth/reset 同一组，server.js › newPasswordProblem）：按 code 折回本页词条，
// 语言切换时跟着变；老服务端没有 code 时按英文句子识别，都认不出才显示原文。
const CODE_KEY = { current_password_incorrect: 'wrongOld', too_short: 'tooShort', too_weak: 'weak', same_as_employee_id: 'sameAsId', same_as_current: 'sameAsOld' };
function serverKey(ex) {
  const code = ex && ex.data && typeof ex.data === 'object' ? ex.data.code : null;
  if (code && CODE_KEY[code]) return CODE_KEY[code];
  const m = String((ex && ex.message) || '');
  if (/current password is incorrect/i.test(m)) return 'wrongOld';
  if (/at least 8 characters/i.test(m)) return 'tooShort';
  if (/different from the current one/i.test(m)) return 'sameAsOld';
  return null;
}

export default function ChangePassword({ forced = false }) {
  const { lang, t } = useI18n();
  const { changePassword, user } = useAuth();
  const s = T[lang];
  const nav = useNavigate();
  // ?next=<module page> (e.g. /culture/): set by App.jsx when a temporary-password account signed in
  // from a module page, or by the module page itself (the learner app sends /#/change-password?next=/culture/).
  // Same whitelist as the sign-in bounce-back (nextpath.js), switches from /api/me: a page of a module that
  // is switched off is ignored (the server answers it with a 404), anything else too — then into the app.
  const next = nextFromSearch(useLocation().search, user && user.modules);
  const [f, setF] = useState({ old: '', neu: '', confirm: '' });
  // Held as a dictionary KEY, not as finished text: a language switch has to
  // re-render the message, and a string frozen into state at submit time
  // cannot follow. `text` is the last-resort escape hatch for a server message
  // we do not recognise — server copy is English-only (server.js 2565-2569),
  // so anything reaching `text` shows English even in the zh UI. serverKey()
  // maps the messages this endpoint can actually return back onto T so the
  // normal cases stay bilingual and switchable.
  const [err, setErr] = useState(null); // null | { k: <T key> } | { text }
  const [busy, setBusy] = useState(false);

  const on = (k) => (e) => setF({ ...f, [k]: e.target.value });

  const submit = async (e) => {
    e.preventDefault();
    // 与服务端同一规则（D-25 ①）
    if (f.neu.length < 8) return setErr({ k: 'tooShort' });
    if (!/[A-Za-z]/.test(f.neu) || !/\d/.test(f.neu)) return setErr({ k: 'weak' });
    if (user && user.employeeId && f.neu.trim().toLowerCase() === String(user.employeeId).trim().toLowerCase()) return setErr({ k: 'sameAsId' });
    if (f.neu === f.old) return setErr({ k: 'sameAsOld' });
    if (f.neu !== f.confirm) return setErr({ k: 'mismatch' });
    setErr(null); setBusy(true);
    try {
      await changePassword(f.old, f.neu);
      // flag cleared server-side; back to the module page the user came from (full load: it is served by
      // the server, not by this SPA's routes), otherwise into the app
      if (next) window.location.assign(next);
      else nav('/');
    } catch (ex) {
      const k = serverKey(ex);
      setErr(k ? { k } : (ex && ex.message ? { text: ex.message } : { k: 'fail' }));
      setBusy(false);
    }
  };

  return (
    <div className="wrap cp-wrap">
      <form className="cp-card" onSubmit={submit}>
        <h1 className="cp-title">{s.title}</h1>
        {forced && <div className="callout">{s.forced}</div>}
        <label className="cp-field">
          <span>{s.old}</span>
          <PasswordField value={f.old} onChange={on('old')} autoComplete="current-password" />
        </label>
        <label className="cp-field">
          <span>{s.neu}</span>
          <PasswordField value={f.neu} onChange={on('neu')} autoComplete="new-password" />
        </label>
        <label className="cp-field">
          <span>{s.confirm}</span>
          <PasswordField value={f.confirm} onChange={on('confirm')} autoComplete="new-password" />
        </label>
        <div className="cp-rule">{s.rule}</div>
        {err && <div className="cp-err" role="alert">{err.text || s[err.k] || ''}</div>}
        <button className="btn" type="submit" disabled={busy} style={{ width: '100%', justifyContent: 'center', marginTop: 6 }}>
          {busy ? s.saving : s.save}
        </button>
        {!forced && (
          <button type="button" className="btn ghost" onClick={() => nav('/')} disabled={busy} style={{ width: '100%', justifyContent: 'center', marginTop: 8 }}>
            {t('cancel')}
          </button>
        )}
      </form>
    </div>
  );
}
