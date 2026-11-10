"use strict";
// 文本与字段辅助（简化 10/11 从 server.js 抽出，函数与注释原样搬）：文本截断、CSV 转义（防公式注入）、
// 下拉选项的中英对照、用户行里 JSON 字段的容错解析。纯函数。

// Free-text fields get a sane ceiling so lists, exports and notification
// templates can't be blown apart by a paste-gone-wrong.
function clampText(v, max) {
  return String(v ?? "").trim().slice(0, max);
}
// ---- select options: a bilingual PAIR of parallel arrays -------------------
// `options[i]` is BOTH the stored value and its English display name;
// `options_zh[i]` is a display name only. Nothing except options[i] is ever
// persisted, which is why splitting the old "Passed 通过" single strings needed
// no data migration: historical details, the passOk regex in
// applyRecordSideEffects and the talent-search facets all keep matching.
// options_zh can be absent (rows written before the split) or short, so every
// read goes through here rather than indexing it directly.
function optionsZhOf(f) {
  const opts = (f && f.options) || [];
  const zh = f && Array.isArray(f.options_zh) ? f.options_zh : [];
  // Equal length, same order, always: a neutral scale (A+, B) has no separate
  // Chinese form, and the client pairs by index — a shorter array would shift
  // every later label onto the wrong option.
  return opts.map((o, i) => (zh[i] ? String(zh[i]) : String(o)));
}
// Incoming value -> canonical options[i]. A Chinese CSV import or a zh UI may
// legitimately carry the Chinese display name; storing that would fork the value
// space in two. null = in neither list, i.e. genuinely invalid.
function canonOption(f, v) {
  const opts = (f && f.options) || [];
  if (!opts.length) return v; // no configured list = free-form select
  if (opts.includes(v)) return v;
  const i = optionsZhOf(f).indexOf(v);
  return i >= 0 ? opts[i] : null;
}
// Chinese display name of an already-canonical value; falls back to the value so
// unpaired options and free-form selects still render something.
function optionZh(f, v) {
  const i = ((f && f.options) || []).indexOf(v);
  return i >= 0 ? optionsZhOf(f)[i] : v;
}
// options_zh off the wire: the settings dialog posts an array, a paste or a bulk
// edit may post one separated string. Result is re-aligned to `options` because
// the pairing is positional — padding with the canonical value beats leaving a
// hole that would silently re-index the rest.
function parseOptionsZh(raw, options) {
  if (raw === undefined || raw === null || raw === "") return null; // let the store keep its zh = en fallback
  const arr = Array.isArray(raw) ? raw.map((o) => String(o).trim()) : String(raw).split(/[,，、]/).map((o) => o.trim());
  return options.map((o, i) => arr[i] || String(o));
}
function parseTags(u) {
  try { return u.talentTags ? JSON.parse(u.talentTags) : []; } catch { return []; }
}
function parseExtras(u) {
  try { return u.extras ? JSON.parse(u.extras) : {}; } catch { return {}; }
}
function csvEscape(v) {
  v = String(v ?? "");
  // CSV formula injection (CWE-1236): Excel/Sheets execute a cell starting with
  // = + - @ or a control char. HR forwards these exports, so neutralise them
  // with a leading apostrophe before the usual quoting.
  if (/^[=+\-@\t\r]/.test(v)) v = "'" + v;
  return /[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
}

module.exports = { clampText, csvEscape, optionsZhOf, canonOption, optionZh, parseOptionsZh, parseTags, parseExtras };
