import React from 'react';
import { createRoot } from 'react-dom/client';
import { HashRouter } from 'react-router-dom';
import './app.css';
// Layout v2（2026-10-06 界面优化方案）叠在 app.css 之后；body 类名由 v2.jsx 按路由写入
import './v2.css';
import App from './App.jsx';
import { I18nProvider } from './i18n.jsx';
import { AuthProvider } from './auth.jsx';
import { CourseScopeProvider } from './coursescope.jsx';
import { isChunkLoadError } from './lazyRetry.js';

// The boundary sits OUTSIDE I18nProvider on purpose — a crash inside the
// provider tree must still be caught — so useI18n()/t() are not available here.
// It therefore resolves the language the same way I18nProvider does (?lang= ->
// saved choice -> browser), reading the 'lms-lang' key directly. Duplicating
// three lines beats the alternatives: showing both languages stacked (every user
// reads half a card of noise) or importing the provider (whose own crash is
// exactly the case this card exists for). Everything is wrapped in try/catch —
// storage access throws in some privacy modes, and a boundary that throws
// while rendering its fallback puts the blank page right back.
function crashLang() {
  try {
    const q = new URLSearchParams(window.location.search).get('lang');
    if (q === 'en' || q === 'zh') return q;
    const saved = localStorage.getItem('lms-lang');
    if (saved === 'en' || saved === 'zh') return saved;
    return (navigator.language || '').toLowerCase().startsWith('zh') ? 'zh' : 'en';
  } catch { return 'en'; }
}

const T = {
  zh: {
    title: '页面出错了',
    body: '刷新页面通常可以恢复；如果反复出现，请联系 HR。',
    reload: '刷新页面',
    updTitle: '系统已更新',
    updBody: '请刷新页面以使用最新版本。',
  },
  en: {
    title: 'Something went wrong',
    body: 'Refreshing the page usually fixes this. If it keeps happening, please contact HR.',
    reload: 'Refresh page',
    updTitle: 'The system has been updated',
    updBody: 'Refresh the page to load the latest version.',
  },
};

// Last-resort error boundary: a render crash shows a friendly localized card
// with a reload button instead of a blank white page.
class ErrorBoundary extends React.Component {
  constructor(props) { super(props); this.state = { error: null }; }
  static getDerivedStateFromError(error) { return { error }; }
  componentDidCatch(error, info) { console.error('Render crash:', error, info); }
  render() {
    if (!this.state.error) return this.props.children;
    const s = T[crashLang()] || T.en;
    // CX-109：发版后旧页面取不到旧分包（lazyRetry 已自动刷新过一次仍失败）—— 说明是系统更新，不是出错
    const upd = isChunkLoadError(this.state.error);
    return (
      <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 24, fontFamily: 'inherit' }}>
        <div style={{ maxWidth: 460, textAlign: 'center' }}>
          <div style={{ marginBottom: 12, color: '#86909c' }} aria-hidden="true">
            <svg className="ic" viewBox="0 0 24 24" style={{ width: 40, height: 40 }} fill="none" stroke="currentColor">
              <path d="M12 3L2 20h20L12 3z" /><path d="M12 9v5" /><path d="M12 17h.01" />
            </svg>
          </div>
          <h1 style={{ fontSize: 18, fontWeight: 600, marginBottom: 8 }}>{upd ? s.updTitle : s.title}</h1>
          <p style={{ fontSize: 13.5, color: '#86909c', marginBottom: 18, lineHeight: 1.6 }}>{upd ? s.updBody : s.body}</p>
          <button
            onClick={() => window.location.reload()}
            style={{ background: '#4636e3', color: '#fff', border: 'none', borderRadius: 8, padding: '10px 22px', fontSize: 14, cursor: 'pointer' }}
          >
            {s.reload}
          </button>
          {!upd && <div style={{ marginTop: 14, fontSize: 11.5, color: '#c2c7d0', wordBreak: 'break-all' }}>{String(this.state.error && this.state.error.message)}</div>}
        </div>
      </div>
    );
  }
}

// Semi UI (CSS + JS) is imported inside AdminLayout, which is lazy-loaded — so
// the employee app never downloads it. Only the HR console pulls in Semi.
createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ErrorBoundary>
      <HashRouter>
        <I18nProvider>
          <AuthProvider>
            <CourseScopeProvider>
              <App />
            </CourseScopeProvider>
          </AuthProvider>
        </I18nProvider>
      </HashRouter>
    </ErrorBoundary>
  </React.StrictMode>
);
