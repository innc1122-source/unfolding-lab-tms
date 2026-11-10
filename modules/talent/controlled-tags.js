"use strict";
// 受控人才标签 · 定义、写法映射与标签状态重建（12.2 工作台改版 组 1，2026-10-09；设计 scratchpad/b12-design.md 第 5 节、2.2、2.8）
// 纯函数，零依赖，不读库。server.js / store.js（组 2：迁移 87、setControlledTag、updateUser 兜底、PUT 校验、工作台高潜保留）require 本文件；
// 前端镜像 web/src/controlledTags.js（组 1 编写，组 3 / 组 4 只 import）。两份文件中「>>> shared」与「<<< shared」之间的代码
// 逐字相同，test/workbench-lib.test.js 比对源码与行为，改白名单必须两边一起改。
//
// ───────────────────────────── 导出 API ─────────────────────────────
// 常量
//   KEYS          ["hipo","key","flight"]（固定顺序：界面胶囊、controlledKeysOf 的输出都按它排）
//   CANONICAL     { hipo:"高潜 HiPo", key:"关键人才 Key talent", flight:"流失风险 Flight risk" }   写进 users.talentTags 的存储值
//   LABELS        { hipo:{zh:"高潜",en:"High potential"}, key:{zh:"关键人才",en:"Key talent"}, flight:{zh:"流失风险",en:"Flight risk"} }
//   ALIASES       { [key]: { zh:[...], en:[...] } }   白名单（第 5.2 节）；可映射写法 = zh ∪ en ∪ zh+en ∪ en+zh（归一化后比较）
//   REASON_MIN = 4、REASON_MAX = 300                  打标理由去首尾空白后的字数（按字符计，不按 UTF-16 码元）
//   ACTIONS       ["add","remove"]；EVENT_SOURCES ["manual","migration","script"]（talent_tag_events.source）
//   RETENTION_KEYS ["hipo","key"]                     高潜与关键人才保留指标（2.2）认的两个标签
//   SCRIPT_REASON  "未经受控标签入口写入"              store.updateUser 兜底写事件用的理由（5.4 第 3 条）
// 写法映射（shared，前端镜像同一份代码）
//   normKey(tag) → string        NFKC → 去首尾 emoji 与空白 → 小写 → 去掉空白与分隔符（- _ / | · • ( ) （ ） [ ] 【 】 ・ 及各种连字符）
//                                非字符串 → ""
//   keyOf(tag) → "hipo"|"key"|"flight"|null      任一可映射写法（含 canonical 本身）→ key；其余（含「高潜 HiPo（2025）」「核心人才」）→ null
//   canonicalOf(tag) → canonical 存储值 | null    = CANONICAL[keyOf(tag)]
//   isCanonical(tag) → bool                       精确等于某个 canonical 值
//   isReservedSpelling(tag) → bool                能映射到受控 key、但不是 canonical 写法（如「HiPo」带 emoji 前缀的「高潜 HiPo」）
//   parseTags(tags) → array                       数组原样；JSON 字符串解析；其余 → []
//   controlledKeysOf(tags) → [key]                只认精确的 canonical 值（工作台、组织诊断计数用，5.5）；按 KEYS 顺序、去重
//   heldKeysOf(tags) → [key]                      任一可映射写法都算（迁移前的旧数据、兜底比较用）；按 KEYS 顺序、去重
//   mapTags(tags) → { tags, changed, mapped:[{ from, key }] }
//                                                 可映射写法替换为 canonical，其余原样；按存储值去重、保留首次出现的位置
//                                                 （非字符串元素按 JSON 去重、原样保留）；changed = 输出与输入不同；
//                                                 mapped = 被替换的原写法（不含本来就是 canonical 的）。迁移 87 第 1、2 步用。
//   normalizeTags(tags) → array                   = mapTags(tags).tags
//   freeTagsOf(tags) → array                      去掉一切能映射到受控 key 的写法后的自由标签（原样）
//   applyControlled(tags, key, action) → { tags, changed }
//                                                 add：未持有（任一写法都不在）→ 末尾追加 canonical；remove：删掉该 key 的所有写法。
//                                                 已持有再 add / 未持有再 remove → changed:false、tags 原样（接口回 unchanged）。
//                                                 key / action 不合法 → 抛 TypeError。
//   diffControlled(before, after) → { added:[key], removed:[key] }   按 heldKeysOf 比较（store.updateUser 兜底写事件用）
//   checkTagSubmission(current, submitted) →      PUT /api/admin/employees/:id 的 talentTags 校验（5.4 第 2 条）
//       { ok:true, tags }                                  tags = normalizeTags(submitted)（只会去重）
//     | { ok:false, code:"tag_reserved", field:<写法> }    提交里有非 canonical 的受控写法（先判这一条）
//     | { ok:false, code:"controlled_tags_use_endpoint" }  提交的受控集合（canonical）与 current 的 heldKeysOf 不同
//   reasonOf(text) → string | null                去首尾空白后 4–300 字 → 该字符串；否则 null（接口回 400 reason_required）
//   labelOf(key, lang) → 显示名                   lang "en" 取英文，其余取中文；未知 key 原样返回
//   tagLabel(tag, lang) → 显示文字                canonical 值 → labelOf；其余原样
// 标签状态重建（只在服务端，2.2）
//   eventDay(event) → "YYYY-MM-DD" | null         effectiveOn；没有时 source = migration → null（日期不详 = 自始持有），
//                                                 其余取 at 的马尼拉日（+08:00）
//   heldOn(events, key, day, currentlyHeld) → bool
//       events = 该人的 talent_tag_events 行（任意 key，函数内按 key 过滤）；按（eventDay，at，id）排序，日期不详的排最前。
//       取 eventDay ≤ day 的最后一条（含 day 当天，故离职日当天 remove → 不持有）：add → 持有，remove → 不持有。
//       没有 ≤ day 的事件：有更晚的事件 → 以最早一条推断（它是 remove 说明此前持有，是 add 说明此前未持有）；
//       该 key 一条事件也没有 → currentlyHeld（「有标签但无事件」视为自始持有）。
//   retentionMetric(people, { exitDayOf(u), exitTypeOf(u), eventsOf(u) }, win) →
//       { exitedIds, voluntaryIds, baseIds, num, den, value }
//       people = 查看者范围内的员工（含已离职；调用方已去掉系统账号）；win = { from, to }（本期 to = 今天）。
//       exitedIds：exitDayOf(u) ∈ win，且离职当天持有高潜或关键人才（heldOn，currentlyHeld 取 heldKeysOf(u.talentTags)）；
//       voluntaryIds：其中 exitTypeOf(u) === "Voluntary"；
//       baseIds（分母）= 季度初在职且持有（heldOn 于 from 前一天；hireDate ≤ from 或为空；未在 from 之前离职）
//                       ∪ 季度内新打上（day ∈ win 的 add 事件、当时在职）∪ exitedIds（保证比率 ≤ 100%）；
//       value = num / den 的百分比，一位小数；den = 0 → null。
//   flightRiskIds(people) → [userId]               在职且 controlledKeysOf 含 flight（工作台「流失风险」本期数）
//   flightSnapshotRows(people, deptNameOf?) → [{ subjectId, deptName, data:{} }]   快照 metric = "flight"（2.8），deptNameOf 缺省 u.department
//   migrationReason(spellings) → "存量标签纳入受控标签（原写法：X、Y）"              迁移 87 补事件的理由

// >>> shared（与 web/src/controlledTags.js 逐字相同）
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

const ACTIONS = Object.freeze(["add", "remove"]);
const EVENT_SOURCES = Object.freeze(["manual", "migration", "script"]);
const RETENTION_KEYS = Object.freeze(["hipo", "key"]);
const SCRIPT_REASON = "未经受控标签入口写入";

const isDay = (v) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);
function manilaDayOf(iso) {
  const t = Date.parse(iso || "");
  return Number.isFinite(t) ? new Date(t + 8 * 3600e3).toISOString().slice(0, 10) : null;
}
function inService(u) {
  return !!u && u.active !== 0 && u.active !== false && u.active !== "0" && u.empStatus !== "exited";
}
function prevDay(day) {
  return new Date(Date.parse(day + "T00:00:00Z") - 86400e3).toISOString().slice(0, 10);
}

function eventDay(e) {
  if (!e) return null;
  if (isDay(e.effectiveOn)) return e.effectiveOn;
  if (e.source === "migration") return null;
  return manilaDayOf(e.at);
}
function sortedEvents(events, key) {
  return (Array.isArray(events) ? events : [])
    .filter((e) => e && e.tagKey === key && (e.action === "add" || e.action === "remove"))
    .map((e) => ({ e, d: eventDay(e) || "0000-00-00" }))
    .sort((x, y) => (x.d < y.d ? -1 : x.d > y.d ? 1 : 0)
      || String(x.e.at || "").localeCompare(String(y.e.at || ""))
      || String(x.e.id || "").localeCompare(String(y.e.id || "")));
}
function heldOn(events, key, day, currentlyHeld) {
  const list = sortedEvents(events, key);
  if (!list.length) return !!currentlyHeld;
  let last = null;
  for (const x of list) { if (x.d <= day) last = x; else break; }
  if (last) return last.e.action === "add";
  return list[0].e.action === "remove";
}
function pct1(num, den) { return den > 0 ? Math.round((num / den) * 1000) / 10 : null; }

function retentionMetric(people, fns, win) {
  const F = fns || {};
  const exitDayOf = typeof F.exitDayOf === "function" ? F.exitDayOf : () => null;
  const exitTypeOf = typeof F.exitTypeOf === "function" ? F.exitTypeOf : () => null;
  const eventsOf = typeof F.eventsOf === "function" ? F.eventsOf : () => [];
  const from = win && win.from, to = win && win.to;
  const exited = [], voluntary = [], base = new Set();
  const startDay = from ? prevDay(from) : null;
  for (const u of Array.isArray(people) ? people : []) {
    if (!u) continue;
    const ev = eventsOf(u) || [];
    const now = new Set(heldKeysOf(u.talentTags));
    const held = (day) => RETENTION_KEYS.some((k) => heldOn(ev, k, day, now.has(k)));
    const xd = exitDayOf(u) || null;
    // 季度初在职且持有
    const hired = !isDay(u.hireDate) || !from || u.hireDate <= from;
    if (startDay && hired && (!xd || xd >= from) && held(startDay)) base.add(u.id);
    // 季度内新打上（当时在职）
    for (const e of ev) {
      if (!e || e.action !== "add" || !RETENTION_KEYS.includes(e.tagKey)) continue;
      const d = eventDay(e);
      if (d && from && to && d >= from && d <= to && (!xd || xd >= d)) { base.add(u.id); break; }
    }
    // 本期离职、离职当天持有
    if (xd && from && to && xd >= from && xd <= to && held(xd)) {
      exited.push(u.id);
      base.add(u.id);
      if (exitTypeOf(u) === "Voluntary") voluntary.push(u.id);
    }
  }
  const baseIds = [...base];
  return { exitedIds: exited, voluntaryIds: voluntary, baseIds, num: exited.length, den: baseIds.length, value: pct1(exited.length, baseIds.length) };
}
function flightRiskIds(people) {
  return (Array.isArray(people) ? people : []).filter((u) => inService(u) && controlledKeysOf(u.talentTags).includes("flight")).map((u) => u.id);
}
function flightSnapshotRows(people, deptNameOf) {
  const dn = typeof deptNameOf === "function" ? deptNameOf : (u) => u.department || null;
  const ids = new Set(flightRiskIds(people));
  return (Array.isArray(people) ? people : []).filter((u) => u && ids.has(u.id)).map((u) => ({ subjectId: u.id, deptName: dn(u) || null, data: {} }));
}
function migrationReason(spellings) {
  const list = [...new Set((Array.isArray(spellings) ? spellings : []).map(String))];
  return list.length ? `存量标签纳入受控标签（原写法：${list.join("、")}）` : "存量标签纳入受控标签";
}

module.exports = {
  KEYS, CANONICAL, LABELS, ALIASES, REASON_MIN, REASON_MAX, ACTIONS, EVENT_SOURCES, RETENTION_KEYS, SCRIPT_REASON,
  normKey, keyOf, canonicalOf, isCanonical, isReservedSpelling, parseTags, controlledKeysOf, heldKeysOf,
  mapTags, normalizeTags, freeTagsOf, applyControlled, diffControlled, checkTagSubmission, reasonOf, labelOf, tagLabel,
  eventDay, heldOn, retentionMetric, flightRiskIds, flightSnapshotRows, migrationReason,
};
