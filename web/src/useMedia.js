// 媒体查询状态（窄屏改用卡片、弹窗筛选等）。简化 10/11：原来 7 个页面各写一份 useNarrow、总览与工作台各一份 useMedia，统一到这里；
// 断点仍由各页按自己的布局传入。员工端包可用（不引 Semi）。
import { useEffect, useState } from 'react';

const match = (q) => { try { return !!(window.matchMedia && window.matchMedia(q).matches); } catch { return false; } };

export function useMedia(q) {
  const [on, setOn] = useState(() => match(q));
  useEffect(() => {
    let mq;
    try { mq = window.matchMedia && window.matchMedia(q); } catch { mq = null; }
    if (!mq) return undefined;
    const fn = () => setOn(mq.matches);
    fn();
    if (mq.addEventListener) mq.addEventListener('change', fn); else if (mq.addListener) mq.addListener(fn);   // Safari < 14
    return () => { if (mq.removeEventListener) mq.removeEventListener('change', fn); else if (mq.removeListener) mq.removeListener(fn); };
  }, [q]);
  return on;
}
