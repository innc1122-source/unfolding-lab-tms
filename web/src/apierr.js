// 服务端的校验失败带 { error, code, field }。error 是「英文字段名 + 中文后缀」拼出来的
// 一句话 —— 服务端不知道读者的语言，只能这样；code/field 才是能本地化的那一半。
//
// 这里不内置任何句子：文案归页面所有（每页有自己的 T = { zh, en }）。页面传一张
// code → 造句 的表，表里没有的 code 原样回落到服务端的 error，所以服务端以后加
// 新 code 时，页面最坏只是少一句本地化，不会变成空白提示。
export function errText(err, map) {
  const data = err && err.data;
  const code = data && data.code;
  const build = code && map && map[code];
  if (build) {
    const text = build(data);
    if (text) return text;
  }
  return (err && err.message) || String(err || '');
}
