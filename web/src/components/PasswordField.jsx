import { useState } from 'react';
import { useI18n } from '../i18n.jsx';

// Password input with a show/hide toggle. The eye stays in the tab order with a
// clear label so it's keyboard- and screen-reader-operable.
const EYE = (
  <svg className="ic sm" viewBox="0 0 24 24"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7z" /><circle cx="12" cy="12" r="3" /></svg>
);
const EYE_OFF = (
  <svg className="ic sm" viewBox="0 0 24 24"><path d="M3 3l18 18" /><path d="M10.6 10.6a3 3 0 004.24 4.24" /><path d="M9.4 5.1A10.6 10.6 0 0112 4.9c6.4 0 10 7.1 10 7.1a18 18 0 01-3.2 4.1M6.2 6.2A17.7 17.7 0 002 12s3.6 7.1 10 7.1a10 10 0 004.3-.95" /></svg>
);

export default function PasswordField({ leading, ...props }) {
  const { lang } = useI18n();
  const [show, setShow] = useState(false);
  const label = show
    ? (lang === 'zh' ? '隐藏密码' : 'Hide password')
    : (lang === 'zh' ? '显示密码' : 'Show password');
  return (
    <div className={'pwf' + (leading ? ' pwf-lead' : '')}>
      {leading}
      <input {...props} type={show ? 'text' : 'password'} />
      <button type="button" className="pwf-eye" onClick={() => setShow((v) => !v)} aria-label={label} aria-pressed={show}>
        {show ? EYE_OFF : EYE}
      </button>
    </div>
  );
}
