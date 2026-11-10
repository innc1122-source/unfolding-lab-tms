"use strict";
// 第四批 6.1 题型注册表：题型目录（设计 §1.1）。键、中英文名、分组与行为标志的唯一来源。
// 本文件有一份前端副本 web/src/qtypes/spec.js（纯 ESM、无 import），test/qtypes-spec-parity.test.js 保证两份一致：
// 改这里必须同步改那里（与 categories.js 同一做法）。本文件零依赖，不引用任何其他模块。
//
// 字段：
//   zh / en / shortZh / shortEn  题型名（全称 / 简称）
//   group          抽题分组：objective（mcqCount 抽）、open（openCount 抽）、case（caseCount 抽）
//   qti            对应的 1EdTech QTI 交互类型（只作说明）
//   phase          上线阶段 4a / 4b / 4c
//   defaultPoints  考试未设该题型默认分值时的分值（case 为 null：分值 = 各小题分值之和）
//   partial        部分给分规则：null 无；half 多选半分（考试 multiPartial）；blanks / adjacent / pairs / items 按比例（考试 partialCredit）；
//                  score 简答按得分折算；sub 案例按小题汇总
//   optionOrder    选项顺序：setting 跟随考试 shuffleOptions；fixed 永不打乱；always 永远打乱；
//                  rightAlways 左栏跟随设置、右栏永远打乱；null 无选项
//   caseItem       能否作为情境案例题组的小题（只允许客观题，设计 D3）
const TYPE_ORDER = ["mcq", "multi", "tf", "fill", "cloze", "ordering", "matching", "classify", "open", "case"];

const TYPES = {
  mcq: { zh: "单选题", en: "Single choice", shortZh: "单选", shortEn: "Single", group: "objective", qti: "choiceInteraction", phase: "4a", defaultPoints: 1, partial: null, optionOrder: "setting", caseItem: true },
  multi: { zh: "多选题", en: "Multiple answer", shortZh: "多选", shortEn: "Multiple", group: "objective", qti: "choiceInteraction", phase: "4a", defaultPoints: 1, partial: "half", optionOrder: "setting", caseItem: true },
  tf: { zh: "判断题", en: "True / false", shortZh: "判断", shortEn: "T/F", group: "objective", qti: "choiceInteraction", phase: "4c", defaultPoints: 1, partial: null, optionOrder: "fixed", caseItem: true },
  fill: { zh: "填空题", en: "Fill in the blank", shortZh: "填空", shortEn: "Fill", group: "objective", qti: "textEntryInteraction", phase: "4a", defaultPoints: 1, partial: null, optionOrder: null, caseItem: true },
  cloze: { zh: "多空填空题", en: "Multi-blank fill", shortZh: "多空", shortEn: "Blanks", group: "objective", qti: "textEntryInteraction", phase: "4c", defaultPoints: 1, partial: "blanks", optionOrder: null, caseItem: true },
  ordering: { zh: "排序题", en: "Ordering", shortZh: "排序", shortEn: "Order", group: "objective", qti: "orderInteraction", phase: "4b", defaultPoints: 1, partial: "adjacent", optionOrder: "always", caseItem: true },
  matching: { zh: "匹配题", en: "Matching", shortZh: "匹配", shortEn: "Match", group: "objective", qti: "matchInteraction", phase: "4b", defaultPoints: 1, partial: "pairs", optionOrder: "rightAlways", caseItem: true },
  classify: { zh: "分类题", en: "Classification", shortZh: "分类", shortEn: "Classify", group: "objective", qti: "matchInteraction", phase: "4c", defaultPoints: 1, partial: "items", optionOrder: "setting", caseItem: true },
  open: { zh: "简答题", en: "Short answer", shortZh: "简答", shortEn: "Short", group: "open", qti: "extendedTextInteraction", phase: "4a", defaultPoints: 10, partial: "score", optionOrder: null, caseItem: false },
  case: { zh: "情境案例题组", en: "Scenario case", shortZh: "案例", shortEn: "Case", group: "case", qti: "stimulus", phase: "4b", defaultPoints: null, partial: "sub", optionOrder: "fixed", caseItem: false },
};

// 已开放的题型（阶段开关）。旧四种在前，第四批新题型依次追加在后；前端副本必须逐项相同。
const ENABLED = ["mcq", "multi", "fill", "open", "ordering", "matching", "case", "classify", "tf", "cloze"];

// 题库字段上限（服务端 validate 与前端 validateDraft 同一组数字）
const LIMITS = {
  text: 300,            // 选项 / 步骤 / 左右项 / 类别 / 分类项的每种语言文字
  passage: 4000,        // 案例材料
  blankAnswer: 100,     // 多空填空每个可接受答案
  responseText: 200,    // 学员每空作答
  ordering: { min: 3, max: 8 },
  matching: { min: 2, max: 8, distractorsMax: 3 },
  classify: { catMin: 2, catMax: 5, itemMin: 2, itemMax: 12 },
  cloze: { min: 1, max: 10, answersMax: 10 },
  case: { min: 2, max: 8 },
};

module.exports = { TYPE_ORDER, TYPES, ENABLED, LIMITS };
