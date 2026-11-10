// 课程类别目录（第三批 4.3 / 4.4，2026-10-08；设计 b3-design §1.1，负责人 10/8 确认 4.4 映射并新增「团建」）
//
// 存储值一律是中文键（课程 / 学习包文档的 category 字段仍是自由文本，不加迁移）；界面按语言显示标签。
// 服务端有一份同样的目录 modules/learning/categories.js（G1），两份由 test/course-categories.test.js 核对：
// 键、顺序、英文标签必须一致。改这里的同时改那边。
//
//   CATEGORY_KEYS            目录里的键（按顺序）
//   UNCATEGORIZED            「未分类」的筛选值（课程 category 为空）
//   categoryLabel(key, lang) 显示标签；空值 → 未分类 / Uncategorized；不在目录里的自定义值原样显示
//   categoryRank(key)        排序位置：目录内按顺序，自定义值排在「其他」之后，未分类最后
//   sortCategoryKeys(keys)   按上面的位置排序（自定义值之间按字母）
//   categoryOptions(lang, inUse) 下拉选项 [{label, value}]：目录 + 正在使用的自定义值；value 永远是中文键
//   normalizeCategoryInput(v)    手输 / 旧数据归一：去空格、截 60 字；英文标签（不分大小写）与旧预设映射回中文键；空 → null
// 纯函数、无依赖，测试用 vm 直接跑（test/course-categories.test.js）。

export const CATEGORIES = [
  { key: '合规', en: 'Compliance' },
  { key: '健康与安全', en: 'Wellbeing & Safety' },
  { key: '入职', en: 'Onboarding' },
  { key: '领导力', en: 'Leadership' },
  { key: '管理', en: 'Management' },
  { key: '专业技术', en: 'Professional & Technical' },
  { key: '产品与业务', en: 'Product & Business' },
  { key: '数字与数据', en: 'Digital & Data' },
  { key: '通用', en: 'General Skills' },
  { key: '团建', en: 'Team Building' },
  { key: '其他', en: 'Other' },
];
export const CATEGORY_KEYS = CATEGORIES.map((c) => c.key);
export const UNCATEGORIZED = '__none';

// 旧预设与 Lark 的英文类别名 → 中文键（课程表单旧的 CATEGORY_OPTS、Lark Course Database 的 Category 列）
const ALIASES = {
  safety: '健康与安全', skills: '专业技术', onboarding: '入职', general: '通用',
  'health & safety': '健康与安全', 'wellbeing / safety': '健康与安全', 'health and safety': '健康与安全',
  'soft skills': '通用', 'product / business': '产品与业务', 'professional / technical': '专业技术',
  'digital / data': '数字与数据', 'team-building': '团建', teambuilding: '团建',
  安全: '健康与安全', 技能: '专业技术', 无匹配类别: '其他',
};

const NONE_LABEL = { zh: '未分类', en: 'Uncategorized' };

const isNone = (key) => key == null || key === '' || key === UNCATEGORIZED;

export function categoryLabel(key, lang) {
  const en = lang === 'en';
  if (isNone(key)) return en ? NONE_LABEL.en : NONE_LABEL.zh;
  const hit = CATEGORIES.find((c) => c.key === key);
  if (!hit) return String(key);
  return en ? hit.en : hit.key;
}

export function categoryRank(key) {
  if (isNone(key)) return CATEGORIES.length + 1;
  const i = CATEGORY_KEYS.indexOf(key);
  return i >= 0 ? i : CATEGORIES.length;
}

export function sortCategoryKeys(keys) {
  return [...(keys || [])].sort((a, b) => (categoryRank(a) - categoryRank(b)) || String(a || '').localeCompare(String(b || '')));
}

export function normalizeCategoryInput(v) {
  if (v == null) return null;
  const t = String(v).trim().slice(0, 60);
  if (!t || t === UNCATEGORIZED) return null;
  if (CATEGORY_KEYS.includes(t)) return t;
  const low = t.toLowerCase();
  const byEn = CATEGORIES.find((c) => c.en.toLowerCase() === low);
  if (byEn) return byEn.key;
  if (Object.prototype.hasOwnProperty.call(ALIASES, low)) return ALIASES[low];
  if (Object.prototype.hasOwnProperty.call(ALIASES, t)) return ALIASES[t];
  return t;
}

// inUse：页面上正在使用的类别值（可含空值，空值不进选项；「未分类」由筛选组件单独加）
export function categoryOptions(lang, inUse = []) {
  const custom = [...new Set((inUse || []).map((v) => (v == null ? '' : String(v).trim())).filter((v) => v && v !== UNCATEGORIZED && !CATEGORY_KEYS.includes(v)))];
  return sortCategoryKeys([...CATEGORY_KEYS, ...custom]).map((key) => ({ label: categoryLabel(key, lang), value: key }));
}

// 标准目录之外的值（HR 手输的新类别）：表单上给出提示，看板会把它单独成列
export const isCustomCategory = (key) => !isNone(key) && !CATEGORY_KEYS.includes(key);
