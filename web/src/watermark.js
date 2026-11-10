// watermark.js — 课件查看人水印（第三批 5.6，2026-10-08）。
// 文字：「姓名 · 工号 · 日期」（本人的姓名与工号，用于截图、录屏追溯；不是展示他人工号，9.1 的例外）。
// PDF / 转换后的 Office 课件：drawWatermark 直接画进 PdfViewer 的 canvas 像素（截图、打印、全屏都带，删 DOM 去不掉）；
// 视频：watermarkTile 生成一块平铺图，WatermarkedVideo 用作覆盖层背景。
// 纯函数部分（watermarkText、tileGrid）不依赖 DOM，test/watermark.test.js 用 vm 直接跑。

export const WM_ANGLE = -22;            // 度
export const WM_TILE_W = 260;           // CSS px
export const WM_TILE_H = 160;
export const WM_FONT = '13px Inter, "PingFang SC", "Microsoft YaHei", "Noto Sans SC", sans-serif';
export const WM_FILL = 'rgba(20,20,40,0.10)';
export const WM_STROKE = 'rgba(255,255,255,0.14)';

const pad2 = (n) => String(n).padStart(2, '0');
export function localDay(d = new Date()) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

// {name} · {employeeId} · {YYYY-MM-DD}；没有工号（纯管理员账号）时为 {name} · {date}
export function watermarkText(user, d = new Date()) {
  const name = String((user && user.name) || '').trim();
  const eid = String((user && user.employeeId) || '').trim();
  return [name, eid, localDay(d)].filter(Boolean).join(' · ');
}

// 覆盖 w×h 区域所需的平铺锚点（CSS px，画布中心旋转前的坐标）。旋转后四角会露白，
// 所以按对角线向四周多铺一圈；隔行错开半块。
export function tileGrid(w, h, tw = WM_TILE_W, th = WM_TILE_H) {
  const diag = Math.ceil(Math.sqrt(w * w + h * h));
  const half = Math.ceil(diag / 2) + Math.max(tw, th);
  const pts = [];
  let row = 0;
  for (let y = -half; y <= half; y += th, row++) {
    const off = row % 2 ? tw / 2 : 0;
    for (let x = -half - off; x <= half; x += tw) pts.push([x, y]);
  }
  return pts;
}

// 在已渲染好的 canvas 上叠加水印。ctx 的 backing 为 cssW×cssH × dpr。
export function drawWatermark(ctx, cssW, cssH, dpr, text) {
  if (!ctx || !text || !cssW || !cssH) return;
  ctx.save();
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.translate(cssW / 2, cssH / 2);
  ctx.rotate((WM_ANGLE * Math.PI) / 180);
  ctx.font = WM_FONT;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineWidth = 1;
  ctx.strokeStyle = WM_STROKE;
  ctx.fillStyle = WM_FILL;
  for (const [x, y] of tileGrid(cssW, cssH)) {
    ctx.strokeText(text, x, y);
    ctx.fillText(text, x, y);
  }
  ctx.restore();
}

// 视频覆盖层用的平铺图（dataURL）。按「用户 + 文字」缓存（文字含日期，所以跨天自动换图；
// 换人登录同一台电脑时 key 不同，不会沿用上一个人的名字）。
const tileCache = new Map();
export function watermarkTile(text, key = '') {
  if (typeof document === 'undefined' || !text) return '';
  const k = key + '|' + text;
  if (tileCache.has(k)) return tileCache.get(k);
  const dpr = Math.max(1, Math.min(2, (typeof window !== 'undefined' && window.devicePixelRatio) || 1));
  const c = document.createElement('canvas');
  c.width = WM_TILE_W * dpr;
  c.height = WM_TILE_H * dpr;
  const ctx = c.getContext('2d');
  if (!ctx) return '';
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.translate(WM_TILE_W / 2, WM_TILE_H / 2);
  ctx.rotate((WM_ANGLE * Math.PI) / 180);
  ctx.font = WM_FONT;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineWidth = 1;
  ctx.strokeStyle = 'rgba(0,0,0,0.18)';
  ctx.fillStyle = 'rgba(255,255,255,0.28)';
  ctx.strokeText(text, 0, 0);
  ctx.fillText(text, 0, 0);
  let url = '';
  try { url = c.toDataURL('image/png'); } catch { url = ''; }
  if (tileCache.size > 8) tileCache.clear();
  tileCache.set(k, url);
  return url;
}
