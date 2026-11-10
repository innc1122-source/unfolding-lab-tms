// F48（负责人 2026-10-09）：界面不用 emoji。需要图标时用线性图标，沿用 svg.ic 约定（app.css：16px、
// stroke currentColor、stroke-width 1.8、圆角端点；.sm = 14px）。这里放几处页面共用的小图标，跟随文字颜色。
// 行内放在文字前时用 verticalAlign 让图标落在文字中线上；放在 flex 容器里时 verticalAlign 不起作用，也无副作用。
const INLINE = { verticalAlign: '-0.15em' };
const Ic = ({ children }) => (
  <svg className="ic sm" viewBox="0 0 24 24" aria-hidden="true" focusable="false" style={INLINE}>{children}</svg>
);

// 警示（原 ⚠）
export const IcWarn = () => (
  <Ic><path d="M10.3 3.9L1.8 18a2 2 0 001.7 3h17a2 2 0 001.7-3L13.7 3.9a2 2 0 00-3.4 0z" /><path d="M12 9v4M12 17h.01" /></Ic>
);
// 提示（原 ℹ）
export const IcInfo = () => (
  <Ic><circle cx="12" cy="12" r="9" /><path d="M12 16v-4M12 8h.01" /></Ic>
);
// 链接（原 🔗，富文本工具栏）
export const IcLink = () => (
  <Ic><path d="M10 13a5 5 0 007.5.5l3-3a5 5 0 00-7.1-7.1l-1.7 1.7" /><path d="M14 11a5 5 0 00-7.5-.5l-3 3a5 5 0 007.1 7.1l1.7-1.7" /></Ic>
);
