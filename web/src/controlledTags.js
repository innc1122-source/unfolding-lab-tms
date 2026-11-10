// 受控人才标签 · 前端镜像（12.2 工作台改版 组 1，2026-10-09；设计 scratchpad/b12-design.md 第 5.1、5.2、7.5 节）
// 零依赖、无 import 的 ESM。服务端定义在 modules/talent/controlled-tags.js；两份文件「>>> shared」与「<<< shared」之间的代码
// 逐字相同（test/workbench-lib.test.js 比对源码与行为）。改白名单或映射规则必须两边一起改。组 3 / 组 4 只 import、不改本文件。
//
// ───────────────────────────── 导出 API（与服务端同名同义）─────────────────────────────
//   KEYS [hipo,key,flight]；CANONICAL（存储值）；LABELS（{zh,en} 显示名）；ALIASES（白名单）；REASON_MIN = 4、REASON_MAX = 300
//   normKey(tag)、keyOf(tag) → key|null、canonicalOf(tag) → 存储值|null、isCanonical(tag)、isReservedSpelling(tag)
//   parseTags(tags)、controlledKeysOf(tags)（只认 canonical）、heldKeysOf(tags)（任一写法）
//   mapTags(tags) → { tags, changed, mapped }、normalizeTags(tags)、freeTagsOf(tags)（去掉受控写法后的自由标签）
//   applyControlled(tags, key, action) → { tags, changed }、diffControlled(before, after) → { added, removed }
//   checkTagSubmission(current, submitted) → { ok:true, tags } | { ok:false, code:"tag_reserved", field } | { ok:false, code:"controlled_tags_use_endpoint" }
//   reasonOf(text) → 去空白后 4–300 字的字符串 | null
//   labelOf(key, lang)、tagLabel(tag, lang)（canonical → 按语言的显示名，其余原样）
// 页面用法（组 4，设计 7.5）：受控胶囊 = controlledKeysOf(profile.talentTags) 配 labelOf；「其他标签」选项 = freeTagsOf(...)；
// 输入时 keyOf(text) 非空 → 提示「这是受控标签，请在上方选择」并阻止创建；确认框理由用 reasonOf 判断与 REASON_MIN / REASON_MAX 计数。

// >>> shared（与 modules/talent/controlled-tags.js 逐字相同）
const KEYS = Object.freeze(["hipo", "key", "flight"]);
const CANONICAL = Object.freeze({ hipo: "高潜 HiPo", key: "关键人才 Key talent", flight: "流失风险 Flight risk" });
const LABELS = Object.freeze({
  hipo: Object.freeze({ zh: "高潜", en: "High potential" }),
  key: Object.freeze({ zh: "关键人才", en: "Key talent" }),
  flight: Object.freeze({ zh: "流失风险", en: "Flight risk" }),
});
// 白名单只此一处（与前端镜像同一份）。写法在 normKey 之后比较，所以大小写、空白、连字符、全角、首尾 emoji 都不影响。
// 繁体写法一并收录；「核心人才」「骨干」「Retention risk」「待观察」等不是受控标签，保持为自由标签。
const ALIASES = Object.freeze({
  hipo: Object.freeze({
    zh: Object.freeze(["高潜", "高潜力", "高潜人才", "高潛", "高潛力", "高潛人才"]),
    en: Object.freeze(["HiPo", "HiPos", "High potential", "High potentials", "Hi-Potential"]),
  }),
  key: Object.freeze({
    zh: Object.freeze(["关键人才", "關鍵人才"]),
    en: Object.freeze(["Key talent", "Key talents"]),
  }),
  flight: Object.freeze({
    zh: Object.freeze(["流失风险", "离职风险", "流失風險", "離職風險"]),
    en: Object.freeze(["Flight risk", "Flight risks"]),
  }),
});
const REASON_MIN = 4, REASON_MAX = 300;
// emoji 字符类与迁移 85 相同：Extended_Pictographic、肤色修饰、区域指示符、ZWJ、VS16、组合键帽；版权、注册商标、商标、左右与上下双向箭头（U+00A9 U+00AE U+2122 U+2194 U+2195）不算 emoji。
const EMOJI_RE = /[\p{Extended_Pictographic}\p{Emoji_Modifier}\p{Regional_Indicator}\u200D\uFE0F\u20E3]/u;
const EMOJI_KEEP = new Set(["\u00A9", "\u00AE", "\u2122", "\u2194", "\u2195"]);
const SEP_RE = /[\s\-_/|·•()（）[\]【】・‐‑‒–—―−]+/g;
const isEmojiChar = (ch) => !EMOJI_KEEP.has(ch) && EMOJI_RE.test(ch);
const isBlankChar = (ch) => /\s/.test(ch);
function stripEdgeEmoji(s) {
  const cps = Array.from(s);
  let a = 0, b = cps.length;
  while (a < b && (isEmojiChar(cps[a]) || isBlankChar(cps[a]))) a++;
  while (b > a && (isEmojiChar(cps[b - 1]) || isBlankChar(cps[b - 1]))) b--;
  return cps.slice(a, b).join("");
}
function normKey(tag) {
  if (typeof tag !== "string") return "";
  return stripEdgeEmoji(tag.normalize("NFKC")).toLowerCase().replace(SEP_RE, "");
}
const ALIAS_INDEX = (() => {
  const m = new Map();
  for (const k of KEYS) {
    const { zh, en } = ALIASES[k];
    const forms = [CANONICAL[k], ...zh, ...en];
    for (const z of zh) for (const e of en) forms.push(z + e, e + z);
    for (const f of forms) { const n = normKey(f); if (n) m.set(n, k); }
  }
  return m;
})();
const CANON_KEY = new Map(KEYS.map((k) => [CANONICAL[k], k]));
function keyOf(tag) {
  const n = normKey(tag);
  return n ? ALIAS_INDEX.get(n) || null : null;
}
function canonicalOf(tag) {
  const k = keyOf(tag);
  return k ? CANONICAL[k] : null;
}
function isCanonical(tag) { return typeof tag === "string" && CANON_KEY.has(tag); }
function isReservedSpelling(tag) { return !isCanonical(tag) && keyOf(tag) !== null; }
function parseTags(tags) {
  if (Array.isArray(tags)) return tags;
  if (typeof tags === "string" && tags.trim()) {
    try { const v = JSON.parse(tags); return Array.isArray(v) ? v : []; } catch { return []; }
  }
  return [];
}
function controlledKeysOf(tags) {
  const has = new Set();
  for (const t of parseTags(tags)) if (isCanonical(t)) has.add(CANON_KEY.get(t));
  return KEYS.filter((k) => has.has(k));
}
function heldKeysOf(tags) {
  const has = new Set();
  for (const t of parseTags(tags)) { const k = keyOf(t); if (k) has.add(k); }
  return KEYS.filter((k) => has.has(k));
}
function mapTags(tags) {
  const list = parseTags(tags);
  const out = [], seen = new Set(), mapped = [];
  for (const t of list) {
    let v = t;
    if (typeof t === "string") {
      const k = keyOf(t);
      if (k && t !== CANONICAL[k]) { v = CANONICAL[k]; mapped.push({ from: t, key: k }); }
    }
    const id = typeof v === "string" ? "s:" + v : "j:" + JSON.stringify(v);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(v);
  }
  const changed = out.length !== list.length || out.some((v, i) => v !== list[i]);
  return { tags: out, changed, mapped };
}
function normalizeTags(tags) { return mapTags(tags).tags; }
function freeTagsOf(tags) { return parseTags(tags).filter((t) => keyOf(t) === null); }
function applyControlled(tags, key, action) {
  if (!KEYS.includes(key)) throw new TypeError("unknown controlled tag key: " + key);
  if (action !== "add" && action !== "remove") throw new TypeError("unknown action: " + action);
  const list = parseTags(tags);
  const held = list.some((t) => keyOf(t) === key);
  if (action === "add") return held ? { tags: list, changed: false } : { tags: [...list, CANONICAL[key]], changed: true };
  return held ? { tags: list.filter((t) => keyOf(t) !== key), changed: true } : { tags: list, changed: false };
}
function diffControlled(before, after) {
  const a = new Set(heldKeysOf(before)), b = new Set(heldKeysOf(after));
  return { added: KEYS.filter((k) => b.has(k) && !a.has(k)), removed: KEYS.filter((k) => a.has(k) && !b.has(k)) };
}
function checkTagSubmission(current, submitted) {
  const sub = parseTags(submitted);
  for (const t of sub) if (isReservedSpelling(t)) return { ok: false, code: "tag_reserved", field: t };
  const want = controlledKeysOf(sub).join(","), have = heldKeysOf(current).join(",");
  if (want !== have) return { ok: false, code: "controlled_tags_use_endpoint" };
  return { ok: true, tags: normalizeTags(sub) };
}
function reasonOf(text) {
  if (typeof text !== "string") return null;
  const s = text.trim();
  const n = Array.from(s).length;
  return n >= REASON_MIN && n <= REASON_MAX ? s : null;
}
function labelOf(key, lang) {
  const l = LABELS[key];
  return l ? (lang === "en" ? l.en : l.zh) : key;
}
function tagLabel(tag, lang) { return isCanonical(tag) ? labelOf(CANON_KEY.get(tag), lang) : tag; }
// <<< shared

export {
  KEYS, CANONICAL, LABELS, ALIASES, REASON_MIN, REASON_MAX,
  normKey, keyOf, canonicalOf, isCanonical, isReservedSpelling, parseTags, controlledKeysOf, heldKeysOf,
  mapTags, normalizeTags, freeTagsOf, applyControlled, diffControlled, checkTagSubmission, reasonOf, labelOf, tagLabel,
};
