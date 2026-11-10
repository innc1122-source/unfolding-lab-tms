// 第四批 6.1（2026-10-08，G3）：题型目录 —— 前端副本。
//   与服务端 modules/learning/qtypes/spec.js（G2）逐项一致（键、顺序、中英文标签、分组、默认分值、计分方式、选项顺序、ENABLED），
//   由 test/qtypes-spec-parity.test.js 守住。纯 ESM、不 import 任何东西（测试用 vm 直接跑）。
//   · group：objective 走 mcqCount 抽题，open 走 openCount，case 走 caseCount；
//   · partial：null = 对错两档；half = 多选题部分正确给一半（考试的 multiPartial）；blanks / adjacent / pairs / items = 按答对比例
//     （考试的 partialCredit）；score = 简答题按分数；sub = 案例题组按小题汇总；
//   · optionOrder：setting = 跟随考试「选项顺序」设置；fixed = 从不打乱；always = 总是打乱；rightAlways = 右栏总是打乱、左栏跟随设置；
//     null = 没有选项；
//   · caseItem：可以作为情境案例的小题（只限客观题，D3）。

export const TYPE_ORDER = ['mcq', 'multi', 'tf', 'fill', 'cloze', 'ordering', 'matching', 'classify', 'open', 'case'];

export const TYPES = {
  mcq: { zh: '单选题', en: 'Single choice', shortZh: '单选', shortEn: 'Single', group: 'objective', qti: 'choiceInteraction', phase: '4a', defaultPoints: 1, partial: null, optionOrder: 'setting', caseItem: true },
  multi: { zh: '多选题', en: 'Multiple answer', shortZh: '多选', shortEn: 'Multiple', group: 'objective', qti: 'choiceInteraction', phase: '4a', defaultPoints: 1, partial: 'half', optionOrder: 'setting', caseItem: true },
  tf: { zh: '判断题', en: 'True / false', shortZh: '判断', shortEn: 'T/F', group: 'objective', qti: 'choiceInteraction', phase: '4c', defaultPoints: 1, partial: null, optionOrder: 'fixed', caseItem: true },
  fill: { zh: '填空题', en: 'Fill in the blank', shortZh: '填空', shortEn: 'Fill', group: 'objective', qti: 'textEntryInteraction', phase: '4a', defaultPoints: 1, partial: null, optionOrder: null, caseItem: true },
  cloze: { zh: '多空填空题', en: 'Multi-blank fill', shortZh: '多空', shortEn: 'Blanks', group: 'objective', qti: 'textEntryInteraction', phase: '4c', defaultPoints: 1, partial: 'blanks', optionOrder: null, caseItem: true },
  ordering: { zh: '排序题', en: 'Ordering', shortZh: '排序', shortEn: 'Order', group: 'objective', qti: 'orderInteraction', phase: '4b', defaultPoints: 1, partial: 'adjacent', optionOrder: 'always', caseItem: true },
  matching: { zh: '匹配题', en: 'Matching', shortZh: '匹配', shortEn: 'Match', group: 'objective', qti: 'matchInteraction', phase: '4b', defaultPoints: 1, partial: 'pairs', optionOrder: 'rightAlways', caseItem: true },
  classify: { zh: '分类题', en: 'Classification', shortZh: '分类', shortEn: 'Classify', group: 'objective', qti: 'matchInteraction', phase: '4c', defaultPoints: 1, partial: 'items', optionOrder: 'setting', caseItem: true },
  open: { zh: '简答题', en: 'Short answer', shortZh: '简答', shortEn: 'Short', group: 'open', qti: 'extendedTextInteraction', phase: '4a', defaultPoints: 10, partial: 'score', optionOrder: null, caseItem: false },
  case: { zh: '情境案例题组', en: 'Scenario case', shortZh: '案例', shortEn: 'Case', group: 'case', qti: 'stimulus', phase: '4b', defaultPoints: null, partial: 'sub', optionOrder: 'fixed', caseItem: false },
};

// 已开放的题型（阶段开关）。本批 4a / 4b / 4c 一次合入：老四种在前，新题型接在后面。
export const ENABLED = ['mcq', 'multi', 'fill', 'open', 'ordering', 'matching', 'case', 'classify', 'tf', 'cloze'];

// AI 出题的题型名 → 题库题型（4c 起 truefalse 存为独立的判断题 tf）
export const AI_TYPE_MAP = {
  single: 'mcq', multi: 'multi', truefalse: 'tf', fill: 'fill', open: 'open',
  ordering: 'ordering', matching: 'matching', classify: 'classify', cloze: 'cloze',
};

export const isKnownType = (key) => Object.prototype.hasOwnProperty.call(TYPES, key);
export const isEnabledType = (key) => isKnownType(key) && ENABLED.includes(key);
// 已开放的题型，按目录顺序
export const enabledTypes = () => TYPE_ORDER.filter((k) => ENABLED.includes(k));
export const groupOf = (key) => (isKnownType(key) ? TYPES[key].group : null);
export const objectiveKeys = () => TYPE_ORDER.filter((k) => TYPES[k].group === 'objective');
// 考试「题型默认分值」的键：除案例题组外的全部题型（案例按小题合计）
export const typePointsKeys = () => TYPE_ORDER.filter((k) => k !== 'case');
// 可以作为案例小题的题型（且已开放）
export const caseItemTypes = () => TYPE_ORDER.filter((k) => TYPES[k].caseItem && ENABLED.includes(k));
export const defaultPointsOf = (key) => (isKnownType(key) ? TYPES[key].defaultPoints : null);

// 题型名：typeLabel('mcq', 'zh') → 单选题；typeLabel('mcq', 'en', true) → Single。未知题型原样返回键名。
export function typeLabel(key, lang, short) {
  const t = isKnownType(key) ? TYPES[key] : null;
  if (!t) return String(key == null ? '' : key);
  if (lang === 'zh') return short ? t.shortZh : t.zh;
  return short ? t.shortEn : t.en;
}
