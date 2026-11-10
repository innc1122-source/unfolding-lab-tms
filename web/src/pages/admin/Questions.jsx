import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  Table, Modal, Button, Tag, Select, Input, TextArea, Popconfirm, Spin,
  Toast, Typography, Banner, Empty, Space, Checkbox, InputNumber,
} from '@douyinfe/semi-ui';
import {
  IconPlus, IconSearch, IconEdit, IconDelete, IconBolt, IconUpload, IconExport, IconArrowLeft, IconDownload,
} from '@douyinfe/semi-icons';
import { api, useAsync } from '../../api.js';
import { useAuth } from '../../auth.jsx';
import { AiTranslateButton } from '../../components/AiTranslate.jsx';
import { BULK_SEL_EXTRA, useBulkSelection, BulkBar, BulkConfirmModal, useBulkRunner } from '../../components/BulkActions.jsx';
import { useI18n } from '../../i18n.jsx';
import { PAGE_TIERS, DEFAULT_PAGE, useDataVersion, clampPage } from '../../pagesize.js';
import { resizableTable } from '../../cardify.js';
import { canUseAction } from '../../rbac.js';
import { errText } from '../../apierr.js';
import { impParseGrid, impSplitPaste, impItems, impExportGrid } from './questionImport.js';
// 第四批 6.1（2026-10-08）：题型注册表 —— 编辑器、题库预览、题型名、编辑稿 ⇄ 请求体都从 web/src/qtypes 来，
// 本页不再自己维护五种题型的界面词（single / multiple / truefalse / short）与 toRow / buildBody / draftToBody。
import {
  qtype, TypeTag, useDraftTranslate, errorMessage, stemOf as qStemOf, typeLabel as qTypeLabel,
  enabledTypes, AI_TYPE_MAP, TYPE_ORDER,
} from '../../qtypes/index.jsx';
import {
  toDraft, toBody, emptyDraft, changeType, hasTypeContent, validateDraft, caseTotal, fromAiDraft, fromAiCase,
} from '../../qtypes/model.js';

const { Text } = Typography;

/* ---------------- co-located bilingual strings ---------------- */
const T = {
  zh: {
    title: '题库',
    lead: '维护各课程的题目：单选、多选、判断、填空、多空填空、排序、匹配、分类、简答与情境案例题组，可用 AI 辅助起草，支持批量导入与导出。',
    total: '全部',
    totalText: (n) => `共 ${n} 条`,
    searchPh: '搜索题干…',
    courseAll: '全部课程',
    add: '新增题目', aiGen: 'AI 生成题目',
    mobileHint: 'AI 出题与批量导入建议在桌面端操作。',
    colType: '题型', colStem: '题干', colCourse: '关联课程', courseGone: '已删除的课程', colAction: '操作',
    colPoints: '分值', ptsDefault: '按考试默认', fPoints: '分值', fPointsPh: '留空 = 按考试的题型默认分值', fPointsHint: '每道题的分值。留空时按所在考试「题型默认分值」计；旧考试仍按原口径（客观题 1 分、简答按满分折算）。',
    edit: '编辑', del: '删除',
    // per-type answer / grading cue under the stem
    hintMulti: (n) => `正确答案 ${n} 项 · 少选得一半分`,
    hintFill: (list) => `可接受答案：${list}`,
    hintShort: '开启 AI 时由 AI 初评 · 分数决定是否通过时须 HR 复核',
    hintCase: (n) => `情境案例 · ${n} 小题`,
    hintCloze: (n) => `${n} 个空 · 按答对的空给分`,
    hintOrdering: (n) => `${n} 个步骤 · 考试时自动打乱`,
    hintMatching: (p, d) => `${p} 组配对${d ? ` · ${d} 个干扰项` : ''}`,
    hintClassify: (c, i) => `${c} 个类别 · ${i} 个项目`,
    hintUnsupported: '此题型需要更新页面后才能查看与编辑',
    delTitle: '删除题目', delConfirm: '确定删除该题目？此操作不可撤销。',
    bulkDel: (n) => `删除所选（${n}）`,
    bulkDelTitle: (n) => `删除 ${n} 道题目`, bulkDelConfirm: '确定删除所选题目？此操作不可撤销。',
    bulkDelOk: (n) => `已删除 ${n} 道题目`, bulkDelPart: (ok, n) => `已删除 ${ok}/${n} 道，其余失败：`,
    // 批量改分值 / 改课程与模块（2026-10-06 SPEC-bulk-ops B4）：服务端原地修改，题目 id 不变
    bulkPoints: '批量改分值', bulkCourse: '批量改课程/模块',
    bulkPtsLabel: '分值（1–100 的整数）', bulkPtsDefault: '恢复为按考试默认分值',
    bulkPtsHint: '固定题目考试的卷面总分随之更新；已开始的作答不受影响。情境案例的分值按小题合计，不在此修改，会在结果中列出。',
    bulkCourseLabel: '所属课程', bulkCoursePh: '选择这些题目要移入的课程', bulkModuleLabel: '所属模块（可不选）', bulkModulePh: '不指定模块',
    bulkCourseHint: '更换课程的题目，所属模块会清空（与单题修改一致）；选了模块则统一设为该模块。题目 id 不变。被固定题目考试使用、而新课程不在该考试关联课程中的题目会跳过并在结果中列出，以免该考试下次保存时丢题；随机抽题考试的题目池若因此少于抽题数，结果中会提示。',
    // 转为判断题（第四批 4c，设计 §1.10）：只转「正确 / 错误」两个选项的单选题，逐题 PUT，绝不自动转换
    bulkTf: '转为判断题', bulkTfTitle: '转为判断题',
    bulkTfLead: (n, m) => `所选 ${n + m} 道中有 ${n} 道是「正确 / 错误」两个选项的单选题，将转为判断题${m ? `；其余 ${m} 道不符合，不会改动` : ''}。`,
    bulkTfNone: '所选题目中没有「正确 / 错误」两个选项的单选题。',
    bulkTfHint: '题干、解析、分值、所属课程与题目 id 都不变，正确答案沿用原来勾选的选项。已开始的作答不受影响。',
    bulkTfOk: (n) => `已转为判断题 ${n} 道`, bulkTfPart: (ok, n) => `已转换 ${ok}/${n} 道，其余失败：`,
    cancel: '取消',
    loadErr: '加载失败，请刷新页面重试。', retry: '重试',
    // 整页编辑器
    addTitle: '新增题目', editTitle: '编辑题目',
    fType: '题型', fCourse: '关联课程', fCoursePh: '选择题目所属课程',
    reqCourse: '请选择关联课程',
    typeDesc: {
      mcq: '一个正确答案', multi: '一个或多个正确答案，少选可得一半分', tf: '判断一句话正确或错误',
      fill: '一个空，填写文字作答', cloze: '题干里多个空，按答对的空给分', ordering: '把步骤排成正确顺序',
      matching: '左右两栏一一配对，可加干扰项', classify: '把项目归入各个类别', open: '文字作答，AI 初评、HR 复核',
      case: '一段情境材料，下设 2–8 道客观小题',
    },
    typeChangeTitle: '更换题型？', typeChangeAsk: '更换题型会清空当前题型已填写的选项与答案；题干、解析与分值保留。', typeChangeOk: '更换题型',
    caseTotal: (n) => `合计 ${n} 分`, casePtsHint: '情境案例的分值是各小题分值之和，在右侧逐个小题设置；小题不填时按考试的题型默认分值。',
    fixErrs: '还有需要修改的地方，请查看标红的字段。',
    save: '保存',
    createdOk: '题目已新增', updatedOk: '题目已更新', deletedOk: '题目已删除',
    // AI 整页
    aiTitle: 'AI 生成题目',
    aiLead: '选择材料来源与各题型数量，AI 将起草题目供你逐题审阅、采纳或丢弃。',
    aiDemo: '演示模式：未接入 AI 服务，返回的是标注「演示样题」的占位题，不是 AI 生成的内容。',
    aiOutbound: '材料会发送给公司指定的 AI 服务处理，请勿粘贴含个人信息的内容（系统会去除邮箱、电话等标识，但无法识别所有个人信息）。',
    aiSource: '材料来源', aiSrcPaste: '粘贴材料', aiSrcCourse: '从所选课程内容生成',
    aiCounts: '各题型数量（合计 1–20 题，每组情境案例按 3 题计）', aiCases: '情境案例（组）', aiTotal: (n) => `合计 ${n} / 20`,
    aiSourceQuote: '出题依据', aiSimilar: '疑似与题库重复', aiDemoTag: '演示样题',
    aiDiff: { easy: '易', medium: '中', hard: '难' },
    aiCourse: '目标课程',
    aiErrs: {
      ai_rate_limited: (d) => `出题过于频繁，请 ${Math.max(1, Math.ceil((d.retryAfterSec || 60) / 60))} 分钟后再试。`,
      ai_budget_exhausted: () => '本月 AI 用量已达上限（由 IT 调整 ai.budget.monthlyTokens）。',
      ai_not_configured: () => 'AI 服务尚未接入，请联系 IT 按 HANDOVER-IT §10 配置。',
      ai_feature_off: () => 'AI 出题未开启。',
      ai_timeout: () => 'AI 服务响应超时，请稍后再试（出题超时后不会自动重试，以免重复计费）。',
      ai_output_invalid: () => 'AI 生成的题目结构不完整，请重试或减少题数。',
      ai_output_truncated: () => 'AI 生成内容不完整，请减少题数后重试。',
      ai_input_too_large: () => '材料过长（上限 60,000 字），请缩短后重试。',
      material_too_short: (d) => (d && d.source === 'course'
        ? '这门课的正文和附件（PDF / Word / PPT）里能读到的文字不足 100 字。扫描版 PDF、视频读不出文字，请改用「粘贴材料」。'
        : '请提供至少几段培训材料（不少于 100 字）。'),
      bad_counts: () => '请生成 1 至 20 道题。',
      bad_ai_call: () => '这份草稿不属于当前账号，请重新生成。',
    },
    aiMaterial: '培训材料', aiMaterialPh: '在此粘贴课程讲义、政策条款或知识点（至少 100 字）…',
    aiGenerate: '生成题目', aiRegen: '重新生成', aiGenerating: '生成中…',
    aiEmpty: '填写材料后点击“生成题目”，AI 起草的题目将显示在此。',
    aiDrafts: 'AI 起草结果', aiAdopt: '采纳', aiDiscard: '丢弃',
    aiTweak: '修改', aiTweakTitle: '修改 AI 草稿',
    aiAdoptAll: '全部采纳', aiClear: '清空',
    aiAdoptedOk: '已采纳并加入题库',
    aiAdoptPartial: (ok, bad) => `已采纳 ${ok} 题；${bad} 题未通过校验，仍留在列表中`,
    aiAdoptedAllOk: (n) => `已采纳 ${n} 道题目`,
    aiNeedMaterial: '请先粘贴培训材料',
    aiNeedCourse: '请先选择目标课程',
    aiReviewTag: '待审阅',
    // 导出（第四批 D12：与导入模板同一版式，导出的文件可原样再导入）
    exp: '导出题库', expOk: (n) => `已导出 ${n} 题`, expSkip: (n) => `${n} 题的题型需要更新页面后才能导出，已跳过`,
    expEmpty: '当前筛选下没有可导出的题目。', expFail: '导出失败，请重试。',
    // bulk import
    imp: '批量导入', impTitle: '批量导入题目',
    impHint: 'Excel 直接粘贴，首行表头自动匹配（列序随意）；逐行检查无误后再导入。题干、选项 A–L、解析、分类分「中文」「英文」两列填写，只填一种语言也可以；旧模板的单语列按中文导入。题型可填单选、多选、判断、填空、多空填空、排序、匹配、分类、问答、案例，各题型的写法见模板的「填写说明」页。每次最多 200 题（一组案例连同小题算 1 题）。',
    impPaste: 'Excel 直接粘贴',
    impPastePh: '在 Excel 里选中区域复制，直接粘贴到此。首行请写表头：题型 / 题干(中文) / Stem (EN) / 选项A(中文) / Option A (EN)…L / 正确答案 / 解析(中文) / Explanation (EN) / 分值 / 案例编号 / 分类(中文) / Categories (EN)，顺序不限。',
    impHeaderOk: (n) => `已按首行表头匹配 ${n} 列`,
    impNoHeader: '未识别首行表头，按模板列序读取',
    impLangSplit: '中英文分列', impLangMono: '单语列 · 按中文导入',
    impTmpl: '下载 Excel 模板', impPick: '上传表格（.xlsx / .csv）',
    impCourse: '导入到课程', impCoursePh: '选择这批题目所属的课程',
    impNeedCourse: '请先选择导入到哪门课程',
    impStat: (ok, bad) => `可导入 ${ok} 题${bad ? ` · ${bad} 行有问题将被跳过` : ''}`,
    impEmpty: '表格里没有读到题目（需要「题型」与至少一列题干）',
    impFileFail: '文件读取失败，请确认是 .xlsx 或 .csv 格式',
    impConfirm: '确认导入', impDoneN: (n) => `已导入 ${n} 题`,
    impSkipN: (n) => `${n} 题被跳过（校验未通过）`,
    impColRow: '行', impColType: '题型', impColStem: '题目', impColAns: '答案', impColState: '检查',
    impOkTag: '可导入', impSubTag: '小题',
    // Each message names what is wrong with THIS row — the accepted type words
    // and column rules live in the banner above the table, not in every cell.
    impErrType: '题型无法识别', impErrStem: '中英文题干都为空', impErrTypeStem: '缺题型与题干',
    impErrPhase: '该题型尚未开放',
    impErrOpts: '选项不足 2 个',
    impErrRange: (l) => `答案 ${l} 不在选项范围`,
    impErrNoAns: '未填正确答案', impErrSingle: '单选只能有 1 个正确答案',
    impErrTf: '判断题答案请填 对 或 错',
    impAnsTrue: '对', impAnsFalse: '错', impAnsPoints: (n) => `${n} 分`,
    impErrFill: '填空需在「正确答案」列填至少一个答案',
    impErrLong: (max) => `有内容超过 ${max} 字`,
    impErrOrderN: (min, max) => `排序题需要 ${min}–${max} 个步骤`,
    impErrOrderSeq: '「正确答案」的字母顺序要把每个选项各写一次，如 CADB',
    impErrOrderDup: '排序题的步骤不能重复',
    impErrArrow: (l) => `选项 ${l} 请写成「左项 => 右项」`,
    impErrPairs: (min, max) => `匹配题需要 ${min}–${max} 组配对`,
    impErrDistractors: (max) => `干扰项最多 ${max} 个`,
    impErrDupRight: '匹配题的右项不能重复',
    impErrCats: (min, max) => `分类列需要 ${min}–${max} 个类别（用 | 分隔）`,
    impErrCatUnknown: (l, name) => `选项 ${l} 的类别「${name}」不在分类列中`,
    impErrClassItems: (min, max) => `分类题需要 ${min}–${max} 个项目`,
    impErrCatEmpty: '每个类别至少要有一个项目',
    impErrMarkers: '题干要用 {{1}}…{{n}} 标出空格，每个出现一次，中英文题干一致',
    impErrBlankAns: '「正确答案」请按「1: 答案 ; 2: 答案」为每个空填写',
    impErrCaseId: '案例行要填「案例编号」，如 C1',
    impErrCaseDup: (id) => `案例编号 ${id} 重复`,
    impErrCaseOrder: (id) => `小题要写在案例 ${id} 那一行之后`,
    impErrCaseUnknown: (id) => `没有案例编号为 ${id} 的案例行`,
    impErrCaseSub: '案例小题只能是客观题（不能是问答或案例）',
    impErrCaseBadSub: (rows) => `第 ${rows} 行小题有问题`,
    impErrCaseN: (min, max) => `案例需要 ${min}–${max} 道小题`,
    impAnsPairs: (p, d) => `${p} 组配对${d ? ` + ${d} 个干扰项` : ''}`,
    impAnsCats: (c, i) => `${c} 类 · ${i} 项`,
    impAnsSubs: (n) => `${n} 小题`,
    // 只读档(learning=read)的说明:写接口服务端一律 403,按钮留着就是「假按钮」。
    roWrite: '只读权限：当前角色对培训只能查看、不能修改，写操作不可用；如需操作请联系超级管理员调整授权。',
    // 整页（编辑题目、AI 生成题目）
    backToList: '返回题库', backToAi: '返回 AI 生成题目',
    qNewSub: '选择题型与所属课程，填写题干和答案后保存。',
    qDraftSub: '来自 AI 起草的题目，保存后加入题库并从草稿列表移除。',
    qNotFound: '找不到这道题目，可能已被删除。', loading: '加载中…',
    edSettings: '题目设置', edContent: '题干与答案',
    discardTitle: '放弃未保存的修改？', discardAsk: '这道题有未保存的修改，离开后会丢失。', discardOk: '放弃修改',
  },
  en: {
    title: 'Question Bank',
    lead: 'Maintain questions per course: single and multiple choice, true/false, fill in the blank, multi-blank fill, ordering, matching, classification, short answer and scenario cases. Draft with AI, import and export in bulk.',
    total: 'All',
    totalText: (n) => `${n} total`,
    searchPh: 'Search question stem…',
    courseAll: 'All courses',
    add: 'Add question', aiGen: 'Generate with AI',
    mobileHint: 'AI drafting and bulk import are best done on a desktop.',
    colType: 'Type', colStem: 'Question', colCourse: 'Course', courseGone: 'Deleted course', colAction: 'Actions',
    colPoints: 'Points', ptsDefault: 'Exam default', fPoints: 'Points', fPointsPh: 'Blank = the exam’s default for this type', fPointsHint: 'Points for this question. Blank uses the exam’s per-type default; legacy exams keep the old rule (1 point per objective question, short answers weighted by their max score).',
    edit: 'Edit', del: 'Delete',
    hintMulti: (n) => `${n} correct answer${n === 1 ? '' : 's'} · a partial pick scores half`,
    hintFill: (list) => `Accepted: ${list}`,
    hintShort: 'AI pre-scores it when AI is on · HR reviews when the score decides pass or fail',
    hintCase: (n) => `Scenario case · ${n} sub-question${n === 1 ? '' : 's'}`,
    hintCloze: (n) => `${n} blank${n === 1 ? '' : 's'} · credit per correct blank`,
    hintOrdering: (n) => `${n} steps · shuffled in the exam`,
    hintMatching: (p, d) => `${p} pair${p === 1 ? '' : 's'}${d ? ` · ${d} distractor${d === 1 ? '' : 's'}` : ''}`,
    hintClassify: (c, i) => `${c} categories · ${i} items`,
    hintUnsupported: 'Refresh the page to view and edit this question type',
    delTitle: 'Delete question', delConfirm: 'Delete this question? This cannot be undone.',
    bulkDel: (n) => `Delete selected (${n})`,
    bulkDelTitle: (n) => `Delete ${n} question${n === 1 ? '' : 's'}`, bulkDelConfirm: 'Delete the selected questions? This cannot be undone.',
    bulkDelOk: (n) => `Deleted ${n} question${n === 1 ? '' : 's'}`, bulkDelPart: (ok, n) => `Deleted ${ok}/${n}; the rest failed: `,
    bulkPoints: 'Set points', bulkCourse: 'Change course / module',
    bulkPtsLabel: 'Points (whole number 1–100)', bulkPtsDefault: 'Use the exam default instead',
    bulkPtsHint: 'Fixed-question exam totals update automatically; attempts already in progress are not affected. A scenario case scores the sum of its sub-questions, so it is skipped and listed in the result.',
    bulkCourseLabel: 'Course', bulkCoursePh: 'Pick the course to move these questions to', bulkModuleLabel: 'Module (optional)', bulkModulePh: 'No module',
    bulkCourseHint: 'Questions moved to another course lose their module (same as editing one question); pick a module to set it for all. Question IDs don’t change. Questions used by a fixed-question exam that does not link the new course are skipped and listed in the result, so that exam does not lose them the next time it is saved. If a random-draw exam is left with fewer questions than it draws, the result says so.',
    bulkTf: 'Convert to true/false', bulkTfTitle: 'Convert to true/false',
    bulkTfLead: (n, m) => `${n} of the ${n + m} selected are single-choice questions with exactly the options True / False and will become true/false questions${m ? `; the other ${m} do not qualify and stay as they are` : ''}.`,
    bulkTfNone: 'None of the selected questions is a single-choice question with exactly the options True / False.',
    bulkTfHint: 'The stem, explanation, points, course and question ID stay the same; the correct answer follows the option that was marked correct. Attempts already in progress are not affected.',
    bulkTfOk: (n) => `Converted ${n} to true/false`, bulkTfPart: (ok, n) => `Converted ${ok}/${n}; the rest failed: `,
    cancel: 'Cancel',
    loadErr: 'Couldn’t load. Refresh the page to try again.', retry: 'Retry',
    addTitle: 'Add question', editTitle: 'Edit question',
    fType: 'Question type', fCourse: 'Course', fCoursePh: 'Select the course this question belongs to',
    reqCourse: 'Please select a course',
    typeDesc: {
      mcq: 'One correct answer', multi: 'One or more correct answers; a partial pick scores half', tf: 'Judge a statement true or false',
      fill: 'One blank, answered in words', cloze: 'Several blanks in the stem, credit per correct blank', ordering: 'Put steps in the right order',
      matching: 'Pair left and right items, optional distractors', classify: 'Sort items into categories', open: 'Written answer, AI pre-score and HR review',
      case: 'A workplace scenario with 2–8 objective sub-questions',
    },
    typeChangeTitle: 'Change the question type?', typeChangeAsk: 'Changing the type clears the options and answers entered for the current type; the stem, explanation and points are kept.', typeChangeOk: 'Change type',
    caseTotal: (n) => `Total ${n} pts`, casePtsHint: 'A scenario case scores the sum of its sub-questions. Set points on each sub-question on the right; a blank uses the exam’s per-type default.',
    fixErrs: 'Some fields still need attention — see the ones marked in red.',
    save: 'Save',
    createdOk: 'Question added', updatedOk: 'Question updated', deletedOk: 'Question deleted',
    aiTitle: 'AI generate questions',
    aiLead: 'Pick the source and how many of each type; AI drafts questions for you to review one by one, adopt or discard.',
    aiDemo: 'Demo mode: no AI service is connected, so the questions below are placeholders marked “Demo sample”, not AI output.',
    aiOutbound: 'The material is sent to the company-designated AI service. Do not paste personal information (emails and phone numbers are removed, but not every personal detail can be detected).',
    aiSource: 'Source', aiSrcPaste: 'Paste material', aiSrcCourse: 'Use the selected course’s content',
    aiCounts: 'Questions per type (1–20 in total; each scenario case counts as 3)', aiCases: 'Scenario cases (groups)', aiTotal: (n) => `Total ${n} / 20`,
    aiSourceQuote: 'Based on', aiSimilar: 'Possible duplicate in the bank', aiDemoTag: 'Demo sample',
    aiDiff: { easy: 'Easy', medium: 'Medium', hard: 'Hard' },
    aiCourse: 'Target course',
    aiErrs: {
      ai_rate_limited: (d) => `Too many requests. Try again in ${Math.max(1, Math.ceil((d.retryAfterSec || 60) / 60))} min.`,
      ai_budget_exhausted: () => "This month's AI usage limit has been reached (IT adjusts ai.budget.monthlyTokens).",
      ai_not_configured: () => 'The AI service is not connected yet — ask IT to configure it (HANDOVER-IT §10).',
      ai_feature_off: () => 'AI question drafting is not enabled.',
      ai_timeout: () => 'The AI service timed out. Try again later (drafting is not retried automatically, to avoid paying twice).',
      ai_output_invalid: () => 'The AI returned incomplete questions. Retry, or ask for fewer.',
      ai_output_truncated: () => 'The AI response was incomplete. Ask for fewer questions and retry.',
      ai_input_too_large: () => 'The material is too long (60,000 characters max). Shorten it and retry.',
      material_too_short: (d) => (d && d.source === 'course'
        ? 'This course has under 100 characters of readable text in its sections and PDF / Word / PPT attachments. Scanned PDFs and videos have no readable text — paste the material instead.'
        : 'Provide at least a few paragraphs of material (100 characters or more).'),
      bad_counts: () => 'Ask for between 1 and 20 questions.',
      bad_ai_call: () => 'This draft does not belong to your account. Generate again.',
    },
    aiMaterial: 'Training material', aiMaterialPh: 'Paste lecture notes, policy clauses or key points here (at least 100 characters)…',
    aiGenerate: 'Generate', aiRegen: 'Regenerate', aiGenerating: 'Generating…',
    aiEmpty: 'Add material and click “Generate” — AI-drafted questions will appear here.',
    aiDrafts: 'AI drafts', aiAdopt: 'Adopt', aiDiscard: 'Discard',
    aiTweak: 'Edit', aiTweakTitle: 'Refine AI draft',
    aiAdoptAll: 'Adopt all', aiClear: 'Clear',
    aiAdoptedOk: 'Adopted and added to the bank',
    aiAdoptPartial: (ok, bad) => `Adopted ${ok}; ${bad} failed validation and stay in the list`,
    aiAdoptedAllOk: (n) => `Adopted ${n} questions`,
    aiNeedMaterial: 'Paste some material first',
    aiNeedCourse: 'Pick a target course first',
    aiReviewTag: 'To review',
    exp: 'Export question bank', expOk: (n) => `Exported ${n} question${n === 1 ? '' : 's'}`, expSkip: (n) => `${n} question${n === 1 ? '' : 's'} of a type this page does not know yet were skipped; refresh the page and export again`,
    expEmpty: 'No questions to export under the current filters.', expFail: 'Export failed. Try again.',
    imp: 'Bulk import', impTitle: 'Bulk import questions',
    impHint: 'Paste straight from Excel — the first row is matched as a header, so any column order works. Review the row-by-row check, then import. Stem, options A–L, explanation and categories each have a Chinese and an English column; filling only one language is fine. Single-language columns from the old template import as Chinese. Types: single, multiple, true/false, fill in the blank, multi-blank fill, ordering, matching, classification, short answer and scenario case; the template’s instructions sheet shows how to write each. Up to 200 per batch (a case with its sub-questions counts as one).',
    impPaste: 'Paste from Excel',
    impPastePh: 'Copy a range in Excel and paste it here. Put a header in the first row — 题型 / 题干(中文) / Stem (EN) / 选项A(中文) / Option A (EN)…L / 正确答案 / 解析(中文) / Explanation (EN) / 分值 / Case ID / 分类(中文) / Categories (EN) — in any order.',
    impHeaderOk: (n) => `Matched ${n} column${n === 1 ? '' : 's'} from the header row`,
    impNoHeader: 'No header row recognised — reading the template column order',
    impLangSplit: 'Chinese and English columns', impLangMono: 'Single-language columns · imported as Chinese',
    impTmpl: 'Download Excel template', impPick: 'Upload spreadsheet (.xlsx / .csv)',
    impCourse: 'Import into course', impCoursePh: 'Pick the course these questions belong to',
    impNeedCourse: 'Pick a target course first',
    impStat: (ok, bad) => `${ok} importable${bad ? ` · ${bad} problem row${bad === 1 ? '' : 's'} will be skipped` : ''}`,
    impEmpty: 'No questions found in the file (needs a Type column and at least one Stem column)',
    impFileFail: 'Could not read the file — make sure it is .xlsx or .csv',
    impConfirm: 'Import', impDoneN: (n) => `Imported ${n} question${n === 1 ? '' : 's'}`,
    impSkipN: (n) => `${n} skipped (failed validation)`,
    impColRow: 'Row', impColType: 'Type', impColStem: 'Question', impColAns: 'Answer', impColState: 'Check',
    impOkTag: 'OK', impSubTag: 'Sub-question',
    impErrType: 'Unrecognized type', impErrStem: 'Both Chinese and English stems are empty', impErrTypeStem: 'Missing type and question',
    impErrPhase: 'This question type is not available yet',
    impErrOpts: 'Fewer than 2 options',
    impErrRange: (l) => `Answer ${l} is not one of the options`,
    impErrNoAns: 'No correct answer given', impErrSingle: 'Single choice allows only one answer',
    impErrTf: 'True-false answer must be 对/True or 错/False',
    impAnsTrue: 'True', impAnsFalse: 'False', impAnsPoints: (n) => `${n} pts`,
    impErrFill: 'A fill-in-the-blank question needs at least one accepted answer',
    impErrLong: (max) => `Some text is longer than ${max} characters`,
    impErrOrderN: (min, max) => `Ordering needs ${min}–${max} steps`,
    impErrOrderSeq: 'The answer letters must list every option once, e.g. CADB',
    impErrOrderDup: 'Ordering steps must all be different',
    impErrArrow: (l) => `Write option ${l} as “left => right”`,
    impErrPairs: (min, max) => `Matching needs ${min}–${max} pairs`,
    impErrDistractors: (max) => `At most ${max} distractors`,
    impErrDupRight: 'Right-hand items must be unique',
    impErrCats: (min, max) => `The categories column needs ${min}–${max} categories (separated by |)`,
    impErrCatUnknown: (l, name) => `Option ${l}: category “${name}” is not in the categories column`,
    impErrClassItems: (min, max) => `Classification needs ${min}–${max} items`,
    impErrCatEmpty: 'Every category needs at least one item',
    impErrMarkers: 'Mark the blanks in the stem as {{1}}…{{n}}, each once, the same in both languages',
    impErrBlankAns: 'Write the answer as “1: answer ; 2: answer”, one entry per blank',
    impErrCaseId: 'A case row needs a Case ID, e.g. C1',
    impErrCaseDup: (id) => `Case ID ${id} is used twice`,
    impErrCaseOrder: (id) => `Sub-questions must come after the row of case ${id}`,
    impErrCaseUnknown: (id) => `There is no case row with Case ID ${id}`,
    impErrCaseSub: 'Case sub-questions must be objective (not short answer or case)',
    impErrCaseBadSub: (rows) => `Sub-question row ${rows} has a problem`,
    impErrCaseN: (min, max) => `A case needs ${min}–${max} sub-questions`,
    impAnsPairs: (p, d) => `${p} pair${p === 1 ? '' : 's'}${d ? ` + ${d} distractor${d === 1 ? '' : 's'}` : ''}`,
    impAnsCats: (c, i) => `${c} categories · ${i} items`,
    impAnsSubs: (n) => `${n} sub-question${n === 1 ? '' : 's'}`,
    roWrite: 'Read-only: your role can view training but not change it, so the write actions are unavailable. Ask a super-admin to widen the grant.',
    backToList: 'Back to question bank', backToAi: 'Back to AI drafts',
    qNewSub: 'Pick the type and course, write the stem and answer, then save.',
    qDraftSub: 'Drafted by AI — saving adds it to the bank and removes it from the drafts.',
    qNotFound: 'This question could not be found — it may have been deleted.', loading: 'Loading…',
    edSettings: 'Question settings', edContent: 'Stem and answer',
    discardTitle: 'Discard unsaved changes?', discardAsk: 'This question has unsaved changes that will be lost if you leave.', discardOk: 'Discard',
  },
};

// 旧写法的判断题：两个选项恰好是「正确 / 错误」（True / False）的单选题 → 正确答案是不是「正确」；不是这种题返回 null
const TF_TRUE = /^(true|正确|对|是|t)$/i;
const TF_FALSE = /^(false|错误|错|否|f)$/i;
function legacyTfAnswer(q) {
  if (!q || q.type !== 'mcq' || !Array.isArray(q.options) || q.options.length !== 2) return null;
  const kind = (o) => {
    const a = String((o && o.text) || '').trim();
    const b = String((o && o.text_zh) || '').trim();
    if ((TF_TRUE.test(a) || !a) && (TF_TRUE.test(b) || !b) && (a || b)) return 'T';
    if ((TF_FALSE.test(a) || !a) && (TF_FALSE.test(b) || !b) && (a || b)) return 'F';
    return null;
  };
  const k = q.options.map(kind);
  if (!((k[0] === 'T' && k[1] === 'F') || (k[0] === 'F' && k[1] === 'T'))) return null;
  const ok = q.options.filter((o) => o.ok);
  if (ok.length !== 1) return null;
  return kind(ok[0]) === 'T';
}

// AI 题型名（single / truefalse …）← 题库题型（mcq / tf …）
const aiNameOf = (type) => Object.keys(AI_TYPE_MAP).find((k) => AI_TYPE_MAP[k] === type) || type;

export default function Questions() {
  const { lang, loc } = useI18n();
  const s = T[lang];
  // 新建/编辑/删除/批量导入/AI 出题全在培训域写(矩阵 6102 questions、6126 questions/bulk、
  // 6157 DELETE questions/:id、6162 ai/generate —— AI 出题不落库但烧配额,矩阵标写),
  // 与本页同域 —— manage 档照旧,只读档收起。GET questions / catalog 是读。
  const { user } = useAuth();
  const canWrite = canUseAction(user, { domain: 'learning', module: 'learning', write: true });
  const typeLabel = (t) => qTypeLabel(t, lang);
  // 列表的题干：多空填空的 {{n}} 换成「____」；情境案例显示它的题干（标题或材料第一行）
  const stemOf = (r) => (r.q ? qStemOf(r.q, lang) : (lang === 'zh' ? (r.stemZh || r.stemEn) : (r.stemEn || r.stemZh)));
  const otherStem = (r) => (lang === 'zh' ? r.stemEn : r.stemZh);
  // Second line of the stem cell: what the learner has to get right and how it is
  // scored. Single choice and true/false grade the obvious way and get no cue, so
  // those rows keep showing the other language's stem. Wording tracks the real
  // grader: multi gives half credit for a correct-but-incomplete pick and short
  // answers are AI-scored with an HR override (/api/admin/attempts/:id/regrade).
  const hintOf = (r) => {
    const q = r.q || {};
    const n = (x) => (Array.isArray(x) ? x.length : 0);
    if (q.unsupported || !TYPE_ORDER.includes(r.type)) return s.hintUnsupported;
    if (r.type === 'multi') return s.hintMulti((q.options || []).filter((o) => o.ok).length);
    if (r.type === 'fill') {
      const list = (q.answers || []).map((a) => String(a).trim()).filter(Boolean);
      return list.length ? s.hintFill(list.join(' / ')) : null;
    }
    if (r.type === 'open') return s.hintShort;
    if (r.type === 'case') return s.hintCase(n(q.items));
    if (r.type === 'cloze') return s.hintCloze(n(q.blanks));
    if (r.type === 'ordering') return s.hintOrdering(n(q.items));
    if (r.type === 'matching') return s.hintMatching(n(q.pairs), n(q.distractors));
    if (r.type === 'classify') return s.hintClassify(n(q.categories), n(q.items));
    return null;
  };

  /* ---- live data ---- */
  const qq = useAsync(() => api.get('/api/admin/questions'), []);
  const cat = useAsync(() => api.get('/api/admin/catalog'), []);

  // 列表行：保留题库原样（q），另取题干两种语言供搜索与副行显示
  const rows = useMemo(() => (qq.data || []).map((q) => ({
    id: q.id, type: q.type, course: q.courseId, moduleId: q.moduleId || null,
    points: q.points == null ? null : q.points,
    stemZh: q.question_zh || '', stemEn: q.question || '',
    search: [q.question, q.question_zh, q.passage, q.passage_zh].filter(Boolean).join(' ').toLowerCase(),
    q,
  })), [qq.data]);
  const listVer = useDataVersion(qq.data);   // 保存后重载 → 表格按记住的页码重挂

  const courses = cat.data?.courses || [];
  const programs = cat.data?.programs || [];
  const courseById = useMemo(() => {
    const m = {}; courses.forEach((c) => { m[c.id] = c; }); return m;
  }, [courses]);
  const programById = useMemo(() => {
    const m = {}; programs.forEach((p) => { m[p.id] = p; }); return m;
  }, [programs]);

  const courseOf = (key) => courseById[key];
  // CX-147：课程已删除（题目因被考试使用而保留）时写「已删除的课程」，不露内部编号
  const courseLabel = (key) => { const c = courseById[key]; return c ? loc(c, 'title') : key && courseById && Object.keys(courseById).length ? s.courseGone : key; };
  const progLabelOf = (key) => {
    const c = courseById[key];
    if (!c) return '';
    const p = programById[c.programId];
    return p ? loc(p, 'title') : '';
  };

  /* ---- filters ---- */
  const [query, setQuery] = useState('');
  const [fCourse, setFCourse] = useState('');
  const [impOpen, setImpOpen] = useState(false);
  const [fType, setFType] = useState('');
  // 打开整页编辑器时表格会卸载；页码、每页条数、列排序、课程列筛选记在这里，回列表时复原（同成绩页做法）。
  // 不传 currentPage：受控后 Semi 不再自己切页，列排序会失效。
  const [listPage, setListPage] = useState(1);
  const [listSize, setListSize] = useState(DEFAULT_PAGE);
  const [listSort, setListSort] = useState(null);       // { dataIndex, sortOrder } | null
  const [listColFilter, setListColFilter] = useState(null); // 课程列筛选的已选值
  useEffect(() => { setListPage(1); }, [query, fCourse, fType]);

  // Everything except the type filter — the chips ARE the type filter, so their
  // counts have to be read from the set the table would show without them.
  const typeBase = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows.filter((r) => {
      if (q && !r.search.includes(q)) return false;
      if (fCourse && r.course !== fCourse) return false;
      return true;
    });
  }, [rows, query, fCourse]);
  const filtered = useMemo(
    () => (fType ? typeBase.filter((r) => r.type === fType) : typeBase),
    [typeBase, fType],
  );
  // 题型筛选芯片：已开放的题型按目录顺序；题库里还有别的题型（未开放 / 更新的服务端写的）也列出，免得看不见
  const chipTypes = useMemo(() => {
    const on = enabledTypes();
    const extra = [...new Set(rows.map((r) => r.type))].filter((t) => !on.includes(t));
    return [...on, ...extra];
  }, [rows]);

  /* ---- question editor (full page) ----
   * 2026-10-06 负责人：培训模块不用抽屉，长内容整页编辑。地址栏是唯一事实源 ——
   *   ?q=new            新增题目
   *   ?q=<questionId>   编辑该题
   *   ?ai=1             AI 生成题目（整页）
   *   ?ai=1&draft=<id>  修改某条 AI 草稿；保存后回到 AI 页，该草稿离开列表
   * setSearchParams({}) 回到题库列表；浏览器返回键可用。
   * 第四批：编辑的是一份编辑稿 draft（web/src/qtypes/model.js），右栏是该题型注册的 Editor。
   */
  const [searchParams, setSearchParams] = useSearchParams();
  const [edReady, setEdReady] = useState(null); // the ?q / draft the editor state below was seeded for
  const [edBase, setEdBase] = useState('');     // snapshot at open, for the unsaved-changes guard
  const [editingId, setEditingId] = useState(null); // null => creating
  const [draftMeta, setDraftMeta] = useState(null); // AI 草稿的来源信息（callId、演示标记）
  const [draftSrc, setDraftSrc] = useState(null);   // AI draft id this edit came from
  const [draft, setDraft] = useState(() => emptyDraft('mcq'));
  const [edErrors, setEdErrors] = useState([]);
  const [saving, setSaving] = useState(false);
  // AI 翻译：编辑稿里所有双语字段（选项、配对、类别、步骤、案例材料、小题……）一并翻译
  const trExtra = useDraftTranslate(draft, setDraft);

  // Seed the editor for one question / draft / a new one (the URL effect below
  // calls this when ?q or ?draft changes) and take the unsaved-changes snapshot.
  const initEditor = (seed, id, meta) => {
    setEditingId(id);
    setDraftMeta(meta || null);
    setDraftSrc(meta ? meta.id : null);
    setDraft(seed);
    setEdErrors([]);
    setEdBase(JSON.stringify(seed));
  };
  const openAdd = () => setSearchParams({ q: 'new' });
  const openEdit = (r) => setSearchParams({ q: String(r.id) });
  // "Refine": an AI draft goes through the same editor, but it has no server row
  // yet — so saving creates (editingId stays null) and the draft leaves the list.
  const openDraftEdit = (d) => setSearchParams({ ai: '1', draft: d.id });

  const edDirty = () => JSON.stringify(draft) !== edBase;
  const guard = (fn) => {
    if (!edDirty()) { fn(); return; }
    Modal.confirm({ title: s.discardTitle, content: s.discardAsk, okText: s.discardOk, cancelText: s.cancel, okButtonProps: { type: 'danger' }, onOk: fn });
  };

  // 换题型：保留题干、解析、分值与课程，题型专属字段重置；已填过内容时先确认
  const onTypeChange = (t) => {
    if (!t || t === draft.type) return;
    const apply = () => { setDraft((d) => changeType(d, t)); setEdErrors([]); };
    if (!hasTypeContent(draft)) { apply(); return; }
    Modal.confirm({ title: s.typeChangeTitle, content: s.typeChangeAsk, okText: s.typeChangeOk, cancelText: s.cancel, onOk: apply });
  };
  const onDraftChange = (next) => {
    setDraft(next);
    // 已经报过的错，改了之后即时更新（没报过就不打扰）
    if (edErrors.length) setEdErrors(validateDraft(next));
  };

  const submitEdit = () => {
    const errs = validateDraft(draft);
    setEdErrors(errs);
    if (errs.length) { Toast.warning(s.fixErrs); return; }
    const body = toBody(draft);
    if (draftSrc && draftMeta && draftMeta.callId) body.aiCallId = draftMeta.callId; // AI 草稿修改后采纳：仍写入来源
    setSaving(true);
    // 编辑走原地修改（PUT）：题目 id 不变，固定题目模式的考试不会少题；所属模块与 AI 来源由服务端沿用
    const run = editingId
      ? api.put(`/api/admin/questions/${editingId}`, body)
      : api.post('/api/admin/questions', body);
    run.then(() => {
      Toast.success(editingId ? s.updatedOk : s.createdOk);
      if (draftSrc) setDrafts((prev) => prev.filter((x) => x.id !== draftSrc));
      // Back to the list (or the AI page for a draft). replace: Back must not
      // reopen an editor that has already been saved.
      setSearchParams(draftSrc ? { ai: '1' } : {}, { replace: true });
      qq.reload();
    }).catch((err) => {
      Toast.error(errText(err) || err.message || s.loadErr);
    }).finally(() => setSaving(false));
  };

  const doDelete = (r) => {
    api.del(`/api/admin/questions/${r.id}`).then(() => {
      Toast.success(s.deletedOk);
      qq.reload();   // 删掉的题重载后离开列表，勾选里随之去掉（useBulkSelection 自动修剪）
    }).catch((err) => Toast.error({ content: err.message || s.loadErr, duration: 6 }));   // CX-146：被已发布考试使用时服务端 409，提示写明考试名
  };

  // 批量删除（2026-10-05 反馈）：逐题调用同一个 DELETE，每题各写一条审计日志，与单题删除完全一致。
  // 勾选（2026-10-06 SPEC-bulk-ops，components/BulkActions.jsx）：表头全选只选当前页；
  // 换搜索词、题型、课程或课程列筛选就清空 —— 不能对屏幕上已经看不到的题执行操作。
  const sel = useBulkSelection({
    rows: filtered,
    resetOn: [query, fType, fCourse, JSON.stringify(listColFilter || [])],
    ready: !!qq.data,
  });
  const runner = useBulkRunner();
  const [bulkBusy, setBulkBusy] = useState(false);
  const doBulkDelete = async () => {
    const ids = sel.keys.slice();
    if (!ids.length) return;
    setBulkBusy(true);
    let ok = 0; const errs = [];
    for (const id of ids) {
      try { await api.del(`/api/admin/questions/${id}`); ok++; }
      catch (err) { errs.push((err && err.message) || id); }
    }
    setBulkBusy(false);
    sel.clear();
    if (errs.length) Toast.error({ content: s.bulkDelPart(ok, ids.length) + errs[0], duration: 5 });
    else Toast.success(s.bulkDelOk(ok));
    qq.reload();
  };

  // 批量改分值 / 改课程与模块（B4）：POST /api/admin/questions/bulk-update，服务端逐题原地修改、逐题审计。
  // 打开确认框时对勾选拍快照（id 与名称，按屏幕顺序），之后勾选再变也不影响这次提交。
  const [bulkOp, setBulkOp] = useState(null);        // 'points' | 'course' | null
  const [bulkSnap, setBulkSnap] = useState(null);    // { ids, list: [名称], names: { id: 名称 } }
  const [bulkPts, setBulkPts] = useState(undefined);
  const [bulkPtsDef, setBulkPtsDef] = useState(false);
  const [bulkCourseId, setBulkCourseId] = useState(undefined);
  const [bulkModuleId, setBulkModuleId] = useState(undefined);
  const shortName = (r) => { const t = String(stemOf(r) || r.id); return t.length > 60 ? t.slice(0, 59) + '…' : t; };
  const openBulk = (op) => {
    const picked = sel.rows;
    if (!picked.length) return;
    const names = {};
    picked.forEach((r) => { names[String(r.id)] = shortName(r); });
    setBulkSnap({ ids: picked.map((r) => String(r.id)), list: picked.map(shortName), names });
    setBulkPts(undefined); setBulkPtsDef(false);
    setBulkCourseId(undefined); setBulkModuleId(undefined);
    setBulkOp(op);
  };
  const bulkPtsOk = bulkPtsDef || (Number.isInteger(bulkPts) && bulkPts >= 1 && bulkPts <= 100);
  const bulkModules = (bulkCourseId && courseById[bulkCourseId] && Array.isArray(courseById[bulkCourseId].modules))
    ? courseById[bulkCourseId].modules : [];
  const submitBulk = async () => {
    if (!bulkSnap || !bulkOp) return;
    const op = bulkOp === 'points' ? s.bulkPoints : s.bulkCourse;
    const body = bulkOp === 'points'
      ? { ids: bulkSnap.ids, op: 'points', points: bulkPtsDef ? null : bulkPts }
      : { ids: bulkSnap.ids, op: 'course', courseId: bulkCourseId, ...(bulkModuleId ? { moduleId: bulkModuleId } : {}) };
    await runner.run({
      op, names: bulkSnap.names,
      request: () => api.post('/api/admin/questions/bulk-update', body),
      onSettled: () => { sel.clear(); qq.reload(); },
    });
    setBulkOp(null);
  };

  // 转为判断题（第四批 4c）：打开时拍快照；只转旧写法的「正确 / 错误」单选题，逐题走单题 PUT（同一套校验与审计）
  const [tfSnap, setTfSnap] = useState(null);   // { list: [row], skip: n }
  const [tfBusy, setTfBusy] = useState(false);
  const openTf = () => {
    const picked = sel.rows;
    if (!picked.length) return;
    const list = picked.filter((r) => legacyTfAnswer(r.q) !== null);
    setTfSnap({ list, skip: picked.length - list.length });
  };
  const submitTf = async () => {
    if (!tfSnap || !tfSnap.list.length) { setTfSnap(null); return; }
    setTfBusy(true);
    let ok = 0; const errs = [];
    for (const r of tfSnap.list) {
      const d = changeType(toDraft(r.q), 'tf');
      d.answer = legacyTfAnswer(r.q) === true;
      try { await api.put(`/api/admin/questions/${r.id}`, toBody(d)); ok++; }
      catch (err) { errs.push((err && err.message) || r.id); }
    }
    setTfBusy(false);
    const n = tfSnap.list.length;
    setTfSnap(null);
    sel.clear();
    if (errs.length) Toast.error({ content: s.bulkTfPart(ok, n) + errs[0], duration: 5 });
    else Toast.success(s.bulkTfOk(ok));
    qq.reload();
  };

  // 导出题库（D12）：当前筛选下的题，按导入模板的版式写成 xlsx（不走服务端、不审计 —— 题库对培训只读档本就可见）
  const [expBusy, setExpBusy] = useState(false);
  const doExport = async () => {
    const list = filtered.map((r) => r.q);
    if (!list.length) { Toast.warning(s.expEmpty); return; }
    setExpBusy(true);
    try {
      const { grid, skipped } = impExportGrid(list);
      const XLSX = await import('xlsx');
      const ws = XLSX.utils.aoa_to_sheet(grid);
      ws['!cols'] = grid[0].map((h) => ({ wch: /题干|Stem/.test(h) ? 36 : /解析|Explanation/.test(h) ? 30 : /选项|Option/.test(h) ? 20 : 12 }));
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, '题目');
      const d = new Date();
      const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
      XLSX.writeFile(wb, `question-bank-${stamp}.xlsx`);
      Toast.success(s.expOk(list.length - skipped));
      if (skipped) Toast.warning(s.expSkip(skipped));
    } catch {
      Toast.error(s.expFail);
    } finally {
      setExpBusy(false);
    }
  };

  /* ---- AI generate (full page at ?ai=1) ---- */
  const [aiMaterial, setAiMaterial] = useState('');
  const [aiCourse, setAiCourse] = useState('');
  const [aiSource, setAiSource] = useState('paste');
  // 各题型数量（第四批：每个已开放的题型一个数量 + 情境案例组数；键用题库题型，提交时换成 AI 题型名）
  const [aiCounts, setAiCounts] = useState({ mcq: 3 });
  const [aiBusy, setAiBusy] = useState(false);
  const [drafts, setDrafts] = useState([]);
  const [aiDemoRun, setAiDemoRun] = useState(false);
  // AI 出题的状态（/api/me 的 ai.questionGen）：on / demo 才显示入口
  const qgState = user && user.ai ? user.ai.questionGen : null;
  const aiAvailable = qgState === 'on' || qgState === 'demo';
  const aiTypes = enabledTypes().filter((t) => t !== 'case');
  const aiTotal = aiTypes.reduce((a, t) => a + (aiCounts[t] || 0), 0) + (aiCounts.case || 0) * 3;

  // Default the AI target course to the first real course once the catalog loads.
  useEffect(() => {
    if (!aiCourse && courses.length) setAiCourse(courses[0].id);
  }, [courses, aiCourse]);

  /* ---- which view the address asks for: list / AI page / question editor ---- */
  // 只读档（learning=read）与未开通 AI 出题的账号：对应参数忽略，照旧显示列表（入口按钮本来就不显示）。
  const qParam = canWrite ? searchParams.get('q') : null;
  const aiPage = canWrite && aiAvailable && searchParams.get('ai') === '1';
  const draftParam = aiPage ? searchParams.get('draft') : null;
  const draftRow = draftParam ? drafts.find((d) => d.id === draftParam) || null : null;
  const editRow = qParam && qParam !== 'new' ? rows.find((r) => String(r.id) === qParam) || null : null;
  // ?q wins over a draft. A draft that is no longer in the list (drafts live only
  // in this page, so a reload drops them) falls back to the AI page.
  const edKey = qParam ? `q:${qParam}` : draftRow ? `d:${draftRow.id}` : null;
  const edSeedReady = qParam ? (qParam === 'new' || !!editRow) : !!draftRow;
  const backTarget = !qParam && draftRow ? { ai: '1' } : {};
  const view = edKey ? 'q' : aiPage ? 'ai' : 'list';

  // Seed the editor whenever the address opens a different question / draft. The
  // bank loads asynchronously, so a deep link to ?q=<id> seeds once it arrives.
  useEffect(() => {
    if (!edKey) { setEdReady(null); return; }
    if (!edSeedReady || edReady === edKey) return;
    if (qParam) {
      if (editRow) initEditor(toDraft(editRow.q), editRow.id, null);
      else initEditor(emptyDraft('mcq', { courseId: fCourse || null }), null, null);
    } else initEditor(JSON.parse(JSON.stringify(draftRow.draft)), null, draftRow);
    setEdReady(edKey);
  }, [edKey, edSeedReady]); // eslint-disable-line react-hooks/exhaustive-deps
  // A full page opens at its top, not at the list's scroll position.
  useEffect(() => {
    if (view !== 'list') { try { window.scrollTo(0, 0); } catch { /* no window */ } }
  }, [view, edKey]);

  const openAi = () => setSearchParams({ ai: '1' });

  const runGenerate = () => {
    if (aiSource === 'paste' && !aiMaterial.trim()) { Toast.warning(s.aiNeedMaterial); return; }
    if (!aiCourse) { Toast.warning(s.aiNeedCourse); return; }
    setAiBusy(true);
    setDrafts([]);
    // 题库题型 → AI 题型名（single / multi / truefalse / fill / open / ordering / matching / classify / cloze）+ case
    const counts = Object.fromEntries(aiTypes.map((t) => [aiNameOf(t), aiCounts[t] || 0]));
    counts.case = aiCounts.case || 0;
    const body = aiSource === 'course' ? { source: 'course', courseId: aiCourse, counts } : { source: 'paste', material: aiMaterial, courseId: aiCourse, counts };
    api.post('/api/admin/ai/generate', body)
      .then((res) => {
        const now = Date.now();
        setAiDemoRun(!!res.demo);
        const base = { courseId: aiCourse };
        const one = (d, i) => ({
          id: `d-${now}-${i}`, callId: res.callId, sourceQuote: d.sourceQuote || '', difficulty: d.difficulty || null,
          similarTo: d.similarTo || null, demo: !!d.demo, draft: fromAiDraft(d, base),
        });
        const qs = (res.questions || []).map(one);
        const cs = (res.cases || []).map((c, i) => ({
          id: `c-${now}-${i}`, callId: res.callId, sourceQuote: c.sourceQuote || '', difficulty: c.difficulty || null,
          similarTo: (c.questions || []).some((x) => x && x.similarTo) ? true : null,
          demo: !!c.demo || (c.questions || []).some((x) => x && x.demo), draft: fromAiCase(c, base),
        }));
        setDrafts([...qs, ...cs]);
      })
      .catch((err) => Toast.error(errText(err, s.aiErrs) || s.loadErr))
      .finally(() => setAiBusy(false));
  };

  const adoptBody = (d) => ({ ...toBody(d.draft), ...(d.callId ? { aiCallId: d.callId } : {}) });
  const adoptDraft = (d) => {
    api.post('/api/admin/questions', adoptBody(d)).then(() => {
      setDrafts((prev) => prev.filter((x) => x.id !== d.id));
      Toast.success(s.aiAdoptedOk);
      qq.reload();
    }).catch((err) => Toast.error(errText(err, s.aiErrs) || s.loadErr));
  };
  const discardDraft = (d) => {
    setDrafts((prev) => prev.filter((x) => x.id !== d.id));
  };
  // 逐题顺序提交（方案 4.2 第 6 条）：原来 Promise.all 并发提交，部分失败时看不出哪些已入库。
  // 成功的离开列表，失败的留在列表里，最后给一句汇总。
  const adoptAll = async () => {
    if (!drafts.length) return;
    let ok = 0;
    const failed = [];
    for (const d of drafts) {
      try { await api.post('/api/admin/questions', adoptBody(d)); ok++; setDrafts((prev) => prev.filter((x) => x.id !== d.id)); }
      catch { failed.push(d.id); }
    }
    if (failed.length) Toast.warning(s.aiAdoptPartial(ok, failed.length)); else Toast.success(s.aiAdoptedAllOk(ok));
    qq.reload();
  };

  /* ---- columns ---- */
  const columns = [
    {
      // No header filter: the count chips above the table own type filtering.
      title: s.colType, dataIndex: 'type', width: 110, className: 'qb-typecol',
      render: (t) => <TypeTag type={t} lang={lang} />,
    },
    {
      title: s.colStem, dataIndex: 'stemZh', width: 500, className: 'qb-stemcol',
      render: (_, r) => {
        const hint = hintOf(r);
        return (
          <>
            <div className="qb-stemcell">
              <Text className="qb-stem" ellipsis={{ showTooltip: true, rows: 2 }}>{stemOf(r)}</Text>
              {hint ? (
                <Text size="small" className="qb-stemhint" ellipsis={{ showTooltip: true }}>
                  {hint}
                </Text>
              ) : (
                <Text type="tertiary" size="small" className="qb-stemsub" ellipsis={{ showTooltip: true }}>
                  {otherStem(r)}
                </Text>
              )}
            </div>
            {/* Phone card (design 20 · 手机 390): 题型 + 课程 / 题干 / 答案提示.
                Drawn from the stem cell — the type and course cells hide instead,
                so the table keeps its pagination and row actions. */}
            <div className="qb-mcard">
              <div className="qb-mc-l1">
                <TypeTag type={r.type} lang={lang} size="small" />
                <span className="qb-mc-course">{courseLabel(r.course)}</span>
              </div>
              <div className="qb-mc-stem">{stemOf(r)}</div>
              {hint && <div className="qb-mc-hint">{hint}</div>}
            </div>
          </>
        );
      },
    },
    {
      title: s.colPoints, dataIndex: 'points', width: 96, className: 'qb-ptscol', align: 'right',
      render: (v, r) => (r.type === 'case'
        ? <span className="tnum">{s.caseTotal(caseTotal(toDraft(r.q)))}</span>
        : v != null ? <span className="tnum">{v}</span> : <Text type="quaternary" size="small">{s.ptsDefault}</Text>),
      sorter: (a, b) => (a.points || 0) - (b.points || 0),
    },
    {
      title: s.colCourse, dataIndex: 'course', width: 170, className: 'qb-coursecol',
      // Semi 列筛选读 text（不是 label），原来选项不显示文字
      filters: courses.map((c) => ({ text: loc(c, 'title'), value: c.id })),
      onFilter: (value, r) => r.course === value,
      render: (key) => {
        const c = courseOf(key);
        return (
          <div className="qb-coursecell">
            <Text size="small" strong>{courseLabel(key)}</Text>
            {c && <Text type="quaternary" size="small">{progLabelOf(key)}</Text>}
          </div>
        );
      },
    },
    // 只读档(learning=read)整列去掉:编辑/删除都是 POST|DELETE /api/admin/questions。
    ...(canWrite ? [{
      title: s.colAction, dataIndex: 'op', width: 150, fixed: 'right', className: 'qb-opcol',
      render: (_, r) => (
        <Space spacing={2}>
          <Button theme="borderless" size="small" icon={<IconEdit />} onClick={() => openEdit(r)}>{s.edit}</Button>
          {/* CX-088（复测退回）：删除确认改为居中的确认框 —— 操作列固定在右侧，气泡在窄屏总会贴边、盖住下一张卡片 */}
          <Button theme="borderless" size="small" type="danger" icon={<IconDelete />}
            onClick={() => Modal.confirm({ title: s.delTitle, content: s.delConfirm, okText: s.del, cancelText: s.cancel, okButtonProps: { type: 'danger' }, onOk: () => doDelete(r) })}>{s.del}</Button>
        </Space>
      ),
    }] : []),
  ];

  // 题型下拉：已开放的题型按目录顺序；编辑一道未开放题型的旧题时把它也列上（不会被悄悄换掉）
  const typeOptions = [...enabledTypes(), ...(draft && draft.type && !enabledTypes().includes(draft.type) ? [draft.type] : [])]
    .map((t) => ({ label: typeLabel(t), value: t }));
  // 「课程名 · 所属学习包」（第三批 10.5）：独立课程没有学习包，不留末尾的「·」
  const courseOptions = courses.map((c) => {
    const t = loc(c, 'title'), p = progLabelOf(c.id);
    return { label: [t, p && p !== t ? p : null].filter(Boolean).join(' · '), value: c.id };
  });

  // ---------- 题目编辑（整页）：新增 / 编辑 / 修改 AI 草稿 ----------
  if (view === 'q') {
    const backBtn = (onClick) => (
      <Button theme="borderless" icon={<IconArrowLeft />} onClick={onClick}>{backTarget.ai ? s.backToAi : s.backToList}</Button>
    );
    if (edReady !== edKey) {
      // Seeding (one frame), the bank still loading for a deep link, or an id
      // that is no longer in the bank.
      const missing = !edSeedReady && !qq.loading;
      return (
        <div className="wrap qb-wrap qb-page">
          <div className="co-page-bar">{backBtn(() => setSearchParams(backTarget))}</div>
          <div className="card co-emptycard" style={{ textAlign: 'center', padding: '48px 0' }}>
            {missing ? <Empty title={qq.error ? s.loadErr : s.qNotFound} /> : <Spin size="large" tip={s.loading} />}
          </div>
        </div>
      );
    }
    const leave = () => guard(() => setSearchParams(backTarget));
    const edTitle = draftSrc ? s.aiTweakTitle : editingId ? s.editTitle : s.addTitle;
    const edSub = draftSrc ? s.qDraftSub
      : editingId ? [courseLabel(draft.courseId), progLabelOf(draft.courseId)].filter(Boolean).join(' · ')
        : s.qNewSub;
    const def = qtype(draft.type);
    const leftErr = (field) => edErrors.filter((e) => e.field === field).map((e) => (field === 'courseId' && e.code === 'required' ? s.reqCourse : errorMessage(e, lang)));
    const isCase = draft.type === 'case';
    return (
      <div className="wrap qb-wrap qb-page">
        <div className="co-page-bar">
          {backBtn(leave)}
          <div className="co-page-titles">
            <h1 className="co-page-title">{edTitle}</h1>
            <div className="co-page-sub">{edSub}</div>
          </div>
          <TypeTag type={draft.type} lang={lang} />
          {draftSrc && draftMeta && <Tag color="grey" type="ghost" shape="circle">{draftMeta.demo ? s.aiDemoTag : s.aiReviewTag}</Tag>}
          <Button theme="solid" type="primary" loading={saving} onClick={submitEdit}>{s.save}</Button>
        </div>
        <div className="qb-form qb-ed-form">
          <div className="qb-ed-grid">
            <aside className="card co-ed-card qb-ed-side">
              <h2 className="co-ed-h">{s.edSettings}</h2>
              <div className="qb-ed-field">
                <span className="qb-fieldlabel">{s.fType}</span>
                <Select value={draft.type} onChange={onTypeChange} style={{ width: '100%' }} optionList={typeOptions} aria-label={s.fType} />
                {s.typeDesc[draft.type] && <Text type="tertiary" size="small" className="qb-typedesc">{s.typeDesc[draft.type]}</Text>}
              </div>
              <div className="qb-ed-field">
                <span className="qb-fieldlabel">{s.fCourse}</span>
                <Select
                  value={draft.courseId || undefined}
                  onChange={(v) => onDraftChange({ ...draft, courseId: v || null })}
                  placeholder={s.fCoursePh}
                  style={{ width: '100%' }}
                  optionList={courseOptions}
                  validateStatus={leftErr('courseId').length ? 'error' : 'default'}
                  filter
                  aria-label={s.fCourse}
                />
                {leftErr('courseId').length > 0 && <span className="qk-err" role="alert">{leftErr('courseId')[0]}</span>}
              </div>
              {isCase ? (
                <div className="qb-ed-field">
                  <span className="qb-fieldlabel">{s.fPoints}</span>
                  <span className="qb-casetotal tnum">{s.caseTotal(caseTotal(draft))}</span>
                  <Text type="tertiary" size="small">{s.casePtsHint}</Text>
                </div>
              ) : (
                <div className="qb-ed-field">
                  <span className="qb-fieldlabel">{s.fPoints}</span>
                  <InputNumber
                    value={draft.points == null ? undefined : draft.points}
                    onChange={(v) => onDraftChange({ ...draft, points: v === '' || v == null ? null : v })}
                    placeholder={s.fPointsPh}
                    min={1}
                    max={100}
                    precision={0}
                    style={{ width: '100%' }}
                    aria-label={s.fPoints}
                  />
                  {leftErr('points').length > 0 && <span className="qk-err" role="alert">{leftErr('points')[0]}</span>}
                  <Text type="tertiary" size="small">{s.fPointsHint}</Text>
                </div>
              )}
            </aside>
            <div className="card co-ed-card qb-ed-main">
              <div className="qb-ed-hrow">
                <h2 className="co-ed-h">{s.edContent}</h2>
                <AiTranslateButton formApi={null} refId={editingId || undefined} extra={trExtra} />
              </div>
              <def.Editor draft={draft} onChange={onDraftChange} lang={lang} errors={edErrors} />
              <div className="qb-ed-foot">
                <Button theme="borderless" onClick={leave}>{s.cancel}</Button>
                <Button theme="solid" type="primary" loading={saving} onClick={submitEdit}>{s.save}</Button>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ---------- AI 生成题目（整页）：左边材料与题量，右边起草结果逐题审阅 ----------
  if (view === 'ai') {
    const setCount = (k, v) => setAiCounts((prev) => ({ ...prev, [k]: Math.max(0, Math.min(10, Number(v) || 0)) }));
    return (
      <div className="wrap qb-wrap qb-page qb-ai-page">
        <div className="co-page-bar">
          <Button theme="borderless" icon={<IconArrowLeft />} onClick={() => setSearchParams({})}>{s.backToList}</Button>
          <div className="co-page-titles">
            <h1 className="co-page-title"><span className="qb-ai-headtitle"><IconBolt /> {s.aiTitle}</span></h1>
            <div className="co-page-sub">{s.aiLead}</div>
          </div>
          {(qgState === 'demo' || aiDemoRun) && <Tag color="grey" type="ghost" shape="circle">{s.aiDemoTag}</Tag>}
        </div>
        <div className="qb-ai-grid">
          <div className="card co-ed-card qb-ai qb-ai-setup">
            {(qgState === 'demo' || aiDemoRun) && (
              <Banner
                type="info"
                className="qb-ai-demo"
                closeIcon={null}
                description={s.aiDemo}
              />
            )}
            <Banner type="warning" className="qb-ai-demo" closeIcon={null} description={s.aiOutbound} />

            <div className="qb-ai-controls">
              <div className="qb-ai-field qb-ai-field-wide">
                <div className="qb-fieldlabel">{s.aiCourse}</div>
                <Select
                  value={aiCourse || undefined}
                  onChange={setAiCourse}
                  style={{ width: '100%' }}
                  optionList={courseOptions}
                  filter
                />
              </div>
              <div className="qb-ai-field">
                <div className="qb-fieldlabel">{s.aiSource}</div>
                <Select value={aiSource} onChange={setAiSource} style={{ width: '100%' }} optionList={[{ value: 'paste', label: s.aiSrcPaste }, { value: 'course', label: s.aiSrcCourse }]} />
              </div>
            </div>

            <div className="qb-ai-field">
              <div className="qb-fieldlabel">{s.aiCounts}</div>
              <div className="qb-ai-counts">
                {aiTypes.map((t) => (
                  <label key={t} className="qb-ai-count">
                    <span>{typeLabel(t)}</span>
                    <Input type="number" min={0} max={10} value={aiCounts[t] || 0} aria-label={typeLabel(t)}
                      onChange={(v) => setCount(t, v)} />
                  </label>
                ))}
                {enabledTypes().includes('case') && (
                  <label className="qb-ai-count">
                    <span>{s.aiCases}</span>
                    <Input type="number" min={0} max={10} value={aiCounts.case || 0} aria-label={s.aiCases}
                      onChange={(v) => setCount('case', v)} />
                  </label>
                )}
              </div>
              <div className={'qb-ai-total tnum' + (aiTotal > 20 || aiTotal < 1 ? ' bad' : '')}>{s.aiTotal(aiTotal)}</div>
            </div>

            {aiSource === 'paste' && (
              <div className="qb-ai-field">
                <div className="qb-fieldlabel">{s.aiMaterial}</div>
                <TextArea
                  value={aiMaterial}
                  onChange={setAiMaterial}
                  placeholder={s.aiMaterialPh}
                  autosize={{ minRows: 4, maxRows: 8 }}
                  maxLength={60000}
                />
              </div>
            )}

            <div className="qb-ai-actions">
              <Button
                theme="solid"
                type="primary"
                icon={<IconBolt />}
                loading={aiBusy}
                onClick={runGenerate}
              >
                {drafts.length ? s.aiRegen : s.aiGenerate}
              </Button>
            </div>
          </div>

          {/* drafts */}
          <div className="card co-ed-card qb-ai-results">
            <div className="qb-ai-resulthead">
              <h2 className="co-ed-h">{s.aiDrafts}{drafts.length > 0 && <> · <span className="tnum">{drafts.length}</span></>}</h2>
              {drafts.length > 0 && (
                <Space>
                  <Button theme="light" type="primary" onClick={adoptAll}>{s.aiAdoptAll}</Button>
                  <Button theme="borderless" type="tertiary" onClick={() => setDrafts([])}>{s.aiClear}</Button>
                </Space>
              )}
            </div>
            {drafts.length === 0 ? (
              <div className="qb-ai-empty">
                <Empty description={aiBusy ? s.aiGenerating : s.aiEmpty} />
              </div>
            ) : (
              <div className="qb-ai-drafts">
                {drafts.map((d) => {
                  const pv = toBody(d.draft);
                  const Pv = qtype(d.draft.type).BankPreview;
                  return (
                    <div className="qb-draft" key={d.id}>
                      <div className="qb-draft-top">
                        <TypeTag type={d.draft.type} lang={lang} size="small" />
                        <Tag color="grey" type="ghost" shape="circle" size="small">{d.demo ? s.aiDemoTag : s.aiReviewTag}</Tag>
                        {d.difficulty && <Tag color="white" type="ghost" shape="circle" size="small">{s.aiDiff[d.difficulty] || d.difficulty}</Tag>}
                        {d.similarTo && <Tag color="orange" type="light" shape="circle" size="small">{s.aiSimilar}</Tag>}
                        <Text type="quaternary" size="small" className="qb-draft-course">{courseLabel(d.draft.courseId)}</Text>
                      </div>
                      {d.draft.type !== 'case' && <div className="qb-draft-stem">{qStemOf(pv, lang)}</div>}
                      {d.sourceQuote && <div className="qb-draft-src"><Text size="small" type="tertiary">{s.aiSourceQuote}：</Text><Text size="small">“{d.sourceQuote}”</Text></div>}
                      <div className="qb-draft-pv"><Pv q={pv} lang={lang} /></div>
                      <div className="qb-draft-act">
                        <Button theme="solid" type="primary" size="small" onClick={() => adoptDraft(d)}>{s.aiAdopt}</Button>
                        <Button theme="light" type="primary" size="small" icon={<IconEdit />} onClick={() => openDraftEdit(d)}>{s.aiTweak}</Button>
                        <Popconfirm
                          title={s.aiDiscard}
                          content={s.delConfirm}
                          okText={s.aiDiscard}
                          cancelText={s.cancel}
                          okType="danger"
                          onConfirm={() => discardDraft(d)}
                        >
                          <Button theme="borderless" type="tertiary" size="small">{s.aiDiscard}</Button>
                        </Popconfirm>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="wrap qb-wrap">
      {/* header */}
      <div className="qb-head">
        <div>
          <h1 className="qb-title">{s.title}</h1>
          <div className="qb-lead">{s.lead}</div>
          {!canWrite && <div className="qb-lead">{s.roWrite}</div>}
        </div>
        {/* Pasting a spreadsheet and reviewing AI drafts both need room; on a
            phone they hide and .qb-mobilehint says where to do them instead.
            导出题库对只读档也开放（题库本就可见）。 */}
        <Space wrap>
          <Button className="qb-deskact" icon={<IconDownload />} theme="light" loading={expBusy} onClick={doExport}>{s.exp}</Button>
          {canWrite && <Button className="qb-deskact" icon={<IconUpload />} theme="light" onClick={() => setImpOpen(true)}>{s.imp}</Button>}
          {canWrite && aiAvailable && <Button className="qb-deskact" icon={<IconBolt />} theme="light" type="primary" onClick={openAi}>{s.aiGen}</Button>}
          {canWrite && <Button icon={<IconPlus />} theme="solid" type="primary" onClick={openAdd}>{s.add}</Button>}
        </Space>
      </div>

      {impOpen && (
        <QuestionImportModal
          s={s} lang={lang} loc={loc} courses={courses}
          onClose={() => setImpOpen(false)}
          onDone={() => { setImpOpen(false); qq.reload(); }}
        />
      )}

      {/* toolbar */}
      <div className="qb-toolbar">
        <Input
          prefix={<IconSearch />}
          placeholder={s.searchPh}
          value={query}
          onChange={setQuery}
          showClear
          className="qb-search"
          aria-label={s.searchPh}
        />
        <Select
          placeholder={s.courseAll}
          value={fCourse || undefined}
          onChange={(v) => setFCourse(v || '')}
          showClear
          className="qb-filter"
          optionList={courses.map((c) => ({ label: loc(c, 'title'), value: c.id }))}
        />
      </div>

      {/* Count chips are the type filter — design 20 has no type dropdown, and
          they sit after the search/course row it used to share. */}
      <div className="qb-chips" role="group" aria-label={s.colType}>
        <button
          type="button"
          className={'pill muted qb-chip' + (fType ? '' : ' on')}
          aria-pressed={!fType}
          onClick={() => setFType('')}
        >
          {s.total} <b className="tnum">{typeBase.length}</b>
        </button>
        {chipTypes.map((t) => (
          <button
            key={t}
            type="button"
            className={'pill pri qb-chip' + (fType === t ? ' on' : '')}
            aria-pressed={fType === t}
            onClick={() => setFType(fType === t ? '' : t)}
          >
            {typeLabel(t)} <b className="tnum">{typeBase.filter((r) => r.type === t).length}</b>
          </button>
        ))}
      </div>

      {(qq.error || cat.error) && (
        <Banner
          type="danger"
          className="qb-error"
          closeIcon={null}
          description={(
            <span>
              {s.loadErr}
              {((qq.error || cat.error).message) ? ` · ${(qq.error || cat.error).message}` : ''}
              {' '}
              <Button size="small" theme="borderless" onClick={() => { qq.reload(); cat.reload(); }}>{s.retry}</Button>
            </span>
          )}
        />
      )}

      {canWrite && (
        <BulkBar count={sel.count} onClear={sel.clear} busy={bulkBusy || runner.busy || tfBusy} selectPage={sel.togglePage}>
          <Button size="small" theme="light" type="primary" disabled={bulkBusy || runner.busy || tfBusy} onClick={() => openBulk('points')}>{s.bulkPoints}</Button>
          <Button size="small" theme="light" type="primary" disabled={bulkBusy || runner.busy || tfBusy} onClick={() => openBulk('course')}>{s.bulkCourse}</Button>
          {enabledTypes().includes('tf') && (
            <Button size="small" theme="light" type="primary" disabled={bulkBusy || runner.busy || tfBusy} onClick={openTf}>{s.bulkTf}</Button>
          )}
          <Popconfirm
            title={s.bulkDelTitle(sel.count)}
            content={s.bulkDelConfirm}
            okText={s.del}
            cancelText={s.cancel}
            okType="danger"
            onConfirm={doBulkDelete}
          >
            <Button size="small" type="danger" theme="solid" icon={<IconDelete />} loading={bulkBusy} disabled={runner.busy || tfBusy}>{s.bulkDel(sel.count)}</Button>
          </Popconfirm>
        </BulkBar>
      )}

      {/* table */}
      <div className="qb-tablecard">
        <div ref={sel.wrapRef}>
          <Table
            key={listVer}
            rowKey="id"
            {...resizableTable(columns.map((c) => {
              let col = c;
              if (c.sorter) col = { ...col, defaultSortOrder: listSort && listSort.dataIndex === c.dataIndex ? listSort.sortOrder : false };
              if (c.filters && c.dataIndex === 'course' && listColFilter && listColFilter.length) col = { ...col, defaultFilteredValue: listColFilter };
              return col;
            }), { extra: canWrite ? BULK_SEL_EXTRA : 0 })}
            onChange={({ sorter, filters }) => {
              setListSort(sorter && sorter.sortOrder ? { dataIndex: sorter.dataIndex, sortOrder: sorter.sortOrder } : null);
              const cf = Array.isArray(filters) ? filters.find((f) => f && f.dataIndex === 'course') : null;
              setListColFilter(cf && Array.isArray(cf.filteredValue) ? cf.filteredValue : null);
            }}
            rowSelection={canWrite ? sel.rowSelection : undefined}
            dataSource={filtered}
            loading={qq.loading}
            pagination={filtered.length > 8 ? {
              pageSize: listSize, defaultCurrentPage: clampPage(listPage, filtered.length, listSize), onPageChange: setListPage, onPageSizeChange: setListSize,
              pageSizeOpts: PAGE_TIERS, showSizeChanger: true, formatPageText: () => s.totalText(filtered.length),
            } : false}
            empty={<Empty description={s.title} />}
          />
        </div>
      </div>
      <div className="qb-mobilehint">{s.mobileHint}</div>

      {canWrite && (
        <BulkConfirmModal
          visible={!!bulkOp && !!bulkSnap}
          op={bulkOp === 'course' ? s.bulkCourse : s.bulkPoints}
          names={bulkSnap ? bulkSnap.list : []}
          okDisabled={bulkOp === 'course' ? !bulkCourseId : !bulkPtsOk}
          loading={runner.busy}
          onOk={submitBulk}
          onCancel={() => setBulkOp(null)}
        >
          {bulkOp === 'points' && (
            <div className="bulk-fields">
              <div className="bulk-field">
                <span className="bulk-field-lab">{s.bulkPtsLabel}</span>
                <InputNumber
                  min={1} max={100} precision={0} step={1}
                  value={bulkPts} disabled={bulkPtsDef}
                  onChange={(v) => setBulkPts(typeof v === 'number' && Number.isFinite(v) ? v : undefined)}
                  aria-label={s.bulkPtsLabel}
                  style={{ width: 160 }}
                />
              </div>
              <Checkbox checked={bulkPtsDef} onChange={(e) => setBulkPtsDef(!!(e && e.target && e.target.checked))}>{s.bulkPtsDefault}</Checkbox>
              <div className="bulk-hint">{s.bulkPtsHint}</div>
            </div>
          )}
          {bulkOp === 'course' && (
            <div className="bulk-fields">
              <div className="bulk-field">
                <span className="bulk-field-lab">{s.bulkCourseLabel}</span>
                <Select
                  filter
                  placeholder={s.bulkCoursePh}
                  optionList={courseOptions}
                  value={bulkCourseId}
                  onChange={(v) => { setBulkCourseId(v || undefined); setBulkModuleId(undefined); }}
                  aria-label={s.bulkCourseLabel}
                  style={{ width: '100%' }}
                />
              </div>
              <div className="bulk-field">
                <span className="bulk-field-lab">{s.bulkModuleLabel}</span>
                <Select
                  showClear
                  placeholder={s.bulkModulePh}
                  disabled={!bulkCourseId || !bulkModules.length}
                  optionList={bulkModules.map((m) => ({ label: loc(m, 'title') || m.id, value: m.id }))}
                  value={bulkModuleId}
                  onChange={(v) => setBulkModuleId(v || undefined)}
                  aria-label={s.bulkModuleLabel}
                  style={{ width: '100%' }}
                />
              </div>
              <div className="bulk-hint">{s.bulkCourseHint}</div>
            </div>
          )}
        </BulkConfirmModal>
      )}
      {canWrite && (
        <Modal
          title={s.bulkTfTitle}
          visible={!!tfSnap}
          onCancel={() => setTfSnap(null)}
          onOk={submitTf}
          okText={s.bulkTf}
          cancelText={s.cancel}
          okButtonProps={{ disabled: !tfSnap || !tfSnap.list.length, loading: tfBusy }}
          maskClosable={false}
        >
          {tfSnap && (
            <div className="qb-tfconv">
              <p>{tfSnap.list.length ? s.bulkTfLead(tfSnap.list.length, tfSnap.skip) : s.bulkTfNone}</p>
              {tfSnap.list.length > 0 && (
                <ul className="qb-tfconv-list">
                  {tfSnap.list.slice(0, 8).map((r) => <li key={r.id}>{shortName(r)}</li>)}
                  {tfSnap.list.length > 8 && <li className="qb-tfconv-more">…</li>}
                </ul>
              )}
              <div className="bulk-hint">{s.bulkTfHint}</div>
            </div>
          )}
        </Modal>
      )}
      {runner.modal}
    </div>
  );
}

/* ---------------- bulk import (paste or spreadsheet) ---------------- */
// 解析逻辑（双语列、旧模板兼容、新题型写法、案例分组、逐行校验）在 questionImport.js，
// 测试见 test/question-import.test.js 与 test/question-import-types.test.js。


function QuestionImportModal({ s, lang, loc, courses, onClose, onDone }) {
  const [courseId, setCourseId] = useState(undefined);
  const [rows, setRows] = useState([]);
  const [paste, setPaste] = useState('');
  const [headerCols, setHeaderCols] = useState(0);
  const [bilingual, setBilingual] = useState(false);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef(null);

  // Paste route: re-check on every change so the row table is the live preview.
  const onPaste = (val) => {
    setPaste(val);
    const out = impParseGrid(val.trim() ? impSplitPaste(val) : [], s);
    setRows(out.rows);
    setHeaderCols(out.headerCols);
    setBilingual(out.bilingual);
  };

  const handleFile = async (file) => {
    if (!file) return;
    try {
      const buf = await file.arrayBuffer();
      let raw;
      if (/\.csv$/i.test(file.name)) {
        let text = new TextDecoder('utf-8').decode(buf);
        if (text.includes('�')) { try { text = new TextDecoder('gb18030').decode(buf); } catch {} }
        raw = text.replace(/^﻿/, '').split(/\r?\n/).map((line) => line.split(','));
      } else {
        const XLSX = await import('xlsx');
        const wb = XLSX.read(buf, { type: 'array' });
        raw = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: false, defval: '' });
      }
      const out = impParseGrid(raw, s);
      if (!out.rows.length) { Toast.warning(s.impEmpty); return; }
      setPaste(''); // the file becomes the source of truth for the row table
      setRows(out.rows);
      setHeaderCols(out.headerCols);
      setBilingual(out.bilingual);
    } catch {
      Toast.error(s.impFileFail);
    } finally {
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  // 可导入的条数：案例连同小题算 1 条（小题行并进案例，不单独提交）
  const items = impItems(rows);
  const badN = rows.filter((r) => r._err).length;
  const submit = async () => {
    if (!courseId) { Toast.warning(s.impNeedCourse); return; }
    if (!items.length) { Toast.warning(s.impEmpty); return; }
    setBusy(true);
    try {
      const res = await api.post('/api/admin/questions/bulk', { courseId, items });
      const ok = (res.results || []).filter((r) => r.ok).length;
      const skipped = (res.results || []).length - ok;
      Toast.success(s.impDoneN(ok));
      if (skipped > 0) Toast.warning(s.impSkipN(skipped));
      onDone();
    } catch (e) {
      Toast.error(e.message);
    } finally {
      setBusy(false);
    }
  };

  const typeLabelOf = (r) => (r._err && !r.type ? '—'
    : r.type === 'mcq' && r.options && r.options.length === 2 && r.options[0].text === 'True' ? qTypeLabel('tf', lang)
      : qTypeLabel(r.type, lang));

  return (
    <Modal title={s.impTitle} visible onCancel={onClose} width={760} maskClosable={false}
      footer={(
        <Space>
          <Button theme="borderless" onClick={onClose}>{s.cancel}</Button>
          {rows.length > 0 && (
            <Button theme="solid" type="primary" loading={busy} disabled={!items.length} onClick={submit}>
              {s.impConfirm}{items.length ? `（${items.length}）` : ''}
            </Button>
          )}
        </Space>
      )}
    >
      <Banner type="info" closeIcon={null} description={s.impHint} style={{ marginBottom: 14 }} />
      <div className="qb-imp-paste">
        <div className="qb-imp-pastehead">
          <span className="qb-fieldlabel">{s.impPaste}</span>
          {rows.length > 0 && (
            <span className={'pill ' + (headerCols ? 'ok' : 'muted')}>
              {headerCols ? s.impHeaderOk(headerCols) : s.impNoHeader}
            </span>
          )}
          {rows.length > 0 && (
            <span className={'pill ' + (bilingual ? 'ok' : 'muted')}>
              {bilingual ? s.impLangSplit : s.impLangMono}
            </span>
          )}
        </div>
        <TextArea
          value={paste}
          onChange={onPaste}
          placeholder={s.impPastePh}
          autosize={{ minRows: 3, maxRows: 8 }}
          aria-label={s.impPaste}
        />
      </div>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', marginBottom: 12 }}>
        <Select
          placeholder={s.impCoursePh} value={courseId} onChange={setCourseId} filter
          style={{ minWidth: 240 }} prefix={s.impCourse + ':'}
          optionList={courses.map((c) => ({ label: loc(c, 'title'), value: c.id }))}
        />
        <input ref={fileRef} type="file" accept=".xlsx,.xls,.csv" style={{ display: 'none' }}
          onChange={(e) => handleFile(e.target.files && e.target.files[0])} />
        <Button theme="solid" type="primary" icon={<IconUpload />} onClick={() => fileRef.current && fileRef.current.click()}>
          {s.impPick}
        </Button>
        <Button icon={<IconExport />} onClick={() => window.open(`${import.meta.env.BASE_URL}templates/question-import-template.xlsx`, '_blank')}>
          {s.impTmpl}
        </Button>
      </div>
      {rows.length > 0 && (
        <>
          <div className="qb-imp-stat">{s.impStat(items.length, badN)}</div>
          <Table size="small" rowKey="_row" dataSource={rows} pagination={rows.length > 8 ? { pageSize: DEFAULT_PAGE, pageSizeOpts: PAGE_TIERS, showSizeChanger: true, formatPageText: false } : false}
            onRow={(r) => ({ className: r._sub ? 'qb-imp-subrow' : undefined })}
            {...resizableTable([
              { title: s.impColRow, dataIndex: '_row', width: 56, render: (v) => <span className="tnum">{v}</span> },
              { title: s.impColType, dataIndex: 'type', width: 96, render: (_, r) => typeLabelOf(r) },
              // 中英文题干分两行显示，导入前就能看出两列有没有对上、有没有串列；案例的小题缩进显示在案例行下面
              { title: s.impColStem, dataIndex: 'question', width: 240, render: (_, r) => {
                const cut = { display: 'block', maxWidth: 300, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' };
                if (!r._stemZh && !r._stemEn) return '—';
                return (
                  <div className={r._sub ? 'qb-imp-sub' : undefined}>
                    {r._sub && <span className="pill muted qb-imp-subtag">{s.impSubTag}</span>}
                    {r._stemZh && <span style={cut} title={r._stemZh}>{r._stemZh}</span>}
                    {r._stemEn && <span style={{ ...cut, color: 'var(--semi-color-text-2)' }} title={r._stemEn}>{r._stemEn}</span>}
                  </div>
                );
              } },
              { title: s.impColAns, dataIndex: '_ans', width: 130, render: (v) => (v ? <span className="tnum">{String(v)}</span> : '—') },
              { title: s.impColState, dataIndex: '_err', width: 200, render: (v) => (v
                ? <Tag color="red" type="light">✗ {String(v)}</Tag>
                : <Tag color="green" type="light">✓ {s.impOkTag}</Tag>) },
            ])} />
        </>
      )}
    </Modal>
  );
}
