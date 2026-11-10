// CX-109（10/11 上线前测试）：按需加载分包失败时的处理。
// 发版后，已打开的旧页面去取旧的分包文件名，新版里已经没有了 → 浏览器报「Failed to fetch dynamically imported module」，
// React.lazy 抛错整页白屏。这里包一层：分包加载失败就自动刷新一次（拿到新版本的页面外壳与分包）；
// 刷新后仍失败才把错误交给出错兜底卡片（main.jsx 认得这类错误，提示「系统已更新，请刷新」）。
// 用法与 React.lazy 相同；各处以 `import { lazyRetry as lazy }` 引入，声明写法不变。
//
// 复测退回（R179）：原来任一分包加载成功就清除「已刷新过」标记 —— 刷新后外壳分包先成功、把标记清了，
// 失败的那个分包每次都被当成第一次失败，页面每 1～2 秒刷新一次。改为按时间窗：同一标签页 30 秒内最多自动刷新一次，
// 标记不再因别的分包成功而清除；30 秒内再失败就停下来显示提示卡。
import { lazy as reactLazy } from 'react';

const KEY = 'tms-chunk-reload-at';
const WINDOW_MS = 30000;

export function isChunkLoadError(e) {
  const m = String((e && (e.message || e)) || '');
  return /dynamically imported module|Importing a module script failed|error loading dynamically imported module|Loading (CSS )?chunk|Unable to preload CSS/i.test(m);
}

// 是否允许这次自动刷新：30 秒内已经刷新过（或存储不可用）就不再刷新
function mayReload() {
  try {
    const last = Number(sessionStorage.getItem(KEY)) || 0;
    if (Date.now() - last < WINDOW_MS) return false;
    sessionStorage.setItem(KEY, String(Date.now()));
    return true;
  } catch {
    return false;   // 存储被禁用时不自动刷新，直接显示提示卡，避免无法记录次数而反复刷新
  }
}

export function lazyRetry(factory) {
  return reactLazy(() => factory().catch((e) => {
    if (isChunkLoadError(e) && mayReload()) {
      window.location.reload();
      return new Promise(() => {});   // 等刷新，不渲染错误
    }
    throw e;
  }));
}
