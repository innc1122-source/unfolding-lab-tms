import { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { api, setUnauthorizedHandler } from './api.js';
// 简化 10/11：登录模块不再直接引 Semi（员工端入口包因此不带 Semi）。换账号 / 退出时要清掉的东西（后台的 Semi 提示）由用到它的模块登记进来。
const sessionResets = new Set();
export function onSessionReset(fn) { sessionResets.add(fn); return () => sessionResets.delete(fn); }
function resetSession() { for (const fn of sessionResets) { try { fn(); } catch { /* CX-044 */ } } }
import { modulePage } from './nextpath.js';

// Auth state for the app. `user` is:
//   undefined  -> still checking (booting)
//   null       -> not logged in
//   { id, name, employeeId, role, aiEnabled, mustChangePassword }
const AuthCtx = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(undefined);

  const refresh = useCallback(async () => {
    try {
      const me = await api.get('/api/me');
      setUser(me);
      return me;
    } catch {
      setUser(null);
      return null;
    }
  }, []);

  // A 401 from any call means the session is gone — reflect that centrally.
  useEffect(() => {
    setUnauthorizedHandler(() => setUser(null));
    // CX-047（2026-10-10 验收）：先探测 /api/env.session（无需登录），没有会话就不打 /api/me，登录页不再留一条 401 在控制台
    api.get('/api/env').then((env) => { if (env && env.session === false) setUser(null); else refresh(); }).catch(() => refresh());
    // CX-094（10/11 上线前测试）：页面从浏览器前进后退缓存还原时（退出登录后点「后退」）重新核对会话；已失效就清掉身份，路由回登录页。
    // 页面外壳已是 no-store（一般不会进这个缓存），这里是保险。
    const onShow = (e) => { if (e && e.persisted) refresh(); };
    window.addEventListener('pageshow', onShow);
    return () => { setUnauthorizedHandler(null); window.removeEventListener('pageshow', onShow); };
  }, [refresh]);

  // next: the sign-in bounce-back (modules/culture/CONTRACT.md 9.5). Login.jsx passes
  // it only when the hash query carried a page of a switched-on module such as
  // /culture/ (modules: /api/env's block, the login page is pre-auth); the
  // server echoes its own whitelisted verdict in the reply (anything else -> "/",
  // including a page of a module that is switched off). When both sides agree
  // and no forced password change is pending, leave with a FULL page load —
  // module pages are served by the server, not by this SPA's routes — and never
  // flip the SPA to the home page first. A pending password change goes through
  // /change-password first: App.jsx carries the next along
  // (/change-password?next=…) and ChangePassword leaves for it with a full load
  // once the new password is saved.
  const login = useCallback(async (employeeId, password, next, modules) => {
    const wanted = modulePage(next, modules);
    const reply = await api.post('/api/auth/login', wanted ? { employeeId, password, next: wanted } : { employeeId, password });
    const target = wanted && reply && typeof reply === 'object' ? modulePage(reply.next, modules) : null;
    if (target) {
      let me = null;
      resetSession();   // CX-044
      try { me = await api.get('/api/me'); } catch { me = null; }
      if (me && !me.mustChangePassword) { window.location.assign(target); return me; }
      if (me) { setUser(me); return me; }
    }
    return refresh(); // pull the canonical identity (incl. role, mustChangePassword)
  }, [refresh]);

  const logout = useCallback(async () => {
    try { await api.post('/api/auth/logout'); } catch { /* ignore */ }
    resetSession();   // CX-044：上一个会话的提示不带进下一个账号
    setUser(null);
  }, []);

  const changePassword = useCallback(async (currentPassword, newPassword) => {
    await api.post('/api/auth/change-password', { currentPassword, newPassword });
    return refresh(); // clears the mustChangePassword flag
  }, [refresh]);

  return (
    <AuthCtx.Provider value={{ user, login, logout, changePassword, refresh }}>
      {children}
    </AuthCtx.Provider>
  );
}

export const useAuth = () => useContext(AuthCtx);
