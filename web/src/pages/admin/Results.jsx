import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import DeptFilter, { deptFilterInvalidText } from '../../components/DeptFilter.jsx';
import { useDeptTree, deptMatcher } from '../../deptfilter.js';
import { useUrlState } from '../../urlstate.js';
import {
  Table, Button, Tag, Select, Input, InputNumber, Modal, Spin,
  Toast, Typography, Banner, Empty, Space, Descriptions, Popconfirm, Tooltip,
} from '@douyinfe/semi-ui';
import { IconSearch, IconEyeOpened, IconEdit, IconSave, IconDownload, IconArrowLeft } from '@douyinfe/semi-icons';
import { api, useAsync } from '../../api.js';
import { useAuth } from '../../auth.jsx';
import { useI18n } from '../../i18n.jsx';
import { PAGE_TIERS, DEFAULT_PAGE_WIDE, useDataVersion, clampPage } from '../../pagesize.js';
import { resizableTable } from '../../cardify.js';
import { canUseAction } from '../../rbac.js';
import { BULK_SEL_EXTRA, useBulkSelection, BulkBar, BulkConfirmModal, useBulkRunner } from '../../components/BulkActions.jsx';
// 第四批 6.1：题型名、每题得分与新题型的逐题回顾都来自题型注册表（web/src/qtypes）
import { qtype, typeLabel as qTypeLabel, stemOf as qStemOf } from '../../qtypes/index.jsx';
import { earnedOf } from '../../qtypes/model.js';

const { Text } = Typography;
const NO_OPTS = [];   // 部门选项未加载时的稳定空数组
const STATUS_KEYS = ['pass', 'fail', 'flagged', 'pending', 'appealing'];   // ?status= 的合法值（顶部状态块）

/* ---------------- co-located bilingual strings ---------------- */
const T = {
  zh: {
    title: '考试成绩',
    lead: '查看员工考试记录、异常行为，并按需复核改分。',
    total: '全部', passed: '通过', failed: '未通过', flagged: '有异常',
    searchPh: '搜索员工姓名 / 工号…',
    examAll: '全部考试', examGone: '该考试不存在或没有答卷，已清除考试筛选。',
    deptLabel: '部门', deptAll: '全部部门',
    stPass: '通过', stFail: '未通过',
    colEmp: '员工', colExam: '课程 / 考试', colScore: '得分', colResult: '结果',
    colTime: '用时', colSubmitted: '提交时间', colFlags: '异常', colAction: '操作',
    tabSwitch: (n) => `切屏 ${n}`,
    pendingReview: '待复核', adjusted: '✎ 已改分',
    appealing: '申诉处理中', appealH: '员工申诉', appealBy: (n) => `${n} 对本次成绩提出申诉`,
    apAccept: '采纳申诉', apReject: '驳回申诉', apReplyPh: '回复员工（驳回必填）…',
    apDone: (st) => (st === 'accepted' ? '已受理 · 已通知员工' : '已驳回 · 已通知员工'),
    apNeedReply: '驳回时请填写理由，员工会看到这句话。',
    viewAnswers: '查看答卷', reviewAct: '复核',
    resetT: '重置考试次数', voidedTag: '已作废', voidedNoGrade: '该答卷已作废（作答次数已重置），不计入成绩，不能改分。',
    resetAsk: (n) => `将 ${n} 在本考试的全部历史尝试作废：次数清零、成绩不再计入，员工可重新参加（答卷仍保留在此处，标记为“已作废”）。`,
    resetOk: (n) => `已作废 ${n} 次尝试，员工可重考`, cancel: '取消',
    // 批量重置作答次数（2026-10-07 B7）
    bulkResetAsk: '作废所选员工在对应考试的全部历史尝试：次数清零、成绩不再计入，员工可重新参加（答卷仍保留，标记为“已作废”）。已通过或结论待定的会跳过。',
    bulkResetMerged: (k) => `同一员工的同一考试只处理一次，已合并 ${k} 条答卷。`,
    bulkResetDone: (n, v) => `已重置 ${n} 项，作废 ${v} 次尝试`,
    passLine: '是否通过以各考试的及格分为准', dash: '—',
    exportCsv: '导出考试记录 CSV',
    exportCsvTip: (n) => `下载全部 ${n} 条考试记录（含用时、切屏次数、HR 改分标记），不受当前筛选影响；导出动作写入审计日志。`,
    // 答卷复核整页（?attempt=<id>，原抽屉）
    sheetTitle: '答卷复核', sheetSub: '查看逐题作答，如有需要可复核改分。',
    pageTitle: (n) => `${n} 的答卷`, backList: '返回成绩列表', loading: '加载中…',
    notFound: '未找到这份答卷，可能已被删除，或链接有误。',
    discardTitle: '放弃未保存的修改？', discardAsk: '这份答卷有未保存的改分或申诉回复，离开后会丢失。',
    discardAskQ: '当前简答题的改分还没保存，切换题目后会丢失。', discardOk: '放弃修改', unsaved: '有未保存的修改',
    dEmp: '员工', dExam: '课程 / 考试',
    dSubmitted: '提交时间', dTime: '用时', dFlags: '异常行为',
    correctOf: (a, b) => `答对 ${a} / ${b} 题`,
    regradeH: '复核改分', regradeLab: '调整后得分',
    regradePick: '选择简答题', regradeNote2: '备注（可选）', notePh: '改分说明…',
    noOpen: '本次作答不含 AI 评分的简答题，无需人工复核改分。',
    points: (n) => `${n} 分`,
    regradeNote: '保存后将更新该题得分并重新计算总分与通过状态，并写入一条审计日志（记录操作人、原分数与新分数）。',
    save: '保存改分', saved: (n) => `已将该题得分改为 ${n} 分 · 已写入审计日志`,
    invalid: '请输入有效的分数',
    reviewH: '逐题回顾', reviewCount: (n) => `${n} 题`,
    qN: (n) => `第 ${n} 题`, yourAns: '本人作答', correctAns: '正确答案',
    correct: '正确', incorrect: '错误', partial: '部分正确',
    // 主观题的分数与评语都出自 AI 批改，标出来 HR 才知道这分数还没人看过。
    aiScore: (a, b) => `AI 给 ${a} / ${b}`, openScore: (a, b) => `得分 ${a} / ${b}`, scoreConv: (e, p) => `折算 ${e} / ${p} 分`,
    gradeScaleHint: (m, p, e) => `按 ${m} 分制评分；本题在本次考试占 ${p} 分${e != null ? `，当前录入折算为 ${e} 分` : ''}。`,
    earned: (n) => `得 ${n} 分`,
    feedback: 'AI 反馈', overridden: '已人工改分',
    close: '关闭', loadErr: '加载成绩失败', empty: '暂无考试记录',
    // 简答题 AI 初评与 HR 复核（AI 治理方案 2.5、4.3 第 7 条）
    gsGrading: '评分中', gsReview: '待复核', gsManual: '待评分', gsPendingResult: '结论待定',
    gsOverdue: '复核已超 3 个工作日', gsOverdueShort: '复核超期',
    showAnswer: '展开作答原文', hideAnswer: '收起作答原文', answerFirst: '请先展开并阅读作答原文，再确认 AI 初评。',
    aiBlock: 'AI 初评', aiMeta: (m, d) => `${m} · ${d}`, aiSuggest: (a, b) => `建议 ${a} / ${b} 分`,
    aiConf: { high: '置信度高', medium: '置信度中', low: '置信度低（不予采用）' },
    aiCriteria: '评分依据', aiLevel: { full: '完全满足', partial: '部分满足', none: '未满足' },
    aiInjection: '作答中含疑似针对评分的指令，请以评分标准为准。', aiFailed: (c) => `AI 初评未完成（${({ ai_not_configured: 'AI 服务尚未接入', ai_feature_off: 'AI 评分功能未开启', ai_budget_exhausted: '本月 AI 用量已达上限', ai_rate_limited: 'AI 调用过于频繁', ai_timeout: 'AI 响应超时', ai_output_invalid: 'AI 返回的结果无法识别', ai_output_truncated: 'AI 返回的结果不完整', ai_refused: 'AI 拒绝评分' })[c] || '服务暂时不可用'}），请人工评分。`,
    aiRetry: '重新 AI 初评', aiRetryHint: 'AI 现在可用时，可以让 AI 重新评这份答卷里还没评上的简答题；已人工定分的题不受影响。',
    aiRetryOk: '已提交 AI 重新初评，一般几十秒内完成，稍后刷新查看。',
    aiDemo: '演示模式：未接入 AI 服务，下方为关键词演示估分，不计分。', demoEst: (a, b) => `演示估分 ${a} / ${b}（不计分）`,
    confirmAi: '确认 AI 初评', confirmed: '已确认 AI 初评', confirmedToast: (n) => `已确认 AI 初评 ${n} 分 · 已写入审计日志`,
    unscored: '待评分', aiProvisional: (a, b) => `AI 初评 ${a} / ${b}`, confirmedScore: (a, b) => `已确认 ${a} / ${b}`,
    aiFeedbackLab: 'AI 评语（初评）',
    gradingNow: '该答卷仍在 AI 评分中，几分钟后刷新再处理。',
    // 只读档(learning=read)的说明:写接口服务端一律 403,按钮留着就是「假按钮」。
    roWrite: '只读权限：当前角色对培训只能查看、不能修改，写操作不可用；如需操作请联系超级管理员调整授权。',
  },
  en: {
    title: 'Exam Results',
    lead: 'Review employee attempts, flagged behavior, and regrade where needed.',
    total: 'All', passed: 'Passed', failed: 'Not passed', flagged: 'Flagged',
    searchPh: 'Search name / employee ID…',
    examAll: 'All exams', examGone: 'That exam does not exist or has no attempts. The exam filter was cleared.',
    deptLabel: 'Department', deptAll: 'All departments',
    stPass: 'Passed', stFail: 'Not passed',
    colEmp: 'Employee', colExam: 'Course / Exam', colScore: 'Score', colResult: 'Result',
    colTime: 'Time', colSubmitted: 'Submitted', colFlags: 'Flags', colAction: 'Actions',
    tabSwitch: (n) => `Tab-switch ${n}`,
    pendingReview: 'Needs review', adjusted: '✎ Adjusted',
    appealing: 'Under review', appealH: 'Grade appeal', appealBy: (n) => `${n} disputes this result`,
    apAccept: 'Uphold', apReject: 'Reject', apReplyPh: 'Reply to the employee (required to reject)…',
    apDone: (st) => (st === 'accepted' ? 'Accepted · employee notified' : 'Rejected · employee notified'),
    apNeedReply: 'A rejection needs a reason — the employee reads it.',
    viewAnswers: 'View answers', reviewAct: 'Review',
    resetT: 'Reset Attempts', voidedTag: 'Voided', voidedNoGrade: 'This attempt was voided (attempts were reset). It does not count and cannot be regraded.',
    resetAsk: (n) => `Void all of ${n}'s past attempts for this exam: the count and best score reset and they can retake it (papers stay here, flagged "Voided").`,
    resetOk: (n) => `${n} attempt(s) voided — the employee can retake`, cancel: 'Cancel',
    bulkResetAsk: 'Void all past attempts of the selected employees for those exams: the count and best score reset and they can retake it (papers stay, flagged "Voided"). Anyone who already passed, or has a result pending, is skipped.',
    bulkResetMerged: (k) => `Each employee × exam is handled once — ${k} attempt(s) merged.`,
    bulkResetDone: (n, v) => `Reset ${n}; ${v} attempt(s) voided`,
    passLine: 'Pass status follows each exam’s passing score', dash: '—',
    exportCsv: 'Export attempts CSV',
    exportCsvTip: (n) => `Downloads all ${n} attempts (time used, tab-switches, HR adjustments) — the full log, not the current filter. The export is written to the audit log.`,
    sheetTitle: 'Answer Sheet Review', sheetSub: 'Inspect each answer and regrade if needed.',
    pageTitle: (n) => `${n}'s answer sheet`, backList: 'Back to results', loading: 'Loading…',
    notFound: 'This attempt was not found. It may have been removed, or the link is wrong.',
    discardTitle: 'Discard unsaved changes?', discardAsk: 'This answer sheet has an unsaved score or appeal reply that will be lost if you leave.',
    discardAskQ: 'The score for this short answer is not saved yet and will be lost if you switch questions.', discardOk: 'Discard', unsaved: 'Unsaved changes',
    dEmp: 'Employee', dExam: 'Course / Exam',
    dSubmitted: 'Submitted', dTime: 'Time used', dFlags: 'Flagged behavior',
    correctOf: (a, b) => `${a} of ${b} correct`,
    regradeH: 'Regrade', regradeLab: 'Adjusted score',
    regradePick: 'Short answer question', regradeNote2: 'Note (optional)', notePh: 'Reason for the change…',
    noOpen: 'This attempt has no AI-graded open questions, so there is nothing to regrade.',
    points: (n) => `${n} pts`,
    regradeNote: 'Saving updates this question’s score, recomputes the total and pass status, and writes an audit-log entry (actor, old score, new score).',
    save: 'Save regrade', saved: (n) => `Score changed to ${n} pts · audit entry written`,
    invalid: 'Enter a valid score',
    reviewH: 'Question-by-Question Review', reviewCount: (n) => `${n} questions`,
    qN: (n) => `Question ${n}`, yourAns: 'Their answer', correctAns: 'Correct answer',
    correct: 'Correct', incorrect: 'Incorrect', partial: 'Partial',
    aiScore: (a, b) => `AI gave ${a} / ${b}`, openScore: (a, b) => `Score ${a} / ${b}`, scoreConv: (e, p) => `= ${e} / ${p} pts`,
    gradeScaleHint: (m, p, e) => `Score on a ${m}-point scale; this question is worth ${p} pts in this exam${e != null ? ` — this entry counts as ${e} pts` : ''}.`,
    earned: (n) => `${n} pt${n === 1 ? '' : 's'}`,
    feedback: 'AI feedback', overridden: 'Manually regraded',
    close: 'Close', loadErr: 'Failed to load results', empty: 'No attempts yet',
    gsGrading: 'Scoring', gsReview: 'Needs review', gsManual: 'Needs scoring', gsPendingResult: 'Pending',
    gsOverdue: 'Review over 3 working days', gsOverdueShort: 'Overdue',
    showAnswer: 'Show the answer', hideAnswer: 'Hide the answer', answerFirst: 'Open and read the answer before confirming the AI pre-score.',
    aiBlock: 'AI pre-score', aiMeta: (m, d) => `${m} · ${d}`, aiSuggest: (a, b) => `Suggests ${a} / ${b} pts`,
    aiConf: { high: 'High confidence', medium: 'Medium confidence', low: 'Low confidence (not adopted)' },
    aiCriteria: 'Rubric check', aiLevel: { full: 'Met', partial: 'Partly met', none: 'Not met' },
    aiInjection: 'The answer contains text that looks like instructions to the grader. Go by the rubric.', aiFailed: (c) => `AI pre-scoring did not complete (${({ ai_not_configured: 'the AI service is not connected', ai_feature_off: 'AI scoring is turned off', ai_budget_exhausted: "this month's AI usage limit has been reached", ai_rate_limited: 'too many AI requests', ai_timeout: 'the AI service timed out', ai_output_invalid: 'the AI result could not be read', ai_output_truncated: 'the AI result was incomplete', ai_refused: 'the AI declined to score it' })[c] || 'the service is temporarily unavailable'}). Please score it manually.`,
    aiRetry: 'Retry AI pre-score', aiRetryHint: 'If AI is available now, it can score the short answers here that it missed; answers HR already scored are not touched.',
    aiRetryOk: 'AI pre-scoring requested. It usually finishes within a minute — refresh to see it.',
    aiDemo: 'Demo mode: no AI service is connected; the keyword estimate below is for display only and is not counted.', demoEst: (a, b) => `Demo estimate ${a} / ${b} (not counted)`,
    confirmAi: 'Confirm AI pre-score', confirmed: 'AI pre-score confirmed', confirmedToast: (n) => `AI pre-score of ${n} confirmed · audit entry written`,
    unscored: 'Needs scoring', aiProvisional: (a, b) => `AI pre-score ${a} / ${b}`, confirmedScore: (a, b) => `Confirmed ${a} / ${b}`,
    aiFeedbackLab: 'AI feedback (provisional)',
    gradingNow: 'This attempt is still being scored by AI. Refresh in a few minutes.',
    roWrite: 'Read-only: your role can view training but not change it, so the write actions are unavailable. Ask a super-admin to widen the grant.',
  },
};

/* Score-color threshold (visual only; real pass/fail comes from the server). */
const PASS_LINE = 80;

// 批量重置作答次数（B7）能勾哪些行：与答卷页「重置考试次数」按钮（canVoid）同口径 ——
// 考试答卷、未作废、未通过、结论已定。模块级常量，引用稳定（useBulkSelection 的 isSelectable）。
const rsResettable = (r) => !!r.examId && !r.voided && !r.passed && !['pending_review', 'grading'].includes(r.gradingStatus || 'final');

// 待复核答卷的复核时限（3 个工作日，扣除周末与菲律宾公共假期）由服务端计算，列表每行带 reviewOverdue（server.js › reviewOverdue）。

export default function Results() {
  const { lang, loc } = useI18n();
  const s = T[lang];
  // 三个写控件都在培训域(矩阵 4985 appeals/:id/resolve、4963 exams/:id/reset-attempts、
  // 5008 attempts/:id/regrade),与本页同域 —— manage 档照旧,只读档收起。
  // 列表本身(任意方法 /api/admin/attempts,矩阵特判第 4 条)与导出 CSV 都是读。
  const { user } = useAuth();
  const canWrite = canUseAction(user, { domain: 'learning', module: 'learning', write: true });

  /* ---- live data ---- */
  const { loading, error, data, reload } = useAsync(() => api.get('/api/admin/attempts'), []);
  const listVer = useDataVersion(data);   // 改分 / 处理申诉后重载 → 表格按记住的页码、排序重挂
  const rows = useMemo(() => (Array.isArray(data) ? data : []), [data]);

  /* ---- filters ---- */
  const [query, setQuery] = useState('');
  // 部门（第二批 3.1）：全站统一的 DeptFilter，按行的 department（答卷提交人的部门原文）过滤，含全部下级；
  // 值写进地址栏 ?dept=，与 ?attempt= 并存（打开 / 关闭答卷整页只改 attempt，不清筛选）。
  const [urlp, patchUrl] = useUrlState();
  const fDept = urlp.dept || null;
  // CX-150：考试筛选写进地址栏 ?exam=（刷新、返回不丢）
  const fExam = urlp.exam || '';
  const setFExam = (v) => patchUrl({ exam: v || null });
  // 状态筛选（第三批 4.1，2026-10-08）：写进地址栏 ?status=，培训概览「待处理」直达（pending = 待复核 / 待评分，appealing = 申诉中）
  const fStatus = STATUS_KEYS.includes(urlp.status) ? urlp.status : '';
  const setFStatus = (v) => patchUrl({ status: v || null });
  const tree = useDeptTree();
  const deptOk = useMemo(() => deptMatcher(tree, fDept), [tree, fDept]);
  const onDeptInvalid = () => { Toast.warning(deptFilterInvalidText(lang)); patchUrl({ dept: null }); };
  // 打开答卷整页时表格会卸载；页码与每页条数记在这里，回列表时按它复原（defaultCurrentPage），
  // 不必从第 1 页重新翻。不传 currentPage：受控后 Semi 不再自己切页，列排序会失效。
  const [listPage, setListPage] = useState(1);
  const [listSize, setListSize] = useState(DEFAULT_PAGE_WIDE);
  // 列排序同理：原抽屉打开时列表一直在底下，排序不丢；改整页后表格会重挂载，
  // 这里记下当前排序（{ dataIndex, sortOrder } | null），重挂载时作为 defaultSortOrder 带回去。
  const [listSort, setListSort] = useState(null);
  useEffect(() => { setListPage(1); }, [query, fStatus, fExam, fDept]);

  /* The row's English names live under the long-standing `program` / `exam` keys
     and the server pairs the Chinese halves with them (`program_zh` / `exam_zh`),
     which is exactly the shape loc() expects — so these are one-liners. */
  const progName = (r) => loc(r, 'program');
  const examName = (r) => loc(r, 'exam');

  // The page is a list of exam attempts, so the one dropdown narrows it by exam
  // (design 21 「全部考试」), not by the course the exam hangs off: two exams on
  // the same course were indistinguishable in the old 全部课程 list.
  // Keyed by examId, not by the displayed name: the name is language-dependent,
  // so a selection made in Chinese used to filter the list down to nothing the
  // moment the user switched to English (and vice versa).
  const exams = useMemo(() => {
    const byId = new Map();
    // A deleted exam still has attempts, and the server can only send its id
    // (exam / exam_zh come from the exams table). Those rows stay OUT of the
    // dropdown rather than showing a raw "ex-7" as if it were a name — their
    // 考试 column is blank anyway, so there is nothing to filter by.
    rows.forEach((r) => {
      const label = examName(r) || r.exam;
      if (r.examId && label && !byId.has(r.examId)) byId.set(r.examId, label);
    });
    return Array.from(byId, ([value, label]) => ({ value, label }))
      .sort((a, b) => String(a.label).localeCompare(String(b.label)));
  }, [rows, lang]);
  // CX-205：地址栏 ?exam= 指向不存在（或没有答卷）的考试时，与部门筛选一样清除并提示（原来下拉显示原始编号、列表 0 行无提示）
  useEffect(() => {
    if (!data || !fExam) return;
    if (!exams.some((o) => o.value === fExam)) { Toast.warning(s.examGone); setFExam(''); }
  }, [data, fExam, exams]); // eslint-disable-line react-hooks/exhaustive-deps

  // An open (free-text) answer starts on an AI/demo score. Once HR regrades it
  // the server stamps `overridden` on that detail row — so "needs review" is
  // "has a free-text answer nobody has looked at yet", and "adjusted" is the
  // opposite. Both derive from data already on the attempt: no new column.
  // These sit above `filtered` because the 待复核 chip calls needsReview inside
  // that useMemo; declared below it they were still in TDZ and clicking the
  // chip threw a ReferenceError.
  // 待复核 / 待评分以服务端的评分状态为准（AI 治理方案 2.5）：pending_review = 简答题分数决定是否通过，须 HR 复核；
  // manual_pending = 是否通过已确定，简答题待 HR 评分。历史答卷（final）不再按「有简答题且没改过分」推断。
  const wasRegraded = (r) => (r.detail || []).some((d) => d.type === 'open' && d.overridden);
  const gsOf = (r) => r.gradingStatus || 'final';
  const needsReview = (r) => gsOf(r) === 'pending_review' || gsOf(r) === 'manual_pending';
  const pendingResult = (r) => gsOf(r) === 'pending_review' || gsOf(r) === 'grading';
  const reviewOverdue = (r) => gsOf(r) === 'pending_review' && r.reviewOverdue === true;
  const isAppealing = (r) => !!(r.appeal && r.appeal.status === 'open');

  // 部门与考试筛选先圈定范围：下面的状态计数（筛选芯片上的数字）与列表都在这个范围里算，芯片数字与看到的行一致
  // （CX-150：原来只按部门圈，选了考试后芯片仍是全部考试的数字）
  const deptRows = useMemo(() => rows.filter((r) => (!fDept || deptOk(r.department)) && (!fExam || r.examId === fExam)), [rows, fDept, deptOk, fExam]);
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return deptRows.filter((r) => {
      if (q && !((r.name || '').toLowerCase().includes(q) || (r.employeeId || '').toLowerCase().includes(q))) return false;
      if (fExam && r.examId !== fExam) return false;
      if (fStatus === 'pass' && !r.passed) return false;
      if (fStatus === 'fail' && (r.passed || pendingResult(r))) return false;
      // "Anomalies" = a tab-switch was recorded during the attempt; that is the
      // set HR actually reviews, so it gets its own filter rather than a column
      // you have to scan for.
      if (fStatus === 'flagged' && !((r.blurCount || 0) > 0)) return false;
      if (fStatus === 'pending' && !needsReview(r)) return false;
      if (fStatus === 'appealing' && !isAppealing(r)) return false;
      return true;
    });
  }, [deptRows, query, fStatus, fExam]);

  const counts = useMemo(() => ({
    total: deptRows.length,
    passed: deptRows.filter((r) => r.passed).length,
    failed: deptRows.filter((r) => !r.passed && !pendingResult(r)).length,
    flagged: deptRows.filter((r) => (r.blurCount || 0) > 0).length,
    pending: deptRows.filter(needsReview).length,
    appealing: deptRows.filter(isAppealing).length,
  }), [deptRows]);

  /* ---- 批量重置作答次数（2026-10-07 B7，components/BulkActions.jsx）----
     勾选的是答卷（表格的 rowKey），服务端换算成「员工 × 考试」，同一对只处理一次；提交前这里先按屏幕顺序去重，
     确认窗的条数与前 5 项名称都按去重后的结果显示。换搜索词或筛选即清空勾选；已作废、已通过、结论待定的行不可勾。
     这些 hook 必须写在下面 `if (attemptParam)` 的提前返回之前。 */
  const sel = useBulkSelection({ rows: filtered, isSelectable: rsResettable, resetOn: [query, fStatus, fExam, fDept], ready: !!data });
  const runner = useBulkRunner();
  const [bulkSnap, setBulkSnap] = useState(null);   // { ids, list: [名称], names: { id: 名称 }, merged }
  const openBulk = () => {
    const seen = new Set();
    const picked = [];
    sel.rows.forEach((r) => {
      const k = `${r.userId}|${r.examId}`;
      if (seen.has(k)) return;
      seen.add(k);
      picked.push(r);
    });
    if (!picked.length) return;
    const label = (r) => `${r.name} · ${examName(r) || r.exam || r.examId}`;
    const names = {};
    picked.forEach((r) => { names[String(r.id)] = label(r); });
    setBulkSnap({ ids: picked.map((r) => String(r.id)), list: picked.map(label), names, merged: sel.rows.length - picked.length });
  };
  const submitBulk = async () => {
    if (!bulkSnap) return;
    await runner.run({
      op: s.resetT, names: bulkSnap.names,
      request: () => api.post('/api/admin/attempts/bulk-reset', { ids: bulkSnap.ids }),
      // 「已重置 N 项」只数真正作废了答卷的项（作废 0 次的记为未改动，走默认文案）
      doneText: (r) => (r && r.voided ? s.bulkResetDone((r.done || 0) - (r.unchanged || 0), r.voided) : null),
      onSettled: () => { sel.clear(); reload(); },
    });
    setBulkSnap(null);
  };

  /* ---- answer-review page（2026-10-06 负责人：培训模块不用抽屉，答卷复核改整页） ----
     地址栏是唯一事实源：?attempt=<id> 打开该答卷的复核整页，删掉 attempt 回到列表，浏览器返回键可用。
     打开 / 关闭只增删 attempt 一个键（第二批 3.1：合并写回，不整串覆盖），?dept= 部门筛选留在地址栏里。
     列表的搜索 / 状态 / 考试筛选在组件状态里，切换只改查询串、本组件不卸载，回列表时原样保留。 */
  const attemptParam = urlp.attempt || null;
  const openAttemptPage = (id) => patchUrl({ attempt: String(id) }, { push: true });
  const closeAttemptPage = () => patchUrl({ attempt: null }, { push: true });
  const [openId, setOpenId] = useState(null);
  const [grade, setGrade] = useState(null);
  const [note, setNote] = useState('');
  // 改分区的快照（打开答卷、切换简答题、保存成功时记下），与当前输入比较判断是否有未保存的修改
  const [base, setBase] = useState({ grade: null, note: '' });
  const [saving, setSaving] = useState(false);
  // 复核页先展示作答原文、再展示 AI 初评；展开原文之后「确认 AI 初评」才可点（方案 4.3 第 7 条）
  const [answerShown, setAnswerShown] = useState(false);
  // Appeal handling lives beside the regrade controls: HR reads the paper,
  // optionally regrades, then answers the appeal. Accepting does not move the
  // score by itself — the regrade above is the audited action that does.
  const [apReply, setApReply] = useState('');
  const [apBusy, setApBusy] = useState(false);
  const resolveAppeal = async (status) => {
    if (!active || !active.appeal) return;
    if (status === 'rejected' && apReply.trim().length < 5) { Toast.warning(s.apNeedReply); return; }
    setApBusy(true);
    try {
      await api.post(`/api/admin/appeals/${active.appeal.id}/resolve`, { status, resolution: apReply.trim() });
      Toast.success(s.apDone(status));
      setApReply('');
      reload();
    } catch (err) { Toast.error(err.message); }
    setApBusy(false);
  };
  // Voiding attempts used to be a third button in the actions column, where it
  // did not fit and could not be clicked. It belongs next to the paper anyway —
  // you read the answers before deciding to let someone retake.
  const [resetBusy, setResetBusy] = useState(false);
  const resetAttempts = async () => {
    if (!active || !active.examId) return;
    setResetBusy(true);
    try {
      const res = await api.post(`/api/admin/exams/${active.examId}/reset-attempts`, { userId: active.userId });
      Toast.success(s.resetOk(res.voided));
      reload();
    } catch (err) { Toast.error(err.message); }
    setResetBusy(false);
  };
  const active = attemptParam ? rows.find((r) => String(r.id) === attemptParam) || null : null;

  const openQuestions = active ? (active.detail || []).filter((d) => d.type === 'open') : [];
  const activeOpen = openQuestions.find((d) => d.id === openId) || openQuestions[0] || null;

  // 进入答卷时按该答卷初始化改分区（原抽屉打开时做的事），回到列表时清空（原抽屉关闭时做的事）。
  // 深链进来时数据晚到：等 active 出现再初始化；用 layout effect 在绘制前完成，不闪上一份的值。
  const initFor = useRef(null);
  useLayoutEffect(() => {
    if (!attemptParam) {
      if (initFor.current !== null) {
        initFor.current = null;
        setOpenId(null); setGrade(null); setNote(''); setAnswerShown(false); setApReply('');
        setBase({ grade: null, note: '' });
      }
      return;
    }
    if (!active || initFor.current === attemptParam) return;
    initFor.current = attemptParam;
    const firstOpen = (active.detail || []).find((d) => d.type === 'open') || null;
    const g = firstOpen ? (firstOpen.score != null ? firstOpen.score : null) : null;
    setOpenId(firstOpen ? firstOpen.id : null);
    setGrade(g);
    setNote('');
    setAnswerShown(false);
    setApReply('');
    setBase({ grade: g, note: '' });
  }, [attemptParam, active]); // eslint-disable-line react-hooks/exhaustive-deps

  // 从列表打开：记下列表滚动位置，回列表时滚回原处；进整页时回到顶部。
  const listScroll = useRef(0);
  const openAttempt = (r) => {
    listScroll.current = window.scrollY || 0;
    openAttemptPage(r.id);
  };
  const prevAttempt = useRef(attemptParam);
  useEffect(() => {
    if (prevAttempt.current === attemptParam) return;
    const fromPage = !!prevAttempt.current;
    prevAttempt.current = attemptParam;
    if (attemptParam) window.scrollTo(0, 0);
    else if (fromPage) window.scrollTo(0, listScroll.current);
  }, [attemptParam]);

  // 未保存的修改：改分输入 / 备注与快照不同，或申诉回复已填未提交（只在这些输入可见时才算）。
  const normG = (v) => (v === '' || v == null || Number.isNaN(Number(v)) ? null : Number(v));
  // CX-207：作废答卷的改分面板只读（服务端也会 409 attempt_voided），不再出现「有未保存的修改」
  const voidedNow = !!(active && active.voided);
  const regradeOn = !!(canWrite && active && gsOf(active) !== 'grading' && activeOpen && !voidedNow);
  const gradeDirty = regradeOn && normG(grade) !== normG(base.grade);
  const dirty = !!active && ((regradeOn && (gradeDirty || note.trim() !== (base.note || '').trim()))
    || (canWrite && isAppealing(active) && apReply.trim() !== ''));
  const confirmDiscard = (fn, content) => Modal.confirm({
    title: s.discardTitle, content, okText: s.discardOk, cancelText: s.cancel, okButtonProps: { type: 'danger' }, onOk: fn,
  });
  const guard = (fn) => { if (dirty) confirmDiscard(fn, s.discardAsk); else fn(); };
  const backToList = () => guard(closeAttemptPage);

  const pickOpen = (id) => {
    const apply = () => {
      setOpenId(id);
      const q = openQuestions.find((d) => d.id === id);
      setGrade(q ? q.score : null);
      setBase((b) => ({ ...b, grade: q ? q.score : null }));
      setAnswerShown(false);
    };
    // 换一道简答题会把改分框换成那道题的分数：本题改了没保存就先问一句
    if (gradeDirty) confirmDiscard(apply, s.discardAskQ); else apply();
  };
  const aiUsable = (d) => !!(d && d.ai && !d.ai.demo && !d.ai.errorCode && d.ai.suggestedScore != null);
  // 交卷时 AI 没接通 / 出错、还没人工给分的简答题：AI 可用后可以重评（POST attempts/:id/ai-retry，只对待复核 / 待评分的答卷）。
  const canAiRetry = (a, d) => !!(canWrite && a && d && d.ai && d.ai.errorCode && d.score == null
    && (gsOf(a) === 'pending_review' || gsOf(a) === 'manual_pending'));
  const retryAi = async () => {
    if (!active) return;
    setSaving(true);
    try {
      await api.post(`/api/admin/attempts/${active.id}/ai-retry`, {});
      Toast.success(s.aiRetryOk);
      reload();
    } catch (err) { Toast.error(err.message); } finally { setSaving(false); }
  };
  const confirmAi = async () => {
    if (!active || !activeOpen) return;
    if (!answerShown) { Toast.warning(s.answerFirst); return; }
    setSaving(true);
    try {
      await api.post(`/api/admin/attempts/${active.id}/regrade`, { questionId: activeOpen.id, confirm: true });
      Toast.success(s.confirmedToast(activeOpen.ai.suggestedScore));
      reload();
    } catch (err) { Toast.error(err.message); } finally { setSaving(false); }
  };

  const saveGrade = async () => {
    if (!active || !activeOpen) return;
    const maxP = activeOpen.maxPoints ?? 10;
    // CX-145：输入框给的可能是字符串（如 abc）—— 先转数字再判，非数字、空值都拦下
    const gnum = typeof grade === 'number' ? grade : (grade == null || String(grade).trim() === '' ? NaN : Number(grade));
    if (!Number.isFinite(gnum) || gnum < 0 || gnum > maxP) {
      Toast.warning(s.invalid);
      return;
    }
    const val = Math.round(gnum);
    setSaving(true);
    try {
      await api.post(`/api/admin/attempts/${active.id}/regrade`, {
        questionId: activeOpen.id,
        score: val,
        ...(note.trim() ? { note: note.trim() } : {}),
      });
      Toast.success(s.saved(val));
      setBase({ grade, note });
      reload();
      window.dispatchEvent(new Event('tms:pending-changed'));   // CX-151：待评分角标随之刷新
    } catch (err) {
      Toast.error(err.message);
    } finally {
      setSaving(false);
    }
  };

  /* ---- shared cell helpers ---- */
  const Check = () => <svg className="ic sm" viewBox="0 0 24 24"><path d="M20 6L9 17l-5-5" /></svg>;
  const Cross = () => <svg className="ic sm" viewBox="0 0 24 24"><path d="M18 6L6 18M6 6l12 12" /></svg>;

  const scoreCls = (v) => (v >= PASS_LINE ? 'ok' : v >= 60 ? 'warn' : 'bad');

  // The list column shows 月-日 时:分 only: the full stamp is 16 characters and
  // never fitted the column, and in a list of this year's attempts the year is
  // noise. The answer-sheet page summary still spells the year out.
  const fmtDT = (iso, withYear = true) => {
    if (!iso) return s.dash;
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return String(iso);
    const p = (n) => String(n).padStart(2, '0');
    const md = `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
    return withYear ? `${d.getFullYear()}-${md}` : md;
  };
  // 用时 is mm:ss, not rounded minutes: 05:48 and 06:12 both read as "6 分钟",
  // and an attempt finished far too fast is one of the things this page exists
  // to surface. Hours only appear if an exam actually ran that long.
  const durClock = (r) => {
    if (!r.startedAt || !r.submittedAt) return null;
    const secs = Math.round((new Date(r.submittedAt) - new Date(r.startedAt)) / 1000);
    if (!Number.isFinite(secs) || secs < 0) return null;
    const p = (n) => String(n).padStart(2, '0');
    const h = Math.floor(secs / 3600);
    const m = Math.floor(secs / 60) % 60;
    return h ? `${h}:${p(m)}:${p(secs % 60)}` : `${p(m)}:${p(secs % 60)}`;
  };

  // Design 21 shows three distinct states in 异常, not just tab-switching:
  // ⚠ switched away, ✎ a score HR adjusted, and free text still awaiting a
  // human look. Shared with the phone card so both read a row the same way.
  const flagMarks = (r) => {
    const marks = [];
    if (isAppealing(r)) marks.push(<Tag key="a" color="orange" type="light" shape="circle">{s.appealing}</Tag>);
    if ((r.blurCount || 0) > 0) marks.push(<Tag key="b" color="amber" type="light" shape="circle">{s.tabSwitch(r.blurCount)}</Tag>);
    if (gsOf(r) === 'grading') marks.push(<Tag key="g" color="grey" type="light" shape="circle">{s.gsGrading}</Tag>);
    else if (gsOf(r) === 'pending_review') {
      marks.push(<Tag key="p" color="blue" type="light" shape="circle">{s.gsReview}</Tag>);
      // 列表的「异常」列较窄，用短标签，完整说明放在悬停提示与答卷整页
      if (reviewOverdue(r)) marks.push(<span key="o" title={s.gsOverdue}><Tag color="red" type="light" shape="circle">{s.gsOverdueShort}</Tag></span>);
    }
    else if (gsOf(r) === 'manual_pending') marks.push(<Tag key="m" color="cyan" type="light" shape="circle">{s.gsManual}</Tag>);
    else if (wasRegraded(r)) marks.push(<Tag key="r" color="grey" type="light" shape="circle">{s.adjusted}</Tag>);
    return marks;
  };

  /* ---- columns ---- */
  const columns = [
    {
      title: s.colEmp, dataIndex: 'name', width: 165, fixed: 'left', className: 'rs-empcol',
      render: (_, r) => (
        <>
          <div className="rs-empcell">
            <span className="rs-avatar" aria-hidden>{(r.name || '?').slice(0, 1)}</span>
            <div className="rs-empmeta">
              <Text strong>{r.name}</Text>
              <Text type="tertiary" size="small" className="tnum">{r.employeeId}</Text>
            </div>
          </div>
          {/* Below 900px this one cell draws the whole attempt as the design's
              three-line card (name + score / exam / 用时 · 提交 · 切屏) and the
              other cells hide, so the table keeps its paging and its row action
              instead of forking into a second list. */}
          <div className="rs-mcard">
            <div className="rs-mc-l1">
              <span className="rs-mc-name">{r.name}</span>
              {flagMarks(r)}
              <span className={`tnum rs-score rs-mc-score ${scoreCls(r.percent)}`}>{r.percent}</span>
            </div>
            <div className="rs-mc-l2">{r.exam ? `${progName(r)} · ${examName(r)}` : progName(r)}</div>
            <div className="rs-mc-l3 tnum">
              {[`${s.colTime} ${durClock(r) || s.dash}`, fmtDT(r.submittedAt, false), s.tabSwitch(r.blurCount || 0)].join(' · ')}
            </div>
          </div>
        </>
      ),
    },
    {
      title: s.colExam, dataIndex: 'program', width: 175,
      render: (_, r) => (
        <div className="rs-examcell">
          <Tag color="violet" type="light" shape="circle">{progName(r)}</Tag>
          {r.exam && <Text type="tertiary" size="small" className="rs-examsub">{examName(r)}</Text>}
        </div>
      ),
    },
    {
      title: s.colScore, dataIndex: 'percent', width: 88, align: 'center',
      sorter: (a, b) => (a.percent || 0) - (b.percent || 0),
      render: (v) => <span className={`tnum rs-score ${scoreCls(v)}`}>{v}</span>,
    },
    {
      title: s.colResult, dataIndex: 'passed', width: 112, align: 'center',
      render: (_, r) => (
        <Space spacing={2}>
          {pendingResult(r)
            ? <Tag color="blue" type="light" shape="circle">{s.gsPendingResult}</Tag>
            : r.passed
              ? <Tag color="green" type="light" shape="circle" prefixIcon={<Check />}>{s.stPass}</Tag>
              : <Tag color="red" type="light" shape="circle" prefixIcon={<Cross />}>{s.stFail}</Tag>}
          {r.voided && <Tag color="grey" type="light" shape="circle">{s.voidedTag}</Tag>}
        </Space>
      ),
    },
    {
      title: s.colTime, dataIndex: 'time', width: 92, align: 'center',
      render: (_, r) => <span className="tnum">{durClock(r) || s.dash}</span>,
    },
    {
      title: s.colSubmitted, dataIndex: 'submittedAt', width: 125,
      sorter: (a, b) => String(a.submittedAt || '').localeCompare(String(b.submittedAt || '')),
      render: (v) => <span className="tnum rs-date">{fmtDT(v, false)}</span>,
    },
    {
      title: s.colFlags, dataIndex: 'blurCount', width: 132, align: 'center',
      render: (_, r) => {
        const marks = flagMarks(r);
        // A clean row is a dash, not the word 正常: nothing to read means
        // nothing to look at, and the eye skips straight to the rows with tags.
        return marks.length
          ? <span className="rs-flagcell">{marks}</span>
          : <Text type="quaternary" size="small">{s.dash}</Text>;
      },
    },
    {
      // One button per row. 查看答卷 and 改分 opened the very same review, and the
      // third (重置尝试) pushed the row past the column and became unclickable —
      // it now lives in the answer-sheet page's header bar. Rows that owe the reviewer
      // something say so instead.
      title: s.colAction, dataIndex: 'op', width: 175, fixed: 'right', className: 'rs-opcol',
      render: (_, r) => {
        const owed = needsReview(r) || isAppealing(r);
        return (
          <Button theme="borderless" size="small"
            icon={owed ? <IconEdit /> : <IconEyeOpened />}
            onClick={() => openAttempt(r)}>
            {owed ? s.reviewAct : s.viewAnswers}
          </Button>
        );
      },
    },
  ];

  // Derived, not hand-tallied: the declared total was 1064 against a scroll.x of
  // 1044, and under table-layout:fixed that deficit shaves every column.

  /* ---- per-question review helpers ---- */
  const typeLabel = (d) => qTypeLabel(d.type, lang);
  // 旧四种题型沿用本页原来的「你的答案 / 正确答案」两行；第四批新题型（排序、匹配、分类、判断、多空填空、案例）
  // 用注册表的 Review 部件，audience='hr'：不论考试是否公开答案，HR 都看完整的正确答案与解析。
  const LEGACY_REVIEW = ['mcq', 'multi', 'fill', 'open'];

  const optText = (d, idx) => (idx == null || idx < 0 || !d.options || !d.options[idx]) ? s.dash : loc(d.options[idx], 'text');
  const yourAnswer = (d) => {
    if (d.type === 'mcq') return d.picked == null ? s.dash : optText(d, d.picked);
    if (d.type === 'multi') return (d.picked && d.picked.length) ? d.picked.map((i) => optText(d, i)).join('；') : s.dash;
    if (d.type === 'fill' || d.type === 'open') return d.answer || s.dash;
    return s.dash;
  };
  const correctAnswer = (d) => {
    if (d.type === 'mcq') return optText(d, d.correct);
    if (d.type === 'multi') return (d.correct || []).map((i) => optText(d, i)).join('；');
    if (d.type === 'fill') return (d.accepted || []).join(' / ');
    return null;
  };
  // Correct=full credit; open counts as correct when full marks.
  const isCorrect = (d) => (d.type === 'open' ? d.score != null && d.score >= d.maxPoints : !!d.isRight);
  // Design 21 prints what each question earned (「得 1 分」), which is how a 部分正确 row
  // says what it actually earned. 第四批（设计 §2.1）：原来写死「答对 1 分、部分正确 0.5 分」，忽略了每题分值 points；
  // 改用与学员成绩页同一个 earnedOf —— 有分值按分值（多选部分正确 = 一半），新题型 = 分值 × credit，旧答卷照旧口径。
  // 回归测试：test/results-earned.test.js。
  const objPoints = (d) => earnedOf(d);

  const detail = active ? (active.detail || []) : [];
  // CX-005（2026-10-09 验收）：「答对 a / b 题」与员工成绩页同一口径 —— 按小题计，案例展开成它的小题
  const flatDetail = detail.flatMap((d) => (d && d.type === 'case' && Array.isArray(d.items) && d.items.length ? d.items : [d]));
  const correctN = flatDetail.filter(isCorrect).length;
  const totalN = flatDetail.length;

  // ---------- 答卷复核整页（?attempt=<id>）：左栏概要与逐题回顾 · 右栏申诉与复核改分 ----------
  // 所有 hook 都在上面；下面的提前 return 只按地址栏在整页 / 列表之间分流。
  if (attemptParam) {
    if (!active) {
      return (
        <div className="wrap rs-wrap rs-page">
          <div className="co-page-bar">
            <Button theme="borderless" icon={<IconArrowLeft />} onClick={closeAttemptPage}>{s.backList}</Button>
          </div>
          <div className="card co-ed-card rs-page-empty">
            {loading && !data ? <Spin size="large" tip={s.loading} />
              : error ? <Banner type="danger" fullMode={false} closeIcon={null} description={`${s.loadErr}: ${error.message}`} />
                : <Empty description={s.notFound} />}
          </div>
        </div>
      );
    }
    // 作废按钮原在抽屉底栏，条件不变：可写、有考试、未作废、未通过、结论已定。
    const canVoid = canWrite && active.examId && !active.voided && !active.passed && !pendingResult(active);
    return (
      <div className="wrap rs-wrap rs-page">
        <div className="co-page-bar">
          <Button theme="borderless" icon={<IconArrowLeft />} onClick={backToList}>{s.backList}</Button>
          <div className="co-page-titles">
            <h1 className="co-page-title" title={s.pageTitle(active.name)}>{s.pageTitle(active.name)}</h1>
            <div className="co-page-sub">{s.sheetSub}</div>
          </div>
          {pendingResult(active)
            ? <Tag color="blue" type="light">{gsOf(active) === 'grading' ? s.gsGrading : s.gsPendingResult}</Tag>
            : active.passed
              ? <Tag color="green" type="light">{s.stPass}</Tag>
              : <Tag color="red" type="light">{s.stFail}</Tag>}
          {active.voided && <Tag color="grey" type="light">{s.voidedTag}</Tag>}
          {isAppealing(active) && <Tag color="orange" type="light">{s.appealing}</Tag>}
          {dirty && <span className="rs-page-unsaved">{s.unsaved}</span>}
          {canVoid && (
            <Popconfirm title={s.resetT} content={s.resetAsk(active.name)} okType="danger" position="bottomRight"
              okText={s.resetT} cancelText={s.cancel} onConfirm={resetAttempts}>
              <Button theme="light" type="danger" loading={resetBusy}>{s.resetT}</Button>
            </Popconfirm>
          )}
        </div>

        <div className="rs-page-grid">
          <div className="rs-page-main">
            {/* attempt summary */}
            <div className="card co-ed-card rs-page-sum">
              <Descriptions
                align="left"
                row
                size="small"
                data={[
                  { key: s.dEmp, value: `${active.name} · ${active.employeeId}` },
                  { key: s.dExam, value: active.exam ? `${progName(active)} · ${examName(active)}` : progName(active) },
                  { key: s.dSubmitted, value: <span className="tnum">{fmtDT(active.submittedAt)}</span> },
                  { key: s.dTime, value: <span className="tnum">{durClock(active) || s.dash}</span> },
                  {
                    key: s.dFlags,
                    // The page states the count either way (「切屏 0」): on the
                    // paper you are about to regrade, "none recorded" is itself
                    // the finding.
                    value: (active.blurCount || 0) > 0
                      ? <Tag color="amber" type="light" shape="circle" size="small">{s.tabSwitch(active.blurCount)}</Tag>
                      : <Text type="tertiary" className="tnum">{s.tabSwitch(0)}</Text>,
                  },
                ]}
              />
              <div className="rs-scoreblock">
                {pendingResult(active)
                  ? <span className="pill pri">{gsOf(active) === 'grading' ? s.gsGrading : s.gsReview}</span>
                  : active.passed
                    ? <span className="pill ok"><Check />{s.stPass}</span>
                    : <span className="pill res-failpill"><Cross />{s.stFail}</span>}
                {gsOf(active) === 'manual_pending' && <span className="pill muted">{s.gsManual}</span>}
                {reviewOverdue(active) && <span className="pill res-failpill">{s.gsOverdue}</span>}
                <span className={`tnum rs-bigscore ${scoreCls(active.percent)}`}>{active.percent}</span>
                <Text type="tertiary" size="small" className="tnum">{s.correctOf(correctN, totalN)}</Text>
              </div>
            </div>

            {/* answer review */}
            <div className="card co-ed-card rs-page-rev rs-review">
              <div className="sec-h">
                <h2>{s.reviewH}</h2>
                <span className="count">{s.reviewCount(flatDetail.length)}</span>
              </div>

              <div className="res-list">
                {detail.map((d, i) => {
                  const correct = isCorrect(d);
                  const partial = !!d.partial;
                  const legacy = LEGACY_REVIEW.includes(d.type);
                  const Review = legacy ? null : qtype(d.type).Review;
                  const isOpen = d.type === 'open';
                  return (
                    <div key={d.id || i} className={'res-q' + (correct ? ' ok' : ' bad')}>
                      <div className="res-qtop">
                        <span className={'res-mark' + (correct ? ' ok' : ' bad')}>
                          {correct ? <Check /> : <Cross />}
                        </span>
                        <div className="res-qhead">
                          <div className="res-qmeta">
                            <span className="res-qn tnum">{s.qN(i + 1)}</span>
                            <span className="pill muted">{typeLabel(d)}</span>
                            {isOpen ? (
                              // Until HR touches it the score is the AI's, and the
                              // page says whose it is rather than presenting it
                              // as settled.
                              <span className={'pill ' + (correct ? 'ok' : 'muted')}>
                                {d.score == null ? s.unscored
                                  : d.review === 'ai_provisional' ? s.aiProvisional(d.score, d.maxPoints)
                                    : d.review === 'confirmed' ? s.confirmedScore(d.score, d.maxPoints)
                                      : d.overridden || d.review === 'manual' ? s.openScore(d.score, d.maxPoints) : s.aiScore(d.score, d.maxPoints)}
                              </span>
                            ) : (
                              <>
                                <span className={'pill ' + (correct ? 'ok' : 'res-failpill')}>
                                  {correct ? s.correct : partial ? s.partial : s.incorrect}
                                </span>
                                <span className="res-qpts tnum">{s.earned(objPoints(d))}</span>
                              </>
                            )}
                            {/* CX-004：评分刻度（maxPoints）与考试分值（points）不同时，题卡同时写折算后的得分，与员工页一致 */}
                            {isOpen && d.score != null && d.points != null && Number(d.points) !== Number(d.maxPoints) && (
                              <span className="pill muted tnum">{s.scoreConv(Math.round(((Number(d.score) || 0) / (Number(d.maxPoints) || 1)) * Number(d.points) * 10) / 10, Number(d.points))}</span>
                            )}
                            {isOpen && d.overridden && <span className="pill pri">{s.overridden}</span>}
                          </div>
                          <div className="res-prompt">{qStemOf(d, lang)}</div>
                        </div>
                      </div>

                      {!legacy ? (
                        <div className="res-ans">
                          <Review d={d} lang={lang} showAnswers audience="hr" />
                        </div>
                      ) : (
                      <div className="res-ans">
                        <div className={'res-arow' + (correct ? ' ok' : ' bad')}>
                          <span className="res-alab">{s.yourAns}</span>
                          <span className="res-aval">{yourAnswer(d)}</span>
                        </div>
                        {!isOpen && !correct && (
                          <div className="res-arow ok">
                            <span className="res-alab">{s.correctAns}</span>
                            <span className="res-aval">{correctAnswer(d)}</span>
                          </div>
                        )}
                        {isOpen && d.feedback && (
                          <div className="res-arow">
                            <span className="res-alab">{d.review === 'ai_provisional' || d.review === 'confirmed' ? s.aiFeedbackLab : s.feedback}</span>
                            <span className="res-aval">{d.feedback}</span>
                          </div>
                        )}
                      </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          </div>

          {/* 右栏：申诉在上（HR 读完答卷、按需改分，再答复申诉），复核改分在下；宽屏时随页面吸顶 */}
          <aside className="rs-page-side">
            {isAppealing(active) && (
              <div className="rs-appeal">
                <h4>{s.appealH}</h4>
                <div className="rs-appeal-reason">
                  <Text type="tertiary" size="small">{s.appealBy(active.name)}</Text>
                  <div>{active.appeal.reason}</div>
                </div>
                {/* 申诉的事由是读,留着;受理/驳回是写(appeals/:id/resolve),只读档收起。 */}
                {canWrite && (
                  <>
                    <Input value={apReply} onChange={setApReply} placeholder={s.apReplyPh} />
                    <div className="rs-appeal-acts" style={{ marginTop: 8 }}>
                      <Button size="small" theme="solid" loading={apBusy} onClick={() => resolveAppeal('accepted')}>{s.apAccept}</Button>
                      <Button size="small" type="danger" loading={apBusy} onClick={() => resolveAppeal('rejected')}>{s.apReject}</Button>
                    </div>
                  </>
                )}
              </div>
            )}
            {/* regrade (open questions only) */}
            <div className="rs-regrade">
              <div className="rs-sec-h"><IconEdit />{s.regradeH}</div>
              {!canWrite ? (
                // 只读档:改分整块换成双语说明,而不是给一个点了必 403 的保存按钮。
                <Banner type="info" fullMode={false} closeIcon={null} className="rs-audit" description={s.roWrite} />
              ) : gsOf(active) === 'grading' ? (
                <Banner type="info" fullMode={false} closeIcon={null} className="rs-audit" description={s.gradingNow} />
              ) : activeOpen ? (
                <>
                  {openQuestions.length > 1 && (
                    <Select
                      value={activeOpen.id}
                      onChange={pickOpen}
                      style={{ width: '100%', marginBottom: 10 }}
                      aria-label={s.regradePick}
                      optionList={openQuestions.map((d, i) => ({ label: `${s.qN(i + 1)} · ${loc(d, 'question')}`, value: d.id }))}
                    />
                  )}
                  {/* 先原文、后 AI 初评（方案 4.3 第 7 条）：疑似注入时在原文上方提示；展开原文后才可确认 AI 初评 */}
                  {activeOpen.ai && activeOpen.ai.injectionFlag && <Banner type="warning" fullMode={false} closeIcon={null} className="rs-audit" description={s.aiInjection} />}
                  <Button size="small" theme="light" onClick={() => setAnswerShown((v) => !v)} style={{ marginBottom: 8 }}>{answerShown ? s.hideAnswer : s.showAnswer}</Button>
                  {answerShown && <div className="rs-openans">{activeOpen.answer || s.dash}</div>}
                  {answerShown && activeOpen.ai && (
                    <div className="rs-aibox">
                      <div className="rs-aibox-h">{s.aiBlock}{activeOpen.ai.model && <Text type="tertiary" size="small"> · {s.aiMeta(activeOpen.ai.modelReturned || activeOpen.ai.model, fmtDT(activeOpen.ai.generatedAt))}</Text>}</div>
                      {activeOpen.ai.demo ? <Text type="tertiary" size="small">{s.aiDemo}</Text>
                        : activeOpen.ai.errorCode ? (
                          <>
                            <Text type="warning" size="small">{s.aiFailed(activeOpen.ai.errorCode)}</Text>
                            {canAiRetry(active, activeOpen) && (
                              <div style={{ marginTop: 8 }}>
                                <Button size="small" theme="light" type="primary" loading={saving} onClick={retryAi}>{s.aiRetry}</Button>
                                <div><Text type="tertiary" size="small">{s.aiRetryHint}</Text></div>
                              </div>
                            )}
                          </>
                        )
                          : (
                            <>
                              <div><b className="tnum">{s.aiSuggest(activeOpen.ai.suggestedScore, activeOpen.maxPoints)}</b> · {s.aiConf[activeOpen.ai.confidence] || activeOpen.ai.confidence}</div>
                              {(activeOpen.ai.criteria || []).length > 0 && (
                                <div className="rs-aicrit">
                                  <Text type="tertiary" size="small">{s.aiCriteria}</Text>
                                  {activeOpen.ai.criteria.map((c, i) => <div key={i}>{(s.aiLevel[c.level] || c.level)} · {c.point}{c.evidence ? ` — “${c.evidence}”` : ''}</div>)}
                                </div>
                              )}
                              {activeOpen.ai.feedback && <div className="rs-aifb"><Text type="tertiary" size="small">{s.aiFeedbackLab}</Text><div>{activeOpen.ai.feedback}</div></div>}
                            </>
                          )}
                      {activeOpen.demoEstimate != null && <div className="tnum">{s.demoEst(activeOpen.demoEstimate, activeOpen.maxPoints)}</div>}
                    </div>
                  )}
                  {voidedNow && <Banner type="info" fullMode={false} closeIcon={null} className="rs-audit" description={s.voidedNoGrade} />}
                  {aiUsable(activeOpen) && activeOpen.review !== 'confirmed' && !voidedNow && (
                    <Button theme="solid" type="secondary" onClick={confirmAi} loading={saving} disabled={!answerShown} style={{ marginBottom: 10 }}>{s.confirmAi}</Button>
                  )}
                  {activeOpen.review === 'confirmed' && <div className="pill ok" style={{ marginBottom: 10 }}>{s.confirmed}</div>}
                  <div className="rs-regrade-row">
                    <InputNumber
                      value={grade}
                      onChange={setGrade}
                      min={0}
                      max={activeOpen.maxPoints ?? 10}
                      suffix={`/ ${activeOpen.maxPoints ?? 10}`}
                      step={1}
                      style={{ width: 160 }}
                      aria-label={s.regradeLab}
                      disabled={voidedNow}
                    />
                    <Button theme="solid" type="primary" icon={<IconSave />} onClick={saveGrade} loading={saving} disabled={voidedNow}>{s.save}</Button>
                  </div>
                  {/* CX-080（10/11 上线前测试）：评分刻度（maxPoints，缺省 10）与本题在本次考试的分值（points）不同时写明折算，录入时就知道实际计多少分 */}
                  {activeOpen.points != null && Number(activeOpen.points) !== Number(activeOpen.maxPoints ?? 10) && (
                    <div className="tset-lead tnum" style={{ margin: '6px 0 8px' }}>
                      {s.gradeScaleHint(activeOpen.maxPoints ?? 10, Number(activeOpen.points),
                        grade == null || grade === '' ? null : Math.round(((Number(grade) || 0) / (Number(activeOpen.maxPoints ?? 10) || 1)) * Number(activeOpen.points) * 10) / 10)}
                    </div>
                  )}
                  <Input
                    value={note}
                    onChange={setNote}
                    disabled={voidedNow}
                    placeholder={s.notePh}
                    aria-label={s.regradeNote2}
                    style={{ marginTop: 10 }}
                  />
                  {!voidedNow && <Banner type="warning" fullMode={false} closeIcon={null} className="rs-audit" description={s.regradeNote} />}
                </>
              ) : (
                <Banner type="info" fullMode={false} closeIcon={null} className="rs-audit" description={s.noOpen} />
              )}
            </div>
          </aside>
        </div>
      </div>
    );
  }

  return (
    <div className="wrap rs-wrap">
      {/* header */}
      <div className="rs-head">
        <div>
          <h1 className="rs-title">{s.title}</h1>
          <div className="rs-lead">{s.lead}</div>
          {!canWrite && <div className="rs-lead">{s.roWrite}</div>}
        </div>
        <div className="rs-headacts">
          <span className="pill pri rs-passline">{s.passLine}</span>
          {/* The server route (and only it) writes the export.attempts-csv audit
              entry, so this is a plain navigation with the session cookie rather
              than a client-side CSV built from `filtered`. Hence the tooltip
              saying the file ignores the filters above. */}
          <Tooltip content={s.exportCsvTip(rows.length)} position="bottomRight">
            <Button
              icon={<IconDownload />}
              theme="solid"
              type="primary"
              disabled={!rows.length}
              onClick={() => { window.location.href = '/api/admin/export/attempts.csv'; }}
            >{s.exportCsv}</Button>
          </Tooltip>
        </div>
      </div>

      {/* Handoff 13: the counts ARE the filter. They were display-only, so the
          number you read and the rows you saw were unrelated. Anomalies get the
          red treatment because that is the pile HR has to work through. */}
      <div className="rs-chips">
        {[
          ['', s.total, counts.total, 'muted'],
          ['pass', s.passed, counts.passed, 'ok'],
          ['fail', s.failed, counts.failed, 'warn'],
          ['flagged', s.flagged, counts.flagged, 'fail'],
          ['pending', s.pendingReview, counts.pending, 'pri'],
          ['appealing', s.appealing, counts.appealing, 'warn'],
        ].map(([val, label, n, tone]) => (
          // data-f is what the phone rules order on (异常优先, design 21 手机版):
          // 全部 → 有异常 → 待复核 first, the rest keep the desktop order.
          <button key={val || 'all'} data-f={val || 'all'}
            className={'pill ' + tone + ' rs-chip' + (fStatus === val ? ' on' : '')}
            onClick={() => setFStatus(val)}>
            {label} <b className="tnum">{n}</b>
          </button>
        ))}
      </div>

      {/* toolbar */}
      <div className="rs-toolbar">
        <Input
          prefix={<IconSearch />}
          placeholder={s.searchPh}
          value={query}
          onChange={setQuery}
          showClear
          className="rs-search"
          aria-label={s.searchPh}
        />
        {/* Status lives on the chips above and nowhere else. This used to be a
            second control bound to the same fStatus, but it only knew pass/fail:
            picking 有异常 / 待复核 / 申诉中 left it displaying the raw English
            value, and its clear button silently deselected the chip. */}
        <Select
          placeholder={s.examAll}
          value={fExam || undefined}
          onChange={(v) => setFExam(v || '')}
          showClear
          className="rs-filter"
          optionList={exams}
        />
        {/* 部门（第二批 3.1）：选上级即含全部下级；选项按数据范围裁过。部门筛选不可用（无部门读权限）时置灰 */}
        <DeptFilter options={tree ? tree.options : NO_OPTS} value={fDept} onChange={(v) => patchUrl({ dept: v || null })}
          lang={lang} label={s.deptLabel} placeholder={s.deptAll} ready={!!tree} disabled={tree === null}
          showNone={!!(tree && tree.hasNone)} onInvalid={onDeptInvalid} />
      </div>

      {/* load error */}
      {error && (
        <Banner type="danger" fullMode={false} closeIcon={null} description={`${s.loadErr}: ${error.message}`} style={{ marginBottom: 12 }} />
      )}

      {/* 批量重置作答次数（B7）：只读档不渲染勾选列与批量栏（写接口服务端 403） */}
      {canWrite && (
        <BulkBar count={sel.count} onClear={sel.clear} busy={runner.busy} selectPage={sel.togglePage}>
          <Button size="small" type="danger" theme="light" disabled={runner.busy} onClick={openBulk}>{s.resetT}</Button>
        </BulkBar>
      )}

      {/* table */}
      <div className="rs-tablecard">
        <div ref={sel.wrapRef}>
          <Table
            key={listVer}
            rowKey="id"
            loading={loading}
            {...resizableTable(columns.map((c) => (c.sorter
              ? { ...c, defaultSortOrder: listSort && listSort.dataIndex === c.dataIndex ? listSort.sortOrder : false }
              : c)), { extra: canWrite ? BULK_SEL_EXTRA : 0 })}
            onChange={({ sorter }) => setListSort(sorter && sorter.sortOrder ? { dataIndex: sorter.dataIndex, sortOrder: sorter.sortOrder } : null)}
            dataSource={filtered}
            rowSelection={canWrite ? sel.rowSelection : undefined}
            pagination={filtered.length > 8 ? {
              pageSize: listSize, defaultCurrentPage: clampPage(listPage, filtered.length, listSize), onPageChange: setListPage, onPageSizeChange: setListSize,
              pageSizeOpts: PAGE_TIERS, showSizeChanger: true, formatPageText: false,
            } : false}
            empty={<Empty description={s.empty} />}
          />
        </div>
      </div>

      {canWrite && (
        <BulkConfirmModal
          visible={!!bulkSnap}
          op={s.resetT}
          danger
          names={bulkSnap ? bulkSnap.list : []}
          loading={runner.busy}
          onOk={submitBulk}
          onCancel={() => setBulkSnap(null)}
        >
          <p>{s.bulkResetAsk}</p>
          {bulkSnap && bulkSnap.merged > 0 && <p className="rs-bulk-note">{s.bulkResetMerged(bulkSnap.merged)}</p>}
        </BulkConfirmModal>
      )}
      {runner.modal}
    </div>
  );
}
