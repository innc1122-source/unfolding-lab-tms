// 未保存修改的离开守卫（第二批 2.2，2026-10-08）：useLeaveGuard(active, message) + 全局登记表。
//
// 写法照 ExamRunner.jsx 的三段守卫（ExamRunner 本身不动）：beforeunload 管关页与刷新；捕获阶段拦截站内链接、
// 头像菜单（.um-item）与通知（.notif-item）的点击；后退键用一条同址的历史记录垫底，popstate 时确认。
// 在它基础上修了审查 P1-6 的三处漏洞：
//   (a) 程序化跳转（通知、头像菜单里的 nav()）绕过链接拦截 —— 守卫改成全局登记表：任何地方跳转前都可以调用
//       confirmLeave()（宿主切页签、切部门组、TopBar / NotifBell 的 nav 之前）；.um-item / .notif-item 的点击
//       在捕获阶段已经拦下，那两个文件不改也有效。
//   (b) 每次「有草稿」翻转为真都垫一条历史记录 —— 改成每个挂载只垫一次；守卫解除时垫的那条若还在顶上，
//       顺手撤掉，保存后按一次返回就能离开。垫底标记另放在 usr 里、urlstate.js 改筛选时原样带上，所以守卫期间
//       改过筛选也认得出；那时下面一条还是旧地址，撤掉后把它改成现在的地址再让路由重新渲染，筛选不回退。
//       取消后退时推回的那条就是新的垫底（padHref = 它下面一条的地址），之后确认后退一次就能离开。
//   (c) 后退时 HashRouter 先按旧地址重新渲染，取消离开后筛选被悄悄还原 —— 取消时把地址推回离开前的那个，
//       再补发一次 popstate，让路由按还原后的地址重新渲染。草稿本身另由宿主存进 sessionStorage（DeptCalibration
//       按「周期 + 一级部门」存），即使组件因旧地址重挂也不会丢。
// 用法：useLeaveGuard(dirty, message) —— 必须无条件调用（hook 顺序，审查 P1-17），不要写成 if (dirty) useLeaveGuard()。
// 宿主不想被拦的链接（例如本页内切换筛选的链接）放在 data-leave-ok 的容器里。不 import Semi，员工端可用。
import { useEffect, useRef } from 'react';

const entries = new Map();   // id → { message }
let seq = 0;
let installed = false;
let confirmedAt = 0;         // 刚确认过离开：同一次跳转里不再重复询问（捕获拦截 + 宿主 confirmLeave 各问一次的情况）
let leaving = false;         // 已确认后退离开、正在等那次 popstate
let leavingTimer = 0;
const skips = [];            // 我们自己触发的 popstate（补发的、撤垫的）：各自 1 秒内有效，过期作废（不会吞掉用户之后真正的后退）
let lastHref = '';           // 守卫生效时最后一次渲染的地址（取消后退时用来还原）
let padHref = '';            // 垫底那条记录下面一条的地址（= 垫的时候的地址）
let padOwner = 0;            // 垫底记录归哪个挂载（它的守卫解除时撤掉）
const RECENT_MS = 1500;
// 垫底记录的标记：放在顶层，另在 usr（React Router 的 location.state）里放一份 —— urlstate.js 只改筛选（replace）时
// 把 usr 原样带上，标记就不会被 React Router 的 replaceState 冲掉（审查：原先改一次筛选，保存后垫底那条就撤不掉了）
export const PAD_KEY = '__lgPad';
const padState = (st, id) => {
  const base = st && typeof st === 'object' ? st : {};
  if (base.usr !== null && base.usr !== undefined && typeof base.usr !== 'object') return { ...base, [PAD_KEY]: id };
  return { ...base, [PAD_KEY]: id, usr: { ...(base.usr || {}), [PAD_KEY]: id } };
};
const isPad = (st, id) => !!st && (st[PAD_KEY] === id || (!!st.usr && typeof st.usr === 'object' && st.usr[PAD_KEY] === id));
const LINK_SEL = 'a[href], .um-item, .notif-item, [data-leave-guard]';

const skipPop = () => { skips.push(Date.now() + 1000); };
const recentlyConfirmed = () => Date.now() - confirmedAt < RECENT_MS;
const href = () => { try { return window.location.href; } catch { return ''; } };

// 当前生效的提示语；没有守卫时为 null
export function leaveGuardMessage() {
  for (const e of entries.values()) if (e.message) return e.message;
  return entries.size ? '' : null;
}

// 跳转前调用：没有守卫或用户确认离开 → true；用户取消 → false。
export function confirmLeave(message) {
  if (!entries.size || recentlyConfirmed()) return true;
  const msg = message || leaveGuardMessage() || '';
  // eslint-disable-next-line no-alert
  if (window.confirm(msg)) { confirmedAt = Date.now(); return true; }
  return false;
}

function onBeforeUnload(e) {
  if (!entries.size || recentlyConfirmed()) return undefined;
  const msg = leaveGuardMessage() || '';
  e.preventDefault();
  e.returnValue = msg;
  return msg;
}

function onClickCapture(e) {
  if (!entries.size) return;
  if (e.defaultPrevented || e.button > 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
  const el = e.target && e.target.closest ? e.target.closest(LINK_SEL) : null;
  if (!el) return;
  if (el.closest('[data-leave-ok]')) return;
  if (el.getAttribute && el.getAttribute('target') === '_blank') return;
  if (el.tagName === 'A') {
    const h = el.getAttribute('href') || '';
    if (!h || h === '#' || h.startsWith('javascript:')) return;
  }
  if (!confirmLeave()) { e.preventDefault(); e.stopPropagation(); }
}

function onPop() {
  const now = Date.now();
  while (skips.length && skips[0] < now) skips.shift();
  if (skips.length) { skips.shift(); return; }
  if (leaving) { leaving = false; return; }
  if (!entries.size) return;
  const back = lastHref;
  const landed = href();
  // eslint-disable-next-line no-alert
  if (recentlyConfirmed() || window.confirm(leaveGuardMessage() || '')) {
    confirmedAt = Date.now();
    // 落在垫底记录下面那条（还是本页）→ 再退一步才是真正离开；垫底那条早已用掉时，这一步已经离开了
    if (padHref && landed === padHref) {
      padHref = '';
      padOwner = 0;
      leaving = true;
      clearTimeout(leavingTimer);
      leavingTimer = setTimeout(() => { leaving = false; }, 1000);
      window.history.back();
    }
    return;
  }
  // 取消：地址推回离开前的那个，补发 popstate 让 HashRouter 重新按它渲染（P1-6 (c)）。推回的这条就是新的垫底，
  // 它下面一条是刚落到的地址 —— 之后确认后退时照样再退一步才离开（审查：原先这里清空 padHref，确认后退要按两次）
  try {
    const owner = padOwner || [...entries.keys()][0] || 0;
    window.history.pushState(owner ? padState(window.history.state, owner) : window.history.state, '', back || landed);
    padHref = landed;
    padOwner = owner;
    skipPop();
    window.dispatchEvent(new PopStateEvent('popstate', { state: window.history.state }));
  } catch { /* 极旧浏览器：至少不离开 */ }
}

function install() {
  if (installed) return;
  installed = true;
  leaving = false;
  window.addEventListener('beforeunload', onBeforeUnload);
  document.addEventListener('click', onClickCapture, true);
  window.addEventListener('popstate', onPop);
}
function uninstall() {
  if (!installed || entries.size) return;
  installed = false;
  window.removeEventListener('beforeunload', onBeforeUnload);
  document.removeEventListener('click', onClickCapture, true);
  window.removeEventListener('popstate', onPop);
}

export function useLeaveGuard(active, message) {
  const idRef = useRef(0);
  const paddedRef = useRef(false);
  if (!idRef.current) idRef.current = ++seq;
  const on = !!active;

  // 每次渲染都同步提示语与「守卫中的当前地址」
  useEffect(() => {
    if (!on) return;
    lastHref = href();
    const e = entries.get(idRef.current);
    if (e) e.message = message || '';
  });

  useEffect(() => {
    if (!on) return undefined;
    const id = idRef.current;
    entries.set(id, { message: message || '' });
    install();
    lastHref = href();
    if (!paddedRef.current) {
      paddedRef.current = true;
      padHref = href();
      padOwner = id;
      try { window.history.pushState(padState(window.history.state, id), '', padHref); } catch { /* noop */ }
    }
    return () => {
      entries.delete(id);
      const st = (() => { try { return window.history.state; } catch { return null; } })();
      if (isPad(st, id)) {
        // 守卫解除（保存了 / 组件就地卸载），垫的那条还在顶上（改筛选的 replace 经 urlstate 保留了标记）：撤掉它
        paddedRef.current = false;
        const cur = href();
        const below = padHref;
        padHref = '';
        padOwner = 0;
        skipPop();
        if (below && cur !== below) {
          // 垫底那条被 replace 过（守卫期间改了筛选），下面那条还是旧地址：退回去之后把它改成现在的地址，
          // 再让路由按它重新渲染 —— 撤掉垫底，筛选也不回退
          let timer = 0;
          const fix = () => {
            window.removeEventListener('popstate', fix);
            clearTimeout(timer);
            try {
              window.history.replaceState(window.history.state, '', cur);
              skipPop();
              window.dispatchEvent(new PopStateEvent('popstate', { state: window.history.state }));
            } catch { /* noop */ }
          };
          timer = setTimeout(() => window.removeEventListener('popstate', fix), 1000);
          window.addEventListener('popstate', fix);
        }
        try { window.history.back(); } catch { /* noop */ }
      }
      uninstall();
    };
    // message 的变化由上一个 effect 同步，这里只跟随开关
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [on]);
}

export default useLeaveGuard;
