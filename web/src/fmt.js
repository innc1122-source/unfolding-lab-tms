// 一致性整改 3（2026-10-09 验收）：日期 / 时间显示只用这两个函数 —— date → YYYY-MM-DD，datetime → YYYY-MM-DD HH:mm（本地时区）。
// 原来 slice(0,10) / slice(0,16) / toLocaleString / fmtDay 五种写法并存；新代码一律走这里，旧页面逐步替换。相对时间另设函数。
const p = (n) => String(n).padStart(2, '0');
const parse = (v) => {
  if (v == null || v === '') return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
  const s = String(v);
  // 纯日期（YYYY-MM-DD）不经时区换算，原样返回
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return { ymd: s };
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
};
export function date(v) {
  const d = parse(v);
  if (!d) return '';
  if (d.ymd) return d.ymd;
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
export function datetime(v) {
  const d = parse(v);
  if (!d) return '';
  if (d.ymd) return d.ymd;
  return `${date(d)} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
// 数字：千分位（4469 → "4,469"），固定 en-US，不随浏览器语言变化。非数字原样返回字符串（简化 10/11：原来 7 个文件各写一份 toLocaleString）
export function num(v) {
  const n = Number(v);
  return v === null || v === undefined || v === '' || !Number.isFinite(n) ? String(v ?? '') : n.toLocaleString('en-US');
}
export const fmt = { date, datetime, num };
export default fmt;
