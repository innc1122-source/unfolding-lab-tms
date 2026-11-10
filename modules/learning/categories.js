"use strict";
// 课程类别目录（第三批 1.1，2026-10-08）。类别仍是课程 / 课程包文档上的自由文本，存中文键；这里给出标准键、顺序与英文名。
// 前端副本 web/src/categories.js，两者由 test/course-categories.test.js 对齐（键、顺序、英文名）。零依赖。
// 不在目录里的值（HR 自己输入的类别）按原样显示，排在「其他」之后、按字母序；null = 未分类（筛选值 "__none"），排最后。

const CATEGORIES = [
  { key: "合规", en: "Compliance" },
  { key: "健康与安全", en: "Wellbeing & Safety" },
  { key: "入职", en: "Onboarding" },
  { key: "领导力", en: "Leadership" },
  { key: "管理", en: "Management" },
  { key: "专业技术", en: "Professional & Technical" },
  { key: "产品与业务", en: "Product & Business" },
  { key: "数字与数据", en: "Digital & Data" },
  { key: "通用", en: "General Skills" },
  { key: "团建", en: "Team Building" },   // 负责人 10/8 新增（4.4）
  { key: "其他", en: "Other" },
];
const NONE = "__none";
const KEY_RANK = new Map(CATEGORIES.map((c, i) => [c.key, i]));
// 英文名（不分大小写）与旧预设 → 中文键。旧预设：Content.jsx 早期的 CATEGORY_OPTS（中英两套不同的存储值）。
const ALIASES = new Map([
  ...CATEGORIES.map((c) => [c.en.toLowerCase(), c.key]),
  ["health & safety", "健康与安全"], ["wellbeing / safety", "健康与安全"],
  ["safety", "健康与安全"], ["skills", "专业技术"], ["onboarding", "入职"], ["general", "通用"],
  ["product / business", "产品与业务"], ["professional / technical", "专业技术"], ["digital / data", "数字与数据"],
  ["soft skills", "通用"], ["general skills", "通用"],
]);
const ZH_ALIASES = new Map([["安全", "健康与安全"], ["技能", "专业技术"]]);

// 排序名次：目录内按目录顺序；目录外的自定义值排在「其他」之后（同名次，调用方再按字母序）；null / "__none" 最后。
function categoryRank(key) {
  if (key == null || key === "" || key === NONE) return CATEGORIES.length + 1;
  return KEY_RANK.has(key) ? KEY_RANK.get(key) : CATEGORIES.length;
}
// 比较两个类别键（用于 sort）
function compareCategory(a, b) {
  const d = categoryRank(a) - categoryRank(b);
  if (d) return d;
  return String(a || "").localeCompare(String(b || ""));
}
// 规范化输入：去首尾空格、限 60 字；空 → null；英文名 / 旧预设 → 中文键；其余原样
function normalizeCategory(v) {
  if (v == null) return null;
  const s = String(v).trim().slice(0, 60);
  if (!s) return null;
  if (KEY_RANK.has(s)) return s;
  if (ZH_ALIASES.has(s)) return ZH_ALIASES.get(s);
  const hit = ALIASES.get(s.toLowerCase());
  return hit || s;
}
// 课程包的类别：自己有就用自己的；没有时，若它的课程都是同一个类别就用那个，否则 null（未分类）
function programCategory(p, getCourse) {
  if (!p) return null;
  if (p.category) return p.category;
  const cats = new Set();
  for (const cid of p.courseIds || []) {
    const c = getCourse ? getCourse(cid) : null;
    if (c) cats.add(c.category || null);
  }
  return cats.size === 1 ? [...cats][0] : null;
}
function categoryLabel(key, lang) {
  if (key == null || key === "" || key === NONE) return lang === "en" ? "Uncategorized" : "未分类";
  if (lang !== "en") return key;
  const c = CATEGORIES.find((x) => x.key === key);
  return c ? c.en : key;
}

module.exports = { CATEGORIES, NONE, categoryRank, compareCategory, normalizeCategory, programCategory, categoryLabel };
