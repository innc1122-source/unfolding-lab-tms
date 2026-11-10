// 绩效申诉原因分类（绩效看板第二期，负责人 2026-10-10「原因可分类」，迁移 97）。
// 与 server.js 的 APPEAL_CATEGORIES 逐项一致（键、顺序、中英文），test/perf-dashboard-phase23.test.js 核对。
// 员工端（ReviewAppeal.jsx）与后台（ReviewAppeals.jsx、绩效看板「申诉」页签）共用；没有 import，测试可用 vm 直接跑。
export const APPEAL_CATEGORIES = [
  { key: 'rating_mismatch', zh: '评级与实际工作表现不符', en: 'The rating does not reflect my actual performance' },
  { key: 'unclear_criteria', zh: '目标或评估标准不清晰', en: 'Goals or assessment criteria were unclear' },
  { key: 'process', zh: '评估过程不规范（如未面谈、反馈不足）', en: 'The review process was not followed (e.g. no 1-on-1, little feedback)' },
  { key: 'wrong_facts', zh: '依据的事实或数据有误', en: 'The facts or data used were wrong' },
  { key: 'calibration', zh: '校准或名额限制影响了评级', en: 'Calibration or the rating quota affected my rating' },
  { key: 'other', zh: '其他', en: 'Other' },
];
export const UNCATEGORIZED = { zh: '未分类', en: 'Not categorised' };
export function categoryLabel(key, lang) {
  const c = APPEAL_CATEGORIES.find((x) => x.key === key);
  const l = lang === 'zh' ? 'zh' : 'en';
  return c ? c[l] : UNCATEGORIZED[l];
}
