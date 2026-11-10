// 第四批 6.1（2026-10-08，G3）：题型套件的公共部件与文案。
//   · 文案 T（中英同键）供各题型的 Editor / Runner / Review / BankPreview 共用；kt(lang) 取一种语言。
//   · 编辑器部件（管理端，用 Semi）：BiTextRow（中文在上 / 英文在下的一对输入）、MoveButtons（↑↓）、FieldError、EditorShell
//     （题干 + 题型专属区 + 解析；案例小题多出题型、分值）、TypeTag、useDraftTranslate（AI 翻译按钮的 extra）。
//   · 学员端部件（纯 HTML，与现有 exam-* 样式同一套）：locText、ResRow（成绩页的一行）、OPT_KEY。
// 简化 10/11：编辑器部件（含 Semi 与 AI 翻译）拆到 commonEdit.jsx；本文件只剩文案、学员端部件与错误文案，员工端包可以安全引用。


import { typeLabel, caseItemTypes } from './spec.js';
export const T = {
  zh: {
    // 编辑器
    stemZh: '题干（中文）', stemEn: '题干（英文）',
    stemZhPh: '例如 下列哪项属于洗钱行为？', stemEnPh: 'e.g. Which of the following is money laundering?',
    explZh: '解析（中文，选填）', explEn: '解析（英文，选填）',
    explPh: '交卷后向学员说明正确答案的理由', explEnPh: 'Why this is the correct answer (shown after submission)',
    zhPh: '中文', enPh: 'English',
    options: '选项', markCorrect: '正确答案', addOption: '添加选项', removeOpt: '删除选项',
    tfAnswer: '正确答案', tfTrue: '正确', tfFalse: '错误',
    fillAnswers: '可接受答案', fillHint: '每行一个可接受答案，判分时忽略大小写与多余空格', addAnswer: '添加答案', answerPh: '可接受答案',
    removeAnswer: '删除答案',
    rubricZh: '评分要点（中文）', rubricEn: '评分要点（英文）',
    rubricZhPh: '列出得分关键点，供人工阅卷参考…', rubricEnPh: 'Key points graders should look for…',
    moveUp: '上移', moveDown: '下移', remove: '删除',
    stepsH: '步骤', orderingCap: '按正确顺序填写，考试时自动打乱', addStep: '添加步骤', stepN: (n) => `第 ${n} 步`,
    pairsH: '配对', leftH: '左项', rightH: '右项', addPair: '添加配对', pairN: (n) => `配对 ${n}`,
    distractorsH: '干扰项（可选）', distractorsHint: '只出现在右栏、不与任何左项配对', addDistractor: '添加干扰项',
    categoriesH: '类别', addCategory: '添加类别', categoryN: (n) => `类别 ${n}`,
    itemsH: '待分类项目', addItem: '添加项目', itemCat: '所属类别', itemN: (n) => `项目 ${n}`,
    insertBlank: '插入空格', clozeHint: '在题干中点「插入空格」放入 {{1}}、{{2}}…，中英文题干的空格要一一对应',
    blankN: (n) => `第 ${n} 空`, blanksH: '各空的可接受答案', blankAnswersPh: '多个可接受答案用 / 分隔',
    clozeMissing: (list) => `题干缺少空格标记：${list}`, clozeExtra: (list) => `题干里有多余的空格标记：${list}`,
    passageZh: '案例材料（中文）', passageEn: '案例材料（英文）', passagePh: '描述一个真实的工作情境，80–200 字为宜',
    caseTitleZh: '案例标题（中文，选填）', caseTitleEn: '案例标题（英文，选填）',
    subsH: '小题', subN: (n) => `小题 ${n}`, addSub: '添加小题', subType: '小题题型', subPoints: '分值',
    subPointsPh: '按考试默认', caseTotal: (n) => `合计 ${n} 分`, collapse: '收起', expand: '展开',
    retypeAsk: '更换题型会清空这道小题已填写的选项与答案，题干与解析保留。确定更换？', retypeOk: '更换', cancel: '取消',
    ptsOf: (a, b) => `${a} / ${b} 分`,
    counter: (a, b) => `${a} / ${b}`,
    // 校验
    e_required: '必填', e_bad_type: '该题型尚未开放', e_points_range: (min, max) => `分值需为 ${min}–${max} 的整数`, e_duplicate: '与上面的内容重复',
    e_options_min: (min) => `请至少填写 ${min} 个选项`, e_mcq_one_correct: '请选择一个正确答案', e_multi_correct: '请至少选择一个正确答案',
    e_tf_answer: '请选择正确答案', e_fill_answers: '请至少填写一个可接受答案',
    e_cloze_blanks: (min, max) => `空格数量需在 ${min}–${max} 个之间`, e_cloze_answers: (min, max) => `每空需要 ${min}–${max} 个可接受答案`,
    e_cloze_markers: '空格标记 {{1}}…{{n}} 需各出现一次，并与下方的空格一一对应',
    e_too_long: (max) => `不超过 ${max} 字`, e_items_count: (min, max) => `需要 ${min}–${max} 项`,
    e_pairs_count: (min, max) => `需要 ${min}–${max} 组配对`, e_distractors_max: (max) => `干扰项最多 ${max} 个`,
    e_right_duplicate: '右项不能重复', e_categories_count: (min, max) => `需要 ${min}–${max} 个类别`,
    e_cat_required: '请选择所属类别', e_category_empty: '每个类别至少要有一个项目',
    e_subs_count: (min, max) => `案例需要 ${min}–${max} 道小题`, e_case_sub_type: '案例小题只能是客观题',
    // 学员端
    multiHint: '（可多选）',
    fillPlaceholder: '在此填写答案…', openPlaceholder: '在此输入你的答案…',
    blankAria: (n) => `第 ${n} 空`,
    orderHint: '调整顺序后作答完成，或点「确认顺序」', confirmOrder: '确认顺序', orderConfirmed: '已确认顺序',
    orderSelectHint: '点选一项，再点目标位置即可移动；也可以用 ↑ ↓ 调整',
    orderSelected: (t) => `已选中「${t}」，点目标位置放到那里`, movedTo: (t, n) => `「${t}」已移到第 ${n} 位`,
    cancelSelect: '取消选择',
    posText: (n, t) => `第 ${n} 位：${t}`, moveUpT: (t) => `上移「${t}」`, moveDownT: (t) => `下移「${t}」`,
    rightsH: '右栏选项', choose: '请选择', inUse: '已选', matchFor: (t) => `为「${t}」选择匹配项`,
    classifyFor: (t) => `「${t}」的类别`,
    viewCase: '查看案例', hideCase: '收起案例', caseH: '案例材料',
    refresh: '此题型需要更新页面后作答，请刷新',
    // 成绩页
    yourAns: '你的作答', hrAns: '本人作答', hrOrder: '本人排序', hrChoice: '本人选择', correctAns: '正确答案', accepted: '可接受答案', explanation: '解析', notAnswered: '未作答',
    yourOrder: '你的顺序', correctOrder: '正确顺序', pairOk: '相邻正确', item: '项目', yourChoice: '你的选择', correctChoice: '正确选择',
    blankOk: '正确', blankBad: '错误', subQ: (n) => `小题 ${n}`,
    scoreOf: (a, b) => `得分 ${a} / ${b}`, scoreConv: (e, p, a, b) => `得分 ${e} / ${p} 分（评分 ${a} / ${b} 折算）`, yourScore: '你的成绩', feedback: '评语', aiFeedback: 'AI 评语（初评）', aiModel: (m) => `模型 ${m}`,
    demoEstimate: (a, b) => `演示估分（不计分）${a} / ${b}`,
    correct: '正确', incorrect: '错误', partial: '部分正确',
    // 题库预览
    answerKey: '答案', acceptedList: (list) => `可接受答案：${list}`, rubricShort: '评分要点', maxPts: (n) => `满分 ${n}`,
    distractorTag: '干扰项', subCount: (n) => `${n} 道小题`,
  },
  en: {
    stemZh: 'Question (Chinese)', stemEn: 'Question (English)',
    stemZhPh: 'e.g. 下列哪项属于洗钱行为？', stemEnPh: 'e.g. Which of the following is money laundering?',
    explZh: 'Explanation (Chinese, optional)', explEn: 'Explanation (English, optional)',
    explPh: 'Why this is the correct answer (shown after submission)', explEnPh: 'Why this is the correct answer (shown after submission)',
    zhPh: 'Chinese', enPh: 'English',
    options: 'Options', markCorrect: 'Correct', addOption: 'Add option', removeOpt: 'Remove option',
    tfAnswer: 'Correct answer', tfTrue: 'True', tfFalse: 'False',
    fillAnswers: 'Accepted answers', fillHint: 'One accepted answer per row; letter case and extra spaces are ignored when scoring', addAnswer: 'Add answer', answerPh: 'Accepted answer',
    removeAnswer: 'Remove answer',
    rubricZh: 'Grading rubric (Chinese)', rubricEn: 'Grading rubric (English)',
    rubricZhPh: '列出得分关键点…', rubricEnPh: 'Key points graders should look for…',
    moveUp: 'Move up', moveDown: 'Move down', remove: 'Remove',
    stepsH: 'Steps', orderingCap: 'Enter the steps in the correct order; they are shuffled in the exam', addStep: 'Add step', stepN: (n) => `Step ${n}`,
    pairsH: 'Pairs', leftH: 'Left', rightH: 'Right', addPair: 'Add pair', pairN: (n) => `Pair ${n}`,
    distractorsH: 'Distractors (optional)', distractorsHint: 'Shown only in the right-hand column and matched to no left item', addDistractor: 'Add distractor',
    categoriesH: 'Categories', addCategory: 'Add category', categoryN: (n) => `Category ${n}`,
    itemsH: 'Items to classify', addItem: 'Add item', itemCat: 'Category', itemN: (n) => `Item ${n}`,
    insertBlank: 'Insert blank', clozeHint: 'Use "Insert blank" to place {{1}}, {{2}}… in the question; the Chinese and English questions need the same blanks',
    blankN: (n) => `Blank ${n}`, blanksH: 'Accepted answers per blank', blankAnswersPh: 'Separate accepted answers with /',
    clozeMissing: (list) => `Missing blank markers: ${list}`, clozeExtra: (list) => `Extra blank markers: ${list}`,
    passageZh: 'Case scenario (Chinese)', passageEn: 'Case scenario (English)', passagePh: 'Describe a realistic workplace situation, ideally 80–200 words',
    caseTitleZh: 'Case title (Chinese, optional)', caseTitleEn: 'Case title (English, optional)',
    subsH: 'Sub-questions', subN: (n) => `Sub-question ${n}`, addSub: 'Add sub-question', subType: 'Sub-question type', subPoints: 'Points',
    subPointsPh: 'Exam default', caseTotal: (n) => `Total ${n} point${n === 1 ? '' : 's'}`, collapse: 'Collapse', expand: 'Expand',
    retypeAsk: 'Changing the type clears the options and answers entered for this sub-question; the question and explanation are kept. Change it?', retypeOk: 'Change', cancel: 'Cancel',
    ptsOf: (a, b) => `${a} / ${b} pts`,
    counter: (a, b) => `${a} / ${b}`,
    e_required: 'Required', e_bad_type: 'This question type is not available yet', e_points_range: (min, max) => `Points must be a whole number from ${min} to ${max}`, e_duplicate: 'Duplicates an entry above',
    e_options_min: (min) => `Provide at least ${min} options`, e_mcq_one_correct: 'Select one correct answer', e_multi_correct: 'Select at least one correct answer',
    e_tf_answer: 'Select the correct answer', e_fill_answers: 'Provide at least one accepted answer',
    e_cloze_blanks: (min, max) => `Use ${min}–${max} blanks`, e_cloze_answers: (min, max) => `Each blank needs ${min}–${max} accepted answers`,
    e_cloze_markers: 'Markers {{1}}…{{n}} must each appear once and match the blanks below',
    e_too_long: (max) => `At most ${max} characters`, e_items_count: (min, max) => `Needs ${min}–${max} items`,
    e_pairs_count: (min, max) => `Needs ${min}–${max} pairs`, e_distractors_max: (max) => `At most ${max} distractors`,
    e_right_duplicate: 'Right-hand items must be unique', e_categories_count: (min, max) => `Needs ${min}–${max} categories`,
    e_cat_required: 'Select a category', e_category_empty: 'Every category needs at least one item',
    e_subs_count: (min, max) => `A case needs ${min}–${max} sub-questions`, e_case_sub_type: 'Case sub-questions must be objective questions',
    multiHint: '(select all that apply)',
    fillPlaceholder: 'Type your answer here…', openPlaceholder: 'Type your answer here…',
    blankAria: (n) => `Blank ${n}`,
    orderHint: 'Reorder the items, or select "Confirm order"', confirmOrder: 'Confirm order', orderConfirmed: 'Order confirmed',
    orderSelectHint: 'Select an item, then select the position to move it to; or use ↑ ↓',
    orderSelected: (t) => `"${t}" selected. Select the position to move it to`, movedTo: (t, n) => `"${t}" moved to position ${n}`,
    cancelSelect: 'Cancel selection',
    posText: (n, t) => `Position ${n}: ${t}`, moveUpT: (t) => `Move "${t}" up`, moveDownT: (t) => `Move "${t}" down`,
    rightsH: 'Right-hand items', choose: 'Select', inUse: 'In use', matchFor: (t) => `Match for "${t}"`,
    classifyFor: (t) => `Category for "${t}"`,
    viewCase: 'View case', hideCase: 'Hide case', caseH: 'Case scenario',
    refresh: 'Refresh the page to answer this question type',
    yourAns: 'Your answer', hrAns: 'Their answer', hrOrder: 'Their order', hrChoice: 'Their choice', correctAns: 'Correct answer', accepted: 'Accepted answers', explanation: 'Explanation', notAnswered: 'Not answered',
    yourOrder: 'Your order', correctOrder: 'Correct order', pairOk: 'Adjacent pair correct', item: 'Item', yourChoice: 'Your choice', correctChoice: 'Correct choice',
    blankOk: 'Correct', blankBad: 'Incorrect', subQ: (n) => `Sub-question ${n}`,
    scoreOf: (a, b) => `Scored ${a} / ${b}`, scoreConv: (e, p, a, b) => `Scored ${e} / ${p} pts (graded ${a} / ${b}, converted)`, yourScore: 'Your score', feedback: 'Feedback', aiFeedback: 'AI feedback (provisional)', aiModel: (m) => `Model ${m}`,
    demoEstimate: (a, b) => `Demo estimate (not counted) ${a} / ${b}`,
    correct: 'Correct', incorrect: 'Incorrect', partial: 'Partially correct',
    answerKey: 'Answer', acceptedList: (list) => `Accepted: ${list}`, rubricShort: 'Rubric', maxPts: (n) => `Max ${n} pts`,
    distractorTag: 'Distractor', subCount: (n) => `${n} sub-question${n === 1 ? '' : 's'}`,
  },
};
export const kt = (lang) => (lang === 'zh' ? T.zh : T.en);
// CX-149：后台答卷页（audience="hr"）把「你的作答 / 你的顺序 / 你的选择」换成「本人作答 / 本人排序 / 本人选择」
export const ktFor = (lang, audience) => { const s = kt(lang); return audience === 'hr' ? { ...s, yourAns: s.hrAns, yourOrder: s.hrOrder, yourChoice: s.hrChoice } : s; };

// 与 i18n 的 loc 同一规则：中文界面取 field_zh（有的话），否则取 field
export const locText = (obj, field, lang) => {
  if (!obj) return '';
  if (lang === 'zh' && obj[field + '_zh'] != null && obj[field + '_zh'] !== '') return obj[field + '_zh'];
  return obj[field] == null ? '' : obj[field];
};
// 题干的纯文字版：多空填空的 {{n}} 换成「____」（成绩页题头、题库列表、答题卡读屏等不放输入框的地方）
export const stemOf = (obj, lang) => {
  const t = locText(obj, 'question', lang);
  return obj && obj.type === 'cloze' ? String(t).replace(/\{\{(\d+)\}\}/g, ' ____ ') : t;
};
export const OPT_KEY = (i) => String.fromCharCode(65 + i); // 0 -> A
export const listSep = (lang) => (lang === 'zh' ? '；' : ', ');

export function errorMessage(e, lang) {
  const s = kt(lang);
  const m = s['e_' + e.code];
  if (typeof m === 'function') return m.length >= 2 ? m(e.min, e.max) : m(e.min != null ? e.min : e.max);
  return m || e.code;
}
// 恰好落在 field 上的错误（不含下级字段）
export function FieldError({ errors, field, lang }) {
  const list = (errors || []).filter((e) => e.field === field);
  if (!list.length) return null;
  return <div className="qk-err" role="alert">{[...new Set(list.map((e) => errorMessage(e, lang)))].join('；')}</div>;
}

// 错误前缀：案例小题的 errors 带 subs.i. 前缀，传给小题编辑器前去掉
export const scopedErrors = (errors, prefix) => (errors || []).filter((e) => e.field.startsWith(prefix)).map((e) => ({ ...e, field: e.field.slice(prefix.length) }));

// 成绩页的一行：标签 + 内容；tone = ok / bad / ''（沿用 .res-arow）
export function ResRow({ tone, label, children }) {
  return (
    <div className={'res-arow' + (tone ? ' ' + tone : '')}>
      <span className="res-alab">{label}</span>
      <span className="res-aval">{children}</span>
    </div>
  );
}
// 解析行（有才显示）
export function ExplRow({ d, lang }) {
  const e = locText(d, 'explanation', lang);
  if (!e) return null;
  return <ResRow label={kt(lang).explanation}>{e}</ResRow>;
}
