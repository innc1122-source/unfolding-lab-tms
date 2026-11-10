// 全站部门筛选的前端口径（第二批 3.1，2026-10-08）。判定规则只在服务端 modules/core/org.js 一处
// （deptPathOf / deptOptionsOf / deptMatcherOf），这里只消费它的结果，不在前端重写大小写、重名、集团层规则：
//   · useDeptTree()          后台页面用：GET /api/admin/dept-tree 的会话内缓存（5 分钟过期，审查 P2）。
//                            缓存按登录身份（用户 id + 角色 + 后台角色）区分：服务端按各人数据范围裁剪部门树，
//                            同一标签页登出后换账号登录不刷新页面，不能沿用上一个账号的树（波次 3 复核）。
//                            返回 undefined = 加载中；null = 不可用（接口 404：W2-A 合入之前，或无权读部门）；
//                            对象 = { options, idByName, chainById, hasNone }。部门有写操作后调 invalidateDeptTree()。
//   · deptMatcher(tree, id)  (部门原文) => bool，给前端整表过滤的页面（名册、组织架构、九宫格等）。
//   · pathMatcher(id)        (行) => bool，给自带 deptPath 的评估类页面（行的 deptPath 是服务端算好的 id 链）。
//   · deptLayout / searchDepts / optionPath：DeptFilter.jsx 的纯函数（按裁剪后的 parentId 深度分列，审查 P2）。
// 选中值：部门 id、"name:<小写名>" 伪 id（部门不在部门表）、"__none"（无部门）；多选时为数组（任一命中即可）。
import { useEffect, useState } from 'react';
import { api } from './api.js';
import { useAuth } from './auth.jsx';

export const DEPT_NONE = '__none';
const TTL_MS = 5 * 60 * 1000;

let cache = null;          // { at, tree, who }（tree 为 null 表示接口 404；who = 取树时的登录身份）
let inflight = null;       // { who, p }
let version = 0;
const listeners = new Set();

export function invalidateDeptTree() {
  cache = null;
  inflight = null;
  version++;
  for (const fn of listeners) { try { fn(); } catch { /* noop */ } }
}

// 登录身份键：数据范围随账号与后台角色变化；未登录 / 取不到身份 = ''
export const deptTreeWho = (u) => (u ? [u.id, u.role, u.adminRoleId === undefined || u.adminRoleId === null ? '' : u.adminRoleId].join(':') : '');

const fresh = (who = '') => !!cache && cache.who === who && Date.now() - cache.at < TTL_MS;

export function loadDeptTree(who = '') {
  if (fresh(who)) return Promise.resolve(cache.tree);
  if (inflight && inflight.who === who) return inflight.p;
  // 换了身份：丢掉上一个账号的缓存与在途请求（在途请求回来后不再写缓存）
  if (cache && cache.who !== who) cache = null;
  const v = ++version;
  const p = api.get('/api/admin/dept-tree').then(
    (tree) => { if (v === version) { cache = { at: Date.now(), tree: tree || null, who }; inflight = null; } return tree || null; },
    (err) => {
      if (v === version) inflight = null;
      // 404 = 接口还没有（或无权）→ 记为不可用，同样缓存到过期；其他错误不缓存，下次挂载重试
      if (err && err.status === 404) { if (v === version) cache = { at: Date.now(), tree: null, who }; return null; }
      return null;
    },
  );
  inflight = { who, p };
  return p;
}

export function useDeptTree() {
  const auth = useAuth();
  const who = deptTreeWho(auth && auth.user);
  const [tree, setTree] = useState(() => (fresh(who) ? cache.tree : undefined));
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const fn = () => setTick((t) => t + 1);
    listeners.add(fn);
    return () => { listeners.delete(fn); };
  }, []);
  useEffect(() => {
    let alive = true;
    if (fresh(who)) { setTree(cache.tree); return undefined; }
    loadDeptTree(who).then((t) => { if (alive) setTree(t); });
    return () => { alive = false; };
  }, [tick, who]);
  return tree;
}

const ids = (sel) => (Array.isArray(sel) ? sel : sel === null || sel === undefined || sel === '' ? [] : [sel]).map(String);
const lower = (s) => String(s === null || s === undefined ? '' : s).trim().toLowerCase();
const blank = (s) => !String(s === null || s === undefined ? '' : s).trim();

// 部门原文 → 服务端给的 id（先按原文，再按去空白，再不分大小写；都找不到时按伪 id 算）
function idOfName(tree, name) {
  const map = (tree && tree.idByName) || {};
  const raw = String(name);
  if (Object.prototype.hasOwnProperty.call(map, raw)) return map[raw];
  const t = raw.trim();
  if (Object.prototype.hasOwnProperty.call(map, t)) return map[t];
  if (!tree.__lower) {
    const lm = new Map();
    for (const k of Object.keys(map)) { const lk = lower(k); if (!lm.has(lk)) lm.set(lk, map[k]); }
    Object.defineProperty(tree, '__lower', { value: lm, enumerable: false });
  }
  return tree.__lower.get(lower(raw)) || 'name:' + lower(raw);
}

// deptMatcher(tree, sel) → (部门原文) => bool。没有选中 → 全部命中；树还没加载（undefined / null）→ 全部命中（不误删行）。
export function deptMatcher(tree, sel) {
  const want = ids(sel);
  if (!want.length) return () => true;
  const none = want.includes(DEPT_NONE);
  const real = want.filter((x) => x !== DEPT_NONE);
  if (!tree) return () => true;
  const chains = tree.chainById || {};
  return (name) => {
    if (blank(name)) return none;
    if (!real.length) return false;
    const id = idOfName(tree, name);
    const chain = chains[id] || [id];
    return real.some((x) => chain.includes(x));
  };
}

// pathMatcher(sel) → (行) => bool：行的 deptPath（服务端 id 链）含选中的 id；"__none" = 没有部门路径的行
export function pathMatcher(sel) {
  const want = ids(sel);
  if (!want.length) return () => true;
  const none = want.includes(DEPT_NONE);
  const real = want.filter((x) => x !== DEPT_NONE);
  return (row) => {
    const p = row && Array.isArray(row.deptPath) ? row.deptPath : [];
    if (!p.length) return none;
    return real.some((x) => p.includes(x));
  };
}

// ---------- DeptFilter 的纯函数 ----------
// deptLayout(options) → { byId, children: Map(parentKey → [option]), roots, depthOf: Map(id → 0..), maxDepth }
//   根 = parentId 不在 options 里的项（范围裁剪后根可能是二级部门）；分列按裁剪后的深度，不按全树 level（审查 P2）。
//   level 为 null 的伪选项（部门不在部门表）排在根列末尾。
export function deptLayout(options) {
  const list = Array.isArray(options) ? options : [];
  const byId = new Map();
  for (const o of list) if (o && o.id !== undefined && o.id !== null && !byId.has(String(o.id))) byId.set(String(o.id), o);
  const children = new Map();
  const roots = [];
  const pseudo = [];
  for (const o of byId.values()) {
    const p = o.parentId === null || o.parentId === undefined ? null : String(o.parentId);
    if (p && byId.has(p) && p !== String(o.id)) {
      if (!children.has(p)) children.set(p, []);
      children.get(p).push(o);
    } else if (o.level === null || o.level === undefined) pseudo.push(o);
    else roots.push(o);
  }
  roots.push(...pseudo);
  const depthOf = new Map();
  let maxDepth = 0;
  const walk = (o, d, seen) => {
    const id = String(o.id);
    if (seen.has(id)) return;          // 防御：parentId 成环的脏数据
    seen.add(id);
    depthOf.set(id, d);
    if (d > maxDepth) maxDepth = d;
    for (const c of children.get(id) || []) walk(c, d + 1, seen);
  };
  const seen = new Set();
  for (const r of roots) walk(r, 0, seen);
  // 成环残留（理论上不会出现）：当根处理，保证每个选项都可达
  for (const o of byId.values()) if (!seen.has(String(o.id))) { roots.push(o); walk(o, 0, seen); }
  return { byId, children, roots, depthOf, maxDepth };
}

// 选项的显示路径：服务端给的 path，没有时用名称
export const optionPath = (o) => (o ? String(o.path || o.name || o.id) : '');

// 名称与路径不区分大小写匹配；按「名称开头 > 名称包含 > 路径包含」排序，同档按路径
export function searchDepts(options, q, limit = 50) {
  const k = lower(q);
  const list = Array.isArray(options) ? options : [];
  if (!k) return [];
  const scored = [];
  for (const o of list) {
    const n = lower(o.name), p = lower(optionPath(o));
    const s = n.startsWith(k) ? 0 : n.includes(k) ? 1 : p.includes(k) ? 2 : -1;
    if (s >= 0) scored.push([s, optionPath(o), o]);
  }
  scored.sort((a, b) => a[0] - b[0] || a[1].localeCompare(b[1]));
  return scored.slice(0, limit).map((x) => x[2]);
}

// id 链（根 → 本选项），用于展开到选中项所在的列
export function ancestorIds(layout, id) {
  const out = [];
  let cur = layout.byId.get(String(id));
  const seen = new Set();
  while (cur && !seen.has(String(cur.id))) {
    seen.add(String(cur.id));
    out.unshift(String(cur.id));
    const p = cur.parentId === null || cur.parentId === undefined ? null : String(cur.parentId);
    cur = p ? layout.byId.get(p) : null;
  }
  return out;
}
