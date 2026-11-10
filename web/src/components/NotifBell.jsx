import { useState, useRef, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useI18n } from '../i18n.jsx';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import { modulePage, sitePath, isModulePath } from '../nextpath.js';

// 铃铛独立成组件,因为服务端 notifyAdmins() 也给管理员发通知,而管理端
// 用的是 AdminLayout 自己的头部 —— 两个外壳都要能挂同一个铃铛。
// Standalone so both shells can mount it: the employee TopBar and the admin
// console header, which is a separate component.
const NT = {
  zh: { title: '通知', empty: '暂无通知', markAll: '全部标为已读', just: '刚刚', min: (n) => `${n} 分钟前`, hr: (n) => `${n} 小时前`, day: (n) => `${n} 天前` },
  en: { title: 'Notifications', empty: 'No notifications', markAll: 'Mark all as read', just: 'just now', min: (n) => `${n}m ago`, hr: (n) => `${n}h ago`, day: (n) => `${n}d ago` },
};
function ago(iso, s) {
  const d = (Date.now() - new Date(iso).getTime()) / 1000;
  if (d < 60) return s.just;
  if (d < 3600) return s.min(Math.floor(d / 60));
  if (d < 86400) return s.hr(Math.floor(d / 3600));
  return s.day(Math.floor(d / 86400));
}

// 不接 props:自己取 lang/loc 和 router,调用点只写 <NotifBell />。
// Props-free on purpose, so every mount point stays a one-liner.
export default function NotifBell() {
  const { lang, loc } = useI18n();
  const { user } = useAuth();
  const nav = useNavigate();
  const s = NT[lang] || NT.en;

  const [nOpen, setNOpen] = useState(false);
  const [items, setItems] = useState([]);
  const [unread, setUnread] = useState(0);
  const nRef = useRef(null);
  const refresh = () => api.get('/api/me/notifications')
    .then((d) => { setItems(d.items || []); setUnread(d.unread || 0); })
    .catch(() => {});
  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 60000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    const onDoc = (e) => { if (nRef.current && !nRef.current.contains(e.target)) setNOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') setNOpen(false); };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey); };
  }, []);

  const clickNotif = async (n) => {
    if (!n.read) { try { await api.post('/api/me/notifications/read', { id: n.id }); } catch {} }
    setNOpen(false);
    refresh();
    // 服务端写入的 link 有两种形状:'#/admin/employees'(带 #)和 '/admin/results'
    // (不带)。剥掉前导 # 之后两者都是合法的 router 路径,所以这里两种都能跳,
    // 服务端不必统一 —— 别以为这里漏了处理。
    // Both link shapes are tolerated: stripping a leading '#' leaves a router
    // path either way, so the server side needs no normalising.
    // 第三种:模块自带页面(如行为实践学员端的见证提醒 /culture/#/home)。它不在本 SPA 的路由里,
    // nav() 过去只会落到 404,必须整页打开。服务端给这类通知标 fullPage: true(判定与登录回跳的 next
    // 白名单同一函数);前端再用 nextpath.js 的同一白名单核一遍(开关取 /api/me 的 modules)。
    // 模块已关闭时服务端给 false、它的页面回 404:这类旧通知(如关闭前发出的见证提醒)落回首页,不进 SPA 的 404 页。
    // Module pages (fullPage) open with a full load; a page of a switched-off module goes home; everything else stays in the router.
    if (n.link) {
      const page = modulePage(n.link, user && user.modules) || (n.fullPage === true ? sitePath(n.link) : null);
      if (page) { window.location.assign(page); return; }
      if (isModulePath(n.link)) { nav('/'); return; }
      const to = n.link.replace(/^#/, ''); if (to.startsWith('/')) nav(to);
    }
  };
  const markAll = async () => { try { await api.post('/api/me/notifications/read', {}); } catch {} refresh(); };

  return (
    <div className="notif" ref={nRef}>
      <button className="icon-btn notif-btn" onClick={() => { setNOpen((o) => !o); if (!nOpen) refresh(); }} aria-label={s.title} aria-haspopup="menu" aria-expanded={nOpen}>
        <svg className="ic sm" viewBox="0 0 24 24"><path d="M18 8a6 6 0 10-12 0c0 7-3 9-3 9h18s-3-2-3-9" /><path d="M13.7 21a2 2 0 01-3.4 0" /></svg>
        {unread > 0 && <span className="notif-dot">{unread > 9 ? '9+' : unread}</span>}
      </button>
      {nOpen && (
        <div className="notif-pop" role="menu">
          <div className="notif-head">
            <span>{s.title}</span>
            {unread > 0 && <button className="notif-markall" onClick={markAll}>{s.markAll}</button>}
          </div>
          {items.length === 0 ? (
            <div className="notif-empty">{s.empty}</div>
          ) : (
            <div className="notif-list">
              {items.map((n) => (
                <button key={n.id} className={'notif-item' + (n.read ? '' : ' unread')} onClick={() => clickNotif(n)}>
                  {!n.read && <span className="notif-udot" aria-hidden="true" />}
                  <div className="notif-body">
                    <div className="notif-title">{loc(n, 'title')}</div>
                    {loc(n, 'body') && <div className="notif-sub">{loc(n, 'body')}</div>}
                    <div className="notif-time">{ago(n.createdAt, s)}</div>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
