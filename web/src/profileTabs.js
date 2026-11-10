// 员工档案页签：前端注册表与渲染（ARCHITECTURE-MODULAR.md §5.4 profile.tabs 的前端一半）。
//
// 服务端：模块在 manifest 的 extensions["profile.tabs"] 登记页签；三个档案接口在响应里带
//   tabs: [{ id, module, title: { zh, en }, order }]
// —— 已按 order 排好、只含已开启的模块、已按位置（audience）与能力域过滤：
//   "admin" → GET /api/admin/employees/:id/profile   pages/admin/People.jsx
//   "line"  → GET /api/me/reports/:userId             pages/ReportProfile.jsx
//   "self"  → GET /api/me/growth                      pages/Record.jsx
//
// 前端：下面的 PROFILE_TAB_COMPONENTS 把页签 id 映射到组件，一律 React.lazy（模块代码按需加载，
// 不进首屏包）。登记一个页签 = 在这里加一行：
//
//   import { lazy } from 'react';
//   const PROFILE_TAB_COMPONENTS = Object.freeze({
//     culture: lazy(() => import('./modules/culture/ProfileTab.jsx')),
//   });
//
// 组件收到 { userId, audience }：userId 是被查看者的用户 id（本人位置即自己），audience 同上。
// 组件自己向所属模块的接口请求数据、自己处理加载与空状态与双语文案 —— 这里不替它取数，
// 档案接口也不捎带模块数据。服务端给了、这里却没有组件的页签显示占位「该模块内容即将上线」。
// 页签组件出错（渲染抛异常、分包加载失败）只影响这一块面板，不连累档案页的其余部分。
//
// 现状（2026-09-26）：culture（行为实践）已登记，manifest 里有一个页签（id "culture"，self / line / admin，
// 后台另需 culture 读权限），组件为 ./modules/culture/ProfileTab.jsx（读 GET /api/v1/culture/people/:userId/summary，
// 不含简版 360 度反馈）。culture 缺省关闭：没在 config.json 打开时三个接口的 tabs 恒为 []，<ProfileTabs>
// 渲染为 null，三个页面的 DOM 与加扩展点之前逐一致。
//
// 本文件是 .js（不走 JSX 转换），所以用 createElement 书写。
import { Component, Suspense, createElement as h, useState } from 'react';
import { lazyRetry as lazy } from './lazyRetry.js';   // CX-109：分包加载失败自动刷新一次

// Unfolding Lab 版（2026-10-12）：行为实践（3+3）模块已删除，没有登记任何模块页签。
// eslint-disable-next-line no-unused-vars
const _lazy = lazy;
const PROFILE_TAB_COMPONENTS = Object.freeze({});

// 页签 id → 组件；没有登记的返回 null。只认自有属性（"constructor" 之类的原型键不算登记）。
export function profileTabComponent(id) {
  return Object.prototype.hasOwnProperty.call(PROFILE_TAB_COMPONENTS, id) ? PROFILE_TAB_COMPONENTS[id] : null;
}

// 当前界面语言的页签名；缺一种语言时退到另一种。
export function profileTabTitle(tab, lang) {
  const t = (tab && tab.title) || {};
  return (lang === 'zh' ? t.zh || t.en : t.en || t.zh) || (tab && tab.id) || '';
}

// 服务端的清单形状不对（老服务端没有 tabs、或字段缺失）就当没有页签。
function usableTabs(tabs) {
  if (!Array.isArray(tabs)) return [];
  const seen = new Set();
  return tabs.filter((t) => t && typeof t.id === 'string' && t.id && !seen.has(t.id) && seen.add(t.id));
}

// 一个页签面板的错误边界：key 取页签 id，切换页签即重置。
class TabBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { failed: false };
  }
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(error) { console.error('[profile tab] ' + this.props.tabId + ' crashed:', error); }
  render() { return this.state.failed ? this.props.fallback : this.props.children; }
}

/* <ProfileTabs> —— 三个档案页共用的页签区块。tabs 为空时返回 null（不留任何 DOM）。
   props:
     tabs      服务端给的 tabs 数组
     userId    被查看者的用户 id
     audience  "self" | "line" | "admin"
     lang      'zh' | 'en'
     s         页面自己 T 字典里的四条文案 { label, soon, loading, failed }
               （tablist 的无障碍名 / 占位 / 加载中 / 出错），文案留在各页面的双语字典里
     cls       页面自己的样式类 { wrap, head, bar, tab, on, empty }，沿用各页已有的卡片与筛选胶囊样式
   只有一个页签时不画一排只有一颗的胶囊（选不了任何东西），改为区块标题；两个及以上才是页签条。 */
export function ProfileTabs({ tabs, userId, audience, lang, s, cls }) {
  const [picked, setPicked] = useState(null);
  const list = usableTabs(tabs);
  if (list.length === 0) return null;
  const active = list.find((t) => t.id === picked) || list[0];
  const dom = (t) => 'ptab-' + audience + '-' + t.id;
  const Comp = profileTabComponent(active.id);
  const note = (text) => h('div', { className: cls.empty }, text);

  const head = list.length === 1
    ? h('div', { className: cls.head }, h('h2', { id: dom(active) }, profileTabTitle(active, lang)))
    : h('div', {
      className: cls.bar, role: 'tablist', 'aria-label': s.label,
      // 方向键 / Home / End 在页签之间移动（WAI-ARIA tabs 的键盘约定），焦点跟着选中项走。
      onKeyDown: (e) => {
        const i = list.findIndex((t) => t.id === active.id);
        const j = e.key === 'ArrowRight' ? (i + 1) % list.length
          : e.key === 'ArrowLeft' ? (i - 1 + list.length) % list.length
            : e.key === 'Home' ? 0 : e.key === 'End' ? list.length - 1 : -1;
        if (j < 0) return;
        e.preventDefault();
        setPicked(list[j].id);
        const el = document.getElementById(dom(list[j]));
        if (el) el.focus();
      },
    }, list.map((t) => h('button', {
      key: t.id, type: 'button', role: 'tab', id: dom(t),
      'aria-selected': t.id === active.id, 'aria-controls': dom(t) + '-panel',
      tabIndex: t.id === active.id ? 0 : -1,
      className: cls.tab + (t.id === active.id ? ' ' + cls.on : ''),
      onClick: () => setPicked(t.id),
    }, profileTabTitle(t, lang))));

  const body = Comp
    ? h(Suspense, { fallback: note(s.loading) }, h(Comp, { userId, audience }))
    : note(s.soon);

  return h('section', { className: cls.wrap, 'data-profile-tabs': audience },
    head,
    h('div', {
      role: list.length === 1 ? 'region' : 'tabpanel',
      id: dom(active) + '-panel', 'aria-labelledby': dom(active),
    }, h(TabBoundary, { key: active.id, tabId: active.id, fallback: note(s.failed) }, body)));
}
