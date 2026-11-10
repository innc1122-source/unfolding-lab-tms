import { useEffect, useState, useCallback } from 'react';

// Thin wrapper over the same-origin JSON API. The SPA is served from /next on
// the same origin as /api, so the httpOnly `sid` session cookie rides along
// automatically and POST/PUT/DELETE satisfy the server's Origin===Host CSRF
// check. A 401 bounces the user to the login route.
export class ApiError extends Error {
  constructor(status, message, data) {
    super(message || 'request failed');
    this.status = status;
    this.data = data;
  }
}

// The auth layer registers a handler so a 401 anywhere (e.g. an expired
// session mid-session) can centrally drop the user back to a logged-out state.
let onUnauthorized = null;
export function setUnauthorizedHandler(fn) { onUnauthorized = fn; }

// CX-156：服务器时钟与本机的时差（毫秒），每个响应按 HTTP Date 头更新一次（1 秒精度）。
// 重考等待期等按服务器时间判断，设备时钟不准时不会误拦或误放。
let serverSkew = 0;
export function serverNow() { return Date.now() + serverSkew; }

async function request(method, path, body, opts = {}) {
  const init = { method, credentials: 'same-origin', headers: {}, ...opts };
  if (body !== undefined && body !== null && !(body instanceof FormData || body instanceof Blob || body instanceof ArrayBuffer)) {
    init.headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  } else if (body !== undefined) {
    init.body = body; // raw (upload)
  }
  const res = await fetch(path, init);
  try { const t = Date.parse(res.headers.get('date') || ''); if (Number.isFinite(t)) serverSkew = t - Date.now(); } catch { /* ignore */ }
  const ct = res.headers.get('content-type') || '';
  const payload = ct.includes('application/json') ? await res.json().catch(() => null) : await res.text();
  if (res.status === 401) {
    // Still drop the app to the logged-out state, but KEEP the server's
    // message/code — the login screen localizes based on them.
    if (onUnauthorized) onUnauthorized();
    const msg = payload && typeof payload === 'object' ? payload.error || payload.message : 'unauthorized';
    throw new ApiError(401, msg || 'unauthorized', payload);
  }
  if (!res.ok) {
    // CX-119 / CX-129 / CX-131：服务端带 error_zh 的，中文界面统一显示中文（i18n.jsx 把界面语言写在 <html lang>）；
    // 各页按 code 造句的仍优先（apierr.js errText），这里只改它们回落时用的那句。
    let zhUi = false;
    try { zhUi = /^zh/i.test(document.documentElement.lang || ''); } catch { zhUi = false; }
    const msg = payload && typeof payload === 'object' ? (zhUi && payload.error_zh) || payload.error || payload.message : String(payload || res.statusText);
    throw new ApiError(res.status, msg, payload);
  }
  return payload;
}

export const api = {
  get: (path) => request('GET', path),
  post: (path, body) => request('POST', path, body),
  put: (path, body) => request('PUT', path, body),
  del: (path, body) => request('DELETE', path, body),
  // Raw request for file uploads (body is a Blob/ArrayBuffer/FormData).
  upload: (path, body, headers) => request('POST', path, body, { headers: headers || {} }),
};

// Whole days from now until a 'YYYY-MM-DD' due date, local-midnight to
// local-midnight. null when unknown; negative when overdue. Shared across Home,
// MyLearning and ProgramDetail so every screen reports the same day count
// (they previously mixed UTC/local parsing and ceil/round, and could disagree).
export function daysUntil(dueAt) {
  if (!dueAt) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(dueAt));
  const due = m ? new Date(+m[1], +m[2] - 1, +m[3]) : new Date(dueAt);
  if (Number.isNaN(due.getTime())) return null;
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((due - today) / 86400000);
}

// Fetch-on-mount helper: returns { loading, error, data, reload }.
export function useAsync(fn, deps = []) {
  const [state, setState] = useState({ loading: true, error: null, data: null });
  const run = useCallback(() => {
    let alive = true;
    setState((s) => ({ ...s, loading: true, error: null }));
    Promise.resolve()
      .then(fn)
      .then(
        (data) => { if (alive) setState({ loading: false, error: null, data }); },
        (error) => { if (alive) setState({ loading: false, error, data: null }); }
      );
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(run, [run]);
  const reload = useCallback(() => { run(); }, [run]);
  return { ...state, reload };
}
