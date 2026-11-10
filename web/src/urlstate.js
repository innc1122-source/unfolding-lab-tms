// 地址栏状态（第二批 2.3 / 3.1，2026-10-08）：页面的视图、筛选都写进地址栏，通知直达、刷新、返回都能还原。
//
// 规则（设计 0.2 + 审查 P1-15）：
//   · 写参数一律「合并旧参数」：只改传进来的键，其余原样保留，不整串覆盖（旧写法 setSearchParams({}) 会把筛选一并清掉）。
//   · 页面层级的切换（view / unit / item / cycle 的值变了）用 push，安卓返回键回到上一层；只改筛选时用 replace，
//     不给每次输入都垫一条历史记录。调用方可以用 { push: true|false } 明确指定。
//   · 读参数用 window.location.hash（HashRouter）：同一轮里连写两次时，第二次基于第一次写完的地址，不会用渲染时的旧值互相覆盖。
//   · replace 时保留当前记录的 location.state（离开守卫的垫底标记在里面，见 useLeaveGuard.js）。
// 纯函数（mergeParams / shouldPush / paramsOf）不依赖 React，test/deptcal-ui.test.js 用 vm 直接跑。
import { useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';

// 校准组件（员工端部门校准、后台部门明细）的筛选键 —— 两端同名同义
export const REVIEW_FILTER_KEYS = ['q', 'dept', 'mgr', 'lv', 'one', 'mr', 'adj', 'hl', 'od', 'tier', 'pending', 'sort', 'flat'];
// 后台周期看板的筛选键
export const BOARD_KEYS = ['dept', 'mgr', 'lv', 'stage'];
// 后台周期列表的筛选键（切视图、开部门明细时都保留）
export const LIST_KEYS = ['kind', 'status', 'year'];
// 整页编辑 / 详情的页面键：退出整页时只删这些，筛选参数留着
export const PAGE_KEYS = ['edit', 'new', 'learn', 'attempt'];
// 页面层级键：值变了 = 进了另一层页面，用 push
export const PUSH_KEYS = ['view', 'unit', 'item', 'cycle'];

const empty = (v) => v === null || v === undefined || v === '' || v === false;

// prev（URLSearchParams | string | object）合并 set（{ 键: 值 }，值为 null / undefined / '' / false 表示删除；数组 = 多值）
// 再删掉 clear 里的键（clear 在 set 之后执行，但 set 里明确给了值的键不删）。返回新的 URLSearchParams。
export function mergeParams(prev, set, clear) {
  const next = new URLSearchParams(prev instanceof URLSearchParams ? prev.toString() : typeof prev === 'string' ? prev : undefined);
  if (prev && !(prev instanceof URLSearchParams) && typeof prev === 'object') {
    for (const [k, v] of Object.entries(prev)) if (!empty(v)) next.set(k, String(v));
  }
  const given = new Set();
  for (const [k, v] of Object.entries(set || {})) {
    next.delete(k);
    if (Array.isArray(v)) { for (const x of v) if (!empty(x)) { next.append(k, String(x)); given.add(k); } }
    else if (!empty(v)) { next.set(k, String(v === true ? '1' : v)); given.add(k); }
  }
  for (const k of clear || []) if (!given.has(k)) next.delete(k);
  return next;
}

// 页面层级键有没有变（决定 push 还是 replace）
export function shouldPush(prev, next, keys = PUSH_KEYS) {
  const a = prev instanceof URLSearchParams ? prev : new URLSearchParams(prev || '');
  const b = next instanceof URLSearchParams ? next : new URLSearchParams(next || '');
  return keys.some((k) => (a.get(k) || '') !== (b.get(k) || ''));
}

// URLSearchParams → 普通对象（同名多值时取第一个）
export function paramsOf(sp) {
  const out = {};
  for (const [k, v] of sp) if (!(k in out)) out[k] = v;
  return out;
}

// 当前地址的查询串：HashRouter 下是 # 后面「?」之后的部分
function currentSearch(fallback) {
  try {
    const h = window.location.hash || '';
    const i = h.indexOf('?');
    if (h.startsWith('#/')) return i >= 0 ? h.slice(i + 1) : '';
  } catch { /* 非浏览器环境 */ }
  return fallback ? fallback.toString() : '';
}

// [params, patch]：params 是当前参数的普通对象；patch(set, { clear, push }) 合并写回。
//   patch({ cycle: id, unit: null }, { clear: REVIEW_FILTER_KEYS })   // 换周期：push（cycle 变了），清掉校准筛选
//   patch({ q: text })                                                  // 筛选：replace
export function useUrlState() {
  const [sp, setSp] = useSearchParams();
  const params = useMemo(() => paramsOf(sp), [sp]);
  const patch = useCallback((set, opts = {}) => {
    const prev = new URLSearchParams(currentSearch(sp));
    const next = mergeParams(prev, set, opts.clear);
    if (next.toString() === prev.toString()) return;
    const push = typeof opts.push === 'boolean' ? opts.push : shouldPush(prev, next);
    // replace（只改筛选、还在同一页）时把当前记录的 location.state（usr）原样带上：离开守卫垫底记录的标记放在这里，
    // 不带的话 React Router 的 replaceState 会把它冲掉，保存后垫底那条就撤不掉了（useLeaveGuard.js）
    let state;
    if (!push) { try { const h = window.history.state; state = h && h.usr != null ? h.usr : undefined; } catch { state = undefined; } }
    setSp(next, state === undefined ? { replace: !push } : { replace: true, state });
  }, [sp, setSp]);
  return [params, patch];
}
