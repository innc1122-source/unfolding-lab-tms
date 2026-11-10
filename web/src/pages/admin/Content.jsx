import { date as fmtDate } from '../../fmt.js';
import { Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { lazyRetry as lazy } from '../../lazyRetry.js';   // CX-109
import {
  Button, Tag, Form, Modal, Popconfirm, Toast, Checkbox,
  Empty, Tooltip, Divider, Upload, Spin, Table, Select, TextArea, DatePicker, Dropdown, Input, Switch, Banner,
} from '@douyinfe/semi-ui';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  IconPlus, IconEdit, IconDelete, IconArrowUp, IconArrowDown, IconArrowLeft,
  IconUpload, IconLink, IconFile, IconMapPin, IconRefresh, IconMore, IconSetting, IconSearch, IconEyeOpened,
  IconVideo, IconPaperclip, IconPlayCircle, IconAlertTriangle,
} from '@douyinfe/semi-icons';
import { useAuth } from '../../auth.jsx';
import { useI18n } from '../../i18n.jsx';
import { PAGE_TIERS, DEFAULT_PAGE, useDataVersion, clampPage } from '../../pagesize.js';
import { useUrlState } from '../../urlstate.js';
import { categoryLabel, categoryOptions, categoryRank, normalizeCategoryInput, isCustomCategory, UNCATEGORIZED } from '../../categories.js';
import { CategorySelect, EnrollSelect, ModeSelect, PublicSelect, JobGradeSelect, parseList, joinList } from '../../components/TrainingFilters.jsx';
import { splitByGrade } from '../../jobgrades.js';
import { AssignModes, AssignCriteria, AssignResult, AssignFooter, AssignHelp, assignBlockReason } from '../../components/AssignPanel.jsx';
import { mediaText, mediaLine, slidesText, hostOf, reasonText, mediaSummaryOf } from '../../mediareasons.js';
import { api, useAsync } from '../../api.js';
import { resizableTable } from '../../cardify.js';
import { canUseAction } from '../../rbac.js';
import { AiTranslateButton, aiTranslateOn, translateItems, needsTranslation, aiErrMap } from '../../components/AiTranslate.jsx';
// 简化 10/11：富文本编辑器（Tiptap / ProseMirror，约 35 万字节）只在小节正文编辑时用到，按需加载，课程库列表不再带它
const RichTextLazy = lazy(() => import('../../components/RichText.jsx'));
function RichText(props) {
  return <Suspense fallback={<div className="co-rt-loading" style={{ minHeight: 240 }} />}><RichTextLazy {...props} /></Suspense>;
}
import { errText } from '../../apierr.js';
import { BULK_SEL_EXTRA, useBulkSelection, BulkBar, BulkConfirmModal, useBulkRunner } from '../../components/BulkActions.jsx';
import OfficeConvertSheet from './OfficeConvertSheet.jsx';
import DeptFilter, { dpfModalProps } from '../../components/DeptFilter.jsx';
import ReadOnlyPill from '../../components/ReadOnlyPill.jsx';
import { useDeptTree, deptMatcher } from '../../deptfilter.js';
import { IcWarn } from '../../components/LineIcons.jsx';

// 部门选项 / 名单未加载时的稳定空数组（DeptFilter 与 useMemo 按引用判断）
const NO_OPTS = [];

// ── 只读档下写控件的总闸门(RBAC P1)──────────────────────────────────────────
// 判据:一个动作控件的显隐取决于**它实际调用的那个接口**所属的能力域与读写,不是它所在
// 页面的域;逐条查仓库根 RBAC-ROUTE-MATRIX.md(108 条后台路由)。本页所有写接口在矩阵里
// 都归「培训 learning · 写」,与本页同域,所以 manage 档一律照旧显示;只有 read 档(客户
// 自建的只读角色)要把写控件收起 —— 服务端对 read 档的写操作回 403。
// 跨域的只有 GET /api/admin/roster(W1 白名单:people/learning/performance/talent 任一
// >=read 即可读),能进本页的角色必然已持 learning>=read,不另设门。
// 可售模块开关与 grants 两层**叠加**,由 canUseAction 一并过完(既有模块开关逻辑照旧)。
// 老服务(/api/me 无 grants)→ isSuperAdmin 为 true → 全部照旧显示,不会锁死界面。
const useCanWrite = () => canUseAction(useAuth().user, { domain: 'learning', module: 'learning', write: true });

// ---------- co-located bilingual UI strings (do NOT edit shared i18n) ----------
// 2026-07 rework: the "package" (课程包) concept is GONE from the UI. A course is
// the unit of everything — assignment, elective application, exams, records.
// (Data-side each course keeps an invisible 1:1 wrapper program; never shown.)
const T = {
  zh: {
    title: '课程库',
    lead: '课程可直接指派、开放申请，也可被发展项目引用。编辑即时保存。',
    newCourse2: '新建课程',
    loading: '加载中…', loadError: '加载失败，请刷新页面重试。', retry: '重试',
    emptyCourses: '还没有课程 — 点右上角「新建课程」开始',
    // course-card meta runs: 模块 4 · 小节 11 · 约 48 分钟 / 题库 32 题
    cModules: (n) => `模块 ${n}`, cSections: (n) => `小节 ${n}`,
    cMinutes: (n) => `约 ${n} 分钟`, cBank: (n) => `题库 ${n} 题`,
    stPublished: '已发布', stDraft: '草稿', stArchived: '已下线',
    // status segments + search
    fAll: '全部', searchPh: '搜索课程名称、类别或发展项目', noMatch: '没有匹配的课程 — 换个关键词或切回「全部」',
    // 培养项目归属：课程行与编辑页头的标签 + 列表筛选（usedInProjects，服务端现算）
    pjTag: (name) => `发展项目：${name}`, pjMore: (total, rest) => `等 ${total} 个`, pjSolo: '独立课程',
    pjListTip: (names) => `被以下发展项目引用：${names}`,
    pjSoloTip: '没有被任何发展项目引用，可单独指派或开放申请',
    pjSt: { planning: '筹备中', running: '进行中', closing: '收尾中', closed: '已关闭', draft: '草稿' },
    kLab: '按发展项目筛选', kAll: '全部课程', kProject: '项目课程', kSolo: '独立课程',
    // question-bank vs draw-count risk
    bkTight: (pool, draw) => `题库仅 ${pool} 题，抽题数为 ${draw}`,
    bkShort: (pool, draw) => `题库仅 ${pool} 题 < 抽题数 ${draw}，出卷会缺题`,
    bkHint: '结业考试每次从本课程题库随机抽取客观题（单选/多选/填空）。题库不大于抽题数时，学员拿到的都是同一份卷子。',
    enrollMandatory: '必修',
    enrollMandatoryFull: '必修（HR 指派）', enrollElectiveFull: '选修（申请制）',
    modeOnline: '线上', modeOffline: '线下',
    tbd: '时间待定',
    editCourse: '编辑内容', renameCourse: '编辑信息', delCourse: '删除课程', moreLab: '更多',
    // CX-032 课程包导出 / 导入（2026-10-09 验收）
    exportPkg: '导出课程包', importPkg: '导入课程包', pkgExported: '课程包已导出',
    pkgBadFile: '不是有效的课程包文件：请选择本系统导出的 .course.json 文件。',
    pkgImported: (t, n) => `已导入「${t}」（${n} 个模块），状态为草稿。`,
    pkgDropped: (n) => `附件与课件内视频不随课程包携带，已去掉 ${n} 项，请在课程里重新上传。`,
    pkgSameName: '已有同名课程', pkgSameNameBody: '课程库里已有同名课程。可以改一个名称再导入；名称不改则同名并存。',
    pkgNewTitleZh: '课程名称（中文）', pkgNewTitleEn: '课程名称（英文）', pkgImportBtn: '导入',
    delCourseAsk: '删除该课程及其模块、小节？题库中属于该课程的题目一并删除（仍被其他考试使用的题目保留）。仅在没有任何发展项目引用、也没有学员记录时可以删除。',
    delBlockedTitle: '这门课程正在被使用，不能删除',
    delUseProjects: (list) => `被发展项目引用：${list}`,
    delUseProgress: (n) => `${n} 名学员有学习进度记录`,
    delUseAttempts: (n) => `已有 ${n} 份考试答卷`,
    delUseExams: (n) => `关联 ${n} 场考试`,
    delBlockedHint: '删除会使引用它的发展项目阶段无法完成，已完成的学习记录也将无法查看。建议改为「下线」：员工端不再显示，历史记录完整保留。',
    delArchiveNow: '改为下线', archivedOk: '已下线：员工端不再显示，历史记录保留',
    publishNow: '发布', publishedOk: '已发布，员工可在首页「可申请的选修课程」中看到（必修课程在指派后可见）',
    examBtn: '考试设置（考试页）',
    // course form
    fmCourseNew: '新建课程', fmCourseEdit: '编辑课程信息',
    fTitleZh: '课程名称（中文）', fTitleEn: '名称（English · 选填）',
    fDescZh: '简介（中文）', fDescEn: '简介（English · 选填）',
    fStatus: '状态', fStatusHint: '草稿：仅后台可见。发布后，选修课程出现在员工首页「可申请的选修课程」中，必修课程在指派后可见。',
    fValid: '默认完成期限（天）', fValidHint: '指派该课程时的默认到期天数（1–365）',
    fMinutes: '预计学习时长（分钟）',
    fMinutesOne: '课程卡片上显示为「约 N 分钟」。本课程只有 1 个模块，这里改的就是该模块的时长。',
    fMinutesSum: (n, k) => `约 ${n} 分钟，是 ${k} 个模块的时长相加。要修改，请在课程编辑器左侧「模块与小节」里点各模块的铅笔按钮。`,
    fMinutesNew: '保存后在课程编辑器里添加模块，每个模块可以设置预计学习时长，课程时长 = 各模块相加。',
    fEnroll: '修读类型', fEnrollHint: '必修：HR 指派后即可学习。选修：员工在首页「可申请的选修课程」中申请，审批通过后学习。',
    fCategory: '类别', phCategory: '选择类别（不在列表里的可以直接输入）',
    fMode: '授课方式', fModeHint: '线下课程请填写时间与地点，供员工查看。出勤通过本课程的「签到管理」登记；被发展项目引用时，也可在发展项目中签到。',
    fSessionAt: '上课时间', phSessionAt: '例如 2026-08-05 14:00（可直接输入或点日历选）',
    fLocation: '上课地点', phLocation: '例如：总部 3F 培训室',
    fSessionNote: '线下说明（选填）', phSessionNote: '例如：请提前 10 分钟到场，携带笔记本电脑',
    fTrainer: '讲师（负责讲授）',
    fTrainerHint: '被指定的人会在员工端获得「我的授课」:显示签到码、为参加本课的学员点名（不含任何后台权限）。',
    phTitleZh: '例如：公司文化与行为准则',
    phTitleEn: 'e.g. Company Culture & Code of Conduct',
    phDescZh: '简要说明本课程的目标与适用人群',
    phDescEn: 'Briefly describe the goal and audience',
    save: '保存', cancel: '取消',
    reqTitle: '请填写课程名称',
    savedCourse: '课程已保存', deleted: '已删除',
    // course editor (modules / sections)
    ceModules: '模块与小节',
    ceBack: '返回课程库', ceAutosave: '编辑即时保存',
    // AI 翻译整门课程（2026-10-06）
    trCourse: 'AI 翻译整门课程', trToEn: '中文 → English', trToZh: 'English → 中文',
    trTitle: (to) => (to === 'en' ? 'AI 翻译整门课程为英文' : 'AI 翻译整门课程为中文'),
    trConfirm: (n) => `将翻译 ${n} 个还没有译文的字段（课程名称与说明、模块名、小节标题与正文），译文直接写入课程，之后可逐项修改。已有译文的字段不动。`,
    trNone: '所有字段都已有译文，不需要翻译', trDone: (n) => `已写入 ${n} 个字段的 AI 译文，请逐项检查`, trDoneDemo: '演示模式：已写入带「演示译文」标记的占位内容，未调用 AI',
    trOk: '开始翻译', trBusy: '正在翻译…', eOff: '该 AI 功能未开启', eConf: 'AI 服务尚未接入', eRate: 'AI 翻译次数已达上限，请稍后再试', eBudget: '本月 AI 用量已达上限', eLong: '内容过长，请分批翻译', eMany: '一次最多翻译 80 个字段',
    ceModulesHint: '拖动 ⋮⋮ 排序，也可用上下箭头 · 点击小节可编辑内容',
    ceOffline: '线下课程也可以在下方添加课件材料（如议程、讲义），员工在课程页可查看。',
    addModule: '添加模块', renameModule: '编辑模块',
    delModuleAsk: '删除该模块及其全部小节？', delModuleTitle: '删除模块',   // CX-153：删除模块确认标题（原来误用「重命名」）
    sectionsN: (n) => `${n} 小节`, addSection: '添加小节',
    emptySections: '暂无小节，点击「添加小节」开始',
    moveUp: '上移', moveDown: '下移', rename: '重命名', del: '删除',
    mrTitleZh: '模块标题（中文）', mrTitleEn: '模块标题（英文，选填）', mrMinutes: '预计学习时长（分钟）', mrMinutesHint: '课程卡片上的「约 N 分钟」= 各模块时长之和', nPeople: (n) => `${n} 人`,
    // 右栏只读：考试规则只在「考试」页编辑，这里只有「需要结业考试」开关 + 实际考试的摘要
    exTitle: '结业考试', exRequired: '需要结业考试',
    exPackage: (name, n) => `所属学习包：${name}（含 ${n} 门课程）。这里显示的是整个学习包的结业考试。`,
    exOffHint: '已关闭：学员学完全部内容即视为完成，不需要考试。原有考试已下线，历史成绩保留。',
    exReadOnlyHint: '考试规则在「考试」页编辑，这里仅作展示。',
    exNone: '本课程还没有结业考试。', exCreate: '新建结业考试', exGoEdit: '去考试页编辑 →',
    exBank: '题库 / 抽题', exBankV: (pool, draw, open) => `${pool} 题 / 抽 ${draw}${open ? ` + 简答 ${open}` : ''}`,
    exPass: '及格分', exTime: '限时', exNoLimit: '不限时', exMin: (n) => `${n} 分钟`,
    exAttempts: '最多次数', exUnlimited: '不限', exShowAnswers: '考后公开答案', exYes: '是', exNo: '否',
    exOffOk: '已关闭结业考试：考试已下线，学员学完即完成',
    exOnOk: '已开启结业考试', exRepubOk: '已开启结业考试，并重新发布了原考试',
    exInProjectTitle: '无法关闭结业考试',
    seNew: '新建小节', seEdit: '编辑小节', seNo: (no) => `小节 ${no}`,
    seTitleZh: '小节标题（中文）', seTitleEn: '小节标题（English）',
    // 整页编辑（2026-10-06）
    edInfo: '课程信息', edEmpty: '从左侧选择一个小节开始编辑，或在模块下点「添加小节」。课程名称、说明、授课方式等在右上角「课程信息」里改。',
    edNotFound: '找不到这门课程，可能已被删除。', bodyZhTab: '中文正文', bodyEnTab: 'English 正文', bodyEnHint: '英文留空时，学员端显示中文。',
    bodyPh: '在这里写小节正文：可以加粗、加标题、列表、引用和链接……',
    discardTitle: '放弃未保存的修改？', discardAsk: '这个小节有未保存的修改，离开后会丢失。', discardOk: '放弃修改', unsaved: '有未保存的修改',
    seVideoBlock: '视频', seAttachBlock: '附件',
    seVideoHint: '上传 mp4/webm（≤500 MB，存 public/videos，内网可播）',
    seVideoPaste: '或粘贴 YouTube / 嵌入地址',
    seVideoUp: '上传视频',
    seAttachHint: 'PDF / PPT / Word / Excel 转为在线只读，不提供下载；转换失败将不能上传 · 音频可在线播放',
    // 课件转换（P0 1.3/1.4）
    seOfficeOff: '课件转换组件（LibreOffice）未安装：PPT / Word / Excel 暂不能上传，请先另存为 PDF 再上传',
    eOfficeOff: '服务器未安装课件转换组件，PPT / Word / Excel 暂不能上传。请先另存为 PDF，或请 IT 安装 LibreOffice',
    eConvFail: '该文件无法转换为在线只读的 PDF，未上传。请确认文件能正常打开，或先另存为 PDF',
    ePdfInvalid: '该文件不是有效的 PDF（可能是其他格式改了扩展名），未上传。请打开后另存为 PDF 再上传',
    eTooLarge: '文件太大（上限 500 MB）',
    converting: '转换中… PPT / Word / Excel 要先转成在线只读的 PDF，可能需要一两分钟，请勿离开本页',
    uploadedHint: '已上传 · 保存小节后员工端才能看到',
    acceptInvalid: '不支持的文件类型。可上传视频、音频、PDF；PPT / Word / Excel 暂不能上传，请先另存为 PDF。',
    ocBtnOk: (n) => `课件转换：可用${n ? ` · ${n} 个待转换` : ''}`,
    ocBtnOff: (n) => `课件转换：未安装${n ? ` · ${n} 个待转换` : ''}`,
    ocBtnDisabled: (n) => `课件转换：已停用${n ? ` · ${n} 个待转换` : ''}`,
    seUpload: '添加附件',
    seVideoUrl: '视频链接（YouTube / Vimeo / bilibili 页面，或 mp4 / webm / m3u8 直链）',
    phVideoUrl: 'https://www.youtube.com/watch?v=...  或  https://…/video.mp4',
    badVideoUrl: '视频链接必须以 http(s):// 开头，请改正后再保存。',
    sePreview: '学员端预览', sePreviewEmpty: '填写标题与正文后在此实时预览',
    seVideoLabel: '视频',
    savedSection: '小节已保存', uploadFail: '上传失败',
    // in-person course check-in
    ckBtn: '签到管理', ckCode: '现场签到码', ckRefresh: '刷新',
    ckBig: '投屏模式', ckExit: '点击任意位置退出投屏', ckRotate: '签到码每分钟自动更换',
    ckHint: '员工手机：打开本课程页 → 输入此码',
    ckAttended: '出席', ckLate: '迟到', ckExcused: '请假', ckMissing: '未签', ckAbsent: '缺席',
    ckMakeup: '补签', ckExcuse: '记请假', ckToPresent: '改为出席', ckClose: '关闭',
    ckMakeupExcused: '补课出席', // 负责人 2026-10-06：请假需补课，补课后直接改为出席
    ckColName: '学员', ckColDept: '部门', ckColState: '状态',
    ckEmpty: '暂无被指派本课程的员工（先发布课程并指派/等待申请通过）',
    // course-side assignment
    asgBtn: '指派', asgTitle: '指派课程',
    asgByDept: '按部门',
    asgDeptPh: '选择一个或多个部门，整批指派', asgPastePh: '粘贴工号，空格 / 逗号 / 换行分隔均可',
    asgPickPh: '搜索并选择员工',
    asgDue: '截止日期', asgDueHint: '不填 = 无截止日期',
    // UI 批 U2 11.5：人数结果条（主数字 + 明细）与标题旁「?」说明
    asgWill: '将新指派', asgMatched: '符合条件', asgFound: '找到', asgPicked: '已选',
    asgSkipped: '已指派过（跳过）', asgNoGradeR: '未设职级（不含）', asgMissingR: '工号未找到',
    asgHelp: '按条件：部门与职级可以单独用，也可以组合（如某部门含下级 × P1–P3），选上级部门即包含全部下级部门，职级可在下拉底部按区间加入；只含在职员工，选了职级时未设职级的人不纳入。三种方式都会自动跳过已指派过的人。',
    asgDo: '指派', asgDoneN: (n) => `已指派 ${n} 人`,
    asgListTitle: (n) => `已指派 ${n} 人`,
    asgRemove: '移除', asgRemoveAsk: (name) => `取消对 ${name} 的指派？学习记录保留。`, asgRemovedOk: '已移除',
    asgEmpty: '还没有指派任何员工',
    asgDraftWarn: '该课程还是草稿，员工端暂时看不到；可以先指派，发布后即可开始学习。',
    asgColDue: '截止', asgColProgress: '进度', asgNone: '请先选择要指派的员工',
    // 部门（第二批 3.1 / P3）：按部门指派含下级、带人数确认；已指派名单与线下签到名单可按部门筛选
    deptAll: '全部部门',
    asgConfirmT: '按部门指派', asgConfirm: (n) => `将指派给 ${n} 人。确认指派？`,
    rosterDept: (n, t) => `当前部门 ${n} / ${t} 人`,
    // 只读档(learning=read)的说明:写接口服务端一律 403,按钮留着就是「假按钮」。
    roWrite: '只读权限：当前角色对培训只能查看、不能修改，写操作不可用；如需操作请联系超级管理员调整授权。',
    // 只读档的查看入口与说明（2026-10-07 QA RO1）：课程编辑器整页只读展示，不给任何写入口
    viewCourse: '查看内容', roNew: '当前角色对培训只有查看权限，不能新建课程，已返回课程库。',
    ceModulesHintRo: '点击小节查看内容',
    edEmptyRo: '从左侧选择一个小节查看内容。课程名称、说明、授课方式等在右上角「课程信息」里查看。',
    exGoView: '去考试页查看 →', close: '关闭',
    // 批量发布 / 下线 / 改分类（2026-10-07 B5）
    selAll: (n) => `全选当前筛选结果（${n}）`,
    bulkPublish: '发布', bulkArchive: '下线', bulkCategory: '改分类',
    bulkArchiveNote: '下线后员工端不再显示这些课程，历史记录保留。',
    bulkCatPh: '选择或输入新分类', bulkCatClear: '不选分类即清空所选课程的分类。',
    bulkSynced: (n, m) => `已完成 ${n} 项；已为引用这些课程的发展项目同步 ${m} 名在训学员的指派`,
    bulkEmptyN: (n) => `其中 ${n} 门线上课程还没有内容（0 个模块、无考试），会跳过、不发布。`,
    // 第三批 4.3 / 10.3：课程库只用列表，一行一门课；类别、修读类型、授课方式筛选写进地址栏
    colCourse: '课程', colCat: '类别', colType: '类型', colHours: '学时', colProjects: '所属发展项目', colContent: '内容', colBank: '题库', colActions: '操作',
    contentOnline: (m, sc, min) => `${m} 个模块 · ${sc} 个小节${min ? ` · ${min} 分钟` : ''}`,
    sessionTbd: '开课时间待定', clear: '清除筛选', emptyFiltered: '没有符合筛选条件的课程',
    totalText: (n) => `共 ${n} 门课程`, hoursUnit: (h) => `${h} 小时`, typeElective: '选修',
    // 第三批 5.5：课程信息表单的类别与学时（8.5 表单两栏：左基本信息、右课程设置）
    fmSecBasic: '基本信息', fmSecSettings: '课程设置',
    fHours: '学时（小时）',
    fHoursOnline: (h) => `留空则按模块时长合计（当前 ${h} 小时）`,
    fHoursOffline: '用于人均学时统计，线下课程请填写',
    fCatCustom: '新类别不在标准列表中，培训概览会把它单独成列。',
    // 第三批 5.5：大纲小节名下方的小图标
    mkVideo: '视频', mkLink: '视频链接', mkFiles: (n, names) => `附件 ${n} 个：${names}`,
    mkDeck: (n) => `课件含 ${n} 段视频`, mkWarn: '有视频待转码或转码失败',
    // 第三批 5.7：课件内视频（编辑器附件区）
    dmTitle: (n) => `课件内视频 ${n} 段`, dmRefresh: '刷新状态', dmWaiting: '等待转码组件',
    dmOpenOffice: '查看转换页', dmResolve: '去处理', dmLoadErr: '视频状态读取失败，请点「刷新状态」重试',
    ocTip: (lo, ff, n) => `LibreOffice：${lo} · ffmpeg：${ff}${n ? ` · ${n} 段视频待处理` : ''}`,
    // 第三批 8.6：按部门 / 职级指派
    asgConfirmT2: '按部门 / 职级指派',
    asgConfirmSkip: (n) => `已扣除已指派过的 ${n} 人。`, asgConfirmNoGrade: (n) => `未设职级的 ${n} 人不在其中。`,
    // 第四批 7：公开课程（无需申请，员工在「课程目录」自主学习）；9.2 取消公开按方案 A：已开始的可学完，未开始的移出，已完成的保留
    fPublic: '公开课程',
    fPublicHint: '全员可在员工端「公开课」自主学习，无需申请；学完计入学时。',
    fPublicElective: '公开后不再需要选修申请。',
    tagPublic: '公开', selfCountN: (n) => `自主学习 ${n} 人`,
    pubRailOn: '已公开：员工可在「公开课」自主学习', pubRailOff: '未公开',
    bulkPublicOn: '设为公开', bulkPublicOff: '取消公开',
    bulkPublicOnNote: '设为公开后，全员可在员工端「公开课」自主学习，无需申请；这些课程待审批的选修申请将自动通过，申请人直接加入。',
    bulkPublicOffNote: '取消公开后，「公开课」立即不再显示这些课程：已开始学习的人可以继续学完（含考试），加入后尚未开始的人将被移出，已完成的记录与学时保留。指派给员工的课程不受影响。',
    bulkPublicOffN: (n) => `所选课程目前共有 ${n} 人在自主学习。`,
    pubCloseTitle: '取消公开课程',
    pubCloseImpact: (total, started, notStarted, done) => `${total} 人正在自主学习：${started} 人已开始（可继续学完），${notStarted} 人未开始（将被移出）；${done} 人已完成（记录与学时保留）。`,
    pubCloseNone: (done) => `目前没有人在自主学习这门课程；${done} 人已完成（记录与学时保留）。`,
    pubClosePolicy: '「公开课」将立即不再显示这门课程；指派给员工的课程不受影响。',
    pubCloseErr: '暂时无法读取影响人数；确认后仍按上述规则处理。',
    pubCloseOk: '取消公开并保存',
  },
  en: {
    title: 'Course Library',
    lead: 'Courses can be assigned directly, opened for application, or used in development programs. Edits save instantly.',
    newCourse2: 'New course',
    loading: 'Loading…', loadError: 'Couldn’t load. Refresh the page to try again.', retry: 'Retry',
    emptyCourses: 'No courses yet — click "New course" to start',
    cModules: (n) => `${n} modules`, cSections: (n) => `${n} sections`,
    cMinutes: (n) => `~${n} min`, cBank: (n) => `Question bank: ${n}`,
    stPublished: 'Published', stDraft: 'Draft', stArchived: 'Retired',
    fAll: 'All', searchPh: 'Search course name, category or development program', noMatch: 'No course matches — try another keyword or go back to "All"',
    pjTag: (name) => `Development Program: ${name}`, pjMore: (total, rest) => `+${rest} more`, pjSolo: 'Standalone course',
    pjListTip: (names) => `Used in these development programs: ${names}`,
    pjSoloTip: 'Not used in any development program — can be assigned on its own or opened for application',
    pjSt: { planning: 'Planning', running: 'In progress', closing: 'Wrapping up', closed: 'Closed', draft: 'Draft' },
    kLab: 'Filter by development program', kAll: 'All courses', kProject: 'Program courses', kSolo: 'Standalone courses',
    bkTight: (pool, draw) => `Bank has only ${pool} questions and draws ${draw}`,
    bkShort: (pool, draw) => `Bank has only ${pool} questions < ${draw} drawn — papers will come up short`,
    bkHint: 'The final exam draws its objective questions (single / multiple answer / fill-in) at random from this course’s bank. When the bank is no bigger than the draw, every learner sits the same paper.',
    enrollMandatory: 'Required',
    enrollMandatoryFull: 'Required (assigned by HR)', enrollElectiveFull: 'Elective (by application)',
    modeOnline: 'Online', modeOffline: 'In-person',
    tbd: 'Time TBD',
    editCourse: 'Edit content', renameCourse: 'Edit info', delCourse: 'Delete course', moreLab: 'More',
    exportPkg: 'Export course package', importPkg: 'Import course package', pkgExported: 'Course package exported',
    pkgBadFile: 'Not a valid course package: choose a .course.json file exported from this system.',
    pkgImported: (t, n) => `Imported "${t}" (${n} modules) as a draft.`,
    pkgDropped: (n) => `Attachments and in-course videos are not carried in the package; ${n} item(s) were dropped. Please re-upload them in the course.`,
    pkgSameName: 'A course with this name exists', pkgSameNameBody: 'The library already has a course with this name. Change the name to import a copy, or keep it to import with the same name.',
    pkgNewTitleZh: 'Course name (Chinese)', pkgNewTitleEn: 'Course name (English)', pkgImportBtn: 'Import',
    delCourseAsk: 'Delete this course with its modules and sections? Its questions in the question bank are deleted too (questions still used by other exams are kept). This is possible only when no development program uses it and no learner has records.',
    delBlockedTitle: "This course is in use — it can't be deleted",
    delUseProjects: (list) => `Used in development programs: ${list}`,
    delUseProgress: (n) => `${n} learner(s) have progress records`,
    delUseAttempts: (n) => `${n} exam attempt(s) exist`,
    delUseExams: (n) => `${n} linked exam${n === 1 ? '' : 's'}`,
    delBlockedHint: 'Deleting it would leave the development program phases that use it permanently incomplete and make completed learning records unavailable. Retire it instead: it is hidden from employees and its history is kept.',
    delArchiveNow: 'Retire instead', archivedOk: 'Retired: hidden from employees, history kept',
    publishNow: 'Publish', publishedOk: 'Published. Employees see it under Electives Open for Application on their home page (required courses appear once assigned).',
    examBtn: 'Exam settings (Exams page)',
    fmCourseNew: 'New course', fmCourseEdit: 'Edit course details',
    fTitleZh: 'Course title (Chinese)', fTitleEn: 'Title (English · optional)',
    fDescZh: 'Description (Chinese)', fDescEn: 'Description (English · optional)',
    fStatus: 'Status', fStatusHint: 'Draft: visible in the console only. Once published, electives appear under Electives Open for Application on the employee home page; required courses appear once assigned.',
    fValid: 'Default completion period (days)', fValidHint: 'Default number of days until due when this course is assigned (1–365)',
    fMinutes: 'Estimated time (minutes)',
    fMinutesOne: 'Shown on the course card as "~N min". This course has one module, so this is that module\'s time.',
    fMinutesSum: (n, k) => `About ${n} min — the sum of its ${k} modules. To change it, use each module's pencil button in the course editor's outline.`,
    fMinutesNew: 'After saving, add modules in the course editor; each module has its own estimated time and the course time is their sum.',
    fEnroll: 'Requirement type', fEnrollHint: 'Required: available as soon as HR assigns it. Elective: employees apply from Electives Open for Application on their home page and start after approval.',
    fCategory: 'Category', phCategory: 'Pick a category (or type a new one)',
    fMode: 'Delivery', fModeHint: "In-person courses need a time and venue for employees to see. Attendance is taken with this course's Check-in; when a development program uses the course, it can also be taken there.",
    fSessionAt: 'Session time', phSessionAt: 'e.g. 2026-08-05 14:00 (type it or pick from the calendar)',
    fLocation: 'Venue', phLocation: 'e.g. HQ 3F Training Room',
    fSessionNote: 'In-person notes (optional)', phSessionNote: 'e.g. Arrive 10 minutes early, bring your laptop',
    fTrainer: 'Trainer (delivers this course)',
    fTrainerHint: 'They get a "My Sessions" workbench: show the check-in code and take the roll for the people assigned this course (no admin rights).',
    phTitleZh: 'e.g. 公司文化与行为准则',
    phTitleEn: 'e.g. Company Culture & Code of Conduct',
    phDescZh: 'Briefly describe the goal and audience (Chinese)',
    phDescEn: 'Briefly describe the goal and audience',
    save: 'Save', cancel: 'Cancel',
    reqTitle: 'Please enter a course title',
    savedCourse: 'Course saved', deleted: 'Deleted',
    ceModules: 'Modules & sections',
    ceBack: 'Back to course library', ceAutosave: 'Edits save instantly',
    trCourse: 'AI-translate whole course', trToEn: 'Chinese → English', trToZh: 'English → Chinese',
    trTitle: (to) => (to === 'en' ? 'AI-translate the whole course into English' : 'AI-translate the whole course into Chinese'),
    trConfirm: (n) => `${n} field(s) without a translation yet (course title and description, module names, section titles and bodies) will be translated and written into the course; you can edit each one afterwards. Fields that already have a translation are left as they are.`,
    trNone: 'Every field already has a translation', trDone: (n) => `AI translation written into ${n} field(s) — please check each one`, trDoneDemo: 'Demo mode: placeholder text marked “Demo translation” was written; no AI was called',
    trOk: 'Translate', trBusy: 'Translating…', eOff: 'This AI feature is not enabled', eConf: 'The AI service is not connected yet', eRate: 'AI translation limit reached — try again later', eBudget: "This month's AI usage limit has been reached", eLong: 'The content is too long — translate it in parts', eMany: 'Translate at most 80 fields at a time',
    ceModulesHint: 'Drag ⋮⋮ to reorder, or use the arrows · click a section to edit its content',
    ceOffline: 'In-person courses can also carry materials below (agenda, handouts) — learners see them on the course page.',
    addModule: 'Add module', renameModule: 'Edit module',
    delModuleAsk: 'Delete this module and all its sections?', delModuleTitle: 'Delete module',
    sectionsN: (n) => `${n} sections`, addSection: 'Add section',
    emptySections: 'No sections yet — click "Add section" to start',
    moveUp: 'Move up', moveDown: 'Move down', rename: 'Rename', del: 'Delete',
    mrTitleZh: 'Module title (Chinese)', mrTitleEn: 'Module title (English, optional)', mrMinutes: 'Estimated time (minutes)', mrMinutesHint: 'The course "~N min" figure is the sum of its modules', nPeople: (n) => `${n} ${n === 1 ? 'person' : 'people'}`,
    exTitle: 'Final exam', exRequired: 'Final exam required',
    exPackage: (name, n) => `Learning package: ${name} (${n} courses). The exam shown here is the final exam of the whole package.`,
    exOffHint: 'Off: learners complete the course by finishing all its content — no exam. Earlier exams are retired; past results are kept.',
    exReadOnlyHint: 'Exam rules are edited on the Exams page; this panel only shows them.',
    exNone: 'This course has no final exam yet.', exCreate: 'Create final exam', exGoEdit: 'Edit on the Exams page →',
    exBank: 'Bank / draw', exBankV: (pool, draw, open) => `${pool} Q / draw ${draw}${open ? ` + ${open} short answer` : ''}`,
    exPass: 'Passing score', exTime: 'Time limit', exNoLimit: 'No limit', exMin: (n) => `${n} min`,
    exAttempts: 'Max attempts', exUnlimited: 'Unlimited', exShowAnswers: 'Show answers after the exam', exYes: 'Yes', exNo: 'No',
    exOffOk: 'Final exam turned off: the exam is retired and finishing the course completes it',
    exOnOk: 'Final exam turned on', exRepubOk: 'Final exam turned on and the previous exam re-published',
    exInProjectTitle: "Can't turn off the final exam",
    seNew: 'New section', seEdit: 'Edit section', seNo: (no) => `Section ${no}`,
    seTitleZh: 'Section title (Chinese)', seTitleEn: 'Section title (English)',
    edInfo: 'Course info', edEmpty: 'Pick a section on the left to start editing, or click “Add section” under a module. Change the course name, description and delivery mode under “Course info” at the top right.',
    edNotFound: 'This course could not be found — it may have been deleted.', bodyZhTab: 'Chinese body', bodyEnTab: 'English body', bodyEnHint: 'When the English body is empty, learners see the Chinese one.',
    bodyPh: 'Write the section body here: bold, headings, lists, quotes and links…',
    discardTitle: 'Discard unsaved changes?', discardAsk: 'This section has unsaved changes that will be lost if you leave.', discardOk: 'Discard', unsaved: 'Unsaved changes',
    seVideoBlock: 'Video', seAttachBlock: 'Attachment',
    seVideoHint: 'Upload mp4/webm (≤500 MB, stored in public/videos, plays on the intranet)',
    seVideoPaste: 'Or paste a YouTube / embed URL',
    seVideoUp: 'Upload video',
    seAttachHint: 'PDF / PPT / Word / Excel become view-only online and are never downloadable; files that can’t be converted are rejected · audio plays inline',
    seOfficeOff: 'The file converter (LibreOffice) isn’t installed: PowerPoint, Word and Excel files can’t be uploaded. Save them as PDF first',
    eOfficeOff: 'The server has no file converter, so PowerPoint, Word and Excel files can’t be uploaded. Save as PDF, or ask IT to install LibreOffice',
    eConvFail: 'This file couldn’t be converted to a view-only PDF and wasn’t uploaded. Check that it opens normally, or save it as PDF',
    ePdfInvalid: 'This file isn’t a valid PDF (it may be another file type renamed to .pdf) and wasn’t uploaded. Open it and save it as PDF, then upload it again',
    eTooLarge: 'File too large (max 500 MB)',
    converting: 'Converting… PowerPoint, Word and Excel files become a view-only PDF first. This can take a minute or two, so stay on this page',
    uploadedHint: 'Uploaded — learners see it after you save the section',
    acceptInvalid: 'Unsupported file type. Upload video, audio or PDF; PPT / Word / Excel cannot be uploaded yet — save as PDF first.',
    ocBtnOk: (n) => `File converter: ready${n ? ` · ${n} pending` : ''}`,
    ocBtnOff: (n) => `File converter: not installed${n ? ` · ${n} pending` : ''}`,
    ocBtnDisabled: (n) => `File converter: turned off${n ? ` · ${n} pending` : ''}`,
    seUpload: 'Add attachment',
    seVideoUrl: 'Video link (YouTube / Vimeo / bilibili page, or an mp4 / webm / m3u8 file)',
    phVideoUrl: 'https://www.youtube.com/watch?v=...  or  https://…/video.mp4',
    badVideoUrl: 'The video link must start with http(s)://. Fix it and save again.',
    sePreview: 'Learner preview', sePreviewEmpty: 'Fill in a title and body to preview here',
    seVideoLabel: 'Video',
    savedSection: 'Section saved', uploadFail: 'Upload failed',
    ckBtn: 'Check-in', ckCode: 'On-site code', ckRefresh: 'Refresh',
    ckBig: 'Projector mode', ckExit: 'Click anywhere to exit', ckRotate: 'Code rotates every minute',
    ckHint: 'Employee phone: open this course page → enter this code',
    ckAttended: 'Present', ckLate: 'Late', ckExcused: 'Excused', ckMissing: 'Missing', ckAbsent: 'Absent',
    ckMakeup: 'Make up', ckExcuse: 'Excuse', ckToPresent: 'Mark present', ckClose: 'Close',
    ckMakeupExcused: 'Mark make-up attended',
    ckColName: 'Learner', ckColDept: 'Department', ckColState: 'Status',
    ckEmpty: 'No one is assigned this course yet (publish & assign first)',
    asgBtn: 'Assign', asgTitle: 'Assign course',
    asgByDept: 'By department',
    asgDeptPh: 'Pick one or more departments to assign in bulk', asgPastePh: 'Paste employee IDs separated by spaces / commas / newlines',
    asgPickPh: 'Search and pick employees',
    asgDue: 'Due date', asgDueHint: 'Empty = no deadline',
    asgWill: 'Newly assigned', asgMatched: 'Match', asgFound: 'Found', asgPicked: 'Picked',
    asgSkipped: 'Already assigned (skipped)', asgNoGradeR: 'No job grade (not included)', asgMissingR: 'IDs not found',
    asgHelp: 'By criteria: use a department, a job grade, or both (e.g. one department with its sub-departments × P1–P3). A parent department includes all its sub-departments, and a range of grades can be added at the bottom of the grade list. Active employees only; when a grade is chosen, people without a job grade are not included. All three ways skip people who are already assigned.',
    asgDo: 'Assign', asgDoneN: (n) => `Assigned ${n}`,
    asgListTitle: (n) => `${n} assigned`,
    asgRemove: 'Remove', asgRemoveAsk: (name) => `Unassign ${name}? Their records are kept.`, asgRemovedOk: 'Removed',
    asgEmpty: 'No one is assigned yet',
    asgDraftWarn: 'This course is still a draft — invisible to employees. You can assign now; learning starts once published.',
    asgColDue: 'Due', asgColProgress: 'Progress', asgNone: 'Pick some employees first',
    deptAll: 'All departments',
    asgConfirmT: 'Assign by department', asgConfirm: (n) => `This assigns the course to ${n} ${n === 1 ? 'person' : 'people'}. Assign?`,
    rosterDept: (n, t) => `${n} of ${t} in this department`,
    roWrite: 'Read-only: your role can view training but not change it, so the write actions are unavailable. Ask a super-admin to widen the grant.',
    viewCourse: 'View content', roNew: 'Your role can only view training, so it cannot create a course — back to the course library.',
    ceModulesHintRo: 'Click a section to view its content',
    edEmptyRo: 'Pick a section on the left to view it. The course name, description and delivery mode are under “Course info” at the top right.',
    exGoView: 'View on the Exams page →', close: 'Close',
    selAll: (n) => `Select all ${n} shown`,
    bulkPublish: 'Publish', bulkArchive: 'Retire', bulkCategory: 'Change category',
    bulkArchiveNote: 'Retired courses are hidden from employees; history is kept.',
    bulkCatPh: 'Pick or type a category', bulkCatClear: 'Leave it empty to clear the category of the selected courses.',
    bulkSynced: (n, m) => `Done: ${n}; assignments synced for ${m} active learner(s) of the development programs that use these courses`,
    bulkEmptyN: (n) => `${n} of them are online courses with no modules and no exam — they will be skipped, not published.`,
    colCourse: 'Course', colCat: 'Category', colType: 'Type', colHours: 'Hours', colProjects: 'Development Programs', colContent: 'Content', colBank: 'Question bank', colActions: 'Actions',
    contentOnline: (m, sc, min) => `${m} module${m === 1 ? '' : 's'} · ${sc} section${sc === 1 ? '' : 's'}${min ? ` · ${min} min` : ''}`,
    sessionTbd: 'Session time not set', clear: 'Clear filters', emptyFiltered: 'No courses match these filters',
    totalText: (n) => `${n} course${n === 1 ? '' : 's'}`, hoursUnit: (h) => `${h} h`, typeElective: 'Elective',
    fmSecBasic: 'Basics', fmSecSettings: 'Course settings',
    fHours: 'Learning hours',
    fHoursOnline: (h) => `Leave blank to use the total module time (currently ${h} h)`,
    fHoursOffline: 'Used for learning hours per head — please fill in for in-person courses',
    fCatCustom: 'This category is not in the standard list, so the training overview shows it as its own column.',
    mkVideo: 'Video', mkLink: 'Video link', mkFiles: (n, names) => `${n} attachment${n === 1 ? '' : 's'}: ${names}`,
    mkDeck: (n) => `Deck has ${n} video${n === 1 ? '' : 's'}`, mkWarn: 'Videos waiting or failed',
    dmTitle: (n) => `${n} video${n === 1 ? '' : 's'} in this deck`, dmRefresh: 'Refresh status', dmWaiting: 'Waiting for the transcoder',
    dmOpenOffice: 'Open the conversion page', dmResolve: 'Resolve', dmLoadErr: "Couldn't read the video status — click “Refresh status” to try again",
    ocTip: (lo, ff, n) => `LibreOffice: ${lo} · ffmpeg: ${ff}${n ? ` · ${n} video${n === 1 ? '' : 's'} waiting` : ''}`,
    asgConfirmT2: 'Assign by department / job grade',
    asgConfirmSkip: (n) => `${n} already assigned ${n === 1 ? 'person was' : 'people were'} left out.`, asgConfirmNoGrade: (n) => `${n} ${n === 1 ? 'person' : 'people'} without a job grade ${n === 1 ? 'is' : 'are'} not included.`,
    fPublic: 'Public course',
    fPublicHint: 'Everyone can take it from Public Courses without applying; completions count toward learning hours.',
    fPublicElective: 'Elective applications are no longer needed once it is public.',
    tagPublic: 'Public', selfCountN: (n) => `${n} self-directed ${n === 1 ? 'learner' : 'learners'}`,
    pubRailOn: 'Public: employees can take it from Public Courses', pubRailOff: 'Not public',
    bulkPublicOn: 'Make public', bulkPublicOff: 'Make not public',
    bulkPublicOnNote: 'Once public, everyone can take these courses from Public Courses without applying. Pending elective applications for them are approved automatically and the applicants are enrolled.',
    bulkPublicOffNote: 'The Public Courses page stops showing these courses at once. People who have started can finish them (including the exam), people who joined but have not started are removed, and completed records and hours are kept. Courses assigned to employees are not affected.',
    bulkPublicOffN: (n) => `${n} ${n === 1 ? 'person is' : 'people are'} currently taking the selected courses as self-directed learning.`,
    pubCloseTitle: 'Make course not public',
    pubCloseImpact: (total, started, notStarted, done) => `${total} self-directed ${total === 1 ? 'learner' : 'learners'}: ${started} started (can finish), ${notStarted} not started (will be removed); ${done} completed (records and hours are kept).`,
    pubCloseNone: (done) => `No one is taking this course as self-directed learning; ${done} completed (records and hours are kept).`,
    pubClosePolicy: 'The Public Courses page stops showing this course at once. Courses assigned to employees are not affected.',
    pubCloseErr: 'Couldn’t read the numbers right now. If you confirm, the same rules apply.',
    pubCloseOk: 'Make not public and save',
  },
};

// 课程类别：目录与标签在 web/src/categories.js（与服务端 modules/learning/categories.js 同一份，第三批 4.3）。
// 学时（第三批 1.2）：课程填了 hours 就用它；否则线上课程 = 各模块分钟数之和 / 60（保留 1 位小数）；线下未填 = 0。
const round1 = (n) => Math.round(n * 10) / 10;
const moduleMinutes = (c) => (c.modules || []).reduce((n, m) => n + (Number(m.minutes) || 0), 0);
const courseHours = (c) => {
  if (c.hours != null && c.hours !== '' && Number.isFinite(Number(c.hours))) return round1(Number(c.hours));
  if ((c.mode || 'online') === 'online') return round1(moduleMinutes(c) / 60);
  return 0;
};
// 表单里的学时：0–999，步长 0.5，保留 1 位；空 = null（线上课程回到按模块时长计）
const clampHours = (v) => {
  if (v == null || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.min(999, Math.max(0, round1(n)));
};
// 地址栏里的筛选键（第三批 4.3）：q 搜索、st 状态、cat 类别（逗号列表，含 __none）、enroll 修读类型、mode 授课方式、kind 使用情况；
// 第四批 7：pub 公开课程（'1' 公开 / '0' 非公开）
const FILTER_KEYS = ['q', 'st', 'cat', 'enroll', 'mode', 'kind', 'pub'];
// 9.2「取消公开」的影响人数（GET /api/admin/courses/:id/public-impact）：started 已开始（可学完）/ notStarted 未开始（移出）/ done 已完成。
// 字段名有别名时也认（kept / removed 可以是人数或名单）。
const impactOf = (imp) => {
  if (!imp || typeof imp !== 'object') return null;
  const n = (...vs) => { for (const v of vs) { if (Array.isArray(v)) return v.length; if (v != null && Number.isFinite(Number(v))) return Math.max(0, Number(v)); } return 0; };
  const started = n(imp.started, imp.kept, imp.keep);
  const notStarted = n(imp.notStarted, imp.removed, imp.remove);
  return { started, notStarted, total: started + notStarted, done: n(imp.done, imp.completed) };
};
// 页面键：课程编辑器、课程信息、新建、课件转换页。切换页面只改这些，筛选保留
const PAGE_RESET = { course: null, view: null, new: null, office: null };
// 课程库分页档（设计 §5.2：20 / 50 / 100）
const LIST_PAGE_TIERS = [20, 50, 100];

const STATUS_META = {
  published: { color: 'green', key: 'stPublished' },
  draft: { color: 'grey', key: 'stDraft' },
  archived: { color: 'amber', key: 'stArchived' },
};

// immutable array move
const move = (arr, i, dir) => {
  const j = i + dir;
  if (j < 0 || j >= arr.length) return arr;
  const next = arr.slice();
  [next[i], next[j]] = [next[j], next[i]];
  return next;
};
// immutable lift-and-insert, for the drag handles (a swap would be wrong here:
// dragging item 11 onto item 1 has to push the rest down, not trade places).
const reorder = (arr, from, to) => {
  if (from === to || from < 0 || to < 0 || from >= arr.length || to >= arr.length) return arr;
  const next = arr.slice();
  next.splice(to, 0, next.splice(from, 1)[0]);
  return next;
};

// client-generated ids (courses/modules are upserted by id via the content PUT)
const genId = (p) => `${p}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
const clampDue = (v) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 1) return 30;
  return Math.min(365, Math.round(n));
};
const clampMinutes = (v) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 1) return 10;
  return Math.min(600, Math.round(n));
};
const fmtD = (d) => fmtDate(new Date(d));
const fmtDT = (d) => { const x = new Date(d); return fmtD(x) + 'T' + String(x.getHours()).padStart(2, '0') + ':' + String(x.getMinutes()).padStart(2, '0'); };

// 「空一行 = 分一段；也可以直接贴 HTML」— what the body hint promises. HR types
// plain text far more often than markup, so a body with no block tags of its own
// gets real paragraphs (single newlines become <br>); anything that already
// carries block markup is a pasted-HTML body and passes through untouched.
// `p`/`br` are on the server's allow-list, so nothing is stripped on save.
const BLOCK_TAG = /<\s*\/?\s*(p|div|ul|ol|li|br|h[1-6]|blockquote|table|pre|hr)\b/i;
const bodyToHtml = (raw) => {
  const t = String(raw == null ? '' : raw);
  if (!t.trim()) return '';
  if (BLOCK_TAG.test(t)) return t;
  return t.trim().split(/\n\s*\n+/)
    .map((p) => `<p>${p.trim().replace(/\n/g, '<br>')}</p>`)
    .join('');
};

// Normalize a pasted video link to an embeddable URL: plain YouTube links
// (watch?v=… / youtu.be/… / shorts/…) become /embed/… so the player iframe
// actually plays them; other http(s) URLs pass through.
const normalizeVideoUrl = (raw) => {
  const v = String(raw || '').trim();
  if (!v) return null;
  let m = v.match(/(?:youtube\.com\/watch\?(?:.*&)?v=|youtu\.be\/)([\w-]{6,})/i);
  if (m) return `https://www.youtube.com/embed/${m[1]}`;
  m = v.match(/youtube\.com\/(?:embed|shorts)\/([\w-]{6,})/i);
  if (m) return `https://www.youtube.com/embed/${m[1]}`;
  return /^https?:\/\//i.test(v) ? v : null;
};

// CX-042 乐观锁：本客户端最近一次保存得到的 updatedAt（课程 id → ISO）；GET 带来的 updatedAt 作为首次基线
const REV = new Map();

export default function Content() {
  const { lang, loc } = useI18n();
  const s = T[lang];
  // 本页写接口:PUT content/courses/:id、PUT content/programs/:id、DELETE content/courses/:id、
  // POST assignments/bulk、POST courses/:id/checkin/mark、POST upload-video、
  // POST attachments —— 矩阵里全归培训域写,与本页同域;GET content / roster / questions /
  // courses/:id/checkin 是读(roster 走 W1 白名单)。所以只有只读档要收起写控件。
  const canWrite = useCanWrite();

  // ---- live content (course documents + their invisible wrappers) ----
  const { loading, error, data, reload } = useAsync(() => api.get('/api/admin/content'), []);
  // People who can be named as the 讲师 of an in-person course.
  const rosterQ = useAsync(() => api.get('/api/admin/roster'), []);
  // The question bank, only for the 「题库 N 题」 count on a course card.
  const questionsQ = useAsync(() => api.get('/api/admin/questions'), []);
  // 真实考试（exams 表，「考试」页维护）：右栏摘要与课程行的题量预警都以它为准，
  // 不再读包装程序上的旧字段（examMcqCount 等对实际考试没有任何作用）。
  const examsQ = useAsync(() => api.get('/api/admin/exams'), []);
  // 课件转换组件状态与待转换清单（P0 1.4，培训读）：页头状态按钮、附件区的未安装提示都读它。
  const oc = useAsync(() => api.get('/api/admin/attachments/office-status'), []);
  const ocState = oc.data && oc.data.converter ? oc.data.converter.state : null;
  // 状态未知（加载中 / 失败）时不收窄上传类型，交给服务端判定并按错误码提示。
  const officeOk = !ocState || ocState === 'ok';
  const nav = useNavigate();
  const examsOfProgram = useMemo(() => {
    const m = {};
    (examsQ.data || []).forEach((e) => { (m[e.programId] = m[e.programId] || []).push(e); });
    const rank = { published: 0, draft: 1, archived: 2 };
    Object.values(m).forEach((list) => list.sort((a, b) => (rank[a.status] ?? 3) - (rank[b.status] ?? 3)
      || String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''))));
    return m;
  }, [examsQ.data]);

  // wrapper (1:1 program) per course id — carries exam settings + legacy fields
  const wrapperOf = useMemo(() => {
    const m = {};
    (data && data.programs ? data.programs : []).forEach((p) => {
      (p.courseIds || []).forEach((cid) => { if (!m[cid]) m[cid] = p; });
    });
    return m;
  }, [data]);

  const courses = useMemo(
    () => (data && data.courses ? data.courses.map(normalizeCourse) : []),
    [data]);

  // Whole bank per course (every type) — the 「题库 N 题」 run on a course card.
  const bankAllOf = useMemo(() => {
    const m = {};
    (questionsQ.data || []).forEach((q) => { m[q.courseId] = (m[q.courseId] || 0) + 1; });
    return m;
  }, [questionsQ.data]);

  // 培养项目 that reference each course (GET content → usedInProjects, read-only; kept
  // out of the course view model so it never travels back in a PUT). null = an older
  // server that doesn't send it → no tag and no filter, rather than calling every
  // course standalone.
  const projectsOf = useMemo(() => {
    const m = {};
    (data && data.courses ? data.courses : []).forEach((c) => { m[c.id] = Array.isArray(c.usedInProjects) ? c.usedInProjects : null; });
    return m;
  }, [data]);
  const hasProjInfo = useMemo(() => Object.values(projectsOf).some((v) => v !== null), [projectsOf]);

  // ---- status segments + search + filters (the list is filtered, the counts are not) ----
  // 第三批 4.3：筛选全部写进地址栏（useUrlState 合并写回，replace），培训概览可以深链到 #/admin/content?cat=__none；
  // 打开课程、返回课程库都只改页面键（goPage），筛选保留。
  const [urlp, patchUrl] = useUrlState();
  const fStatus = ['published', 'draft', 'archived'].includes(urlp.st) ? urlp.st : ''; // '' = all
  const fKind = ['project', 'solo'].includes(urlp.kind) ? urlp.kind : 'all'; // all | project | solo
  const query = urlp.q || '';
  const fCat = useMemo(() => parseList(urlp.cat), [urlp.cat]);
  const fEnroll = ['mandatory', 'elective'].includes(urlp.enroll) ? urlp.enroll : '';
  const fMode = ['online', 'offline'].includes(urlp.mode) ? urlp.mode : '';
  const fPub = ['1', '0'].includes(urlp.pub) ? urlp.pub : '';
  const setFilter = (k, v) => patchUrl({ [k]: v || null }, { push: false });
  const setFStatus = (v) => setFilter('st', v);
  const setFKind = (v) => setFilter('kind', v === 'all' ? null : v);
  const setQuery = (v) => setFilter('q', v);
  const hasFilters = FILTER_KEYS.some((k) => !!urlp[k]);
  const clearFilters = () => patchUrl(Object.fromEntries(FILTER_KEYS.map((k) => [k, null])), { push: false });
  // A course row shows the course's own status, falling back to its wrapper's.
  const statusOf = (c) => c.status || (wrapperOf[c.id] && wrapperOf[c.id].status) || 'draft';
  const enrollOf = (c) => c.enrollType || (wrapperOf[c.id] && wrapperOf[c.id].enrollType) || 'mandatory';
  const categoryOf = (c) => c.category || (wrapperOf[c.id] && wrapperOf[c.id].category) || null;
  // 第四批 7：公开课程（课程文档的 public；旧数据只在包装程序上有时也认）与自主学习人数（GET content 的 selfCount，按数据范围计，只读）
  const publicOf = (c) => c.public === true || (c.public == null && !!wrapperOf[c.id] && wrapperOf[c.id].public === true);
  const selfCountOf = useMemo(() => {
    const m = {};
    (data && data.courses ? data.courses : []).forEach((c) => { m[c.id] = Number.isFinite(Number(c.selfCount)) ? Number(c.selfCount) : 0; });
    return m;
  }, [data]);
  const counts = useMemo(() => {
    const st = courses.map(statusOf);
    return {
      total: st.length,
      published: st.filter((x) => x === 'published').length,
      draft: st.filter((x) => x === 'draft').length,
      archived: st.filter((x) => x === 'archived').length,
      project: courses.filter((c) => (projectsOf[c.id] || []).length > 0).length,
      solo: courses.filter((c) => projectsOf[c.id] && projectsOf[c.id].length === 0).length,
    };
  }, [courses, wrapperOf, projectsOf]); // eslint-disable-line react-hooks/exhaustive-deps
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return courses.filter((c) => {
      if (fStatus && statusOf(c) !== fStatus) return false;
      const pj = projectsOf[c.id];
      if (fKind === 'project' && !(pj && pj.length)) return false;
      if (fKind === 'solo' && !(pj && pj.length === 0)) return false;
      const cat = categoryOf(c);
      if (fCat.length && !fCat.includes(cat || UNCATEGORIZED)) return false;
      if (fEnroll && enrollOf(c) !== fEnroll) return false;
      if (fMode && (c.mode || 'online') !== fMode) return false;
      if (fPub && publicOf(c) !== (fPub === '1')) return false;
      if (!q) return true;
      // A project's name finds every course it uses; a category matches in either language.
      return [c.title, c.title_zh, cat, cat && categoryLabel(cat, 'en'), c.description, c.description_zh,
        ...(pj || []).flatMap((p) => [p.title, p.title_zh])]
        .some((v) => v && String(v).toLowerCase().includes(q));
    });
  }, [courses, wrapperOf, projectsOf, fStatus, fKind, query, fCat, fEnroll, fMode, fPub]); // eslint-disable-line react-hooks/exhaustive-deps

  // 类别：标准目录（categories.js）+ 正在使用的自定义值；标签按语言，值永远是中文键（第三批 4.3 / 5.5）
  const catInUse = useMemo(() => courses.map((c) => categoryOf(c)).filter(Boolean), [courses, wrapperOf]); // eslint-disable-line react-hooks/exhaustive-deps
  const categoryOpts = useMemo(() => categoryOptions(lang, catInUse), [lang, catInUse]);

  // course form sheet / editor sheet / small modals
  // formSheet（课程信息表单）由地址栏推出，见 editingCourse 之后
  // 整页编辑（2026-10-06 负责人：新建与编辑课程都用整页，不用抽屉）：地址栏是唯一事实源 ——
  //   ?course=<id>            该课程的整页编辑器（培养项目「引用 某课程」跳来同一入口，返回键可用）
  //   ?course=<id>&view=info  同一页面中间栏显示课程信息表单
  //   ?new=1                  新建课程（整页表单），保存后进入该课程的编辑器
  const [searchParams] = useSearchParams();
  // 切换页面（编辑器 / 课程信息 / 新建 / 课件转换页）只改页面键、push 一条历史，筛选参数原样保留（第三批 4.3）
  const goPage = (set, opts) => patchUrl({ ...PAGE_RESET, ...(set || {}) }, { push: true, ...(opts || {}) });
  // 课件转换整页（?office=1），不用抽屉
  const ocOpen = searchParams.get('office') === '1';
  const courseParam = searchParams.get('course');
  const courseRef = courseParam ? { courseId: courseParam } : null;
  const isNewPage = searchParams.get('new') === '1';
  const pageView = courseParam && searchParams.get('view') === 'info' ? 'info' : 'outline';
  const setCourseRef = (v) => goPage(v ? { course: v.courseId } : null);
  const [bodyLang, setBodyLang] = useState('zh');
  const [sectionBase, setSectionBase] = useState('');
  const [moduleEdit, setModuleEdit] = useState(null); // { moduleId, title_zh, title, minutes }
  const [sectionEdit, setSectionEdit] = useState(null); // { moduleId, sectionId|null }
  const [sectionDraft, setSectionDraft] = useState(null);
  const [ckCourse, setCkCourse] = useState(null); // offline course being checked in
  const [asgCourse, setAsgCourse] = useState(null); // { c, w } course being assigned
  // drag-reorder: {kind:'mod'|'sec', moduleId, index} being dragged, and the row
  // currently under the pointer (so it can show where the drop will land)
  const [drag, setDrag] = useState(null);
  const [dropAt, setDropAt] = useState(null);

  const editingCourse = useMemo(
    () => (courseRef ? courses.find((c) => c.id === courseRef.courseId) || null : null),
    [courses, courseRef]);
  const editingWrapper = editingCourse ? wrapperOf[editingCourse.id] || null : null;
  const editFormData = (c) => ({
    ...c,
    desc_zh: c.description_zh, desc: c.description,
    validDays: c.defaultDueDays || 30,
    // 预计学习时长：课程本身不存分钟数，「约 N 分钟」= 各模块 minutes 之和。只有 1 个模块时在这里直接改（写回该模块）。
    minutes: (c.modules || []).length === 1 ? clampMinutes(c.modules[0].minutes) : undefined,
    status: c.status || 'draft',
    enrollType: c.enrollType || 'mandatory',
    mode: c.mode || 'online',
    trainerId: c.trainerId || undefined,
    hours: c.hours != null ? c.hours : undefined,
    public: publicOf(c),
  });
  const NEW_COURSE = useMemo(() => ({ status: 'draft', enrollType: 'mandatory', mode: 'online', validDays: 30, category: '', public: false }), []);
  const formSheet = useMemo(() => {
    if (isNewPage) return { mode: 'new', data: NEW_COURSE };
    if (editingCourse && pageView === 'info') return { mode: 'edit', data: editFormData(editingCourse) };
    return null;
  }, [isNewPage, editingCourse, pageView, NEW_COURSE]); // eslint-disable-line react-hooks/exhaustive-deps
  // 关闭课程信息表单：新建页回课程库；编辑时回到该课程的大纲
  const setFormSheet = (v) => {
    if (v) return;
    if (isNewPage) goPage(null);
    else if (courseParam) goPage({ course: courseParam });
  };
  // 小节是否有未保存的修改：与打开（或上次保存）时的快照比较
  const pickSec = (d) => JSON.stringify({
    title_zh: d.title_zh || '', title: d.title || '', body_zh: bodyToHtml(d.body_zh), body: bodyToHtml(d.body),
    videoUrl: d.videoUrl || '', video: d.video || '', att: (d.attachments || []).map((a) => a.id).join(','),
  });
  const sectionDirty = !!sectionDraft && pickSec(sectionDraft) !== sectionBase;
  const guard = (fn) => {
    if (!sectionDirty) { fn(); return; }
    Modal.confirm({ title: s.discardTitle, content: s.discardAsk, okText: s.discardOk, cancelText: s.cancel, okButtonProps: { type: 'danger' }, onOk: fn });
  };
  const closeSection = () => { setSectionEdit(null); setSectionDraft(null); setSectionBase(''); };
  // 换课程（或离开编辑器）时收起小节
  useEffect(() => { closeSection(); }, [courseParam]); // eslint-disable-line react-hooks/exhaustive-deps
  // ?course=<id> 深链：地址栏驱动（见 courseParam），不再需要单独的 effect

  // ---- generic mutation runner: call API, toast, refresh ----
  const runMut = async (fn, okMsg, onOk) => {
    try {
      await fn();
      if (okMsg) Toast.success({ content: okMsg, duration: 2 });
      if (onOk) onOk();
      reload();
    } catch (err) {
      // 服务端带 error_zh 的按界面语言显示（CX-035 视频链接等）
      const zh = err && err.data && typeof err.data === 'object' && err.data.error_zh;
      Toast.error({ content: (lang === 'zh' && zh) || (err && err.message) || String(err), duration: 4 });
    }
  };

  const putCourse = (course) =>
    api.put(`/api/admin/content/courses/${course.id}`, { ...serializeCourse(course), ...(REV.get(course.id) ? { updatedAt: REV.get(course.id) } : {}) })
      .then((r) => { if (r && r.updatedAt) REV.set(course.id, r.updatedAt); return r; });   // CX-042：保存后记住新的 updatedAt

  // ---- AI 翻译整门课程（2026-10-06）：只填目标语言还没有译文的字段，确认后写入 ----
  const { user } = useAuth();
  const sectionApi = useRef(null);
  const [trBusy, setTrBusy] = useState(false);
  const courseTrItems = (c, to) => {
    const from = to === 'en' ? 'zh' : 'en';
    const src = (o, k) => (from === 'zh' ? o[k + '_zh'] : o[k]);
    const dst = (o, k) => (to === 'zh' ? o[k + '_zh'] : o[k]);
    const items = [];
    const add = (key, o, k, html) => { const v = String(src(o, k) || ''); if (v.trim() && needsTranslation(dst(o, k), v, to)) items.push({ key, text: v, format: html ? 'html' : 'text' }); };
    add('c|title', c, 'title'); add('c|description', c, 'description');
    (c.modules || []).forEach((m, mi) => {
      add(`m|${mi}|title`, m, 'title');
      (m.sections || []).forEach((sec, si) => { add(`s|${mi}|${si}|title`, sec, 'title'); add(`s|${mi}|${si}|body`, sec, 'body', true); });
    });
    return items;
  };
  const translateCourse = (to) => {
    if (!editingCourse) return;
    const items = courseTrItems(editingCourse, to);
    if (!items.length) { Toast.info({ content: s.trNone, duration: 2 }); return; }
    Modal.confirm({
      title: s.trTitle(to), content: s.trConfirm(items.length), okText: s.trOk, cancelText: s.cancel,
      onOk: async () => {
        setTrBusy(true);
        try {
          const { map, demo } = await translateItems(items, to, editingCourse.id);
          const next = structuredClone(editingCourse);
          const k = (f) => (to === 'zh' ? f + '_zh' : f);
          for (const [key, text] of map) {
            const p = key.split('|');
            if (p[0] === 'c') next[k(p[1])] = text;
            else if (p[0] === 'm') next.modules[Number(p[1])][k(p[2])] = text;
            else if (p[0] === 's') next.modules[Number(p[1])].sections[Number(p[2])][k(p[3])] = text;
          }
          await runMut(() => putCourse(next), demo ? s.trDoneDemo : s.trDone(map.size));
        } catch (err) {
          Toast.error({ content: errText(err, aiErrMap(s)), duration: 3 });
        }
        setTrBusy(false);
      },
    });
  };

  // ---- course CRUD ----
  const openNewCourse = () => goPage({ new: '1' });
  const openEditCourse = (c) => goPage({ course: c.id, view: 'info' });
  // The API refuses to delete a course that projects reference or learners have
  // history on (409 + impact list) — turn that into a readable explanation with
  // "archive instead" as the way out.
  const deleteCourse = async (cid) => {
    try {
      await api.del(`/api/admin/content/courses/${cid}`);
      Toast.success({ content: s.deleted, duration: 2 });
      reload();
    } catch (err) {
      const u = err && err.data && err.data.usage;
      if (err && err.status === 409 && u) {
        const lines = [];
        if (u.projects.length) lines.push(s.delUseProjects(u.projects.map((p) => `${[lang === 'zh' ? (p.title_zh || p.title) : (p.title || p.title_zh), p.cohort].filter(Boolean).join(' · ')} (${s.nPeople(p.learners)})`).join(lang === 'zh' ? '、' : '; ')));
        if (u.learnersWithProgress) lines.push(s.delUseProgress(u.learnersWithProgress));
        if (u.attempts) lines.push(s.delUseAttempts(u.attempts));
        if (u.exams.length) lines.push(s.delUseExams(u.exams.length));
        Modal.warning({
          title: s.delBlockedTitle,
          content: (
            <div style={{ fontSize: 13, lineHeight: 1.8 }}>
              {lines.map((l, i) => <div key={i}>· {l}</div>)}
              <div style={{ marginTop: 10, color: 'var(--semi-color-text-2)' }}>{s.delBlockedHint}</div>
            </div>
          ),
          okText: s.delArchiveNow,
          cancelText: s.cancel,
          hasCancel: true,
          onOk: () => {
            const c = courses.find((x) => x.id === cid);
            if (c) runMut(() => putCourse({ ...c, status: 'archived' }), s.archivedOk);
          },
        });
      } else {
        Toast.error({ content: (err && err.message) || String(err), duration: 3 });
      }
    }
  };
  const publishCourse = (c) =>
    runMut(() => putCourse({ ...c, status: 'published' }), s.publishedOk);

  // ---- CX-032 课程包导出 / 导入（2026-10-09 验收，负责人拍板仍在范围）----
  // 导出：GET …/export 拿 JSON，存成 <课程名>.course.json。导入：读 .json → 先在前端认格式（不是课程包就不发请求）→
  // 同名课程先问是否改名 → POST …/import；附件与课件内视频不随包携带，结果里提示补传。
  const exportCourse = async (c) => {
    try {
      const pkg = await api.get(`/api/admin/content/courses/${encodeURIComponent(c.id)}/export`);
      const name = ((lang === 'zh' ? (c.title_zh || c.title) : (c.title || c.title_zh)) || c.id).replace(/[\\/:*?"<>|]+/g, '_');
      const url = URL.createObjectURL(new Blob([JSON.stringify(pkg, null, 2)], { type: 'application/json' }));
      const a = document.createElement('a'); a.href = url; a.download = `${name}.course.json`; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      Toast.success({ content: s.pkgExported, duration: 2 });
    } catch (e) { Toast.error({ content: (e && e.message) || s.loadError, duration: 3 }); }
  };
  const importRef = useRef(null);
  const importCourseFile = async (file) => {
    if (!file) return;
    let pkg = null;
    try { pkg = JSON.parse(await file.text()); } catch { pkg = null; }
    if (!pkg || typeof pkg !== 'object' || pkg.format !== 'tms-course' || !pkg.course || typeof pkg.course !== 'object') { Toast.error({ content: s.pkgBadFile, duration: 4 }); return; }
    const t0 = String(pkg.course.title || '').trim(), z0 = String(pkg.course.title_zh || '').trim();
    const dup = courses.some((x) => (z0 && (x.title_zh || '').trim() === z0) || (t0 && (x.title || '').trim() === t0));
    const doImport = async (title, title_zh) => {
      try {
        const r = await api.post('/api/admin/content/courses/import', { package: pkg, ...(title != null ? { title } : {}), ...(title_zh != null ? { title_zh } : {}) });
        const shown = lang === 'zh' ? (r.title_zh || r.title) : (r.title || r.title_zh);
        Toast.success({ content: s.pkgImported(shown, r.modules) + (r.attachmentsDropped ? ' ' + s.pkgDropped(r.attachmentsDropped) : ''), duration: 6 });
        reload();
      } catch (e) { Toast.error({ content: (e && e.data && (lang === 'zh' ? (e.data.error_zh || e.data.error) : e.data.error)) || (e && e.message) || s.loadError, duration: 4 }); }
    };
    if (!dup) return doImport();
    let nz = z0, ne = t0;
    Modal.confirm({
      title: s.pkgSameName,
      content: (
        <div>
          <p>{s.pkgSameNameBody}</p>
          <Input defaultValue={z0} placeholder={s.pkgNewTitleZh} onChange={(v) => { nz = v; }} />
          <Input style={{ marginTop: 8 }} defaultValue={t0} placeholder={s.pkgNewTitleEn} onChange={(v) => { ne = v; }} />
        </div>
      ),
      okText: s.pkgImportBtn, cancelText: s.cancel || 'Cancel',
      onOk: () => doImport(String(ne || '').trim(), String(nz || '').trim()),
    });
  };

  const submitForm = (values) => {
    // CX-036（2026-10-09 验收）：英文留空就留空（接口接受中英至少一个），显示层按语言回退；不再把中文复制进英文字段。
    const title = (values.title || '').trim();
    const titleZh = (values.title_zh || '').trim();
    if (!title && !titleZh) { Toast.warning({ content: s.reqTitle, duration: 2 }); return; }
    const shared = {
      title,
      title_zh: titleZh || null,
      description: (values.desc || '').trim() || null,
      description_zh: (values.desc_zh || '').trim() || null,
      category: normalizeCategoryInput(values.category),
      hours: clampHours(values.hours),
      enrollType: values.enrollType || 'mandatory',
      status: values.status || 'draft',
      defaultDueDays: clampDue(values.validDays),
      mode: values.mode === 'offline' ? 'offline' : 'online',
      sessionAt: values.mode === 'offline' && values.sessionAt ? fmtDT(values.sessionAt) : null,
      location: values.mode === 'offline' ? (values.location || '').trim() || null : null,
      sessionNote: values.mode === 'offline' ? (values.sessionNote || '').trim() || null : null,
      trainerId: values.mode === 'offline' ? (values.trainerId || null) : null,
      public: values.public === true,
    };
    if (formSheet.mode === 'new') {
      const course = { id: genId('course'), modules: [], ...shared };
      runMut(() => putCourse(course), s.savedCourse, () => goPage({ course: course.id }, { push: false }));
    } else {
      const next = { ...formSheet.data, ...shared };
      if (next.mode !== 'offline' && (next.modules || []).length === 1 && values.minutes != null)
        next.modules = [{ ...next.modules[0], minutes: clampMinutes(values.minutes) }];
      delete next.minutes;
      const save = () => runMut(() => putCourse(next), s.savedCourse, () => setFormSheet(null));
      // 第四批 7 / 9.2：已保存的公开课程取消公开 → 先确认影响人数再保存
      if (formSheet.data.public === true && next.public === false) { confirmPublicClose(next, save); return; }
      save();
    }
  };
  // 取消公开的确认窗（短操作 = 弹窗）：读影响人数（读不到也可以继续，规则不变）
  const confirmPublicClose = async (c, onOk) => {
    let imp = null;
    try { imp = impactOf(await api.get(`/api/admin/courses/${encodeURIComponent(c.id)}/public-impact`)); } catch { imp = null; }
    Modal.confirm({
      title: s.pubCloseTitle,
      content: (
        <div style={{ fontSize: 13, lineHeight: 1.8 }}>
          <div>{imp ? (imp.total > 0 ? s.pubCloseImpact(imp.total, imp.started, imp.notStarted, imp.done) : s.pubCloseNone(imp.done)) : s.pubCloseErr}</div>
          <div style={{ marginTop: 8, color: 'var(--semi-color-text-2)' }}>{s.pubClosePolicy}</div>
        </div>
      ),
      okText: s.pubCloseOk, cancelText: s.cancel, okButtonProps: { type: 'danger' }, onOk,
    });
  };

  // ---- module mutators (within courseRef) ----
  const addModule = () => {
    if (!editingCourse) return;
    const next = {
      ...editingCourse,
      modules: [...editingCourse.modules, { id: genId('m'), title_zh: '新模块', title: 'New module', minutes: 10, sections: [] }],
    };
    runMut(() => putCourse(next), s.savedCourse);
  };
  const moveModule = (i, dir) => {
    const next = { ...editingCourse, modules: move(editingCourse.modules, i, dir) };
    runMut(() => putCourse(next), s.savedCourse);
  };
  const dropModule = (to) => {
    if (!drag || drag.kind !== 'mod' || drag.index === to) return;
    const next = { ...editingCourse, modules: reorder(editingCourse.modules, drag.index, to) };
    runMut(() => putCourse(next), s.savedCourse);
  };
  const deleteModule = (mid) => {
    const next = { ...editingCourse, modules: editingCourse.modules.filter((m) => m.id !== mid) };
    runMut(() => putCourse(next), s.savedCourse);
  };
  const saveModuleName = (vals) => {
    const { moduleId } = moduleEdit;
    const title = (vals.title || '').trim();
    const titleZh = (vals.title_zh || '').trim();
    if (!title && !titleZh) { Toast.warning({ content: s.reqTitle, duration: 2 }); return; }
    const next = {
      ...editingCourse,
      modules: editingCourse.modules.map((m) => (m.id === moduleId ? { ...m, title_zh: titleZh || null, title, minutes: clampMinutes(vals.minutes) } : m)),
    };
    runMut(() => putCourse(next), s.savedCourse, () => setModuleEdit(null));
  };

  // ---- section mutators ----
  const withSections = (mid, fn) => ({
    ...editingCourse,
    modules: editingCourse.modules.map((m) => (m.id === mid ? { ...m, sections: fn(m.sections) } : m)),
  });
  const moveSection = (mid, i, dir) =>
    runMut(() => putCourse(withSections(mid, (secs) => move(secs, i, dir))), s.savedCourse);
  // Sections only reorder inside their own module — dragging one across modules
  // would move content between chapters, which is a copy/paste job, not a drag.
  const dropSection = (mid, to) => {
    if (!drag || drag.kind !== 'sec' || drag.moduleId !== mid || drag.index === to) return;
    runMut(() => putCourse(withSections(mid, (secs) => reorder(secs, drag.index, to))), s.savedCourse);
  };
  const deleteSection = (mid, sid) =>
    runMut(() => putCourse(withSections(mid, (secs) => secs.filter((x) => x.id !== sid))), s.savedCourse);

  const scrollToSectionEditor = () => {
    if (typeof window === 'undefined' || !window.matchMedia || !window.matchMedia('(max-width: 900px)').matches) return;
    setTimeout(() => { const el = document.querySelector('.co-se-page'); if (el) el.scrollIntoView({ block: 'start' }); }, 60);
  };
  const openNewSection = (mid) => guard(() => {
    if (pageView === 'info') goPage({ course: courseParam });
    const blank = { title_zh: '', title: '', body_zh: '', body: '', videoUrl: '', video: '', attachments: [], attach: '' };
    setSectionEdit({ moduleId: mid, sectionId: null });
    setSectionDraft(blank);
    setSectionBase(pickSec(blank));
    setBodyLang('zh');
    scrollToSectionEditor();
  });
  const openEditSection = (mid, sec, no) => guard(() => {
    if (pageView === 'info') goPage({ course: courseParam });
    setSectionEdit({ moduleId: mid, sectionId: sec.id, no });
    setSectionDraft({ ...sec });
    setSectionBase(pickSec(sec));
    setBodyLang('zh');
    scrollToSectionEditor();
  });
  const saveSection = () => {
    const { moduleId, sectionId } = sectionEdit;
    // CX-035（2026-10-09 验收）：非法地址不再静默丢弃 —— 不是 http(s) 的先拦下；来源白名单由服务端判（400 bad_video_url，中文提示）
    if (String(sectionDraft.videoUrl || '').trim() && !/^https?:\/\//i.test(String(sectionDraft.videoUrl).trim())) { Toast.error({ content: s.badVideoUrl, duration: 4 }); return; }
    // Paragraph-ize here rather than in serializeCourse: only the section HR just
    // edited is rewritten, so an unrelated module reorder never touches bodies.
    const draft = {
      ...sectionDraft,
      body: bodyToHtml(sectionDraft.body),
      body_zh: bodyToHtml(sectionDraft.body_zh),
    };
    // 整页编辑：保存后停留在这个小节（新小节拿到 id，之后再保存就是更新）
    const id = sectionId == null ? genId('s') : sectionId;
    const next = withSections(moduleId, (secs) =>
      sectionId == null
        ? [...secs, { ...draft, id }]
        : secs.map((x) => (x.id === sectionId ? { ...x, ...draft } : x)));
    runMut(() => putCourse(next), s.savedSection, () => {
      setSectionEdit((e) => (e ? { ...e, sectionId: id } : e));
      setSectionDraft({ ...draft, id });
      setSectionBase(pickSec({ ...draft, id }));
    });
  };

  // ---- final exam (real exams live in the exams table — edited on the Exams page) ----
  // 课程编辑器右栏与课程行 ⋯ 菜单都不再编辑考试规则（旧的 PUT content/programs/:id 写的是包装
  // 程序上的遗留字段，对真实考试不起作用），只保留「需要结业考试」开关和跳转。
  const examsPath = (w, extra) => `/admin/exams?program=${encodeURIComponent(w.id)}${extra || ''}`;
  const goExams = (w, examId) => nav(examsPath(w, examId ? `&edit=${encodeURIComponent(examId)}` : ''));
  const goNewExam = (w) => nav(examsPath(w, '&new=1'));
  // 开关显示值：有已发布考试 = 开；否则看包装程序上的 noExam（纯界面状态）。
  const examRequired = (w) => (examsOfProgram[w.id] || []).some((e) => e.status === 'published') || !w.noExam;
  const [examToggling, setExamToggling] = useState(false);
  const toggleExamRequired = async (w, required) => {
    if (!w || !canWrite) return;
    setExamToggling(true);
    try {
      const r = await api.post(`/api/admin/programs/${w.id}/exam-required`, { required });
      if (!required) Toast.success({ content: s.exOffOk, duration: 3 });
      else if (r && r.republished) Toast.success({ content: s.exRepubOk, duration: 3 });
      else if (r && r.needsExam) Toast.info({ content: lang === 'zh' ? (r.message_zh || r.message) : (r.message || r.message_zh), duration: 4 });
      else Toast.success({ content: s.exOnOk, duration: 2 });
      reload();
      examsQ.reload();
    } catch (err) {
      const d = (err && err.data) || {};
      const msg = (lang === 'zh' ? d.error_zh : d.error) || (err && err.message) || String(err);
      if (d.code === 'exam_in_project' || d.code === 'exam_shared') Modal.warning({ title: s.exInProjectTitle, content: msg, okText: s.cancel });
      else Toast.error({ content: msg, duration: 4 });
    } finally {
      setExamToggling(false);
    }
  };

  // Shape line under a course title: 模块 4 · 小节 11 · 约 48 分钟. An in-person
  // course has no per-module minutes to add up, so it carries its time & venue
  // there instead — that is what HR needs from the row.
  const courseShape = (c) => {
    const mods = c.modules.length;
    const secs = c.modules.reduce((n, m) => n + m.sections.length, 0);
    const mins = c.modules.reduce((n, m) => n + (Number(m.minutes) || 0), 0);
    const runs = [s.cModules(mods), s.cSections(secs)];
    if ((c.mode || 'online') === 'offline') {
      return (
        <>
          <span>{runs.join(' · ')}</span>
          <span className="co-dot">·</span>
          <span>
            <IconMapPin size="small" style={{ verticalAlign: '-2px' }} />{' '}
            {c.sessionAt ? c.sessionAt.replace('T', ' ') : s.tbd}
            {c.location ? ` · ${c.location}` : ''}
          </span>
        </>
      );
    }
    if (mins > 0) runs.push(s.cMinutes(mins));
    return <span>{runs.join(' · ')}</span>;
  };

  // ---- 只读档打开 ?new=1（2026-10-07 QA RO1）：新建是写操作，回到课程库并说明原因 ----
  useEffect(() => {
    if (!isNewPage || canWrite) return;
    goPage(null, { push: false });
    Toast.warning({ content: s.roNew, duration: 4 });
  }, [isNewPage, canWrite]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- 批量发布 / 下线 / 改分类（2026-10-07 B5，components/BulkActions.jsx）----
  // 第三批 10.3：课程库改为分页表格（一行一门课），挂 wrapRef：表头全选只选当前页。换筛选或搜索词即清空勾选。
  // 这些 hook 必须写在下面 isNewPage / courseParam 的提前返回之前。
  const sel = useBulkSelection({ rows: visible, resetOn: [fStatus, fKind, query, urlp.cat || '', fEnroll, fMode, fPub], ready: !!data });
  const runner = useBulkRunner();
  // 列表分页 / 排序：整页编辑器卸载列表后回来、或保存后重载时，按记住的页码与排序复原（与题库同一做法）
  const listVer = useDataVersion(data);
  const [listPage, setListPage] = useState(1);
  const [listSize, setListSize] = useState(LIST_PAGE_TIERS[0]);
  const [listSort, setListSort] = useState(null); // { dataIndex, sortOrder } | null
  const [bulkOp, setBulkOp] = useState(null);        // 'publish' | 'archive' | 'category' | null
  const [bulkSnap, setBulkSnap] = useState(null);    // { ids, list: [名称], names: { id: 名称 }, empty }
  const [bulkCat, setBulkCat] = useState(undefined);
  // 发布时服务端跳过的空课程（线上、0 个模块、没有已发布的考试；G3 empty_course）—— 确认窗先按同一口径数出来
  const isEmptyCourse = (c) => (c.mode || 'online') !== 'offline' && (c.modules || []).length === 0
    && !((wrapperOf[c.id] && examsOfProgram[wrapperOf[c.id].id]) || []).some((e) => e.status === 'published');
  const bulkLabel = (op) => (op === 'publish' ? s.bulkPublish : op === 'archive' ? s.bulkArchive : op === 'publicOn' ? s.bulkPublicOn : op === 'publicOff' ? s.bulkPublicOff : s.bulkCategory);
  const openBulk = (op) => {
    const picked = sel.rows;
    if (!picked.length) return;
    const names = {};
    picked.forEach((c) => { names[String(c.id)] = loc(c, 'title') || c.id; });
    setBulkSnap({
      ids: picked.map((c) => String(c.id)),
      list: picked.map((c) => loc(c, 'title') || c.id),
      names,
      empty: picked.filter((c) => statusOf(c) !== 'published' && isEmptyCourse(c)).length,
      selfTotal: picked.reduce((n, c) => n + (selfCountOf[c.id] || 0), 0),
    });
    setBulkCat(undefined);
    setBulkOp(op);
  };
  const submitBulk = async () => {
    if (!bulkSnap || !bulkOp) return;
    const op = bulkOp;
    await runner.run({
      op: bulkLabel(op), names: bulkSnap.names,
      // 第四批 7：设为公开 / 取消公开 = op 'public' + value（服务端按课程逐门处理待审批申请与 9.2 规则）
      request: () => api.post('/api/admin/content/bulk-update', op === 'publicOn' || op === 'publicOff'
        ? { op: 'public', ids: bulkSnap.ids, value: op === 'publicOn' }
        : { op, ids: bulkSnap.ids, ...(op === 'category' ? { category: normalizeCategoryInput(bulkCat) } : {}) }),
      doneText: (r) => (r && r.syncedMembers ? s.bulkSynced(r.done, r.syncedMembers) : null),
      onSettled: () => { sel.clear(); reload(); },
    });
    setBulkOp(null);
  };

  // ---------- 课程信息表单的字段（新建整页与编辑器「课程信息」共用） ----------
  // 第三批 8.5 表单页宽度规范：桌面端两栏 —— 左「基本信息」（名称、简介，长文本限舒适行宽），右「课程设置」
  // （授课方式、修读类型、类别、学时、状态、期限）。两栏由容器宽度决定（app.css .co-form2 的容器查询），
  // 编辑器中间栏窄时、手机上自动回到单栏。只读档：Form 级 disabled，不给 AI 翻译。
  const renderCourseFields = (formApi, values) => {
    const mods = (formSheet && formSheet.mode === 'edit' && formSheet.data.modules) || [];
    const offline = values.mode === 'offline';
    const catKey = normalizeCategoryInput(values.category);
    const autoHours = round1(mods.reduce((n, m) => n + (Number(m.minutes) || 0), 0) / 60);
    return (
      <div className="co-form2-grid">
        <section className="co-form2-col co-form2-main" aria-label={s.fmSecBasic}>
          <h3 className="co-form2-h">{s.fmSecBasic}</h3>
          {canWrite && <div className="ai-tr-row"><AiTranslateButton formApi={formApi} refId={formSheet && formSheet.data && formSheet.data.id} pairs={[{ zh: 'title_zh', en: 'title' }, { zh: 'desc_zh', en: 'desc' }]} /></div>}
          <Form.Input field="title_zh" label={s.fTitleZh} placeholder={s.phTitleZh} />
          <Form.Input field="title" label={s.fTitleEn} placeholder={s.phTitleEn} />
          <Form.TextArea field="desc_zh" label={s.fDescZh} placeholder={s.phDescZh} autosize={{ minRows: 3, maxRows: 12 }} rows={3} />
          <Form.TextArea field="desc" label={s.fDescEn} placeholder={s.phDescEn} autosize={{ minRows: 3, maxRows: 12 }} rows={3} />
        </section>
        <section className="co-form2-col co-form2-side" aria-label={s.fmSecSettings}>
          <h3 className="co-form2-h">{s.fmSecSettings}</h3>
          <Form.Select field="mode" label={s.fMode} style={{ width: '100%' }} extraText={s.fModeHint}>
            <Form.Select.Option value="online">{s.modeOnline}</Form.Select.Option>
            <Form.Select.Option value="offline">{s.modeOffline}</Form.Select.Option>
          </Form.Select>
          {offline && (
            <>
              {/* `format` makes a TYPED value parse and commit — without it
                  Semi only accepts a pick from the panel and silently drops
                  anything HR typed by hand. */}
              <Form.DatePicker
                field="sessionAt" type="dateTime" label={s.fSessionAt}
                format="yyyy-MM-dd HH:mm" style={{ width: '100%' }}
                placeholder={s.phSessionAt}
              />
              <Form.Input field="location" label={s.fLocation} placeholder={s.phLocation} />
              <Form.TextArea field="sessionNote" label={s.fSessionNote} placeholder={s.phSessionNote} autosize rows={2} />
              <Form.Select field="trainerId" label={s.fTrainer} extraText={s.fTrainerHint} filter showClear style={{ width: '100%' }}
                optionList={(rosterQ.data || []).filter((r) => r.active).map((r) => ({ label: `${r.name}（${r.employeeId}）`, value: r.id }))} />
            </>
          )}
          <Form.Select field="enrollType" label={s.fEnroll} style={{ width: '100%' }} extraText={s.fEnrollHint}>
            <Form.Select.Option value="mandatory">{s.enrollMandatoryFull}</Form.Select.Option>
            <Form.Select.Option value="elective">{s.enrollElectiveFull}</Form.Select.Option>
          </Form.Select>
          {/* 第四批 7：公开课程（与必修 / 选修相互独立）；取消勾选已保存的公开课程时，保存前先确认影响人数 */}
          <Form.Checkbox field="public" noLabel className="co-pub-check"
            extraText={<>{s.fPublicHint}{values.public && values.enrollType === 'elective' ? <><br />{s.fPublicElective}</> : null}</>}>
            {s.fPublic}
          </Form.Checkbox>
          {/* 类别（第三批 5.5）：标签按语言、值是中文键；手输的英文标签保存时归一回中文键（Compliance → 合规）；
              不在标准目录里的新类别给出提示（看板会单独成列），不拦截 */}
          <Form.Select
            field="category" label={s.fCategory} placeholder={s.phCategory}
            style={{ width: '100%' }} filter allowCreate showClear
            optionList={categoryOpts}
            extraText={isCustomCategory(catKey) ? s.fCatCustom : undefined}
          />
          {/* 学时（第三批 1.2 / 5.5）：0–999 小时，步长 0.5；线上留空 = 按模块时长合计，线下用于人均学时统计 */}
          <Form.InputNumber
            field="hours" label={s.fHours} min={0} max={999} step={0.5} precision={1} style={{ width: '100%' }}
            extraText={offline ? s.fHoursOffline : s.fHoursOnline(autoHours)}
          />
          <Form.Select field="status" label={s.fStatus} style={{ width: '100%' }} extraText={s.fStatusHint}>
            <Form.Select.Option value="published">{s.stPublished}</Form.Select.Option>
            <Form.Select.Option value="draft">{s.stDraft}</Form.Select.Option>
            <Form.Select.Option value="archived">{s.stArchived}</Form.Select.Option>
          </Form.Select>
          <Form.InputNumber
            field="validDays" label={s.fValid} min={1} max={365} style={{ width: '100%' }}
            extraText={s.fValidHint}
          />
          {!offline && (mods.length === 1 ? (
            <Form.InputNumber field="minutes" label={s.fMinutes} min={1} max={600} precision={0} style={{ width: '100%' }} extraText={s.fMinutesOne} />
          ) : (
            <div className="semi-form-field" style={{ paddingTop: 12 }}>
              <div className="semi-form-field-label-text" style={{ fontWeight: 600, marginBottom: 4 }}>{s.fMinutes}</div>
              <div style={{ fontSize: 13, color: 'var(--semi-color-text-2)' }}>{mods.length ? s.fMinutesSum(moduleMinutes({ modules: mods }), mods.length) : s.fMinutesNew}</div>
            </div>
          ))}
        </section>
      </div>
    );
  };

  // ---------- 新建课程（整页）：只读档不进（见上面的 effect） ----------
  if (ocOpen) {
    return (
      <div className="co-wrap">
        <OfficeConvertSheet
          canWrite={canWrite}
          initial={oc.data}
          onChanged={oc.reload}
          onClose={() => { goPage(null); oc.reload(); }}
        />
      </div>
    );
  }
  if (isNewPage && canWrite) {
    return (
      <div className="wrap co-wrap co-page">
        <div className="co-page-bar">
          <Button theme="borderless" icon={<IconArrowLeft />} onClick={() => goPage(null)}>{s.ceBack}</Button>
          <div className="co-page-titles"><h1 className="co-page-title">{s.fmCourseNew}</h1></div>
        </div>
        <div className="card co-ed-card co-formpage co-form2">
          <Form
            key={(formSheet.data && formSheet.data.id) || 'new-course'}
            initValues={formSheet.data}
            onSubmit={submitForm}
          >
            {({ formApi, values }) => (
              <>
                {renderCourseFields(formApi, values)}
                <div className="co-sheet-foot">
                  <Button theme="borderless" onClick={() => setFormSheet(null)}>{s.cancel}</Button>
                  <Button theme="solid" type="primary" onClick={() => formApi.submitForm()}>{s.save}</Button>
                </div>
              </>
            )}
          </Form>
        </div>
      </div>
    );
  }

  // ---------- 课程编辑器（整页）：左大纲 · 中间小节 / 课程信息 · 右预览与考试 ----------
  if (courseParam) {
    if (!editingCourse) {
      return (
        <div className="wrap co-wrap co-page">
          <div className="co-page-bar">
            <Button theme="borderless" icon={<IconArrowLeft />} onClick={() => goPage(null)}>{s.ceBack}</Button>
          </div>
          <div className="card co-emptycard" style={{ textAlign: 'center', padding: '48px 0' }}>
            {loading && !data ? <Spin size="large" tip={s.loading} /> : <Empty title={s.edNotFound} />}
          </div>
        </div>
      );
    }
    const edStatus = statusOf(editingCourse);
    const edMeta = STATUS_META[edStatus] || STATUS_META.draft;
    const sectionTitle = !sectionEdit ? '' : sectionEdit.sectionId == null ? s.seNew
      : [sectionEdit.no ? s.seNo(sectionEdit.no) : s.seEdit, sectionDraft && loc(sectionDraft, 'title')].filter(Boolean).join(' · ');
    return (
      <div className="wrap co-wrap co-page co-editor">
        <div className="co-page-bar">
          <Button theme="borderless" icon={<IconArrowLeft />} onClick={() => guard(() => { closeSection(); goPage(null); })}>{s.ceBack}</Button>
          <div className="co-page-titles">
            <h1 className="co-page-title" title={loc(editingCourse, 'title')}>{loc(editingCourse, 'title')}</h1>
            <div className="co-page-sub">{courseShape(editingCourse)}</div>
            <ProjectTags s={s} loc={loc} lang={lang} list={projectsOf[editingCourse.id]} />
          </div>
          <Tag color={edMeta.color} type="light">{s[edMeta.key]}</Tag>
          {(editingCourse.mode || 'online') === 'offline' && <Tag color="orange" type="light">{s.modeOffline}</Tag>}
          <span className="co-ce-auto">{canWrite ? s.ceAutosave : s.roWrite}</span>
          {canWrite && aiTranslateOn(user) && (
            <Dropdown trigger="click" position="bottomRight" clickToHide render={(
              <Dropdown.Menu>
                <Dropdown.Item onClick={() => translateCourse('en')}>{s.trToEn}</Dropdown.Item>
                <Dropdown.Item onClick={() => translateCourse('zh')}>{s.trToZh}</Dropdown.Item>
              </Dropdown.Menu>
            )}>
              <Button theme="light" loading={trBusy} className="ai-tr-btn">{trBusy ? s.trBusy : s.trCourse}</Button>
            </Dropdown>
          )}
          {canWrite && edStatus === 'draft' && <Button theme="solid" type="primary" onClick={() => publishCourse(editingCourse)}>{s.publishNow}</Button>}
          <Button theme={pageView === 'info' ? 'solid' : 'light'} icon={<IconSetting />}
            onClick={() => guard(() => { closeSection(); goPage({ course: courseParam, view: 'info' }); })}>{s.edInfo}</Button>
        </div>
        {(editingCourse.mode || 'online') === 'offline' && <div className="co-offline-note">{s.ceOffline}</div>}
        <div className="co-ed-grid">
          <aside className="co-ed-outline">
            <div className="co-ce-h">
              <div>
                <h3 className="co-ce-htitle">{s.ceModules}</h3>
                <div className="co-ce-hint">{canWrite ? s.ceModulesHint : s.ceModulesHintRo}</div>
              </div>
              {canWrite && <Button theme="light" size="small" icon={<IconPlus />} onClick={addModule}>{s.addModule}</Button>}
            </div>
                {editingCourse.modules.map((m, mi) => (
                  <div className="co-mod" key={m.id}>
                    {/* Grab anywhere on the header row; the ⋮⋮ says so. The arrows
                        stay — they are the keyboard path to the same reorder. */}
                    <div
                      className={'co-mod-h'
                        + (drag && drag.kind === 'mod' && drag.index === mi ? ' co-dragging' : '')
                        + (dropAt === `mod:${mi}` ? ' co-dropping' : '')}
                      draggable={canWrite}
                      onDragStart={(e) => {
                        setDrag({ kind: 'mod', index: mi });
                        e.dataTransfer.effectAllowed = 'move';
                        e.dataTransfer.setData('text/plain', m.id); // Firefox needs a payload
                      }}
                      onDragEnd={() => { setDrag(null); setDropAt(null); }}
                      onDragOver={(e) => {
                        if (!drag || drag.kind !== 'mod' || drag.index === mi) return;
                        e.preventDefault();
                        setDropAt(`mod:${mi}`);
                      }}
                      onDragLeave={() => setDropAt((v) => (v === `mod:${mi}` ? null : v))}
                      onDrop={(e) => { e.preventDefault(); setDropAt(null); dropModule(mi); setDrag(null); }}
                    >
                      {canWrite && <span className="co-grip" aria-hidden>⋮⋮</span>}
                      <span className="co-mod-idx tnum">{mi + 1}</span>
                      <span className="co-mod-name" title={loc(m, 'title')}>{loc(m, 'title')}</span>
                      <span className="co-mod-count">{s.sectionsN(m.sections.length)}</span>
                      {canWrite && (<span className="co-mod-act">
                        <IconBtn icon={<IconArrowUp />} label={s.moveUp} disabled={mi === 0} onClick={() => moveModule(mi, -1)} />
                        <IconBtn icon={<IconArrowDown />} label={s.moveDown} disabled={mi === editingCourse.modules.length - 1} onClick={() => moveModule(mi, 1)} />
                        <IconBtn icon={<IconEdit />} label={s.rename} onClick={() => setModuleEdit({ moduleId: m.id, title_zh: m.title_zh, title: m.title, minutes: m.minutes })} />
                        <Popconfirm title={s.delModuleTitle} content={s.delModuleAsk} okType="danger" onConfirm={() => deleteModule(m.id)}>
                          <span><IconBtn icon={<IconDelete />} label={s.del} danger /></span>
                        </Popconfirm>
                      </span>)}
                    </div>

                    <div className="co-seclist">
                      {m.sections.length === 0 && <div className="co-nosec">{s.emptySections}</div>}
                      {m.sections.map((sec, si) => (
                        <div
                          className={'co-sec' + (sectionEdit && sectionEdit.sectionId === sec.id ? ' on' : '')
                            + (drag && drag.kind === 'sec' && drag.moduleId === m.id && drag.index === si ? ' co-dragging' : '')
                            + (dropAt === `sec:${m.id}:${si}` ? ' co-dropping' : '')}
                          key={sec.id}
                          draggable={canWrite}
                          onDragStart={(e) => {
                            setDrag({ kind: 'sec', moduleId: m.id, index: si });
                            e.dataTransfer.effectAllowed = 'move';
                            e.dataTransfer.setData('text/plain', sec.id);
                          }}
                          onDragEnd={() => { setDrag(null); setDropAt(null); }}
                          onDragOver={(e) => {
                            if (!drag || drag.kind !== 'sec' || drag.moduleId !== m.id || drag.index === si) return;
                            e.preventDefault();
                            setDropAt(`sec:${m.id}:${si}`);
                          }}
                          onDragLeave={() => setDropAt((v) => (v === `sec:${m.id}:${si}` ? null : v))}
                          onDrop={(e) => { e.preventDefault(); setDropAt(null); dropSection(m.id, si); setDrag(null); }}
                        >
                          {canWrite && <span className="co-grip co-grip-sec" aria-hidden>⋮⋮</span>}
                          <button className="co-sec-main" onClick={() => openEditSection(m.id, sec, `${mi + 1}.${si + 1}`)}>
                            <span className="co-sec-no tnum">{mi + 1}.{si + 1}</span>
                            {/* 第三批 5.5：视频 / 附件标记改成小图标，放在小节名下方一行，不再挤占名称 */}
                            <span className="co-sec-text">
                              <span className="co-sec-name" title={loc(sec, 'title')}>{loc(sec, 'title')}</span>
                              <SecMarks s={s} sec={sec} />
                            </span>
                          </button>
                          {canWrite && (<span className="co-sec-act">
                            <IconBtn icon={<IconArrowUp />} label={s.moveUp} disabled={si === 0} onClick={() => moveSection(m.id, si, -1)} />
                            <IconBtn icon={<IconArrowDown />} label={s.moveDown} disabled={si === m.sections.length - 1} onClick={() => moveSection(m.id, si, 1)} />
                            <IconBtn icon={<IconEdit />} label={s.rename} onClick={() => openEditSection(m.id, sec, `${mi + 1}.${si + 1}`)} />
                            <Popconfirm title={s.del} content={s.delModuleAsk} okType="danger" onConfirm={() => deleteSection(m.id, sec.id)}>
                              <span><IconBtn icon={<IconDelete />} label={s.del} danger /></span>
                            </Popconfirm>
                          </span>)}
                        </div>
                      ))}
                      {canWrite && (
                        <button className="co-addsec" onClick={() => openNewSection(m.id)}>
                          <IconPlus /> {s.addSection}
                        </button>
                      )}
                    </div>
                  </div>
                ))}
          </aside>
          <main className="co-ed-main">
            {pageView === 'info' ? (
              <div className="card co-ed-card co-form2">
                <h2 className="co-ed-h">{canWrite ? s.fmCourseEdit : s.edInfo}</h2>
                {formSheet && (
          // 只读档：整张表单置灰（Form 级 disabled 下发到每个字段），不给 AI 翻译与保存
          <Form
            key={(formSheet.data && formSheet.data.id) || 'new-course'}
            initValues={formSheet.data}
            onSubmit={submitForm}
            disabled={!canWrite}
          >
            {({ formApi, values }) => (
              <>
                {renderCourseFields(formApi, values)}
                <div className="co-sheet-foot">
                  <Button theme="borderless" onClick={() => setFormSheet(null)}>{canWrite ? s.cancel : s.close}</Button>
                  {canWrite && <Button theme="solid" type="primary" onClick={() => formApi.submitForm()}>{s.save}</Button>}
                </div>
              </>
            )}
          </Form>
                )}
              </div>
            ) : sectionDraft ? (
              <div className="card co-ed-card co-se co-se-page">
                <div className="co-ed-hrow">
                  <h2 className="co-ed-h">{sectionTitle}</h2>
                  {sectionDirty && <span className="pill warn">{s.unsaved}</span>}
                </div>
            <div className="co-se-form">
              <Form
                key={(sectionEdit.moduleId) + (sectionEdit.sectionId || 'new')}
                initValues={sectionDraft}
                getFormApi={(a) => { sectionApi.current = a; }}
                disabled={!canWrite}
                // Semi's form values carry every initValues key, including the
                // upload-owned video / attachments / attach — snapshotted when the
                // sheet opened. Spreading all of them back wiped a fresh upload on
                // the next keystroke, so only the real form fields merge here.
                onValueChange={(vals) => setSectionDraft((d) => ({
                  ...d,
                  title_zh: vals.title_zh, title: vals.title,
                  videoUrl: vals.videoUrl,
                }))}
              >
                {canWrite && <div className="ai-tr-row"><AiTranslateButton formApi={sectionApi} refId={courseRef && courseRef.courseId} pairs={[{ zh: 'title_zh', en: 'title' }]}
                  extra={{
                    // 正文在本地状态里（RichText），一并翻译
                    get: (from, to, ow) => {
                      const src = from === 'zh' ? sectionDraft.body_zh : sectionDraft.body;
                      const dst = to === 'zh' ? sectionDraft.body_zh : sectionDraft.body;
                      return src && String(src).trim() && (ow || needsTranslation(dst, src, to)) ? [{ key: 'body', text: bodyToHtml(src), format: 'html' }] : [];
                    },
                    set: (map, to) => { if (map.has('body')) { setSectionDraft((d) => ({ ...d, [to === 'zh' ? 'body_zh' : 'body']: map.get('body') })); setBodyLang(to); } },
                  }} /></div>}
                <Form.Input field="title_zh" label={s.seTitleZh} />
                <Form.Input field="title" label={s.seTitleEn} />
                {/* 正文：所见即所得（2026-10-06）—— 中文 / English 两个页签，各一份 HTML */}
                <div className="co-body-tabs" role="tablist">
                  <button type="button" role="tab" aria-selected={bodyLang === 'zh'} className={'ppl-chip' + (bodyLang === 'zh' ? ' on' : '')} onClick={() => setBodyLang('zh')}>{s.bodyZhTab}</button>
                  <button type="button" role="tab" aria-selected={bodyLang === 'en'} className={'ppl-chip' + (bodyLang === 'en' ? ' on' : '')} onClick={() => setBodyLang('en')}>{s.bodyEnTab}</button>
                  {bodyLang === 'en' && <span className="co-ce-hint">{s.bodyEnHint}</span>}
                </div>
                <RichText
                  key={(sectionEdit.moduleId) + (sectionEdit.sectionId || 'new') + bodyLang}
                  value={bodyToHtml(bodyLang === 'zh' ? sectionDraft.body_zh : sectionDraft.body)}
                  onChange={(html) => setSectionDraft((d) => ({ ...d, [bodyLang === 'zh' ? 'body_zh' : 'body']: html }))}
                  readOnly={!canWrite}
                  placeholder={s.bodyPh}
                />

                {/* Video and attachment are two different jobs and used to share
                    one upload slot — a handout replaced the lesson video. The
                    video file goes to public/videos (played inline), the handout
                    stays a protected attachment. */}
                <div className="co-se-media">
                  <div className="co-se-medialab">{s.seVideoBlock}</div>
                  <div className="co-se-mediahint">{s.seVideoHint}</div>
                  {/* 上传视频 = POST /api/admin/upload-video(矩阵 1985 · 培训域写),只读档收起。 */}
                  {canWrite && (
                    <VideoUpload
                      key={(sectionEdit.moduleId) + (sectionEdit.sectionId || 'new')}
                      label={s.seVideoUp}
                      value={sectionDraft.video}
                      failMsg={s.uploadFail}
                      onDone={(url) => setSectionDraft((d) => ({ ...d, video: url }))}
                    />
                  )}
                  <div className="co-se-mediahint co-se-mediahint2">{s.seVideoPaste}</div>
                  <Form.Input
                    field="videoUrl" label={s.seVideoUrl} placeholder={s.phVideoUrl}
                    prefix={<IconLink />}
                  />
                </div>

                <div className="co-se-media">
                  <div className="co-se-medialab">{s.seAttachBlock}</div>
                  <div className="co-se-mediahint">{s.seAttachHint}</div>
                  {/* 转换组件不可用时 PPT / Word / Excel 会被服务端拒收（P0 1.3），先说清楚，并从选择框里去掉这几种扩展名。 */}
                  {canWrite && !officeOk && <Banner type="warning" fullMode={false} closeIcon={null} description={s.seOfficeOff} style={{ marginBottom: 10 }} />}
                  {/* 上传课件 = POST /api/admin/attachments(培训域写),只读档收起。 */}
                  {canWrite && (
                    <SectionUpload
                      label={s.seUpload}
                      courseId={courseRef && courseRef.courseId}
                      value={sectionDraft.attach}
                      officeOk={officeOk}
                      failMsg={s.uploadFail}
                      onAttach={(att) => setSectionDraft((d) => ({ ...d, attachments: [att], attach: att.name }))}
                      onClear={() => setSectionDraft((d) => ({ ...d, attachments: [], attach: '' }))}
                    />
                  )}
                  {sectionDraft.attachments && sectionDraft.attachments[0] && (
                    <DeckMedia key={sectionDraft.attachments[0].id} s={s} lang={lang} att={sectionDraft.attachments[0]}
                      onOpenOffice={() => guard(() => { closeSection(); goPage({ office: '1' }); })} />
                  )}
                </div>
              </Form>
            </div>

                <div className="co-se-foot">
                  <Button theme="borderless" onClick={() => guard(closeSection)}>{canWrite ? s.cancel : s.close}</Button>
                  {canWrite && <Button theme="solid" type="primary" onClick={saveSection}>{s.save}</Button>}
                </div>
              </div>
            ) : (
              <div className="card co-ed-card co-ed-empty">{canWrite ? s.edEmpty : s.edEmptyRo}</div>
            )}
          </main>
          <aside className="co-ed-side">
            {/* 第四批 7：公开状态与自主学习人数（只读；在「课程信息」里勾选「公开课程」） */}
            {(publicOf(editingCourse) || (selfCountOf[editingCourse.id] || 0) > 0) && (
              <div className="co-ce-rail co-pub-rail">
                <h3 className="co-ce-htitle">{s.fPublic}</h3>
                <div className="co-ce-hint">{publicOf(editingCourse) ? s.pubRailOn : s.pubRailOff}</div>
                <div className="co-pub-n tnum">{s.selfCountN(selfCountOf[editingCourse.id] || 0)}</div>
              </div>
            )}
            {sectionDraft && pageView !== 'info' && (
              <div className="co-se">
            {/* live learner preview */}
            <div className="co-se-preview">
              <div className="co-se-plab">{s.sePreview}</div>
              <div className="co-se-pcard">
                {(loc(sectionDraft, 'title') || loc(sectionDraft, 'body')) ? (
                  <>
                    <div className="co-pv-title">{loc(sectionDraft, 'title') || '—'}</div>
                    {(sectionDraft.videoUrl || sectionDraft.video) && (
                      <div className="co-pv-video">
                        <div className="co-pv-play" aria-hidden>
                          <svg viewBox="0 0 24 24" className="ic"><path d="M8 5v14l11-7z" fill="currentColor" stroke="none" /></svg>
                        </div>
                        <span className="co-pv-vurl">{sectionDraft.videoUrl || sectionDraft.video}</span>
                      </div>
                    )}
                    {/* Same paragraph pass and same language fallback the learner
                        gets, so both promises in the body labels are visible here
                        before HR commits. */}
                    <div
                      className="co-pv-body prose"
                      dangerouslySetInnerHTML={{
                        __html: sanitize(bodyToHtml(lang === 'zh'
                          ? (sectionDraft.body_zh || sectionDraft.body)
                          : (sectionDraft.body || sectionDraft.body_zh))),
                      }}
                    />
                    {sectionDraft.attach && (
                      <div className="co-pv-attach">
                        <IconFile />
                        <span className="co-pv-fn">{sectionDraft.attach}</span>
                      </div>
                    )}
                  </>
                ) : (
                  <div className="co-pv-empty">{s.sePreviewEmpty}</div>
                )}
              </div>
            </div>

              </div>
            )}
              {editingWrapper && (editingCourse.mode || 'online') !== 'offline' && (() => {
                const w = editingWrapper;
                const list = examsOfProgram[w.id] || [];
                const required = examRequired(w);
                const shown = required ? list.filter((e) => e.status !== 'archived') : list;
                const stTag = (st) => {
                  const m = STATUS_META[st] || STATUS_META.draft;
                  return <Tag color={m.color} type="light" size="small">{s[m.key]}</Tag>;
                };
                const row = (label, value) => (
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 13, padding: '3px 0' }}>
                    <span style={{ color: 'var(--ink-3)' }}>{label}</span>
                    <span className="tnum" style={{ textAlign: 'right' }}>{value}</span>
                  </div>
                );
                return (
                  <aside className="co-ce-rail">
                    <h3 className="co-ce-htitle">{s.exTitle}</h3>
                    {(w.courseIds || []).length > 1 && <div className="co-ce-hint co-ex-pkg">{s.exPackage(loc(w, 'title'), w.courseIds.length)}</div>}
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 10 }}>
                      <span style={{ fontSize: 13, fontWeight: 600 }}>{s.exRequired}</span>
                      <Switch
                        checked={required}
                        loading={examToggling}
                        disabled={!canWrite || examToggling || !examsQ.data}
                        onChange={(v) => toggleExamRequired(w, v)}
                        aria-label={s.exRequired}
                      />
                    </div>
                    {!required && <div className="co-ce-hint" style={{ marginBottom: 10 }}>{s.exOffHint}</div>}
                    {required && shown.length === 0 && (
                      <>
                        <div className="co-ce-hint" style={{ marginBottom: 10 }}>{s.exNone}</div>
                        {canWrite && (
                          <Button theme="solid" type="primary" size="small" className="co-ce-railsave" icon={<IconPlus />} onClick={() => goNewExam(w)}>
                            {s.exCreate}
                          </Button>
                        )}
                      </>
                    )}
                    {shown.map((e) => (
                      <div key={e.id} style={{ border: '1px solid var(--line, rgba(0,0,0,.08))', borderRadius: 8, padding: '10px 12px', marginBottom: 10 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
                          <b style={{ fontSize: 13, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
                            {lang === 'zh' ? (e.title_zh || e.title) : (e.title || e.title_zh)}
                          </b>
                          {stTag(e.status)}
                        </div>
                        {row(s.exBank, s.exBankV((e.poolObjective || 0) + (e.poolOpen || 0), e.mcqCount || 0, e.openCount || 0))}
                        {row(s.exPass, `${e.passingScore}%`)}
                        {row(s.exTime, e.timeLimitMinutes ? s.exMin(e.timeLimitMinutes) : s.exNoLimit)}
                        {row(s.exAttempts, e.maxAttempts ? e.maxAttempts : s.exUnlimited)}
                        {row(s.exShowAnswers, e.showAnswersAfterExam !== false ? s.exYes : s.exNo)}
                        <Button theme="borderless" size="small" style={{ marginTop: 4, paddingLeft: 0 }} onClick={() => goExams(w, e.id)}>
                          {canWrite ? s.exGoEdit : s.exGoView}
                        </Button>
                      </div>
                    ))}
                    <div className="co-ce-hint">{canWrite ? s.exReadOnlyHint : s.roWrite}</div>
                  </aside>
                );
              })()}
          </aside>
        </div>
      {/* ---------- module rename modal ---------- */}
      <Modal
        title={s.renameModule}
        visible={!!moduleEdit}
        onCancel={() => setModuleEdit(null)}
        footer={null}
        width={420}
      >
        {moduleEdit && (
          <Form initValues={{ title_zh: moduleEdit.title_zh, title: moduleEdit.title, minutes: clampMinutes(moduleEdit.minutes) }} onSubmit={saveModuleName}>
            {({ formApi }) => (
              <>
                <div className="ai-tr-row"><AiTranslateButton formApi={formApi} refId={courseRef && courseRef.courseId} pairs={[{ zh: 'title_zh', en: 'title' }]} /></div>
                <Form.Input field="title_zh" label={s.mrTitleZh} />
                <Form.Input field="title" label={s.mrTitleEn} />
                <Form.InputNumber field="minutes" label={s.mrMinutes} extraText={s.mrMinutesHint} min={1} max={600} precision={0} style={{ width: '100%' }} />
                <div className="co-sheet-foot">
                  <Button theme="borderless" onClick={() => setModuleEdit(null)}>{s.cancel}</Button>
                  <Button theme="solid" type="primary" onClick={() => formApi.submitForm()}>{s.save}</Button>
                </div>
              </>
            )}
          </Form>
        )}
      </Modal>

      {ckCourse && <CourseCheckinModal s={s} loc={loc} course={ckCourse} onClose={() => setCkCourse(null)} />}
      {asgCourse && <AssignCourseModal s={s} loc={loc} course={asgCourse.c} wrapper={asgCourse.w} onClose={() => setAsgCourse(null)} />}
      </div>
    );
  }

  // ---------- 课程库列表（第三批 10.3：只用列表，一行一门课；4.3 类别 / 修读类型 / 授课方式筛选） ----------
  const mt = mediaText(lang);
  const ocCounts = (oc.data && oc.data.counts) || {};
  const mediaCounts = (oc.data && oc.data.mediaCounts) || {};
  const vState = oc.data && oc.data.transcoder ? oc.data.transcoder.state : null;
  const mediaWaiting = (mediaCounts.pending || 0) + (mediaCounts.transcoding || 0) + (mediaCounts.failed || 0);
  // 页头按钮的圆点取两个组件里更差的那个：视频转码不可用或有失败时显示提醒色（data-video，样式见 app.css）
  const videoDot = (vState && vState !== 'ok') || mediaCounts.failed ? 'warn' : 'ok';
  const archiveCourse = (c) => Modal.confirm({
    title: s.bulkArchive, content: s.bulkArchiveNote, okText: s.bulkArchive, cancelText: s.cancel,
    okButtonProps: { type: 'danger' }, onOk: () => runMut(() => putCourse({ ...c, status: 'archived' }), s.archivedOk),
  });
  const selKeys = new Set(sel.rowSelection.selectedRowKeys.map(String));
  const filterSig = [fStatus, fKind, query, urlp.cat || '', fEnroll, fMode, fPub].join('|');
  const columns = [
    {
      title: s.colCourse, dataIndex: 'title', width: 230,
      sorter: (a, b) => String(loc(a, 'title') || '').localeCompare(String(loc(b, 'title') || ''), lang === 'zh' ? 'zh' : 'en'),
      render: (_, c) => {
        const meta = STATUS_META[statusOf(c)] || STATUS_META.draft;
        const primary = loc(c, 'title');
        const alt = lang === 'zh' ? c.title : c.title_zh;
        return (
          <div className="co-row-title">
            <div className="co-row-name">
              <button type="button" className="co-row-link" onClick={() => setCourseRef({ courseId: c.id })}>{primary}</button>
              <Tag color={meta.color} type="light" size="small">{s[meta.key]}</Tag>
            </div>
            {alt && alt !== primary && <div className="co-row-alt">{alt}</div>}
          </div>
        );
      },
    },
    {
      title: s.colCat, dataIndex: 'category', width: 100,
      sorter: (a, b) => (categoryRank(categoryOf(a)) - categoryRank(categoryOf(b))) || String(categoryOf(a) || '').localeCompare(String(categoryOf(b) || '')),
      render: (_, c) => {
        const cat = categoryOf(c);
        return <span className={cat ? '' : 'co-row-muted'}>{categoryLabel(cat, lang)}</span>;
      },
    },
    {
      title: s.colType, dataIndex: 'enrollType', width: 120,
      render: (_, c) => {
        const ele = enrollOf(c) === 'elective';
        const off = (c.mode || 'online') === 'offline';
        return (
          <span className="co-row-tags">
            <Tag size="small" type="light" color={ele ? 'grey' : 'violet'}>{ele ? s.typeElective : s.enrollMandatory}</Tag>
            <Tag size="small" type="light" color={off ? 'orange' : 'blue'}>{off ? s.modeOffline : s.modeOnline}</Tag>
            {publicOf(c) && (
              <Tooltip content={s.selfCountN(selfCountOf[c.id] || 0)}>
                <Tag size="small" type="light" color="green">{s.tagPublic}</Tag>
              </Tooltip>
            )}
          </span>
        );
      },
    },
    {
      title: s.colHours, dataIndex: 'hours', width: 70,
      sorter: (a, b) => courseHours(a) - courseHours(b),
      render: (_, c) => {
        const h = courseHours(c);
        return h > 0 ? <span className="tnum">{s.hoursUnit(h)}</span> : <span className="co-row-muted">—</span>;
      },
    },
    {
      title: s.colProjects, dataIndex: 'projects', width: 130,
      render: (_, c) => <ProjectTags s={s} loc={loc} lang={lang} list={projectsOf[c.id]} />,
    },
    {
      title: s.colContent, dataIndex: 'content', width: 130,
      render: (_, c) => {
        if ((c.mode || 'online') === 'offline') {
          const when = c.sessionAt ? c.sessionAt.replace('T', ' ') : s.sessionTbd;
          return <span className="co-row-meta"><IconMapPin size="small" className="co-row-ic" />{[when, c.location].filter(Boolean).join(' · ')}</span>;
        }
        const secs = c.modules.reduce((n, m) => n + m.sections.length, 0);
        return <span className="co-row-meta">{s.contentOnline(c.modules.length, secs, moduleMinutes(c))}</span>;
      },
    },
    {
      title: s.colBank, dataIndex: 'bank', width: 100,
      render: (_, c) => {
        const w = wrapperOf[c.id];
        const offline = (c.mode || 'online') === 'offline';
        // Bank risk: the final exam draws `draw` objective questions from this course (the course's real
        // published exam: mcqCount vs poolObjective). A bank at or below the draw can't produce a varied paper.
        const liveExam = w ? (examsOfProgram[w.id] || []).find((e) => e.status === 'published') : null;
        const draw = liveExam ? (liveExam.mcqCount || 0) : 0;
        const pool = liveExam ? (liveExam.poolObjective || 0) : 0;
        // CX-148：固定题目考试不抽题，不提示题库不足
        if (!offline && liveExam && liveExam.mode !== 'fixed' && statusOf(c) !== 'archived' && draw > 0 && pool <= draw) {
          const short = pool < draw;
          return (
            <Tooltip content={s.bkHint}>
              <span className={'co-bankwarn' + (short ? ' bad' : '')} tabIndex={0}>
                <span aria-hidden><IcWarn /></span>{short ? s.bkShort(pool, draw) : s.bkTight(pool, draw)}
              </span>
            </Tooltip>
          );
        }
        const bankN = w && !offline && questionsQ.data ? (bankAllOf[c.id] || 0) : null;
        return bankN != null ? <span className="tnum">{s.cBank(bankN)}</span> : <span className="co-row-muted">—</span>;
      },
    },
    {
      // QA D2（第三批）：列宽合计 + 勾选列 ≤ 1440 宽内容区（约 1150px），操作列固定在右侧，屏宽不足或拖宽列时「编辑内容 / 指派」仍可见
      title: s.colActions, dataIndex: 'op', width: 180, fixed: 'right', className: 'co-opcol',
      render: (_, c) => {
        const w = wrapperOf[c.id];
        const status = statusOf(c);
        const offline = (c.mode || 'online') === 'offline';
        return (
          <span className="co-row-acts">
            {/* 只读档同一入口进的是只读的课程编辑器，按钮写「查看内容」 */}
            <Button theme="borderless" size="small" icon={canWrite ? <IconEdit /> : <IconEyeOpened />}
              onClick={() => setCourseRef({ courseId: c.id })}>
              {canWrite ? s.editCourse : s.viewCourse}
            </Button>
            {/* 指派 = POST /api/admin/assignments/bulk(写) */}
            {canWrite && w && <Button theme="light" size="small" onClick={() => setAsgCourse({ c, w })}>{s.asgBtn}</Button>}
            {canWrite && (
              <Dropdown
                trigger="click"
                position="bottomRight"
                render={(
                  <Dropdown.Menu>
                    {status === 'draft' && <Dropdown.Item onClick={() => publishCourse(c)}>{s.publishNow}</Dropdown.Item>}
                    {status === 'published' && <Dropdown.Item onClick={() => archiveCourse(c)}>{s.bulkArchive}</Dropdown.Item>}
                    {/* 签到管理：现场签到码、投屏与补签都是开课人员的操作（QA RO1），只读档不显示 */}
                    {offline && status !== 'draft' && <Dropdown.Item onClick={() => setCkCourse(c)}>{s.ckBtn}</Dropdown.Item>}
                    <Dropdown.Item icon={<IconEdit />} onClick={() => openEditCourse(c)}>{s.renameCourse}</Dropdown.Item>
                    <Dropdown.Item onClick={() => exportCourse(c)}>{s.exportPkg}</Dropdown.Item>
                    {w && !offline && <Dropdown.Item icon={<IconSetting />} onClick={() => goExams(w)}>{s.examBtn}</Dropdown.Item>}
                    <Dropdown.Divider />
                    <Dropdown.Item
                      icon={<IconDelete />} type="danger"
                      onClick={() => Modal.confirm({
                        title: s.delCourse,
                        content: s.delCourseAsk,
                        okText: s.delCourse,
                        cancelText: s.cancel,
                        okButtonProps: { type: 'danger' },
                        onOk: () => deleteCourse(c.id),
                      })}
                    >{s.delCourse}</Dropdown.Item>
                  </Dropdown.Menu>
                )}
              >
                <Button theme="borderless" size="small" icon={<IconMore />} aria-label={s.moreLab} />
              </Dropdown>
            )}
          </span>
        );
      },
    },
  ];
  return (
    <div className="wrap co-wrap co-lib">
      {/* header */}
      <div className="co-head">
        <div>
          {/* 11.4 / F47：只读档在标题右侧放「只读」胶囊，悬停给一句说明（不再单列一段权限说明） */}
          <div className="u-title-line">
            <h1 className="co-title">{s.title}</h1>
            {!canWrite && <ReadOnlyPill tip={s.roWrite} />}
          </div>
          <div className="co-lead">{s.lead}</div>
        </div>
        <div className="co-head-acts">
          {/* 课件转换（P0 1.4）+ 视频转码（第三批 5.7）：培训读即可查看状态与待处理清单，补转按钮只给写权限。
              数字 = 待转换的课件 + 等待 / 转码中 / 失败的课件内视频；圆点取两个组件里更差的那个。 */}
          {ocState && (
            <Tooltip content={s.ocTip(mt.vst[ocState] || ocState, vState ? (mt.vst[vState] || vState) : '—', mediaWaiting)}>
              <Button theme="light" className={'co-oc-btn ' + (ocState === 'ok' ? 'is-ok' : 'is-off')} data-video={videoDot} onClick={() => goPage({ office: '1' })}>
                <span className="dot" aria-hidden />
                {(ocState === 'ok' ? s.ocBtnOk : ocState === 'disabled' ? s.ocBtnDisabled : s.ocBtnOff)((ocCounts.pending || 0) + mediaWaiting)}
              </Button>
            </Tooltip>
          )}
          {canWrite && <input ref={importRef} type="file" accept=".json,application/json" style={{ display: 'none' }}
            onChange={(e) => { const f = e.target.files && e.target.files[0]; e.target.value = ''; importCourseFile(f); }} />}
          {canWrite && <Button theme="light" icon={<IconUpload />} onClick={() => importRef.current && importRef.current.click()}>{s.importPkg}</Button>}
          {canWrite && <Button theme="solid" type="primary" icon={<IconPlus />} onClick={openNewCourse}>{s.newCourse2}</Button>}
        </div>
      </div>

      {/* 搜索 + 状态（计数就是筛选按钮，计数不随筛选变）+ 类别 / 修读类型 / 授课方式 / 使用情况；全部写进地址栏 */}
      {courses.length > 0 && (
        <div className="co-filters co-filters-b3">
          <Input
            prefix={<IconSearch />}
            placeholder={s.searchPh}
            value={query}
            onChange={setQuery}
            showClear
            className="co-search"
            aria-label={s.searchPh}
          />
          <div className="co-chips">
            {[
              ['', s.fAll, counts.total, 'muted'],
              ['published', s.stPublished, counts.published, 'ok'],
              ['draft', s.stDraft, counts.draft, 'warn'],
              ['archived', s.stArchived, counts.archived, 'muted'],
            ].map(([val, label, n, tone]) => (
              <button
                key={label}
                type="button"
                className={'pill ' + tone + ' co-chip' + (fStatus === val ? ' on' : '')}
                aria-pressed={fStatus === val}
                onClick={() => setFStatus(val)}
              >
                {label} <b className="tnum">{n}</b>
              </button>
            ))}
          </div>
          <div className="co-fsel">
            <CategorySelect value={fCat} onChange={(v) => patchUrl({ cat: joinList(v) }, { push: false })} inUse={catInUse} />
            <EnrollSelect value={fEnroll} onChange={(v) => setFilter('enroll', v)} />
            <PublicSelect value={fPub} onChange={(v) => setFilter('pub', v)} />
            <ModeSelect value={fMode} onChange={(v) => setFilter('mode', v)} />
            {/* 项目课程 / 独立课程: the owner's question 「哪些是项目的、哪些不是」, counts unfiltered like the chips. */}
            {hasProjInfo && (
              <Select
                value={fKind}
                onChange={(v) => setFKind(v || 'all')}
                className="co-kind tf-select"
                aria-label={s.kLab}
                optionList={[
                  { value: 'all', label: `${s.kAll} · ${counts.total}` },
                  { value: 'project', label: `${s.kProject} · ${counts.project}` },
                  { value: 'solo', label: `${s.kSolo} · ${counts.solo}` },
                ]}
              />
            )}
            {hasFilters && <Button theme="borderless" className="co-fclear" onClick={clearFilters}>{s.clear}</Button>}
          </div>
          {/* 批量（B5）：「全选当前筛选结果」= 筛选后的全部课程（跨页）；表头勾选框只管当前页。只读档不渲染 */}
          {canWrite && (
            <Checkbox
              className="co-selall"
              checked={visible.length > 0 && sel.count >= visible.length && visible.every((c) => selKeys.has(String(c.id)))}
              indeterminate={sel.count > 0 && !(sel.count >= visible.length && visible.every((c) => selKeys.has(String(c.id))))}
              disabled={!visible.length || runner.busy}
              onChange={(e) => {
                if (e && e.target && e.target.checked) visible.forEach((c) => sel.rowSelection.onSelect(c, true));
                else sel.clear();
              }}
            >{s.selAll(visible.length)}</Checkbox>
          )}
        </div>
      )}

      {canWrite && (
        <BulkBar count={sel.count} onClear={sel.clear} busy={runner.busy} pageOnly={false} selectPage={sel.togglePage}>
          <Button size="small" theme="light" type="primary" disabled={runner.busy} onClick={() => openBulk('publish')}>{s.bulkPublish}</Button>
          <Button size="small" theme="light" type="primary" disabled={runner.busy} onClick={() => openBulk('category')}>{s.bulkCategory}</Button>
          <Button size="small" theme="light" type="primary" disabled={runner.busy} onClick={() => openBulk('publicOn')}>{s.bulkPublicOn}</Button>
          <Button size="small" theme="light" type="warning" disabled={runner.busy} onClick={() => openBulk('publicOff')}>{s.bulkPublicOff}</Button>
          <Button size="small" theme="light" type="danger" disabled={runner.busy} onClick={() => openBulk('archive')}>{s.bulkArchive}</Button>
        </BulkBar>
      )}

      {error && !data ? (
        <div className="card co-emptycard">
          <Empty title={s.loadError} description={error.message} />
          <div style={{ marginTop: 12, textAlign: 'center' }}>
            <Button onClick={reload}>{s.retry}</Button>
          </div>
        </div>
      ) : loading && !data ? (
        <div className="card co-emptycard" style={{ textAlign: 'center', padding: '48px 0' }}>
          <Spin size="large" tip={s.loading} />
        </div>
      ) : visible.length === 0 ? (
        <div className="card co-nocourse co-nocard">
          {courses.length === 0 ? s.emptyCourses : hasFilters ? s.emptyFiltered : s.noMatch}
          {courses.length > 0 && hasFilters && <div style={{ marginTop: 10 }}><Button theme="light" onClick={clearFilters}>{s.clear}</Button></div>}
        </div>
      ) : (
        <div className="co-ctable">
          <div ref={sel.wrapRef}>
            <Table
              key={listVer + '|' + filterSig}
              rowKey="id"
              {...resizableTable(columns.map((c) => (c.sorter ? { ...c, defaultSortOrder: listSort && listSort.dataIndex === c.dataIndex ? listSort.sortOrder : false } : c)), { extra: canWrite ? BULK_SEL_EXTRA : 0 })}
              onChange={({ sorter }) => setListSort(sorter && sorter.sortOrder ? { dataIndex: sorter.dataIndex, sortOrder: sorter.sortOrder } : null)}
              rowSelection={canWrite ? sel.rowSelection : undefined}
              dataSource={visible}
              pagination={visible.length > LIST_PAGE_TIERS[0] ? {
                pageSize: listSize, defaultCurrentPage: clampPage(listPage, visible.length, listSize), onPageChange: setListPage, onPageSizeChange: setListSize,
                pageSizeOpts: LIST_PAGE_TIERS, showSizeChanger: true, formatPageText: () => s.totalText(visible.length),
              } : false}
            />
          </div>
        </div>
      )}

      {ckCourse && <CourseCheckinModal s={s} loc={loc} course={ckCourse} onClose={() => setCkCourse(null)} />}
      {asgCourse && <AssignCourseModal s={s} loc={loc} course={asgCourse.c} wrapper={asgCourse.w} onClose={() => setAsgCourse(null)} />}

      {/* 批量发布 / 下线 / 改分类的确认窗（B5）：列出前 5 门课，其余写「等 N 项」 */}
      {canWrite && (
        <BulkConfirmModal
          visible={!!bulkOp && !!bulkSnap}
          op={bulkLabel(bulkOp)}
          names={bulkSnap ? bulkSnap.list : []}
          danger={bulkOp === 'archive' || bulkOp === 'publicOff'}
          loading={runner.busy}
          onOk={submitBulk}
          onCancel={() => setBulkOp(null)}
        >
          {bulkOp === 'publish' && (
            <>
              <p>{s.fStatusHint}</p>
              {bulkSnap && bulkSnap.empty > 0 && <p className="co-bulk-note">{s.bulkEmptyN(bulkSnap.empty)}</p>}
            </>
          )}
          {bulkOp === 'archive' && <p>{s.bulkArchiveNote}</p>}
          {bulkOp === 'publicOn' && <p>{s.bulkPublicOnNote}</p>}
          {bulkOp === 'publicOff' && (
            <>
              <p>{s.bulkPublicOffNote}</p>
              {bulkSnap && <p className="co-bulk-note">{s.bulkPublicOffN(bulkSnap.selfTotal || 0)}</p>}
            </>
          )}
          {bulkOp === 'category' && (
            <>
              <Select filter allowCreate showClear style={{ width: '100%' }} value={bulkCat}
                onChange={(v) => setBulkCat(v || undefined)} optionList={categoryOpts} placeholder={s.bulkCatPh} aria-label={s.fCategory} />
              {!bulkCat && <p className="co-bulk-note">{s.bulkCatClear}</p>}
              {bulkCat && isCustomCategory(normalizeCategoryInput(bulkCat)) && <p className="co-bulk-note">{s.fCatCustom}</p>}
            </>
          )}
        </BulkConfirmModal>
      )}
      {runner.modal}
    </div>
  );
}

// Course-side assignment: HR picks WHO learns this course — by department,
// by pasting employee IDs, or one by one — with an optional due date.
// (Built for a 3000-person roster; already-assigned people are auto-skipped.)
function AssignCourseModal({ s, loc, course, wrapper, onClose }) {
  const { lang } = useI18n();
  const rosterQ = useAsync(() => api.get('/api/admin/roster'), []);
  const asgQ = useAsync(() => api.get(`/api/admin/programs/${wrapper.id}/assignees`), [wrapper.id]);
  const roster = rosterQ.data || [];
  const assignedSet = useMemo(() => new Set(((asgQ.data && asgQ.data.list) || []).map((x) => x.userId)), [asgQ.data]);
  const eligible = useMemo(() => roster.filter((r) => r.active && r.role !== 'admin'), [roster]);

  const [mode, setMode] = useState('dept'); // dept | paste | pick
  const [depts, setDepts] = useState([]);
  // 「按部门」（第二批 3.1 / P3）：全站统一的 DeptFilter 多选，选上级部门即含全部下级（原来按部门原文精确匹配、不含下级）；
  // 指派前弹确认框写明人数。部门树没加载好（或不可用）时不按部门解析 —— deptMatcher 无树时一律放行，必须挡住。
  const tree = useDeptTree();
  const deptOk = useMemo(() => deptMatcher(tree, depts), [tree, depts]);
  // 已指派名单的部门筛选：弹窗内部状态，只影响下面那张表
  const [listDept, setListDept] = useState(null);
  const listDeptOk = useMemo(() => deptMatcher(tree, listDept), [tree, listDept]);
  // 第三批 8.6：按职级（可与部门组合）。职级目录 GET /api/admin/job-grades（培训读可读）；员工职级 = roster 的 jobLevel。
  // 只含在职员工（eligible）；选了职级时没有设职级的人不纳入，并提示人数。
  const gradesQ = useAsync(() => api.get('/api/admin/job-grades').catch(() => ({ ranks: [] })), []);
  const ranks = (gradesQ.data && gradesQ.data.ranks) || NO_OPTS;
  const gradesInUse = useMemo(() => [...new Set(eligible.map((r) => r.jobLevel).filter(Boolean))], [eligible]);
  const [grades, setGrades] = useState([]);
  const [paste, setPaste] = useState('');
  const [picked, setPicked] = useState([]);
  const [due, setDue] = useState(() => {
    const d = new Date();
    d.setDate(d.getDate() + (course.defaultDueDays || 30));
    return d;
  });
  const [busy, setBusy] = useState(false);

  const byId = useMemo(() => {
    const m = {};
    for (const r of eligible) m[(r.employeeId || '').toLowerCase()] = r;
    return m;
  }, [eligible]);
  const pasteTokens = paste.split(/[\s,，;；、]+/).map((x) => x.trim()).filter(Boolean);
  const pasteMissing = pasteTokens.filter((tk) => !byId[tk.toLowerCase()]);

  // Candidate user ids for the current mode, minus the already-assigned.
  const candidates = useMemo(() => {
    let ids = [];
    let noGrade = 0;
    if (mode === 'dept') {
      // 部门（含下级）× 职级：两者都可单用。选了部门但部门树没加载好 → 一个人也不解析（deptMatcher 无树时一律放行，必须挡住）
      const byDept = depts.length && tree ? eligible.filter((r) => deptOk(r.department)) : depts.length ? [] : grades.length ? eligible : [];
      const g = splitByGrade(byDept, grades);
      ids = g.match.map((r) => r.id);
      noGrade = g.noGrade.length;
    } else if (mode === 'paste') ids = pasteTokens.map((tk) => byId[tk.toLowerCase()]).filter(Boolean).map((r) => r.id);
    else ids = picked;
    const uniq = [...new Set(ids)];
    return { fresh: uniq.filter((id) => !assignedSet.has(id)), skip: uniq.filter((id) => assignedSet.has(id)).length, noGrade };
  }, [mode, depts, grades, paste, picked, eligible, assignedSet, tree, deptOk]); // eslint-disable-line react-hooks/exhaustive-deps

  // 按部门 / 职级：先确认人数（含下级部门、已扣掉已指派过的人、写明未设职级不纳入的人数），确认后再指派
  const askAssign = () => {
    if (!candidates.fresh.length) { Toast.warning(s.asgNone); return; }
    if (mode !== 'dept') { doAssign(); return; }
    const tail = [candidates.skip ? s.asgConfirmSkip(candidates.skip) : '', grades.length && candidates.noGrade ? s.asgConfirmNoGrade(candidates.noGrade) : ''].filter(Boolean).join(' ');
    Modal.confirm({
      title: grades.length ? s.asgConfirmT2 : s.asgConfirmT, content: s.asgConfirm(candidates.fresh.length) + (tail ? ' ' + tail : ''),
      okText: s.asgDo, cancelText: s.cancel, onOk: () => doAssign(),
    });
  };
  const doAssign = async () => {
    if (!candidates.fresh.length) { Toast.warning(s.asgNone); return; }
    setBusy(true);
    try {
      await api.post('/api/admin/assignments/bulk', {
        userIds: candidates.fresh,
        programId: wrapper.id,
        dueAt: due ? fmtD(due) : null,
        action: 'assign',
        // 选人依据（第三批 8.6）：服务端写进审计 after.criteria；不认识这个字段的旧服务忽略它
        ...(mode === 'dept' ? { criteria: { depts, grades } } : {}),
      });
      Toast.success(s.asgDoneN(candidates.fresh.length));
      setDepts([]); setGrades([]); setPaste(''); setPicked([]);
      asgQ.reload();
    } catch (e) {
      Toast.error(e.message);
    } finally {
      setBusy(false);
    }
  };
  const removeOne = async (row) => {
    try {
      await api.post('/api/admin/assignments/bulk', { userIds: [row.userId], programId: wrapper.id, action: 'unassign' });
      Toast.success(s.asgRemovedOk);
      asgQ.reload();
    } catch (e) {
      Toast.error(e.message);
    }
  };

  const assignedList = (asgQ.data && asgQ.data.list) || [];
  const assignedShown = listDept ? assignedList.filter((r) => listDeptOk(r.department)) : assignedList;

  // UI 批 U2 11.5（F52）：页签「按条件 / 粘贴工号 / 逐个选择」→ 条件两行等宽 → 人数结果条 → 底部左截止日期、右 关闭 / 指派（不可用时写原因）
  const nameOf = useMemo(() => new Map(eligible.map((r) => [r.id, `${r.name}（${r.employeeId}）`])), [eligible]);
  const matched = candidates.fresh.length + candidates.skip;
  const reason = assignBlockReason({
    mode, criteria: depts.length > 0 || grades.length > 0, waitTree: depts.length > 0 && !tree,
    input: mode === 'paste' ? pasteTokens.length : picked.length, matched, fresh: candidates.fresh.length,
  });
  const resultItems = mode === 'dept'
    ? [{ key: 'm', label: s.asgMatched, n: matched }, { key: 's', label: s.asgSkipped, n: candidates.skip }, { key: 'g', label: s.asgNoGradeR, n: grades.length ? candidates.noGrade : 0, tone: 'warn' }]
    : mode === 'paste'
      ? [{ key: 'f', label: s.asgFound, n: matched }, { key: 's', label: s.asgSkipped, n: candidates.skip }, { key: 'x', label: s.asgMissingR, n: pasteMissing.length, tone: 'bad' }]
      : [{ key: 'p', label: s.asgPicked, n: matched }, { key: 's', label: s.asgSkipped, n: candidates.skip }];

  return (
    <Modal {...dpfModalProps()} className="u-modal-visible"
      title={<span className="asg-title"><span>{[s.asgTitle, loc(course, 'title')].filter(Boolean).join(' · ')}</span><AssignHelp text={s.asgHelp} /></span>}
      visible onCancel={onClose} width={720}
      footer={(
        <AssignFooter
          left={<label className="asg-due"><span className="asg-due-lab">{s.asgDue}</span><DatePicker type="date" value={due} onChange={setDue} placeholder={s.asgDueHint} style={{ width: 160 }} /></label>}
          reason={reason} cancelText={s.ckClose} onCancel={onClose} loading={busy} onOk={askAssign}
          okText={<>{s.asgDo}{candidates.fresh.length ? `（${candidates.fresh.length}）` : ''}</>} />
      )}>
      {(course.status || 'draft') === 'draft' && (
        <div className="co-offline-note" style={{ marginBottom: 12 }}>{s.asgDraftWarn}</div>
      )}
      <AssignModes mode={mode} onChange={setMode} />
      {mode === 'dept' && (
        <AssignCriteria
          dept={(
            <DeptFilter multiple options={tree ? tree.options : NO_OPTS} value={depts} onChange={(v) => setDepts(Array.isArray(v) ? v : [])}
              lang={lang} label={s.asgByDept} placeholder={s.asgDeptPh} ready={!!tree} disabled={tree === null}
              showNone={!!(tree && tree.hasNone)} />
          )}
          grade={<JobGradeSelect value={grades} onChange={setGrades} ranks={ranks} inUse={gradesInUse} />} />
      )}
      {mode === 'paste' && (
        <TextArea rows={3} placeholder={s.asgPastePh} value={paste} onChange={setPaste} />
      )}
      {mode === 'pick' && (
        <Select multiple filter style={{ width: '100%' }} placeholder={s.asgPickPh} maxTagCount={6}
          value={picked} onChange={setPicked}
          optionList={eligible.map((r) => ({ label: `${r.name}（${r.employeeId}）${r.department ? ' · ' + r.department : ''}`, value: r.id }))} />
      )}
      <AssignResult main={{ label: s.asgWill, n: candidates.fresh.length }} items={resultItems}
        names={candidates.fresh.map((id) => nameOf.get(id) || id)} />
      <Divider margin="10px" />
      <div style={{ fontSize: 13.5, fontWeight: 600, margin: '8px 0' }}>{s.asgListTitle(assignedList.length)}</div>
      {assignedList.length > 0 && (
        <div className="u-filterbar">
          <DeptFilter size="small" options={tree ? tree.options : NO_OPTS} value={listDept} onChange={(v) => setListDept(v || null)}
            lang={lang} label={s.ckColDept} placeholder={s.deptAll} ready={!!tree} disabled={tree === null}
            showNone={!!(tree && tree.hasNone)} />
          {listDept && <span className="u-count">{s.rosterDept(assignedShown.length, assignedList.length)}</span>}
        </div>
      )}
      {asgQ.loading ? (
        <div style={{ padding: 20, textAlign: 'center' }}><Spin /></div>
      ) : assignedList.length === 0 ? (
        <Empty description={s.asgEmpty} style={{ padding: '16px 0' }} />
      ) : (
        <Table size="small" rowKey="userId" dataSource={assignedShown}
          pagination={assignedShown.length > 8 ? { pageSize: DEFAULT_PAGE, pageSizeOpts: PAGE_TIERS, showSizeChanger: true, formatPageText: false } : false}
          {...resizableTable([
            { title: s.ckColName, dataIndex: 'name', width: 280, render: (v, r) => <span>{v} <span className="tnum" style={{ color: 'var(--semi-color-text-2)', fontSize: 12 }}>{r.employeeId}</span></span> },
            { title: s.ckColDept, dataIndex: 'department', width: 110, render: (v) => v || '—' },
            { title: s.asgColDue, dataIndex: 'dueAt', width: 110, render: (v) => v ? <span className="tnum">{v}</span> : '—' },
            { title: s.asgColProgress, dataIndex: 'progress', width: 80, render: (v) => <span className="tnum">{v}%</span> },
            { title: '', dataIndex: 'op', width: 70, render: (_, r) => (
              <Popconfirm title={s.asgRemove} content={s.asgRemoveAsk(r.name)} okType="danger" onConfirm={() => removeOne(r)}>
                <Button size="small" theme="borderless" type="danger">{s.asgRemove}</Button>
              </Popconfirm>
            ) },
          ])} />
      )}
    </Modal>
  );
}

// Live roll-call for an in-person course — same UX as the project offline
// check-in: rotating 6-digit code, projector mode, make-up / excuse marks.
function CourseCheckinModal({ s, loc, course, onClose }) {
  const { lang } = useI18n();
  const canWrite = useCanWrite();
  const q = useAsync(() => api.get(`/api/admin/courses/${course.id}/checkin`), [course.id]);
  const d = q.data;
  // 部门筛选（第二批 3.1）：弹窗内部状态，按名单行的 department 含下级过滤；上面的出勤统计仍是整份名单
  const tree = useDeptTree();
  const [fDept, setFDept] = useState(null);
  const deptOk = useMemo(() => deptMatcher(tree, fDept), [tree, fDept]);
  const allRows = d ? d.list || NO_OPTS : NO_OPTS;
  const rows = useMemo(() => (fDept ? allRows.filter((r) => deptOk(r.department)) : allRows), [allRows, fDept, deptOk]);
  const [big, setBig] = useState(false);
  const [left, setLeft] = useState(null);
  useEffect(() => {
    const iv = setInterval(() => q.reload(), big ? 10000 : 20000);
    return () => clearInterval(iv);
  }, [big]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (d) setLeft(d.secondsLeft); }, [d]);
  useEffect(() => {
    const t = setInterval(() => setLeft((v) => {
      if (v == null) return v;
      if (v <= 1) { q.reload(); return null; }
      return v - 1;
    }), 1000);
    return () => clearInterval(t);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const mark = async (userId, status) => {
    try { await api.post(`/api/admin/courses/${course.id}/checkin/mark`, { userId, status }); q.reload(); }
    catch (e) { Toast.error(e.message); }
  };
  const present = d ? d.stats.attended + d.stats.late : 0;
  const total = d ? d.list.length : 0;
  return (
    <Modal {...dpfModalProps()} className="u-modal-visible" title={[s.ckBtn, loc(course, 'title')].filter(Boolean).join(' · ')} visible onCancel={onClose} footer={<Button onClick={onClose}>{s.ckClose}</Button>} width={720}>
      {big && d && (
        <div className="ckbig" onClick={() => setBig(false)}>
          <div className="ckbig-exit">{s.ckExit}</div>
          <div className="ckbig-title">{loc(course, 'title')}</div>
          <div className="ckbig-code tnum">{String(d.code).split('').map((ch, i) => <span key={i}>{ch}</span>)}</div>
          <div className="ckbig-bar"><i style={{ width: `${((left || 0) / 60) * 100}%` }} /></div>
          <div className="ckbig-meta">{s.ckRotate} · {s.ckHint}</div>
          <div className="ckbig-count tnum">{present} / {total}</div>
        </div>
      )}
      {q.loading || !d ? <div style={{ padding: 30, textAlign: 'center' }}><Spin /></div> : (
        // The code card sits ABOVE the roster instead of taking a 200px column
        // beside it. Side by side the roster could never fit: a width=720 modal
        // gives 670 of content, minus 200 for the card and an 18 gap leaves 452
        // for a table that wants 600+, so the make-up / excuse column was always
        // pushed out of sight. Stacked, the roster gets the full 670 and needs no
        // horizontal scroll at default widths — and unlike widening the modal,
        // this still holds on a narrow screen.
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap', border: '1px solid var(--semi-color-border)', borderRadius: 8, padding: '10px 14px' }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
              <span style={{ fontSize: 12, color: 'var(--semi-color-text-2)', flex: 'none' }}>{s.ckCode}{left != null ? ` · ${left}s` : ''}</span>
              <span className="tnum" style={{ fontSize: 30, fontWeight: 800, letterSpacing: 4, color: 'var(--semi-color-primary)' }}>{d.code}</span>
            </div>
            <span style={{ fontSize: 12, color: 'var(--semi-color-text-2)', flex: 1, minWidth: 140 }}>{s.ckHint}</span>
            <div style={{ display: 'flex', gap: 6, flex: 'none' }}>
              <Button size="small" theme="solid" type="primary" onClick={() => setBig(true)}>{s.ckBig}</Button>
              <Button size="small" icon={<IconRefresh />} onClick={() => q.reload()} aria-label={s.ckRefresh} />
            </div>
          </div>
          <div style={{ minWidth: 0 }}>
            <div style={{ display: 'flex', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
              <Tag color="green" type="light">{s.ckAttended} {d.stats.attended}</Tag>
              <Tag color="amber" type="light">{s.ckLate} {d.stats.late}</Tag>
              <Tag type="light">{s.ckExcused} {d.stats.excused}</Tag>
              <Tag color="red" type="light">{s.ckMissing} {d.stats.missing}</Tag>
            </div>
            {d.list.length > 0 && (
              <div className="u-filterbar">
                <DeptFilter size="small" options={tree ? tree.options : NO_OPTS} value={fDept} onChange={(v) => setFDept(v || null)}
                  lang={lang} label={s.ckColDept} placeholder={s.deptAll} ready={!!tree} disabled={tree === null}
                  showNone={!!(tree && tree.hasNone)} />
                {fDept && <span className="u-count">{s.rosterDept(rows.length, d.list.length)}</span>}
              </div>
            )}
            {d.list.length === 0 ? (
              <Empty description={s.ckEmpty} style={{ padding: '24px 0' }} />
            ) : (
              // The height cap now comes from `.ck-roster` in app.css, which puts
              // it on .semi-table-body so the horizontal scrollbar stays at the
              // bottom of the visible list instead of the bottom of all 30 rows.
              // Name column matches the project roll-call's 220; 610 for the four
              // columns fits the 670 of content without scrolling.
              <Table size="small" rowKey="userId" dataSource={rows} pagination={false} className="ck-roster"
                {...resizableTable([
                  { title: s.ckColName, dataIndex: 'name', width: 220, render: (v, r) => <span>{v} <span className="tnum" style={{ color: 'var(--semi-color-text-2)', fontSize: 12 }}>{r.employeeId}</span></span> },
                  { title: s.ckColDept, dataIndex: 'department', width: 110, render: (v) => v || '—' },
                  { title: s.ckColState, dataIndex: 'status', width: 90, render: (v) => v === 'attended' ? <Tag color="green" type="light">{s.ckAttended}</Tag> : v === 'late' ? <Tag color="amber" type="light">{s.ckLate}</Tag> : v === 'excused' ? <Tag type="light">{s.ckExcused}</Tag> : v === 'absent' ? <Tag color="red" type="light">{s.ckAbsent}</Tag> : <span style={{ color: 'var(--semi-color-text-3)' }}>{s.ckMissing}</span> },
                  { title: '', dataIndex: 'op', width: 190, render: (_, r) => (
                    <span style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                      {canWrite && !r.status && <Button size="small" theme="borderless" onClick={() => mark(r.userId, 'attended')}>{s.ckMakeup}</Button>}
                      {canWrite && !r.status && <Button size="small" theme="borderless" onClick={() => mark(r.userId, 'excused')}>{s.ckExcuse}</Button>}
                      {canWrite && r.status === 'late' && <Button size="small" theme="borderless" onClick={() => mark(r.userId, 'attended')}>{s.ckToPresent}</Button>}
                      {/* 负责人 2026-10-06：请假不算完成，补课后直接改为出席 */}
                      {canWrite && r.status === 'excused' && <Button size="small" theme="borderless" onClick={() => mark(r.userId, 'attended')}>{s.ckMakeupExcused}</Button>}
                    </span>
                  ) },
                ])} />
            )}
          </div>
        </div>
      )}
    </Modal>
  );
}

// ---------- helpers / sub-components ----------

// 「培养项目：<名称>」 per project that uses the course (at most two; the rest fold
// into 「等 N 个」 whose tooltip names them all), or a neutral 「独立课程」. Shown on
// the course row and in the editor header. list === null → unknown (older server):
// render nothing.
function ProjectTags({ s, loc, lang, list }) {
  if (!Array.isArray(list)) return null;
  if (!list.length) {
    return (
      <div className="co-ptags">
        <Tooltip content={s.pjSoloTip}><span className="co-ptag solo" tabIndex={0}>{s.pjSolo}</span></Tooltip>
      </div>
    );
  }
  const name = (p) => loc(p, 'title') || p.title || p.title_zh || p.id;
  const withStatus = (p) => name(p) + (s.pjSt[p.status] ? ` · ${s.pjSt[p.status]}` : '');
  const all = list.map(withStatus).join(lang === 'zh' ? '、' : '; ');
  return (
    <div className="co-ptags">
      {list.slice(0, 2).map((p) => (
        <span key={p.id} className="co-ptag" title={withStatus(p)}>{s.pjTag(name(p))}</span>
      ))}
      {list.length > 2 && (
        <Tooltip content={s.pjListTip(all)}>
          <span className="co-ptag more" tabIndex={0}>{s.pjMore(list.length, list.length - 2)}</span>
        </Tooltip>
      )}
    </div>
  );
}

// 大纲小节名下方的小图标（第三批 5.5）：上传的视频、视频链接、附件（一个回形针，提示里列出文件名）、
// 课件内视频段数（5.7，GET content 给每个附件带 media 汇总），有待转码或失败的再加一个提醒标记。
// 图标是 role="img" + aria-label（屏幕阅读器读得到），title 给鼠标悬停。
const markAt = (cls, label, icon, extra) => (
  <span className={'co-sec-mark ' + cls} role="img" aria-label={label} title={label}>{icon}{extra}</span>
);
function SecMarks({ s, sec }) {
  const atts = Array.isArray(sec.attachments) ? sec.attachments : [];
  const media = atts.map((a) => a && a.media).filter((m) => m && m.total > 0);
  const vids = media.reduce((n, m) => n + Math.max(0, (m.total || 0) - (m.skipped || 0)), 0);
  const warn = media.some((m) => (m.failed || 0) + (m.pending || 0) + (m.transcoding || 0) > 0);
  const marks = [];
  if (sec.video) marks.push(markAt('is-video', s.mkVideo, <IconVideo size="small" />));
  if (sec.videoUrl) marks.push(markAt('is-link', s.mkLink, <IconLink size="small" />));
  if (atts.length) marks.push(markAt('is-file', s.mkFiles(atts.length, atts.map((a) => a.name).filter(Boolean).join('、')), <IconPaperclip size="small" />));
  if (vids > 0) marks.push(markAt('is-deck', s.mkDeck(vids), <IconPlayCircle size="small" />, <span className="tnum">{vids}</span>));
  if (warn) marks.push(markAt('is-warn', s.mkWarn, <IconAlertTriangle size="small" />));
  if (!marks.length) return null;
  return <span className="co-sec-marks">{marks.map((m, i) => <span key={i} className="co-sec-markwrap">{m}</span>)}</span>;
}

// 课件内视频清单（第三批 5.7，设计 §13.7）：附件区课件下方。数据先用上传响应里的 media（含 items），
// 否则 GET /api/admin/attachments/:id/media。有等待 / 转码中的视频且转码组件可用时每 5 秒刷新一次，10 分钟后停；
// 转码组件不可用时写「等待转码组件」并给出课件转换页入口；失败的行给「去处理」。
const DM_POLL_MS = 5000;
const DM_POLL_MAX_MS = 10 * 60 * 1000;
function DeckMedia({ s, lang, att, onOpenOffice }) {
  const mt = mediaText(lang);
  const init = att && att.media;
  const [d, setD] = useState(() => (init && Array.isArray(init.items) ? { items: init.items, transcoder: init.transcoder || null, mapping: init.mapping || null } : null));
  const [err, setErr] = useState(false);
  const [busy, setBusy] = useState(false);
  const started = useRef(Date.now());
  const attId = att && att.id;
  const total = init ? (init.total || (init.items ? init.items.length : 0)) : 0;
  const load = async () => {
    if (!attId) return;
    setBusy(true);
    try {
      const r = await api.get(`/api/admin/attachments/${encodeURIComponent(attId)}/media`);
      setD({ items: (r && r.items) || [], transcoder: (r && r.transcoder) || null, mapping: (r && r.mapping) || null });
      setErr(false);
    } catch { setErr(true); }
    setBusy(false);
  };
  useEffect(() => {
    started.current = Date.now();
    if (!d && attId && total > 0) load();
  }, [attId]); // eslint-disable-line react-hooks/exhaustive-deps
  const items = (d && d.items) || [];
  const tState = d && d.transcoder ? (typeof d.transcoder === 'string' ? d.transcoder : d.transcoder.state) : null;
  const open = items.some((x) => x.status === 'pending' || x.status === 'transcoding');
  useEffect(() => {
    if (!open || tState !== 'ok' || Date.now() - started.current > DM_POLL_MAX_MS) return undefined;
    const t = setTimeout(load, DM_POLL_MS);
    return () => clearTimeout(t);
  }, [d]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!att) return null;
  if (init && init.error === 'ppt_binary') return <div className="co-dm co-dm-note">{reasonText('ppt_binary', lang)}</div>;
  if (init && init.error && !total) return <div className="co-dm co-dm-note is-warn">{reasonText(init.error, lang)}</div>;
  if (!total && !items.length) return null;
  const shown = items.filter((x) => x.kind !== 'audio');
  const sum = mediaSummaryOf(shown);
  const counts = ['ready', 'transcoding', 'pending', 'failed', 'external', 'skipped']
    .filter((k) => sum[k] > 0).map((k) => `${mt.st[k]} ${sum[k]}`).join(' · ');
  const mp = d && d.mapping ? (typeof d.mapping === 'string' ? { state: d.mapping } : d.mapping) : null;
  const lineOf = (x) => {
    const where = slidesText(x.slides, lang);
    if (x.status === 'external') return [where, mt.external(hostOf(x.url))].filter(Boolean).join(' · ');
    const st = mt.st[x.status] || x.status;
    const why = x.reason ? reasonText(x.reason, lang, { ext: x.srcExt }) : '';
    return [where, x.name, why && (x.status === 'failed' || x.status === 'skipped') ? `${st}${lang === 'en' ? ': ' : '：'}${why}` : st].filter(Boolean).join(' · ');
  };
  return (
    <div className="co-dm" role="status">
      <div className="co-dm-h">
        <span className="co-dm-title">{s.dmTitle(shown.length || total)}</span>
        {counts && <span className="co-dm-counts">{counts}</span>}
        <Button size="small" theme="borderless" icon={<IconRefresh />} loading={busy} onClick={load}>{s.dmRefresh}</Button>
      </div>
      {open && tState && tState !== 'ok' && (
        <div className="co-dm-wait">
          {s.dmWaiting}
          {onOpenOffice && <Button size="small" theme="borderless" onClick={onOpenOffice}>{s.dmOpenOffice}</Button>}
        </div>
      )}
      {mp && mp.state === 'mismatch' && <div className="co-dm-note is-warn">{mt.mismatch(mp.slides != null ? mp.slides : '?', mp.pages != null ? mp.pages : '?')}</div>}
      {err && <div className="co-dm-note is-warn">{s.dmLoadErr}</div>}
      {shown.length > 0 && (
        <ul className="co-dm-list">
          {shown.map((x) => (
            <li key={x.id} className={'co-dm-row' + (x.status === 'failed' ? ' is-warn' : '')} title={x.status === 'failed' ? mediaLine(x, lang) : undefined}>
              <span className="co-dm-text">{lineOf(x)}</span>
              {x.status === 'failed' && onOpenOffice && <Button size="small" theme="borderless" onClick={onOpenOffice}>{s.dmResolve}</Button>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// content-doc course -> UI view model (heading/html/videoEmbed -> title/body/videoUrl)
function normalizeCourse(c) {
  return {
    id: c.id,
    programId: c.programId,
    updatedAt: c.updatedAt || null,   // CX-042
    title: c.title,
    title_zh: c.title_zh,
    description: c.description,
    description_zh: c.description_zh,
    category: c.category || null,
    enrollType: c.enrollType || null,
    status: c.status || null,
    defaultDueDays: c.defaultDueDays || null,
    mode: c.mode || 'online',
    sessionAt: c.sessionAt || null,
    location: c.location || null,
    sessionNote: c.sessionNote || null,
    trainerId: c.trainerId || null,
    // 学时（第三批 1.2）：课程文档上的可选字段，三处（这里、serializeCourse、submitForm）都要带上，否则任何一次保存都会把它清掉
    hours: c.hours != null && c.hours !== '' && Number.isFinite(Number(c.hours)) ? Number(c.hours) : null,
    // 第四批 7：公开课程。旧服务端不带这个字段 → null（保存时不发，服务端「缺省 = 保留原值」）
    public: typeof c.public === 'boolean' ? c.public : null,
    modules: (c.modules || []).map((m) => ({
      id: m.id,
      title: m.title,
      title_zh: m.title_zh,
      minutes: m.minutes,
      sections: (m.sections || []).map((sec, i) => ({
        id: `${m.id}#${i}`,
        title: sec.heading,
        title_zh: sec.heading_zh,
        body: sec.html,
        body_zh: sec.html_zh,
        videoUrl: sec.videoEmbed || '',
        video: sec.video || '',
        attachments: sec.attachments || [],
        attach: (sec.attachments && sec.attachments[0] && sec.attachments[0].name) || '',
      })),
    })),
  };
}

// UI view model course -> content-doc shape for PUT /api/admin/content/courses/:id
function serializeCourse(course) {
  return {
    id: course.id,
    programId: course.programId,
    ...(course.updatedAt ? { updatedAt: course.updatedAt } : {}),   // CX-042 乐观锁：带回读到的保存时间
    title: course.title || '',   // CX-036：英文留空就留空，不复制中文
    title_zh: course.title_zh || null,
    description: course.description || null,
    description_zh: course.description_zh || null,
    category: course.category || null,
    enrollType: course.enrollType || 'mandatory',
    status: course.status || 'draft',
    defaultDueDays: course.defaultDueDays || 30,
    mode: course.mode || 'online',
    sessionAt: course.sessionAt || null,
    location: course.location || null,
    sessionNote: course.sessionNote || null,
    trainerId: course.trainerId || null,
    hours: clampHours(course.hours),
    ...(typeof course.public === 'boolean' ? { public: course.public } : {}),
    modules: (course.modules || []).map((m) => ({
      id: m.id,
      title: m.title || '',
      title_zh: m.title_zh || null,
      minutes: clampMinutes(m.minutes),
      sections: (m.sections || []).map((sec) => ({
        // CX-036：英文留空就留空；「留空则显示中文」由显示层（i18n loc）回退实现，不再复制中文。
        heading: sec.title || '',
        heading_zh: sec.title_zh || null,
        html: sec.body || '',
        html_zh: sec.body_zh || null,
        video: sec.video || null,
        videoEmbed: normalizeVideoUrl(sec.videoUrl),
        attachments: (sec.attachments || []).map((a) => ({ id: a.id, kind: a.kind, name: a.name, size: a.size })),
      })),
    })),
  };
}

// very small allow-list sanitizer for the preview (b/strong/i/em/br/p only)
function sanitize(html) {
  // 与服务端 sanitizeHtml 白名单对齐（编辑器产出：段落、换行、标题、加粗/斜体/下划线/删除线、列表、引用、链接、分隔线）
  return String(html)
    .replace(/<(script|style|iframe|object|embed)\b[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<(?!\/?(p|br|b|strong|i|em|u|s|ul|ol|li|h2|h3|h4|blockquote|code|pre|a|hr|span|div)\b)[^>]*>/gi, '')
    .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/href\s*=\s*(["'])\s*javascript:[^"']*\1/gi, 'href="#"');
}

function IconBtn({ icon, label, onClick, disabled, danger }) {
  return (
    <Tooltip content={label}>
      <Button
        theme="borderless" size="small" disabled={disabled}
        type={danger ? 'danger' : 'tertiary'}
        icon={icon} aria-label={label} onClick={onClick}
      />
    </Tooltip>
  );
}

// The lesson video: raw bytes to POST /api/admin/upload-video, which stores the
// file under public/videos and answers with its /videos/… path. That path goes
// into the section's `video` field and the learner page plays it inline.
function VideoUpload({ label, value, onDone, failMsg }) {
  const { lang } = useI18n();
  const s = T[lang];
  return (
    <Upload
      action="/api/admin/upload-video"
      limit={1}
      accept=".mp4,.webm,.m4v,.mov"
      customRequest={async ({ fileInstance, onSuccess, onError }) => {
        try {
          const res = await api.upload(
            `/api/admin/upload-video?name=${encodeURIComponent(fileInstance.name)}`, fileInstance);
          onDone(res.url);
          // Same trap as an attachment: stored, but only live once the section saves.
          Toast.info({ content: s.uploadedHint, duration: 4 });
          onSuccess(res, fileInstance);
        } catch (err) {
          Toast.error({ content: (err && err.message) || failMsg, duration: 3 });
          if (onError) onError({ message: (err && err.message) || failMsg });
        }
      }}
      onRemove={() => onDone('')}
      defaultFileList={value ? [{ uid: 'v0', name: value, status: 'success' }] : []}
    >
      <Button icon={<IconUpload />} theme="light">{label}</Button>
    </Upload>
  );
}

// Upload a protected course attachment: raw file bytes to POST /api/admin/attachments
// with ?name=&courseId= (NOT multipart / NOT JSON — see contract gotcha #7).
// Video files have their own block now (public/videos, played inline), so this
// slot takes the handouts: documents and audio.
// P0 1.3: PPT / Word / Excel are converted to a view-only PDF during the upload
// itself (the request stays open until LibreOffice finishes, up to ~2 minutes),
// and a file that can't be converted is rejected — never kept as a download.
// While the converter is unavailable (officeOk=false) the picker drops those
// extensions; the server stays the authority either way (422 + code).
const OFFICE_FILE = /\.(pptx?|docx?|xlsx?)$/i;
const ACCEPT_BASE = '.mp3,.m4a,.wav,.ogg,.pdf';
const ACCEPT_OFFICE = '.ppt,.pptx,.doc,.docx,.xls,.xlsx';
function SectionUpload({ label, courseId, value, onAttach, onClear, failMsg, officeOk = true }) {
  const { lang } = useI18n();
  const s = T[lang];
  const [converting, setConverting] = useState(false);
  const failText = (err) => {
    const status = err && err.status;
    const text = errText(err, {
      office_converter_unavailable: () => s.eOfficeOff,
      office_convert_failed: () => s.eConvFail,
      pdf_invalid: () => s.ePdfInvalid,
    });
    if (err && err.data && err.data.code) return text;
    // 413 / 422 without a code (older server or proxy) still get a sentence in the page's language.
    if (status === 413) return s.eTooLarge;
    if (status === 422) return s.eConvFail;
    return text || failMsg;
  };
  return (
    <>
      <Upload
        action="/api/admin/attachments"
        limit={1}
        accept={officeOk ? `${ACCEPT_BASE},${ACCEPT_OFFICE}` : ACCEPT_BASE}
        onAcceptInvalid={() => Toast.error({ content: s.acceptInvalid, duration: 5 })}   // CX-037：绕过 accept 选了 Office 等文件也要有提示
        customRequest={async ({ fileInstance, onSuccess, onError }) => {
          const office = OFFICE_FILE.test(fileInstance.name || '');
          if (office) setConverting(true);
          try {
            const q = new URLSearchParams({ name: fileInstance.name, courseId: courseId || '' }).toString();
            const res = await api.upload(`/api/admin/attachments?${q}`, fileInstance);
            // 第三批 5.7：.pptx 的上传响应带 media（课件内视频清单），交给附件区的 DeckMedia 显示；保存小节时不随课程文档写回
            onAttach({ id: res.id, kind: res.kind, name: res.originalName || fileInstance.name, size: res.size, media: res.media || null });
            // The file is stored, but it only reaches learners after the section
            // itself is saved — people were closing the sheet here and losing it.
            Toast.info({ content: s.uploadedHint, duration: 4 });
            onSuccess(res, fileInstance);
          } catch (err) {
            const msg = failText(err);
            Toast.error({ content: msg, duration: 5 });
            if (onError) onError({ message: msg });
          } finally {
            if (office) setConverting(false);
          }
        }}
        onRemove={() => onClear()}
        defaultFileList={value ? [{ uid: 'v0', name: value, status: 'success' }] : []}
      >
        <Button icon={<IconUpload />} theme="light" loading={converting}>{label}</Button>
      </Upload>
      {converting && (
        <div className="co-oc-converting" role="status"><Spin size="small" /><span>{s.converting}</span></div>
      )}
    </>
  );
}
