import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Table, Form, Modal, Button, Tag, Select, Input, Popconfirm,
  Toast, Typography, Banner, Empty, Space, Spin, Tooltip,
} from '@douyinfe/semi-ui';
import {
  IconPlus, IconSearch, IconEdit, IconDelete, IconSend, IconUndo, IconAlertTriangle, IconArrowLeft,
} from '@douyinfe/semi-icons';
import { api, useAsync } from '../../api.js';
import { useAuth } from '../../auth.jsx';
import { AiTranslateButton } from '../../components/AiTranslate.jsx';
import ReadOnlyPill from '../../components/ReadOnlyPill.jsx';
import { useI18n } from '../../i18n.jsx';
import { PAGE_TIERS, DEFAULT_PAGE, useDataVersion, clampPage } from '../../pagesize.js';
import { resizableTable } from '../../cardify.js';
import { dataTableColumns } from '../../components/DataTable.jsx';   // 一致性整改 2
import { canUseAction } from '../../rbac.js';
import { useUrlState } from '../../urlstate.js';
import { useLeaveGuard } from '../../components/useLeaveGuard.js';
import { typeLabel, typePointsKeys, defaultPointsOf, ENABLED, groupOf } from '../../qtypes/spec.js';
import Composer, { COMPOSER_KEYS } from './exam/Composer.jsx';
import PaperPreview from './exam/PaperPreview.jsx';
import { paperSummary, pointsOf } from './exam/paperSummary.js';
import { drawPaper, seededRng } from './exam/drawPaper.js';

const { Text } = Typography;

// 第四批 6.1：按答对比例给分的题型（考试的 partialCredit 开关只对它们起作用）
const PARTIAL_TYPES = ['cloze', 'ordering', 'matching', 'classify'];
// 题型默认分值的表单字段名：tp_<题型>
const tpField = (k) => `tp_${k}`;

/* ---------------- co-located bilingual strings ---------------- */
const T = {
  zh: {
    title: '考试',
    lead: '设置结业考试的抽题规则、及格分与发布状态。',
    searchPh: '搜索考试名称…',
    progAll: '全部课程',
    add: '新建考试',
    colName: '名称', colProgram: '所属课程', colBank: '题库 / 抽题',
    colPass: '及格分', colLimit: '限时', colStatus: '状态', colRate: '通过率',
    colAction: '操作',
    stPublished: '已发布', stDraft: '草稿', stArchived: '已下线',
    edit: '编辑', publish: '发布', unpublish: '取消发布', archive: '下线',
    minutes: (n) => `${n} 分钟`, noLimit: '不限时',
    questionsN: (n) => `${n} 题`, drawN: (n) => `抽 ${n}`,
    // 手机卡片把规则做成标签；归档行的通过率是停用前的历史数据
    mPass: (v) => `及格 ${v}%`, mRate: (v) => `通过率 ${v}%`, rateHist: '历史',
    // 抽题数超过题库容量：服务端会拒绝发布，行内必须先说出来
    shortObj: (have, need) => `题库客观题 ${have} 题 < 抽题数 ${need}`,
    // 同一套字段说法：抽题数 = 客观题，简答题数 = 主观题
    shortOpen: (have, need) => `题库简答题 ${have} 题 < 简答题数 ${need}`,
    shortCase: (have, need) => `题库情境案例 ${have} 组 < 案例组数 ${need}`,
    shortSep: ' · ',
    shortTailDraft: '，无法发布',
    shortTailLive: '，已发布但抽不满卷，请补题',
    dash: '—',
    archiveTitle: '下线考试', archiveConfirm: (n) => `确定下线《${n}》？下线后员工将无法作答，历史记录仍会保留。`,
    publishConfirm: (n) => `确定发布《${n}》？发布后员工即可在关联课程中作答。`,
    // 整页编辑器 / 表单（2026-10-06 起不用抽屉）
    addTitle: '新建考试', editTitle: '编辑考试',
    secBasic: '基本信息', secLink: '关联内容', secRules: '评分与规则',
    fTitleZh: '名称（中文）', fTitleEn: '名称（EN）',
    fTitleZhPh: '例如 反洗钱合规结业考试', fTitleEnPh: 'e.g. AML Compliance Final Exam',
    fProgram: '所属课程', fProgramPh: '选择该考试所属的课程（题目从课程题库抽取）',
    fCourses: '关联课程', fCoursesHint: '题目将从下列已选课程的知识点中抽取。',
    pickProgramFirst: '请先选择所属课程。',
    noCourses: '该课程暂无可关联内容。',
    fPass: '及格分', fLimit: '限时', fMcq: '客观题抽题数', fOpen: '简答题数', fCase: '情境案例组数',
    fMode: '出卷方式', modeRandom: '随机抽题', modeFixed: '固定题目', modeHint: '随机抽题按下方抽题数从关联课程题库中抽；固定题目则整卷就是你在「组卷」里选定的题，顺序即答题顺序，总分固定。',
    fQuestions: '试卷', fixedN: (n) => `固定 ${n} 题`, reqQuestions: '固定题目模式至少选 1 道题，请先组卷',
    paperN: (n, pts) => `已选 ${n} 题 · ${pts} 分`, paperEmpty: '还没有选题。点「组卷」从关联课程的题库选题、排好顺序。',
    paperOut: (n) => `${n} 道题已不在关联课程题库中，保存时会移除`,
    buildPaper: '组卷', previewPaper: '预览试卷', previewRandom: '预览一套随机试卷',
    secPoints: '分值', unitPts: '分', fPtsType: (t) => `${t}默认分值`,
    ptsHint: '题库里单题设置的分值优先于这里的题型默认分值；情境案例的分值是各小题之和。及格仍按百分比判定。',
    fMultiPartial: '多选题少选且无错选给一半分', multiPartialHint: '有错选不得分；关闭后多选题必须全部选对才得分。',
    fPartial: '排序 / 匹配 / 分类 / 多空填空按答对比例给分', partialHint: '关闭后这几种题须全部答对才得分。',
    fOptOrder: '选项顺序', optRandom: '每次随机（默认）', optFixed: '固定，按题库顺序',
    optOrderHint: '排序题与匹配题右栏始终打乱，否则会直接显示答案；判断题不打乱。',
    fAttempts: '最多次数', fCooldown: '重考间隔', fShow: '考后公开正确答案与解析',
    fRetrain: '考试次数用完仍未通过时，自动重新指派本课程',
    retrainHint: '需设置「最多次数」才会触发：最后一次仍未通过时，自动清空关联课程进度与本场考试次数，员工重新学习后可再考（会收到通知）。影响范围：关联课程的全部学习进度会清空，同一课程里的其它考试也要重新学完才能解锁；已通过的考试成绩保留。',
    unitPct: '%', unitMin: '分钟', unitQ: '题', unitHr: '小时', unitGroup: '组',
    attemptsHint: '设为 0 表示不限次数。',
    showHint: '关闭可保护题库，员工只看对错与得分。',
    // F58：考前须知（选填）
    secNotice: '考前须知（选填）',
    noticeHint: '显示在员工考前说明页的系统固定须知之后；纯文本，可换行，中英文各不超过 1000 字。未填写时只显示系统须知；员工界面语言对应的一栏未填写时，显示另一种语言的内容。简答题 AI 初评告知由系统固定显示，不在此编辑。',
    fNoticeZh: '考前须知（中文）', fNoticeEn: '考前须知（EN）',
    fNoticeZhPh: '例如 请提前准备纸笔；考试期间不得查阅资料或与他人讨论。', fNoticeEnPh: 'e.g. Have pen and paper ready. Do not consult materials or discuss with others during the exam.',
    errNoticeLen: '不能超过 1000 字',
    reqTitleZh: '请输入中文标题', reqTitleAny: '请填写考试名称（中文或英文至少一个）', fixErrors: '有字段未通过校验，已定位到第一处，请修改后再保存。', reqProgram: '请选择所属课程', reqCourses: '请至少选择一门课程',
    save: '保存', cancel: '取消',
    createdOk: (n) => `已创建考试《${n}》`, updatedOk: (n) => `已更新考试《${n}》`,
    publishedOk: (n) => `已发布《${n}》`, unpublishedOk: (n) => `已取消发布《${n}》`,
    archivedOk: (n) => `已下线《${n}》`,
    loadErr: '加载考试失败', loadEditErr: '加载考试详情失败',
    // 整页编辑器（2026-10-06 负责人：考试的新建 / 编辑不用抽屉，改整页）
    backList: '返回考试列表', newSub: '保存后为草稿，可在考试列表中发布。',
    backSettings: '返回考试设置', backPaper: '返回组卷',
    unsaved: '有未保存的修改',
    discardTitle: '放弃未保存的修改？', discardAsk: '这场考试有未保存的修改，离开后会丢失。', discardOk: '放弃修改',
    sumTitle: '试卷概览', sumMode: '出卷方式', sumCount: '题量', sumPoints: '卷面总分', sumPass: '及格线',
    sumLimit: '限时', sumAttempts: '作答次数', sumPool: '关联课程题库', sumOptOrder: '选项顺序',
    poolN: (o, p, c) => `客观题 ${o} · 简答题 ${p}${c ? ` · 情境案例 ${c} 组` : ''}`,
    ptsVal: (n) => `${n} 分`, ptsRange: (a, b) => `${a}–${b} 分`, passPts: (p, n) => `${p}%（约 ${n} 分）`, pctVal: (p) => `${p}%`,
    attemptsN: (n) => `最多 ${n} 次`, attemptsUnl: '不限次数',
    sumRandomHint: '随机抽题：总分按当前题库与分值设置估算；题目自带分值不同时，每份试卷的总分会在区间内浮动。',
    sumFixedHint: '固定题目：总分为所选题目分值之和，题目自带的分值优先于题型默认分值。',
    // 只读档(learning=read)的说明:写接口服务端一律 403,按钮留着就是「假按钮」。
    roWrite: '只读权限：当前角色对培训只能查看、不能修改，写操作不可用；如需操作请联系超级管理员调整授权。',
    fixErrs: '考试设置里有需要修改的地方。',
  },
  en: {
    title: 'Exams',
    lead: 'Set draw rules, passing scores and publishing status for final exams.',
    searchPh: 'Search exam name…',
    progAll: 'All courses',
    add: 'New exam',
    colName: 'Name', colProgram: 'Course', colBank: 'Bank / Draw',
    colPass: 'Passing Score', colLimit: 'Time limit', colStatus: 'Status', colRate: 'Pass rate',
    colAction: 'Actions',
    stPublished: 'Published', stDraft: 'Draft', stArchived: 'Retired',
    edit: 'Edit', publish: 'Publish', unpublish: 'Unpublish', archive: 'Retire',
    minutes: (n) => `${n} min`, noLimit: 'No limit',
    questionsN: (n) => `${n} Q`, drawN: (n) => `draw ${n}`,
    mPass: (v) => `Pass ${v}%`, mRate: (v) => `Pass rate ${v}%`, rateHist: 'Past',
    shortObj: (have, need) => `objective bank ${have} Q < draw count ${need}`,
    shortOpen: (have, need) => `short-answer bank ${have} Q < short answers ${need}`,
    shortCase: (have, need) => `scenario-case bank ${have} < case groups ${need}`,
    shortSep: ' · ',
    shortTailDraft: ' — cannot publish',
    shortTailLive: ' — live but the paper cannot be filled, add questions',
    dash: '—',
    archiveTitle: 'Retire Exam', archiveConfirm: (n) => `Retire “${n}”? Employees can no longer take it; its history is kept.`,
    publishConfirm: (n) => `Publish “${n}”? Once published, employees can take it in the linked course.`,
    addTitle: 'New exam', editTitle: 'Edit exam',
    secBasic: 'Basics', secLink: 'Linked content', secRules: 'Scoring & rules',
    fTitleZh: 'Name (Chinese)', fTitleEn: 'Name (EN)',
    fTitleZhPh: 'e.g. 反洗钱合规结业考试', fTitleEnPh: 'e.g. AML Compliance Final Exam',
    fProgram: 'Course', fProgramPh: 'Select the course this exam belongs to (questions come from its bank)',
    fCourses: 'Linked courses', fCoursesHint: 'Questions are drawn from the topics of the selected courses.',
    pickProgramFirst: 'Choose a course first.',
    noCourses: 'Nothing to link under this course yet.',
    fPass: 'Passing score', fLimit: 'Time limit', fMcq: 'Objective questions drawn', fOpen: 'Short answer questions', fCase: 'Scenario case groups',
    fMode: 'Paper', modeRandom: 'Random draw', modeFixed: 'Fixed questions', modeHint: 'Random draw picks the counts below from the linked courses’ bank; fixed questions makes the paper exactly the questions you choose in Build paper, in that order, with a fixed total.',
    fQuestions: 'Paper', fixedN: (n) => `${n} fixed`, reqQuestions: 'A fixed-question exam needs at least one question. Build the paper first.',
    paperN: (n, pts) => `${n} question${n === 1 ? '' : 's'} · ${pts} pts`, paperEmpty: 'No questions yet. Select Build paper to pick questions from the linked courses and order them.',
    paperOut: (n) => `${n} question${n === 1 ? ' is' : 's are'} no longer in the linked courses’ bank and will be removed on save`,
    buildPaper: 'Build paper', previewPaper: 'Preview paper', previewRandom: 'Preview a random paper',
    secPoints: 'Points', unitPts: 'pt', fPtsType: (t) => `${t} default points`,
    ptsHint: 'A question’s own points (set in the Question Bank) override these per-type defaults; a scenario case scores the sum of its sub-questions. Passing is still judged as a percentage.',
    fMultiPartial: 'Half credit for multiple-answer questions with a missed option and no wrong option', multiPartialHint: 'Any wrong option scores zero. When off, a multiple-answer question scores only when every correct option is selected.',
    fPartial: 'Give proportional credit on ordering, matching, classification and multi-blank questions', partialHint: 'When off, these questions score only when fully correct.',
    fOptOrder: 'Option order', optRandom: 'Shuffle for each attempt (default)', optFixed: 'Fixed, as entered in the question bank',
    optOrderHint: 'Ordering items and the right-hand column of matching questions are always shuffled; otherwise the answer would be visible. True/false is never shuffled.',
    fAttempts: 'Max attempts', fCooldown: 'Time between attempts', fShow: 'Reveal correct answers and explanations after the exam',
    fRetrain: 'Reassign the course automatically when all attempts are used without passing',
    retrainHint: 'Requires a max-attempts limit: failing the last attempt clears the linked course progress and resets this exam\'s attempts — the employee re-studies and retakes (with a notification). Scope: all learning progress of the linked course is cleared, so other exams in that course must be unlocked again by finishing the modules; passed results are kept.',
    unitPct: '%', unitMin: 'min', unitQ: 'Q', unitHr: 'h', unitGroup: 'groups',
    attemptsHint: 'Set to 0 for unlimited attempts.',
    showHint: 'Off keeps the bank protected — employees see only right/wrong and their score.',
    secNotice: 'Pre-exam notice (optional)',
    noticeHint: 'Shown on the employee’s exam preparation page after the standard notes. Plain text with line breaks, up to 1,000 characters in each language. If both are blank, only the standard notes appear; if the employee’s language is blank, the other language is shown. The AI pre-scoring disclosure for short answers is fixed by the system and is not edited here.',
    fNoticeZh: 'Pre-exam notice (Chinese)', fNoticeEn: 'Pre-exam notice (EN)',
    fNoticeZhPh: 'e.g. 请提前准备纸笔；考试期间不得查阅资料或与他人讨论。', fNoticeEnPh: 'e.g. Have pen and paper ready. Do not consult materials or discuss with others during the exam.',
    errNoticeLen: 'Keep it within 1,000 characters',
    reqTitleZh: 'Chinese title is required', reqTitleAny: 'Enter an exam name (Chinese or English)', fixErrors: 'Some fields failed validation. The first one is shown; fix it and save again.', reqProgram: 'Course is required', reqCourses: 'Select at least one course',
    save: 'Save', cancel: 'Cancel',
    createdOk: (n) => `Exam "${n}" created`, updatedOk: (n) => `Exam "${n}" updated`,
    publishedOk: (n) => `Published “${n}”`, unpublishedOk: (n) => `Unpublished “${n}”`,
    archivedOk: (n) => `Retired “${n}”`,
    loadErr: 'Failed to load exams', loadEditErr: 'Failed to load exam',
    backList: 'Back to exams', newSub: 'Saved as a draft; publish it from the exam list.',
    backSettings: 'Back to exam settings', backPaper: 'Back to paper',
    unsaved: 'Unsaved changes',
    discardTitle: 'Discard unsaved changes?', discardAsk: 'This exam has unsaved changes that will be lost if you leave.', discardOk: 'Discard',
    sumTitle: 'Paper summary', sumMode: 'Paper', sumCount: 'Questions', sumPoints: 'Total points', sumPass: 'Passing score',
    sumLimit: 'Time limit', sumAttempts: 'Attempts', sumPool: 'Linked question bank', sumOptOrder: 'Option order',
    poolN: (o, p, c) => `${o} objective · ${p} short answer${c ? ` · ${c} scenario case${c === 1 ? '' : 's'}` : ''}`,
    ptsVal: (n) => `${n} pts`, ptsRange: (a, b) => `${a}–${b} pts`, passPts: (p, n) => `${p}% (about ${n} pts)`, pctVal: (p) => `${p}%`,
    attemptsN: (n) => `Up to ${n}`, attemptsUnl: 'Unlimited',
    sumRandomHint: 'Random draw: the total is estimated from the current bank and point settings; when questions carry different points, each paper’s total varies within the range.',
    sumFixedHint: 'Fixed questions: the total is the sum of the selected questions’ points; a question’s own points override the per-type defaults.',
    roWrite: 'Read-only: your role can view training but not change it, so the write actions are unavailable. Ask a super-admin to widen the grant.',
    fixErrs: 'Some exam settings need attention.',
  },
};

export default function Exams() {
  const { lang, loc } = useI18n();
  const s = T[lang];
  // 新建/编辑/发布/撤回/归档都打 POST|PUT /api/admin/exams(矩阵 3459 / 3485 = 培训域写),
  // 与本页同域 —— manage 档照旧,只读档收起。GET exams/:id 是读,不另设门。
  const { user } = useAuth();
  const canWrite = canUseAction(user, { domain: 'learning', module: 'learning', write: true });

  /* ---- reads ---- */
  const ex = useAsync(() => api.get('/api/admin/exams'), []);
  const listVer = useDataVersion(ex.data);   // 保存后重载 → 表格按记住的页码重挂
  const cat = useAsync(() => api.get('/api/admin/catalog'), []);
  // 固定题目模式的选题清单：全部题目，按表单里选中的课程过滤
  const bank = useAsync(() => api.get('/api/admin/questions').catch(() => []), []);
  const [formMode, setFormMode] = useState('random');
  const [formCourses, setFormCourses] = useState([]);
  const [formQuestionIds, setFormQuestionIds] = useState([]);

  const rows = ex.data || [];
  const programs = cat.data?.programs || [];
  const courses = cat.data?.courses || [];

  const progById = useMemo(() => {
    const m = {};
    programs.forEach((p) => { m[p.id] = p; });
    return m;
  }, [programs]);

  const progName = (id, fallback) => {
    const p = progById[id];
    return p ? loc(p, 'title') : (fallback || id);
  };
  const examName = (r) => (lang === 'zh' ? (r.title_zh || r.title) : (r.title || r.title_zh));
  const examSub = (r) => (lang === 'zh' ? r.title : r.title_zh);
  const statusLabel = (st) => (st === 'published' ? s.stPublished : st === 'archived' ? s.stArchived : s.stDraft);
  const statusTone = (st) => (st === 'published' ? 'ok' : st === 'archived' ? 'muted' : 'warn');
  const rateTone = (rate) => (rate >= 80 ? 'ok' : rate >= 60 ? 'warn' : 'bad');
  // "32 题 / 抽 8": bank capacity first, then the objective draw count — the same
  // figure the drawer calls 抽题数 (简答题数 is its own field, and its own ⚠).
  const bankText = (r) => (r.mode === 'fixed'
    ? s.fixedN((r.questionIds || []).length)
    : `${s.questionsN((r.poolObjective || 0) + (r.poolOpen || 0) + (r.poolCase || 0))} / ${s.drawN(r.mcqCount || 0)}`);

  /* ---- bank capacity vs draw counts ----
     The server refuses to publish when either pool is thinner than its own draw
     count (validateExam: poolObjective < mcqCount || poolOpen < openCount), and
     it says so in English after the click. The row says it first, per pool —
     "题库 4 题" alone would be a lie when only the open pool is short.
     第四批：情境案例按组另算（poolCase < caseCount）。 */
  const bankShortWhy = (r) => {
    const parts = [];
    if ((r.poolObjective || 0) < (r.mcqCount || 0)) parts.push(s.shortObj(r.poolObjective || 0, r.mcqCount || 0));
    if ((r.poolOpen || 0) < (r.openCount || 0)) parts.push(s.shortOpen(r.poolOpen || 0, r.openCount || 0));
    if ((r.poolCase || 0) < (r.caseCount || 0)) parts.push(s.shortCase(r.poolCase || 0, r.caseCount || 0));
    if (!parts.length) return null;
    // A live exam is already past the gate: the fix is questions, not a click.
    return parts.join(s.shortSep) + (r.status === 'published' ? s.shortTailLive : s.shortTailDraft);
  };

  /* ---- filters ---- */
  const [query, setQuery] = useState('');
  const [fStatus, setFStatus] = useState('');
  // 打开整页编辑器时表格会卸载；页码与每页条数记在这里，回列表时复原（同成绩页做法，不传 currentPage）
  const [listPage, setListPage] = useState(1);
  const [listSize, setListSize] = useState(DEFAULT_PAGE);
  // 地址栏是唯一事实源（2026-10-06 整页编辑，不再用抽屉）：
  //   ?program=<包装程序 id>  列表按课程筛选（课程编辑器右栏跳来；筛选下拉也写回这里）
  //   ?edit=<examId>          该考试的整页编辑器（课程编辑器「去考试页编辑」、培养项目考试节点跳来）
  //   ?new=1                  新建考试整页；带 ?program= 时预填所属课程
  //   &view=paper | preview   第四批：考试编辑页的子视图「组卷」「预览试卷」（同一份表单状态，未保存的新考试也能用）
  // 写地址一律经 useUrlState().patch（只改给出的键，其余保留）；返回列表时保留 ?program=；浏览器后退可用。
  const [urlp, patchUrl] = useUrlState();
  const fProg = urlp.program || '';
  const editParam = urlp.edit || null;
  // 同原深链：edit 优先于 new；只读档不开新建页
  const isNewPage = !editParam && urlp.new === '1' && canWrite;
  const pageOpen = !!editParam || isNewPage;
  // 离开整页：编辑页的键（含组卷筛选）全部清掉，?program= 留着
  const PAGE_CLEAR = ['edit', 'new', 'view', ...COMPOSER_KEYS];
  const toList = () => patchUrl(Object.fromEntries(PAGE_CLEAR.map((k) => [k, null])), { push: true });

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows.filter((r) => {
      if (q && !((r.title || '').toLowerCase().includes(q) || (r.title_zh || '').toLowerCase().includes(q))) return false;
      if (fProg && r.programId !== fProg) return false;
      if (fStatus && r.status !== fStatus) return false;
      return true;
    });
  }, [rows, query, fProg, fStatus]);

  // Segment sizes for the status chips — counted over every exam, not the
  // filtered view, so the numbers stay put while you click through them.
  const counts = useMemo(() => ({
    published: rows.filter((r) => r.status === 'published').length,
    draft: rows.filter((r) => r.status === 'draft').length,
    archived: rows.filter((r) => r.status === 'archived').length,
  }), [rows]);

  /* ---- editor page ----
     2026-10-06 负责人：培训模块不再用抽屉 —— 新建 / 编辑考试改为整页，由地址栏驱动（见上方 editParam / isNewPage）。 */
  const [editingId, setEditingId] = useState(null); // null => creating
  const [editData, setEditData] = useState(null); // contract-shaped exam (or defaults)
  const [editLoading, setEditLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [formProgram, setFormProgram] = useState(undefined); // drives the course list
  // 未保存修改守卫：载入时的表单快照 vs 当前表单值；当前值同时驱动右栏的试卷概览
  const [formBase, setFormBase] = useState('');
  const [formVals, setFormVals] = useState(null);
  const editApi = useRef(null);
  const loadSeq = useRef(0); // 快速切换考试时丢弃过期的详情响应
  const listScroll = useRef(null); // 从列表进整页时记下列表滚动位置，回列表时滚回原处（同原抽屉：列表不动）
  // 预览试卷：从哪个视图打开（返回按钮回到那里）；随机抽题考试的示例种子（「换一套」换种子）
  const [previewFrom, setPreviewFrom] = useState('settings');
  const [sampleSeed, setSampleSeed] = useState(() => Date.now());

  // 新考试的题型默认分值（负责人 2026-10-06 定：客观题 1 分、简答 10 分；第四批新题型按题型目录默认）
  const defaultTypePoints = () => Object.fromEntries(typePointsKeys().map((k) => [k, defaultPointsOf(k)]));
  const defaults = {
    title: '', title_zh: '', programId: undefined, courseIds: [],
    passingScore: 80, timeLimitMinutes: 0, mcqCount: 8, openCount: 1, caseCount: 0,
    maxAttempts: 0, retakeCooldownHours: 0, showAnswersAfterExam: true,
    typePoints: defaultTypePoints(), multiPartial: true,
    // 第四批：选项顺序（10.6，默认每次随机）、新题型按比例给分（默认开）
    shuffleOptions: true, partialCredit: true,
    mode: 'random', questionIds: [],
  };

  const editInit = (src) => {
    const d = src || editData || defaults;
    const tp = d.typePoints && typeof d.typePoints === 'object' ? d.typePoints : null;
    const out = {
      titleZh: d.title_zh || '',
      titleEn: d.titleEn !== undefined ? d.titleEn : (d.title || ''),   // CX-154：编辑时英文框显示库里的英文原值（可能为空）
      program: d.programId,
      courses: d.courseIds || [],
      pass: d.passingScore ?? 80,
      limit: d.timeLimitMinutes ?? 0,
      mcqCount: d.mcqCount ?? 8,
      openCount: d.openCount ?? 1,
      caseCount: d.caseCount ?? 0,
      attempts: d.maxAttempts ?? 0,
      cooldown: d.retakeCooldownHours ?? 0,
      showAnswers: d.showAnswersAfterExam ?? true,
      autoRetrain: d.autoRetrain !== false,
      multiPartial: d.multiPartial !== false,
      partialCredit: d.partialCredit !== false,
      optOrder: d.shuffleOptions === false ? 'fixed' : 'random',
      mode: d.mode === 'fixed' ? 'fixed' : 'random',
      questionIds: Array.isArray(d.questionIds) ? d.questionIds : [],
      // F58：考前须知（选填）
      noticeZh: d.preNotice_zh || '',
      noticeEn: d.preNotice || '',
    };
    // 题型默认分值：旧考试 typePoints 为空 → 按旧口径的等价值回显（客观题 1 分、简答 1 分）；缺的键按题型目录默认
    for (const k of typePointsKeys()) out[tpField(k)] = tp ? (tp[k] ?? defaultPointsOf(k)) : 1;
    return out;
  };

  // 比较用的规范化：随机抽题时题目清单不参与（保存时也会被清空）；清空的数字框按空值比较
  const pickExam = (v) => (v ? JSON.stringify({
    titleZh: v.titleZh || '', titleEn: v.titleEn || '',
    // 关联课程是集合（CheckboxGroup 取消再勾回会把它排到末尾），排序后再比；题目清单的顺序就是出题顺序，不排序
    program: v.program || '', courses: Array.isArray(v.courses) ? [...v.courses].sort() : [],
    pass: v.pass ?? '', limit: v.limit ?? '', mcqCount: v.mcqCount ?? '', openCount: v.openCount ?? '', caseCount: v.caseCount ?? '',
    attempts: v.attempts ?? '', cooldown: v.cooldown ?? '',
    showAnswers: !!v.showAnswers, autoRetrain: v.autoRetrain !== false,
    tp: typePointsKeys().map((k) => v[tpField(k)] ?? ''),
    multiPartial: v.multiPartial !== false, partialCredit: v.partialCredit !== false,
    optOrder: v.optOrder === 'fixed' ? 'fixed' : 'random',
    mode: v.mode === 'fixed' ? 'fixed' : 'random',
    questionIds: v.mode === 'fixed' && Array.isArray(v.questionIds) ? v.questionIds : [],
    notice: [String(v.noticeZh || '').trim(), String(v.noticeEn || '').trim()],
  }) : '');

  // 载入表单：与原 openAdd / openEdit 的状态初始化相同，并记下快照
  const openForm = (d) => {
    const iv = editInit(d);
    setEditData(d);
    setFormProgram(d.programId);
    setFormMode(d.mode === 'fixed' ? 'fixed' : 'random');
    setFormCourses(Array.isArray(d.courseIds) ? d.courseIds : []);
    setFormQuestionIds(Array.isArray(d.questionIds) ? d.questionIds : []);
    setFormVals(iv);
    setFormBase(pickExam(iv));
  };

  // 地址栏 → 编辑器：?edit=<id> 拉详情；?new=1 用默认值（带 ?program= 时预填所属课程，同原深链）；都没有 = 列表
  useEffect(() => {
    const seq = ++loadSeq.current;
    // 整页从顶部开始（不停在列表的滚动位置）；回到列表时滚回进入前的位置
    if (editParam || isNewPage) { try { window.scrollTo(0, 0); } catch { /* no window */ } }
    else if (listScroll.current != null) {
      const y = listScroll.current;
      listScroll.current = null;
      try { window.scrollTo(0, y); } catch { /* no window */ }
    }
    if (editParam) {
      setEditingId(editParam);
      setEditData(null);
      setFormProgram(undefined);
      setFormBase(''); setFormVals(null);
      setEditLoading(true);
      api.get(`/api/admin/exams/${encodeURIComponent(editParam)}`).then((exam) => {
        if (seq !== loadSeq.current) return;
        openForm(exam);
        setEditLoading(false);
      }).catch((err) => {
        if (seq !== loadSeq.current) return;
        setEditLoading(false);
        Toast.error(err.message || s.loadEditErr);
        // 同原抽屉：详情载入失败就回到列表
        patchUrl(Object.fromEntries(PAGE_CLEAR.map((k) => [k, null])), { push: false });
      });
    } else if (isNewPage) {
      setEditingId(null);
      setEditLoading(false);
      openForm({ ...defaults, programId: fProg || undefined });
    } else {
      setEditingId(null);
      setEditData(null);
      setEditLoading(false);
      setFormBase(''); setFormVals(null);
    }
    // 切换考试 / 离开本页时作废在途请求（卸载后再跳转会把人从别的页面拽回考试列表）
    return () => { loadSeq.current += 1; };
  }, [editParam, isNewPage]); // eslint-disable-line react-hooks/exhaustive-deps

  const examDirty = pageOpen && !!formBase && pickExam(formVals) !== formBase;
  // 关页 / 刷新 / 站内链接 / 后退：全局离开守卫（第二批 useLeaveGuard，取代本页原来的 beforeunload）
  useLeaveGuard(examDirty, s.discardAsk);
  // 离开整页（返回列表 / 取消）：有未保存的修改先确认
  const guardLeave = (fn) => {
    if (!examDirty) { fn(); return; }
    Modal.confirm({ title: s.discardTitle, content: s.discardAsk, okText: s.discardOk, cancelText: s.cancel, okButtonProps: { type: 'danger' }, onOk: fn });
  };
  const leavePage = () => guardLeave(toList);

  // 子视图切换（设置 ⇄ 组卷 ⇄ 预览）：同一页、同一份表单，用 replace —— 后退键直接离开整页（经离开守卫确认），
  // 不会在子视图之间来回、也不会被守卫误当成离开
  const view = pageOpen && (urlp.view === 'paper' || urlp.view === 'preview') ? urlp.view : 'settings';
  const goView = (v) => {
    patchUrl({ view: v === 'settings' ? null : v }, { push: false });
    try { window.scrollTo(0, 0); } catch { /* no window */ }
  };
  const openPreview = (from) => { setPreviewFrom(from); setSampleSeed(Date.now()); goView('preview'); };

  // 列表 → 整页：推一条历史（浏览器后退回到列表），保留 ?program= 筛选
  const rememberScroll = () => { try { listScroll.current = window.scrollY || 0; } catch { /* no window */ } };
  const openAdd = () => { rememberScroll(); patchUrl({ new: '1', edit: null, view: null }, { push: true }); };
  const openEdit = (r) => { rememberScroll(); patchUrl({ edit: r.id, new: null, view: null }, { push: true }); };

  // when the program changes inside the form, reset the course selection
  const onValueChange = (values, changed) => {
    if (changed && Object.prototype.hasOwnProperty.call(changed, 'program')) {
      setFormProgram(values.program);
      if (editApi.current) editApi.current.setValue('courses', []);
    }
    if (values) { setFormMode(values.mode === 'fixed' ? 'fixed' : 'random'); setFormCourses(Array.isArray(values.courses) ? values.courses : []); setFormQuestionIds(Array.isArray(values.questionIds) ? values.questionIds : []); }
    // 当前值的副本：未保存守卫与右栏概览用（Semi 传进来的是内部对象，复制一份再存）
    if (values) setFormVals(JSON.parse(JSON.stringify(values)));
  };

  // 组卷页改试卷：写回同一份表单的 questionIds（表单在组卷视图下仍然挂着，只是隐藏）
  const setPaper = (ids) => {
    const next = Array.isArray(ids) ? ids.slice() : [];
    if (editApi.current) editApi.current.setValue('questionIds', next);
    setFormQuestionIds(next);
    setFormVals((v) => ({ ...(v || {}), questionIds: next }));
  };

  const submitEdit = () => {
    const formApi = editApi.current;
    if (!formApi) return;
    // CX-008：校验失败时整体提示并滚到第一处错误（原来只在页首字段下方标红，页尾看不到）
    const onInvalid = () => {
      Toast.error(s.fixErrors);
      setTimeout(() => { const el = document.querySelector('.semi-form-field-error-message'); if (el && el.scrollIntoView) el.scrollIntoView({ block: 'center', behavior: 'smooth' }); }, 0);
    };
    formApi.validate().catch((errs) => { onInvalid(); throw errs; }).then((v0) => {
      const v = { ...(formApi.getValues ? formApi.getValues() : {}), ...v0 };
      const name = lang === 'zh' ? (v.titleZh || v.titleEn) : (v.titleEn || v.titleZh);
      const status = editingId ? (editData?.status || 'draft') : 'draft';
      const fixed = v.mode === 'fixed';
      const qids = fixed ? formQuestionIds : [];
      if (fixed && !qids.length) { Toast.warning(s.reqQuestions); return; }
      const body = {
        programId: v.program,
        title: (v.titleEn || '').trim(),   // CX-154：英文留空就留空，不再用中文名填
        title_zh: (v.titleZh || '').trim() || null,
        status,
        // Single-course wrapper: the link is implied, no need to tick a box.
        courseIds: (v.courses && v.courses.length) ? v.courses : courseOptions.map((c) => c.id),
        passingScore: v.pass,
        mcqCount: v.mcqCount,
        openCount: v.openCount,
        caseCount: v.caseCount || 0,
        timeLimitMinutes: v.limit ? v.limit : null,
        maxAttempts: v.attempts,
        retakeCooldownHours: v.cooldown,
        showAnswersAfterExam: v.showAnswers,
        autoRetrain: v.autoRetrain !== false,
        typePoints: Object.fromEntries(typePointsKeys().map((k) => [k, v[tpField(k)]])),
        multiPartial: v.multiPartial !== false,
        partialCredit: v.partialCredit !== false,
        shuffleOptions: v.optOrder !== 'fixed',
        mode: fixed ? 'fixed' : 'random',
        questionIds: qids,
        // F58：考前须知（选填，纯文本）；清空 = null，员工端只显示系统须知
        preNotice: String(v.noticeEn || '').trim() || null,
        preNotice_zh: String(v.noticeZh || '').trim() || null,
      };
      setSaving(true);
      const pageSeq = loadSeq.current; // 保存途中离开 / 换了考试，就不再导航
      const req = editingId
        ? api.put(`/api/admin/exams/${editingId}`, body)
        : api.post('/api/admin/exams', body);
      req.then(() => {
        Toast.success(editingId ? s.updatedOk(name) : s.createdOk(name));
        setFormBase(pickExam({ ...v, questionIds: qids })); // 已保存：离开守卫随之解除
        if (pageSeq === loadSeq.current) toList(); // 保存后回到列表（同原抽屉关闭）
        setSaving(false);
        ex.reload();
      }).catch((err) => {
        setSaving(false);
        // 服务端带中文提示（如 F58 考前须知超长 pre_notice_too_long）时中文界面用中文
        Toast.error((lang === 'zh' && err.data && err.data.error_zh) || err.message);
      });
    }).catch(() => {
      // 校验没过的字段在设置视图里：从组卷 / 预览保存时先切回去，让人看到红字
      if (view !== 'settings') { goView('settings'); Toast.warning(s.fixErrs); }
    });
  };

  /* ---- row actions (publish/unpublish/archive are PUTs per contract) ---- */
  const putStatus = (r, status, okMsg) => {
    const body = {
      programId: r.programId,
      title: r.title,
      title_zh: r.title_zh ?? null,
      status,
      courseIds: r.courseIds || [],
      passingScore: r.passingScore,
      mcqCount: r.mcqCount,
      openCount: r.openCount,
      caseCount: r.caseCount || 0,
      timeLimitMinutes: r.timeLimitMinutes ?? null,
      maxAttempts: r.maxAttempts,
      retakeCooldownHours: r.retakeCooldownHours,
      showAnswersAfterExam: r.showAnswersAfterExam,
      autoRetrain: r.autoRetrain !== false,
      typePoints: r.typePoints || null,
      multiPartial: r.multiPartial !== false,
      partialCredit: r.partialCredit !== false,
      shuffleOptions: r.shuffleOptions !== false,
      mode: r.mode === 'fixed' ? 'fixed' : 'random',
      questionIds: r.questionIds || [],
    };
    api.put(`/api/admin/exams/${r.id}`, body).then(() => {
      Toast.success(okMsg);
      ex.reload();
    }).catch((err) => Toast.error(err.message));
  };
  const doPublish = (r) => putStatus(r, 'published', s.publishedOk(examName(r)));
  const doUnpublish = (r) => putStatus(r, 'draft', s.unpublishedOk(examName(r)));
  const doArchive = (r) => putStatus(r, 'archived', s.archivedOk(examName(r)));

  /* ---- columns ---- */
  const columns = [
    {
      title: s.colName, dataIndex: 'title', width: 200, fixed: 'left', className: 'exm-namecol',
      render: (_, r) => {
        const why = bankShortWhy(r);
        return (
          <>
            <div className="exm-namecell">
              <Text strong>{examName(r)}</Text>
              <Text type="tertiary" size="small" className="exm-namesub">
                {examSub(r)}
              </Text>
            </div>
            {/* Below 900px this one cell draws the whole row as the design's phone
                card — title + status on one line, course as subtitle, the rules as
                chips — and every other cell hides, so the table keeps its paging
                and row actions instead of forking into a second list. */}
            <div className="exm-mcard">
              <div className="exm-mc-l1">
                <span className="exm-mc-name">{examName(r)}</span>
                <span className={`pill ${statusTone(r.status)}`}>{statusLabel(r.status)}</span>
              </div>
              <div className="exm-mc-sub">{progName(r.programId, r.programTitle)}</div>
              <div className="exm-mc-chips">
                <span className={`exm-mc-chip${why ? ' bad' : ''}`}>{bankText(r)}</span>
                <span className="exm-mc-chip">{s.mPass(r.passingScore)}</span>
                <span className="exm-mc-chip">{r.timeLimitMinutes ? s.minutes(r.timeLimitMinutes) : s.noLimit}</span>
                {r.passRate != null && (
                  <span className={`exm-mc-chip ${rateTone(r.passRate)}`}>
                    {r.status === 'archived' ? `${s.rateHist} ${r.passRate}%` : s.mRate(r.passRate)}
                  </span>
                )}
              </div>
              {why && (
                <div className="exm-mc-warn">
                  <IconAlertTriangle size="small" /> {why}
                </div>
              )}
            </div>
          </>
        );
      },
    },
    {
      title: s.colProgram, dataIndex: 'programId', width: 150,
      render: (id, r) => <Tag color="violet" type="light" shape="circle">{progName(id, r.programTitle)}</Tag>,
    },
    {
      title: s.colBank, dataIndex: 'mcqCount', width: 150,
      render: (_, r) => {
        // 固定题目模式：题数由清单决定，没有「题库不足」一说
        const why = r.mode === 'fixed' ? null : bankShortWhy(r);
        return (
          <span className={`exm-bank${why ? ' short' : ''}`}>
            <span className="exm-bankline">
              {r.mode === 'fixed' ? (
                <b className="tnum">{s.fixedN((r.questionIds || []).length)}</b>
              ) : (<>
              <b className="tnum">{s.questionsN((r.poolObjective || 0) + (r.poolOpen || 0))}</b>
              <Text type="quaternary" size="small" className="tnum exm-bankdraw">
                / {s.drawN(r.mcqCount || 0)}
              </Text>
              </>)}
              {why && (
                <Tooltip content={why}>
                  <span className="exm-bankwarn-i" aria-label={why}><IconAlertTriangle size="small" /></span>
                </Tooltip>
              )}
            </span>
            {/* the phone card has room for the whole sentence; the desktop cell
                keeps the ⚠ and puts the reason in its tooltip */}
            {why && <span className="exm-bankwarn">{why}</span>}
          </span>
        );
      },
    },
    {
      title: s.colPass, dataIndex: 'passingScore', width: 90, align: 'center',
      render: (v) => <span className="tnum exm-pass">{v}%</span>,
    },
    {
      title: s.colLimit, dataIndex: 'timeLimitMinutes', width: 100, align: 'center',
      render: (v) => <span className="tnum">{v ? s.minutes(v) : <Text type="quaternary">{s.noLimit}</Text>}</span>,
    },
    {
      title: s.colStatus, dataIndex: 'status', width: 100,
      render: (st) => (st === 'published'
        ? <Tag color="green" type="light" shape="circle">{s.stPublished}</Tag>
        : st === 'archived'
          ? <Tag color="amber" type="light" shape="circle">{s.stArchived}</Tag>
          : <Tag color="grey" type="light" shape="circle">{s.stDraft}</Tag>),
    },
    {
      title: s.colRate, dataIndex: 'passRate', width: 110, align: 'center',
      render: (rate, r) => {
        if (rate == null) return <Text type="quaternary">{s.dash}</Text>;
        return (
          <span className={`exm-rate ${rateTone(rate)}`}>
            {/* An archived exam's rate is frozen at the day it was pulled. */}
            {r.status === 'archived' && <span className="exm-ratehist">{s.rateHist}</span>}
            <span className="tnum">{rate}%</span>
          </span>
        );
      },
    },
    // 只读档(learning=read)整列去掉:编辑/发布/撤回/归档全是 PUT|POST,服务端 403。
    ...(canWrite ? [{
      // 三个按钮（编辑/撤回或发布/归档）实测需要约 228px；190 会把第三个裁掉。
      title: s.colAction, dataIndex: 'op', width: 260, fixed: 'right', className: 'exm-opcol',
      render: (_, r) => (
        <Space spacing={2}>
          <Button theme="borderless" size="small" icon={<IconEdit />} onClick={() => openEdit(r)}>{s.edit}</Button>
          {r.status === 'published' ? (
            <Button theme="borderless" size="small" icon={<IconUndo />} onClick={() => doUnpublish(r)}>{s.unpublish}</Button>
          ) : bankShortWhy(r) ? (
            // Publishing is guaranteed to 400 — offer the reason, not the button.
            <Tooltip content={bankShortWhy(r)}>
              <span className="exm-tipwrap">
                <Button theme="borderless" size="small" icon={<IconSend />} disabled>{s.publish}</Button>
              </span>
            </Tooltip>
          ) : (
            <Popconfirm
              title={s.publish}
              content={s.publishConfirm(examName(r))}
              okText={s.publish}
              cancelText={s.cancel}
              onConfirm={() => doPublish(r)}
            >
              <Button theme="borderless" size="small" icon={<IconSend />}>{s.publish}</Button>
            </Popconfirm>
          )}
          {r.status !== 'archived' && (
            <Popconfirm
              title={s.archiveTitle}
              content={s.archiveConfirm(examName(r))}
              okText={s.archive}
              cancelText={s.cancel}
              okType="danger"
              onConfirm={() => doArchive(r)}
            >
              <Button theme="borderless" size="small" type="danger" icon={<IconDelete />}>{s.archive}</Button>
            </Popconfirm>
          )}
        </Space>
      ),
    }] : []),
  ];

  // A course can live in several wrappers/packages — match by programIds, not
  // the legacy single programId field.
  const courseOptions = formProgram
    ? courses.filter((c) => (c.programIds || (c.programId ? [c.programId] : [])).includes(formProgram))
    : [];

  // ---------- 考试编辑（整页）：左侧表单 + 右侧试卷概览 + 底部吸附的保存条 ----------
  // 第四批：同一页还有两个子视图 —— 组卷（view=paper）与预览试卷（view=preview）。设置表单一直挂着（只是隐藏），
  // 所以三处改的是同一份表单状态，保存仍走这一页的保存按钮。
  if (pageOpen) {
    const pageReady = !!editData && !editLoading && editingId === (editParam || null) && !(cat.loading && !cat.data);
    const pageStatus = editingId ? ((editData && editData.status) || 'draft') : 'draft';
    const pageTitle = editingId ? ((editData && examName(editData)) || s.editTitle) : s.addTitle;
    const pageSub = editingId
      ? [s.editTitle, editData && editData.programId ? progName(editData.programId, editData.programTitle) : null].filter(Boolean).join(' · ')
      : s.newSub;

    /* 右栏试卷概览：从当前表单值推算（与服务端 examPointsRange 同一口径：题目自带分值优先，否则用题型默认分值；
       情境案例 = 各小题分值之和） */
    const v = formVals || {};
    const num = (x) => (x === '' || x == null || Number.isNaN(Number(x)) ? null : Number(x));
    const r1 = (x) => Math.round(x * 10) / 10;
    const tp = Object.fromEntries(typePointsKeys().map((k) => [k, num(v[tpField(k)])]));
    const bankReady = Array.isArray(bank.data);
    const bankList = bankReady ? bank.data : [];
    const isFixed = formMode === 'fixed';
    const mcqN = num(v.mcqCount) || 0;
    const openN = num(v.openCount) || 0;
    const caseN = num(v.caseCount) || 0;
    // 同保存逻辑：没勾关联课程 = 所属课程下全部内容
    const poolCourseIds = formCourses.length ? formCourses : courseOptions.map((c) => c.id);
    const cidSet = new Set(poolCourseIds);
    const pool = formProgram ? bankList.filter((q) => cidSet.has(q.courseId) && !q.unsupported && ENABLED.includes(q.type)) : [];
    const qPts = (q) => pointsOf(q, tp);
    const objPts = pool.filter((q) => groupOf(q.type) === 'objective').map(qPts);
    const opnPts = pool.filter((q) => groupOf(q.type) === 'open').map(qPts);
    const casePts = pool.filter((q) => groupOf(q.type) === 'case').map(qPts);
    const hasPartialTypes = pool.some((q) => PARTIAL_TYPES.includes(q.type)
      || (q.type === 'case' && (q.items || []).some((it) => PARTIAL_TYPES.includes(it && it.type))));
    const passN = num(v.pass);
    const paperSum = paperSummary(formQuestionIds, bankList, { typePoints: tp, passingScore: passN, poolCourseIds, enabled: ENABLED });
    let qCount = isFixed ? formQuestionIds.length : mcqN + openN + caseN;
    let ptsMin = null;
    let ptsMax = null;
    if (isFixed && bankReady) {
      qCount = paperSum.count;
      if (paperSum.count) { ptsMin = paperSum.total; ptsMax = ptsMin; }
    } else if (!isFixed && bankReady && pool.length) {
      const take = (arr, n, dir) => arr.slice().sort((a, b) => (dir === 'min' ? a - b : b - a)).slice(0, n).reduce((x, y) => x + y, 0);
      const nObj = Math.min(mcqN, objPts.length);
      const nOpn = Math.min(openN, opnPts.length);
      const nCase = Math.min(caseN, casePts.length);
      ptsMin = take(objPts, nObj, 'min') + take(opnPts, nOpn, 'min') + take(casePts, nCase, 'min');
      ptsMax = take(objPts, nObj, 'max') + take(opnPts, nOpn, 'max') + take(casePts, nCase, 'max');
    }
    const limitN = num(v.limit);
    const attN = num(v.attempts);
    const pointsText = ptsMin == null ? s.dash : ptsMin === ptsMax ? s.ptsVal(r1(ptsMin)) : s.ptsRange(r1(ptsMin), r1(ptsMax));
    const passText = passN == null ? s.dash
      : (ptsMin != null && ptsMin === ptsMax && ptsMin > 0) ? s.passPts(passN, r1((ptsMin * passN) / 100)) : s.pctVal(passN);
    // 随机抽题：题库不够抽时服务端拒绝发布 —— 这里边填边提示（与列表行的 ⚠ 同一套说法）
    const shortParts = [];
    if (!isFixed && formProgram && bankReady) {
      if (objPts.length < mcqN) shortParts.push(s.shortObj(objPts.length, mcqN));
      if (opnPts.length < openN) shortParts.push(s.shortOpen(opnPts.length, openN));
      if (casePts.length < caseN) shortParts.push(s.shortCase(casePts.length, caseN));
    }
    const shortWhy = shortParts.length
      ? shortParts.join(s.shortSep) + (pageStatus === 'published' ? s.shortTailLive : s.shortTailDraft)
      : null;
    const listRow = editingId ? rows.find((r) => r.id === editingId) : null;
    const examLabel = (v.titleZh || v.titleEn) ? (lang === 'zh' ? (v.titleZh || v.titleEn) : (v.titleEn || v.titleZh)) : (editData ? examName(editData) : '');

    // 预览：固定题目 = 当前试卷；随机抽题 = 按当前规则抽一套示例（客观题合池，与服务端开考同一口径）
    const previewIds = view !== 'preview' ? []
      : isFixed ? formQuestionIds
        : drawPaper(pool, { groups: { objective: mcqN, open: openN, case: caseN }, balance: false }, seededRng(sampleSeed)).ids;

    const saveBar = (
      <div className="exm-savebar">
        {examDirty && <span className="pill warn">{s.unsaved}</span>}
        <Button theme="borderless" onClick={leavePage}>{canWrite ? s.cancel : s.backList}</Button>
        {canWrite && <Button theme="solid" type="primary" onClick={submitEdit} loading={saving}>{s.save}</Button>}
      </div>
    );

    return (
      <div className={'wrap exm-wrap exm-page' + (view !== 'settings' ? ' exm-sub-' + view : '')}>
        {view === 'settings' && (
          <div className="co-page-bar">
            <Button theme="borderless" icon={<IconArrowLeft />} onClick={leavePage}>{s.backList}</Button>
            <div className="co-page-titles">
              <h1 className="co-page-title" title={pageTitle}>{pageTitle}</h1>
              <div className="co-page-sub">{pageSub}</div>
            </div>
            {(!editingId || editData) && (
              <Tag color={pageStatus === 'published' ? 'green' : pageStatus === 'archived' ? 'amber' : 'grey'} type="light" shape="circle">
                {statusLabel(pageStatus)}
              </Tag>
            )}
            {examDirty && <span className="pill warn">{s.unsaved}</span>}
          </div>
        )}

        {view === 'settings' && !canWrite && <Banner type="info" closeIcon={null} className="exm-page-ro" description={s.roWrite} />}
        {cat.error && <Banner type="danger" className="exm-error" description={cat.error.message || s.loadErr} />}

        {!pageReady ? (
          <div className="card co-ed-card exm-form-loading exm-page-loading">
            <Spin size="large" />
          </div>
        ) : (
          <>
          {view === 'paper' && (
            <>
              <Composer
                lang={lang} loc={loc} examTitle={examLabel}
                bank={bankList} courses={courses} poolCourseIds={poolCourseIds}
                paper={formQuestionIds} setPaper={setPaper}
                typePoints={tp} passingScore={passN}
                published={pageStatus === 'published'} attempts={listRow ? listRow.attempts || 0 : 0}
                readOnly={!canWrite}
                onBack={() => goView('settings')}
                onPreview={() => openPreview('paper')}
              />
              {saveBar}
            </>
          )}
          {view === 'preview' && (
            <>
              <PaperPreview
                lang={lang} examTitle={examLabel}
                paper={previewIds} bank={bankList}
                typePoints={tp} passingScore={passN} poolCourseIds={poolCourseIds} enabled={ENABLED}
                timeLimit={limitN} maxAttempts={attN} shuffleOptions={v.optOrder !== 'fixed'}
                sample={!isFixed}
                onRedraw={isFixed ? null : () => setSampleSeed(Date.now())}
                onBack={() => goView(previewFrom === 'paper' && isFixed ? 'paper' : 'settings')}
                backLabel={previewFrom === 'paper' && isFixed ? s.backPaper : s.backSettings}
              />
              {saveBar}
            </>
          )}
          {/* 设置表单：组卷 / 预览时隐藏但不卸载（同一份表单状态） */}
          <div hidden={view !== 'settings'}>
          <div className="exm-page-grid">
            <div className="card co-ed-card exm-page-main">
              <Form
                key={editingId || 'new'}
                initValues={editInit()}
                getFormApi={(formApi) => { editApi.current = formApi; }}
                onValueChange={onValueChange}
                labelPosition="top"
                className="exm-form"
                disabled={!canWrite}
              >
                {/* basics */}
                <div className="exm-sec-h">{s.secBasic}</div>
                {canWrite && <div className="ai-tr-row"><AiTranslateButton formApi={editApi} pairs={[{ zh: 'titleZh', en: 'titleEn' }]} /></div>}
                <div className="exm-grid2">
                  <Form.Input
                    field="titleZh"
                    label={s.fTitleZh}
                    placeholder={s.fTitleZhPh}
                    // CX-008（2026-10-09 验收）：中英至少一个（只有英文名的旧考试也能保存）
                    rules={[{ validator: (_r, v) => !!String(v || '').trim() || !!String((editApi.current && editApi.current.getValue('titleEn')) || '').trim(), message: s.reqTitleAny }]}
                  />
                  <Form.Input field="titleEn" label={s.fTitleEn} placeholder={s.fTitleEnPh} />
                </div>

                {/* linked content */}
                <div className="exm-sec-h">{s.secLink}</div>
                {/* 字段级 disabled 会盖过表单级 disabled，所以只读档要在这里一并带上 */}
                <Form.Select
                  field="program"
                  label={s.fProgram}
                  placeholder={s.fProgramPh}
                  style={{ width: '100%' }}
                  disabled={!canWrite || !!editingId}
                  optionList={programs.map((p) => ({ label: loc(p, 'title'), value: p.id }))}
                  rules={[{ required: true, message: s.reqProgram }]}
                />
                {!formProgram ? (
                  <Banner
                    type="info"
                    className="exm-course-hint"
                    closeIcon={null}
                    description={s.pickProgramFirst}
                  />
                ) : courseOptions.length === 1 ? null : courseOptions.length > 0 ? (
                  <Form.CheckboxGroup
                    field="courses"
                    label={{ text: s.fCourses, extra: <Text type="tertiary" size="small">{s.fCoursesHint}</Text> }}
                    direction="vertical"
                    rules={[{ required: true, type: 'array', min: 1, message: s.reqCourses }]}
                    options={courseOptions.map((c) => ({ label: loc(c, 'title'), value: c.id }))}
                  />
                ) : (
                  <Banner
                    type="info"
                    className="exm-course-hint"
                    closeIcon={null}
                    description={s.noCourses}
                  />
                )}

                {/* 出卷方式（2026-10-06）：随机抽题 / 固定题目 */}
                <Form.RadioGroup field="mode" type="button" label={{ text: s.fMode, extra: <Text type="tertiary" size="small">{s.modeHint}</Text> }}>
                  <Form.Radio value="random">{s.modeRandom}</Form.Radio>
                  <Form.Radio value="fixed">{s.modeFixed}</Form.Radio>
                </Form.RadioGroup>
                {/* 固定题目（第四批 6.2 / F8）：原来的下拉多选换成试卷概况 + 「组卷」整页 */}
                {formMode === 'fixed' && (
                  <div className="exm-fixedsum">
                    <div className="exm-fixedsum-h">{s.fQuestions}</div>
                    {formQuestionIds.length ? (
                      <>
                        <div className="exm-fixedsum-n tnum">{s.paperN(paperSum.count, paperSum.total)}</div>
                        {paperSum.typeMix.length > 0 && (
                          <div className="exm-fixedsum-mix">
                            {paperSum.typeMix.map((m) => <span key={m.type} className="exc-mix tnum">{typeLabel(m.type, lang, true)} {m.count}</span>)}
                          </div>
                        )}
                        {paperSum.outOfPool.length > 0 && (
                          <div className="exm-page-warn"><IconAlertTriangle size="small" /><span>{s.paperOut(paperSum.outOfPool.length)}</span></div>
                        )}
                      </>
                    ) : (
                      <Text type="tertiary" size="small">{s.paperEmpty}</Text>
                    )}
                    <Space wrap className="exm-fixedsum-acts">
                      <Button theme="solid" type="primary" disabled={!formProgram} onClick={() => goView('paper')}>{s.buildPaper}</Button>
                      <Button theme="light" disabled={!formQuestionIds.length} onClick={() => openPreview('settings')}>{s.previewPaper}</Button>
                    </Space>
                  </div>
                )}

                {/* scoring & rules */}
                <div className="exm-sec-h">{s.secRules}</div>
                <div className="exm-grid2 exm-page-g3">
                  <Form.InputNumber field="mcqCount" label={s.fMcq} suffix={s.unitQ} min={1} max={50} style={{ width: '100%' }} disabled={!canWrite || formMode === 'fixed'} />
                  <Form.InputNumber field="openCount" label={s.fOpen} suffix={s.unitQ} min={0} max={10} style={{ width: '100%' }} disabled={!canWrite || formMode === 'fixed'} />
                  <Form.InputNumber field="caseCount" label={s.fCase} suffix={s.unitGroup} min={0} max={10} style={{ width: '100%' }} disabled={!canWrite || formMode === 'fixed'} />
                  <Form.InputNumber field="pass" label={s.fPass} suffix={s.unitPct} min={1} max={100} style={{ width: '100%' }} />
                  <Form.InputNumber field="limit" label={s.fLimit} suffix={s.unitMin} min={0} max={240} style={{ width: '100%' }} />
                  <Form.InputNumber field="attempts" label={{ text: s.fAttempts, extra: <Text type="tertiary" size="small">{s.attemptsHint}</Text> }} min={0} max={20} style={{ width: '100%' }} />
                  <Form.InputNumber field="cooldown" label={s.fCooldown} suffix={s.unitHr} min={0} max={720} style={{ width: '100%' }} />
                </div>
                {formMode === 'random' && formProgram && (
                  <div className="exm-randprev">
                    <Button theme="light" disabled={!pool.length} onClick={() => openPreview('settings')}>{s.previewRandom}</Button>
                  </div>
                )}
                {/* 选项顺序（第四批 10.6 / F36，负责人 10/8 定加开关）：默认每次随机 */}
                <Form.RadioGroup field="optOrder" type="button" label={{ text: s.fOptOrder, extra: <Text type="tertiary" size="small">{s.optOrderHint}</Text> }}>
                  <Form.Radio value="random">{s.optRandom}</Form.Radio>
                  <Form.Radio value="fixed">{s.optFixed}</Form.Radio>
                </Form.RadioGroup>
                {/* 每题分值（2026-10-06）：题型默认分值 + 多选部分给分；第四批按题型目录列出全部题型 */}
                <div className="exm-sec-h">{s.secPoints}</div>
                <Text type="tertiary" size="small" style={{ display: 'block', marginBottom: 8 }}>{s.ptsHint}</Text>
                <div className="exm-grid2 exm-page-g4">
                  {typePointsKeys().map((k) => (
                    <Form.InputNumber key={k} field={tpField(k)} label={s.fPtsType(typeLabel(k, lang, true))} suffix={s.unitPts} min={1} max={100} style={{ width: '100%' }} />
                  ))}
                </div>
                <Form.Switch
                  field="multiPartial"
                  label={{ text: s.fMultiPartial, extra: <Text type="tertiary" size="small">{s.multiPartialHint}</Text> }}
                />
                {/* 按比例给分：只在关联题库里有排序 / 匹配 / 分类 / 多空填空（含案例小题）时显示；不显示时保留原值 */}
                {hasPartialTypes && (
                  <Form.Switch
                    field="partialCredit"
                    label={{ text: s.fPartial, extra: <Text type="tertiary" size="small">{s.partialHint}</Text> }}
                  />
                )}
                <Form.Switch
                  field="showAnswers"
                  label={{ text: s.fShow, extra: <Text type="tertiary" size="small">{s.showHint}</Text> }}
                />
                <Form.Switch
                  field="autoRetrain"
                  label={{ text: s.fRetrain, extra: <Text type="tertiary" size="small">{s.retrainHint}</Text> }}
                />
                {/* F58（负责人 10/9 定）：考前须知（选填），中英文两栏，纯文本可换行，各不超过 1000 字；员工考前说明页显示在系统固定须知之后 */}
                <div className="exm-sec-h">{s.secNotice}</div>
                <Text type="tertiary" size="small" style={{ display: 'block', marginBottom: 8 }}>{s.noticeHint}</Text>
                {[['noticeZh', s.fNoticeZh, s.fNoticeZhPh], ['noticeEn', s.fNoticeEn, s.fNoticeEnPh]].map(([f, label, ph]) => (
                  <Form.TextArea
                    key={f}
                    field={f}
                    label={label}
                    placeholder={ph}
                    autosize={{ minRows: 3, maxRows: 12 }}
                    rows={3}
                    maxCount={1000}
                    rules={[{ validator: (_r, val) => Array.from(String(val || '').trim()).length <= 1000, message: s.errNoticeLen }]}
                  />
                ))}
              </Form>
              <div className="exm-page-foot">
                <Button theme="borderless" onClick={leavePage}>{canWrite ? s.cancel : s.backList}</Button>
                {canWrite && <Button theme="solid" type="primary" onClick={submitEdit} loading={saving}>{s.save}</Button>}
              </div>
            </div>

            <aside className="exm-page-side">
              <div className="card co-ed-card exm-page-sum">
                <h2 className="exm-page-sumh">{s.sumTitle}</h2>
                <dl className="exm-page-kv">
                  <div><dt>{s.sumMode}</dt><dd>{isFixed ? s.modeFixed : s.modeRandom}</dd></div>
                  <div><dt>{s.sumCount}</dt><dd className="tnum">{s.questionsN(qCount)}</dd></div>
                  <div><dt>{s.sumPoints}</dt><dd className="tnum">{pointsText}</dd></div>
                  <div><dt>{s.sumPass}</dt><dd className="tnum">{passText}</dd></div>
                  <div><dt>{s.sumLimit}</dt><dd className="tnum">{limitN ? s.minutes(limitN) : s.noLimit}</dd></div>
                  <div><dt>{s.sumAttempts}</dt><dd className="tnum">{attN ? s.attemptsN(attN) : s.attemptsUnl}</dd></div>
                  <div><dt>{s.sumOptOrder}</dt><dd>{v.optOrder === 'fixed' ? s.optFixed : s.optRandom}</dd></div>
                  {!isFixed && formProgram && bankReady && (
                    <div><dt>{s.sumPool}</dt><dd className="tnum">{s.poolN(objPts.length, opnPts.length, casePts.length)}</dd></div>
                  )}
                </dl>
                {shortWhy && (
                  <div className="exm-page-warn"><IconAlertTriangle size="small" /><span>{shortWhy}</span></div>
                )}
                <div className="exm-page-hint">{isFixed ? s.sumFixedHint : s.sumRandomHint}</div>
              </div>
            </aside>
          </div>
          </div>
          </>
        )}
      </div>
    );
  }

  return (
    <div className="wrap exm-wrap">
      {/* header */}
      <div className="exm-head">
        <div>
          {/* 11.4（F49）：只读说明不再单独成段，标题右侧放「只读」胶囊，悬停给这一句 */}
          <div className="u-title-line"><h1 className="exm-title">{s.title}</h1>{!canWrite && <ReadOnlyPill tip={s.roWrite} />}</div>
          <div className="exm-lead">{s.lead}</div>
        </div>
        {canWrite && <Button icon={<IconPlus />} theme="solid" type="primary" onClick={openAdd}>{s.add}</Button>}
      </div>

      {/* toolbar — status has no dropdown: the three counts ARE the filter, so a
          segment's size and the click that isolates it are the same control.
          Clicking the active chip again clears it. */}
      <div className="exm-toolbar">
        <Input
          prefix={<IconSearch />}
          placeholder={s.searchPh}
          value={query}
          onChange={setQuery}
          showClear
          className="exm-search"
          aria-label={s.searchPh}
        />
        <Select
          placeholder={s.progAll}
          value={fProg || undefined}
          onChange={(v) => patchUrl({ program: v || null }, { push: false })}
          showClear
          className="exm-filter"
          optionList={programs.map((p) => ({ label: loc(p, 'title'), value: p.id }))}
        />
        <div className="exm-chips" role="group" aria-label={s.colStatus}>
          {[
            ['published', s.stPublished, counts.published],
            ['draft', s.stDraft, counts.draft],
            ['archived', s.stArchived, counts.archived],
          ].map(([val, label, n]) => (
            <button
              key={val}
              type="button"
              className={`pill ${statusTone(val)} exm-chip${fStatus === val ? ' on' : ''}`}
              aria-pressed={fStatus === val}
              onClick={() => setFStatus(fStatus === val ? '' : val)}
            >
              {label} <b className="tnum">{n}</b>
            </button>
          ))}
        </div>
      </div>

      {(ex.error || cat.error) && (
        <Banner
          type="danger"
          className="exm-error"
          description={(ex.error || cat.error).message || s.loadErr}
        />
      )}

      {/* table */}
      <div className="exm-tablecard">
        <Table
          key={listVer}
          rowKey="id"
          {...resizableTable(dataTableColumns(columns, { titleKey: 'title', opsKey: 'op' }))}
          dataSource={filtered}
          loading={ex.loading}
          pagination={filtered.length > 8 ? {
            pageSize: listSize, defaultCurrentPage: clampPage(listPage, filtered.length, listSize), onPageChange: setListPage, onPageSizeChange: setListSize,
            pageSizeOpts: PAGE_TIERS, showSizeChanger: true, formatPageText: false,
          } : false}
          empty={<Empty description={s.title} />}
        />
      </div>
    </div>
  );
}
