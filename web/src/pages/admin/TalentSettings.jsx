// Talent settings 设置 — the customization home (HRIS groundwork):
//   1. Record types & their fields (add/rename/options/required/visible/filterable/order)
//      incl. the reserved "user" pseudo-type = custom EMPLOYEE fields (→ users.extras)
//   2. Job grade system (dual M/P track) + the promotion criteria it feeds
// Departments moved out to their own page (/admin/departments).
// Every change takes effect immediately across the profile page, record editor,
// timeline filters and CSV import/export columns.
import { useMedia } from '../../useMedia.js';
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Button, Input, Select, Checkbox, Switch, Tag, Space, Toast, Banner, Spin, Popconfirm, Typography, Table, Empty, InputNumber, Modal,
} from '@douyinfe/semi-ui';
import { IconPlus, IconArrowUp, IconArrowDown, IconDelete, IconEdit } from '@douyinfe/semi-icons';
import { api, useAsync } from '../../api.js';
import { useAuth } from '../../auth.jsx';
import { useI18n } from '../../i18n.jsx';
import { SettingsWorkspace } from '../../v2.jsx';
import { canReadDomain, canWriteDomain, modOn } from '../../rbac.js';
import { IcWarn } from '../../components/LineIcons.jsx';

const { Text } = Typography;

const T = {
  zh: {
    title: '档案与职级设置', lead: '记录类型、字段、职级体系都在这里自定义——改动立即生效：添加记录表单、时间线显示、筛选、导入导出列全部跟随。',
    userTab: '员工档案字段', newType: '新建记录类型', typeName: '类型名', typeCreate: '创建',
    userHint: '这里的字段出现在每个员工档案的「编辑资料」里，存入员工主数据——HRIS 扩展点（如证件号、紧急联系人、银行账户）。',
    builtinHint: '内置类型（可停用，不可删除）', delType: '删除该类型及其字段配置？', delTypeDesc: '该类型已存的历史记录数据仍保留在库里，但不再显示图标与字段定义。',
    renameType: '改类型名', renameField: '改字段名', save: '保存',
    nameZh: '中文名', nameEn: '英文名 (English)',
    nameZhPh: '如：绩效', nameEnPh: 'e.g. Performance',
    renameHint: '两个名字只填一个也行 —— 另一种语言会回落到它。界面按当前语言显示。',
    renameNeedOne: '至少填一个名字',
    optTitle: '选项', optEdit: '修改选项', optEmpty: '未设置选项，点击添加', optAdd: '添加选项',
    optDescZh: '说明（中文，选填）', optDescEn: '说明（英文，选填）',
    optDescHint: '选项说明会在上级评级与 HR 校准的评级按钮上悬停显示；绩效评级各档的说明请按公司绩效制度填写（灰色文字是方案建议，仅作参考，不会自动保存）。',
    optZhPh: '如：轻微', optEnPh: '如：Minor',
    optHint: '一行一个选项，中英文成对、同序。只填一个也行 —— 另一种语言会回落到它。',
    optStoreHint: '英文名同时是存进记录里的值：改它会让已存的历史记录对不上这个选项；中文名只影响显示。',
    optMismatch: (zh, en) => `中文 ${zh} 项、英文 ${en} 项，数量不一致 —— 缺的那几项先按英文显示。保存后按下面这张列表重新对齐。`,
    optDup: (v) => `英文名「${v}」重复了 —— 它是存进记录里的值，必须唯一。`,
    thField: '字段名', thInput: '类型', thOptions: '选项', thReq: '必填', thShow: '时间线', thFilter: '可筛选', thOps: '',
    // 是否发给 AI（AI 治理方案 2.2.1 第 5 条）
    thAi: '发送给 AI', aiShare: { send: '原样', mask: '脱敏', omit: '不发' },
    aiShareTip: '人才画像是否发送该字段：原样 / 脱敏（去除标识与敏感话题）/ 不发。扩大发送范围只限超级管理员，每次变更记审计；其他账号只能改严。',
    aiShareNever: '该类记录整条不发送给 AI（离职、HR 备注）。',
    thShowLong: '时间线显示', dragHint: '拖动可调整字段顺序',
    addFieldPh: '新字段名，如：带教人、紧急联系人', addField: '添加字段',
    inputText: '文本', inputNumber: '数字', inputDate: '日期', inputSelect: '下拉', inputSuggest: '联想', inputTextarea: '多行', inputCheckbox: '勾选',
    hint: '开关说明：必填 = 保存时校验 · 时间线 = 出现在时间线卡片 · 可筛选 = 进入档案的字段筛选栏。删除字段不影响已存的历史数据。',
    active: '启用', saved: '已保存', deleted: '已删除', noFields: '该类型还没有字段 — 用右上角「加字段」添加。',
    /* 只读档没有「加字段」按钮,空态不能再叫人去点它。 */
    noFieldsRo: '该类型还没有字段。',
    loadFail: '加载失败，请刷新页面重试。', delete: '删除', cancel: '取消',
    deskOnly: '字段增删与职级体系建议在桌面端编辑。',
    // 第五批 8.1：晋升条件改为「人才盘点 › 晋升评审候选」的内置筛选条件，本卡只作说明与跳转
    promoTitle: '晋升条件', promoLead: '晋升条件已改为「人才盘点 › 晋升评审候选」的筛选条件：在那里设置条件、查看逐人核对结果，并可手动加入或写明理由排除。',
    promoGo: '前往晋升评审候选',
    empVis: '员工可见', gTitle: '职级体系', gLead: '双通道：M 管理通道、P 专业通道。每个职级对应一个职等和一个序号；晋升顺序按同一通道内的序号自动排列，全站职级下拉均读取此处。', gAdd: '添加一行', gTrackM: 'M · 管理通道', gTrackP: 'P · 专业通道', gSaved: '职级体系已保存',
    empVisHint: '「员工可见」开启后，这一类型的记录会出现在员工本人的成长档案中；违纪、离职、备注类记录建议保持隐藏。', mgrVis: '经理可见', mgrHidden: '经理不可见',
    mgrVisHint: '「经理可见」关闭后，这一类型的记录不会出现在经理（含整条汇报线上的上级）查看的下属档案中，仅在管理后台可见。',
    gSave: '保存职级体系', gUnsaved: '有未保存的修改', delRank: '删除该职级？', delRankDesc: '全站职级下拉都读这张表，点「保存职级体系」后才真正生效。',
    gThRank: '职级', gThGrade: '职等', gThLevel: '序号',
    fieldCfg: (n) => `字段配置（${n} 个字段）`, offTag: '已停用', disable: '停用', restore: '恢复', moveUp: '上移', moveDown: '下移', rename: '重命名',
    promoStat: (n, pct) => `按当前条件：${n} 人列为晋升评审候选（占在职人数 ${pct}%）`,
    gOffCatalog: (n) => `当前有 ${n} 名员工的职级未纳入职级体系，无法核对其晋升条件`,
    gNoLevelPart: (n) => `（其中 ${n} 人未设职级）`,
    /* 只读档(fields=read):记录类型/字段/职级的所有写接口在服务端都会吃 403,
       所以这一页按「只读视图」渲染(与手机端同一套只读卡片),并说明原因。 */
    roFields: '你的角色对「档案与职级设置」是只读权限：记录类型、字段与职级体系只能查看，不能新增、修改或删除。需要改动请联系超级管理员。',
    /* 晋升条件卡的接口(GET/PUT promotion-config、GET promotion-candidates)属
       人才发展域,不是本页的字段域 —— 跨域,所以单独判。 */
    roPromoHidden: '晋升条件属于「人才发展」能力域，你的角色无权查看，已隐藏。',
    roPromoRead: '晋升条件属于「人才发展」能力域，你的角色在该能力域只有只读权限：晋升评审候选的条件只能查看，不能修改。',
  },
  en: {
    title: 'Profile & Job Level Settings', lead: 'Record types, fields and the Job Level Framework are customized here — changes apply immediately to the record form, timeline, filters and CSV columns.',
    userTab: 'Employee profile fields', newType: 'New record type', typeName: 'Type name', typeCreate: 'Create',
    userHint: 'Fields here appear in every employee’s "Edit info" form and are stored on the employee master record — the HRIS extension point (IDs, emergency contact, bank account).',
    builtinHint: 'Built-in type (can be disabled, not deleted)', delType: 'Delete this type and its field config?', delTypeDesc: 'Existing records of this type stay in the database but lose their field definitions.',
    renameType: 'Rename type', renameField: 'Rename field', save: 'Save',
    nameZh: 'Chinese name', nameEn: 'English name',
    nameZhPh: 'e.g. 绩效', nameEnPh: 'e.g. Performance',
    renameHint: 'One name is enough — the other language falls back to it. The UI shows whichever matches the current language.',
    renameNeedOne: 'Enter at least one name',
    optTitle: 'Options', optEdit: 'Edit options', optEmpty: 'No options yet. Click to add.', optAdd: 'Add option',
    optDescZh: 'Description (Chinese, optional)', optDescEn: 'Description (English, optional)',
    optDescHint: 'Option descriptions appear as hover hints on the rating buttons used by managers and in HR calibration. Write the performance rating descriptions according to the company performance policy (the grey text is a suggestion only and is not saved).',
    optZhPh: 'e.g. 轻微', optEnPh: 'e.g. Minor',
    optHint: 'One option per row — the two languages are paired and stay in the same order. One name is enough; the other language falls back to it.',
    optStoreHint: 'The English name is also the value stored on every record: renaming it leaves existing records pointing at an option that no longer exists. The Chinese name only affects display.',
    optMismatch: (zh, en) => `${zh} Chinese options against ${en} English ones — the untranslated ones fall back to English. Saving re-aligns them to the list below.`,
    optDup: (v) => `"${v}" appears twice — the English name is the stored value, so it has to be unique.`,
    thField: 'Field', thInput: 'Type', thOptions: 'Options', thReq: 'Required', thShow: 'Timeline', thFilter: 'Filterable', thOps: '',
    thAi: 'Sent to AI', aiShare: { send: 'As is', mask: 'Masked', omit: 'Not sent' },
    aiShareTip: 'Whether the talent portrait sends this field: as is / masked (identifiers and sensitive topics removed) / not sent. Only a super admin can widen it, and each change is audited; others can only make it stricter.',
    aiShareNever: 'Records of this type are never sent to AI (exit, HR note).',
    thShowLong: 'Shown on timeline', dragHint: 'Drag to reorder fields',
    addFieldPh: 'New field, e.g. Mentor / Emergency contact', addField: 'Add field',
    inputText: 'Text', inputNumber: 'Number', inputDate: 'Date', inputSelect: 'Select', inputSuggest: 'Suggest', inputTextarea: 'Textarea', inputCheckbox: 'Checkbox',
    hint: 'Required = validated on save · Timeline = shown on timeline cards · Filterable = appears in the profile filter bar. Deleting a field never touches stored history.',
    active: 'Active', saved: 'Saved', deleted: 'Deleted', noFields: 'No fields yet — use "Add field" in the card header.',
    noFieldsRo: 'No fields yet.',
    loadFail: 'Couldn’t load. Refresh the page to try again.', delete: 'Delete', cancel: 'Cancel',
    deskOnly: 'Adding or removing fields and editing the grade system are best done on a desktop.',
    promoTitle: 'Promotion Criteria', promoLead: 'Promotion criteria are now the conditions of the Talent Review › Promotion Panel Candidates filter. Set the conditions there, review the per-employee results, and add employees manually or exclude them with a reason.',
    promoGo: 'Go to Promotion Panel Candidates',
    empVis: 'Employee-visible', gTitle: 'Job Level Framework', gLead: 'Two tracks: M Management and P Professional. Each job level has a grade and a sequence number; the promotion order follows the sequence within a track, and every job level list reads from here.', gAdd: 'Add row', gTrackM: 'M · Management', gTrackP: 'P · Professional', gSaved: 'Job Level Framework saved',
    empVisHint: 'With Employee-visible on, records of this type appear in the employee’s own Development Record. Keep disciplinary, separation and note records hidden.', mgrVis: 'Visible to managers', mgrHidden: 'Hidden from managers',
    mgrVisHint: 'With Visible to managers off, records of this type do not appear in subordinate profiles viewed by managers (including higher-level managers in the reporting line) and remain visible in the admin console only.',
    gSave: 'Save Job Level Framework', gUnsaved: 'Unsaved changes', delRank: 'Delete this rank?', delRankDesc: 'Every job-level dropdown reads this table; the delete only lands once you hit Save.',
    gThRank: 'Job Level', gThGrade: 'Grade', gThLevel: 'Sequence',
    fieldCfg: (n) => `Field config (${n} field${n === 1 ? '' : 's'})`, offTag: 'Disabled', disable: 'Disable', restore: 'Restore', moveUp: 'Move up', moveDown: 'Move down', rename: 'Rename',
    promoStat: (n, pct) => `Under the current conditions: ${n} employee${n === 1 ? ' is a' : 's are'} promotion panel candidate${n === 1 ? '' : 's'} (${pct}% of active headcount)`,
    gOffCatalog: (n) => `${n} employee${n === 1 ? ' has a job level' : 's have job levels'} not in the Job Level Framework, so their promotion criteria cannot be checked.`,
    gNoLevelPart: (n) => `(${n} of them have no job level at all)`,
    roFields: 'Your role has read-only access to Profile & Job Level Settings: record types, fields and the Job Level Framework can be reviewed but not added, changed or deleted. Ask a Super Admin to make changes.',
    roPromoHidden: 'Promotion criteria belong to the Talent Development capability domain, which your role cannot read, so the card is hidden.',
    roPromoRead: 'Promotion criteria belong to the Talent Development capability domain, where your role is read-only: the Promotion Panel Candidates conditions can be reviewed but not changed.',
  },
};

const INPUT_KEYS = ['text', 'number', 'date', 'select', 'suggest', 'textarea', 'checkbox'];
const HAS_OPTIONS = (input) => input === 'select' || input === 'suggest';

/* An option is a PAIR. options[i] is the value written into every record (and
   the English display name); options_zh[i] is a display name only. Read per
   ITEM, never per array: a field whose options_zh is missing or shorter has to
   fall back to English on those items instead of shifting every label by one. */
const optLabel = (f, i, lang) => {
  const en = (f.options || [])[i];
  const zh = (f.options_zh || [])[i];
  return (lang === 'zh' ? zh || en : en) || '';
};
// Equal length is the contract, not a guarantee — half-translated data predates
// it — and a silently truncated Chinese list is exactly what the ⚠ is for.
const optMismatched = (f) => {
  const zh = (f.options_zh || []).length;
  return zh > 0 && zh !== (f.options || []).length;
};
// The dialog's own grid: 序号 / 中文 / 英文 / 删除. Inline because app.css is
// shared with the rest of the console and this grid has exactly one user.
const OPT_GRID = { display: 'grid', gridTemplateColumns: '20px 1fr 1fr 30px', gap: 8, alignItems: 'center' };
// 绩效评级各档说明（D-14）：2026-09-30 负责人提供正式说明，由数据迁移 61 写入；这里只作输入框的灰色占位提示 ——
// 具体表述由负责人按公司绩效制度确定后在本对话框填写。
const RATING_DESC_SUGGEST = {
  'A+': ['远超预期：关键绩效指标持续表现优异，主动承担项目并取得重大成果，对组织产生积极影响，展现出战略创新能力与组织影响力。', 'Far Exceeds Expectations: Continuously perform well on Key Performance Indicators, proactively undertake projects and achieve significant results, have a positive impact on the organization, and demonstrate strategic innovation and organizational influence.'],
  A: ['超出预期：大部分关键绩效指标表现突出，成果质量明显高于岗位要求；主动创新、主动解决问题并推动团队绩效提升，展现出高度的责任感与专业成熟度。', 'Exceeds Expectations: Outstanding performance on most Key Performance Indicators, with significantly higher quality results than job requirements; proactive innovation, proactive problem-solving, and driving team performance improvement, demonstrating a high sense of responsibility and professional maturity.'],
  'B+': ['部分超出预期：在特定项目或领域表现稳定且突出，具备发展潜力与积极态度，是团队中可靠且持续成长的成员。', 'Exceeds Partial Expectations: Stable and outstanding performance in specific projects or fields, with development potential and positive attitude, is a reliable and growing member of the team.'],
  B: ['达到预期：稳定履行岗位职责、完成目标要求，绩效符合公司标准，是有价值的贡献者。', 'Meets expectations: Consistent completion of job responsibilities and target requirements, performance meets company standards, and is a valuable contributor.'],
  C: ['低于预期：部分关键任务未达到标准，绩效或成果质量不稳定。', 'Below Expectations: Failure to meet standards for some key tasks, inconsistent performance or quality of results.'],
  D: ['需要改进：绩效远低于要求，多数任务未达到标准或对团队产生负面影响，需要立即进行绩效辅导或调整。', 'Needs Improvement: Performance is far below requirements, most tasks are not up to standard or have a negative impact on the team, immediate performance coaching or adjustment is needed.'],
};

/* A {zh, en} name draft → the paired label / label_zh the server stores. Either
   name alone is enough; the missing language falls back to the one that was
   typed, which is what loc() does at render time anyway. Returns null when both
   are blank so the caller can refuse to save instead of creating an unnamed row.
   Shared by create and rename: the two must never disagree about the rule. */
const namePayload = ({ zh, en }) => {
  const z = String(zh || '').trim();
  const e = String(en || '').trim();
  if (!z && !e) return null;
  return { label: e || z, label_zh: z || e };
};

// A field row is eight columns of controls; below ~900px they cannot be laid out
// without either a magnifying glass or horizontal scrolling. Design 23 answers
// this with a read-only phone variant (「手机 390 · 只读为主」), so the breakpoint
// is read in JS and the narrow branch renders badges instead of inputs.
const NARROW_Q = '(max-width:900px)';
const useNarrow = () => useMedia(NARROW_Q);

// 是否发给 AI 的三档（从严到宽）；离职与 HR 备注整条不发（画像输入构建器硬编码排除）
const AI_RANK = { omit: 0, mask: 1, send: 2 };
const AI_NEVER = new Set(['exit', 'note']);
// 8.3 经理可见（迁移 71）：接口布尔字段 managerVisible，兼容 0/1 的 mgrVis；两者都没有时按迁移默认值（备注关、其余开）
const mgrVisibleOf = (t) => (t.managerVisible !== undefined ? !!t.managerVisible : t.mgrVis !== undefined ? !!t.mgrVis : t.key !== 'note');

export default function TalentSettings() {
  const { lang, loc } = useI18n();
  const s = T[lang];
  const narrow = useNarrow();
  // Module switches from the /api/me payload — a payload without `modules`
  // (an older server) means all on. The promotion block is talent-owned
  // (裁定②). 第五批 8.1：晋升条件的编辑移到人才盘点的内置筛选，模块关闭的叶子由服务端判为「忽略」，
  // 本页不再按 performance / learning 收起门槛。
  const { user } = useAuth();
  const mods = user && user.modules;
  const talentOn = modOn(mods, 'talent');
  // ai 模块默认关闭：只有显式 true 才显示「发送给 AI」列（方案 5.3 TalentSettings）
  const aiOn = modOn(mods, 'ai');
  const superAdmin = !!(user && (user.isSuperAdmin || !user.grants));
  /* 授权闸门,与模块开关叠加(两个都要过)。本页所属域是 fields:记录类型、字段、
     职级体系的写接口都在 fields 写里,read 档发过去必然 403 —— 所以 fields 只有
     read 时整页按只读视图渲染(复用手机端那套只读卡片)。
     晋升条件那张卡是**跨域**的:GET/PUT /api/admin/promotion-config 与
     GET /api/admin/promotion-candidates 都属 talent 域(RBAC-ROUTE-MATRIX.md
     「人才发展」段),fields=manage 的角色照样可能 talent=none —— 那就 404,卡片
     不能显示。老服务(无 grants)与超管:三个值全 true,与改动前完全一致。 */
  const fieldsWrite = canWriteDomain(user, 'fields');
  const talentRead = canReadDomain(user, 'talent');
  const talentWrite = canWriteDomain(user, 'talent');
  const cfgQ = useAsync(() => api.get('/api/admin/config/records'), []);
  // One shared read for both bottom cards: this endpoint walks every employee ×
  // every assignment, so the grade warning and the promotion tally must not each
  // pay for it. Reloaded only when a threshold or the grade catalogue changes.
  // talent off = the endpoint is gone and neither consumer renders, so skip it.
  // talent unreadable = the gate 404s it for this role — same skip, same reason.
  const candQ = useAsync(
    () => ((talentOn && talentRead) ? api.get('/api/admin/promotion-candidates') : Promise.resolve(null)),
    [talentOn, talentRead],
  );
  const [sel, setSel] = useState(null);
  const [newType, setNewType] = useState(null); // {zh, en, color} | null
  const [adding, setAdding] = useState(false); // add-field row, opened from the card header
  // Two names on creation, not one. A single box meant whatever the creator
  // typed became BOTH labels, so a type/field named in Chinese by an HR user
  // stayed Chinese forever in the English console — and the rename dialog was
  // the only place that could ever fix it. Same draft shape and same rule as
  // `rename` below: either name alone is enough, the other falls back to it.
  const [addName, setAddName] = useState({ zh: '', en: '' });
  const [addInput, setAddInput] = useState('text');
  const [dragId, setDragId] = useState(null); // field being dragged by its ⋮⋮ grip
  const [overId, setOverId] = useState(null);
  // Renaming — types and fields alike — happens in one dialog rather than inline.
  // Both names need a label to be usable ("中" crammed into an input read as part
  // of the value), and the row has no room for two boxes without crushing
  // everything beside them. `rename` holds the draft; null = dialog closed.
  // Declared up here with the other hooks, NOT next to saveRename below: the
  // early `if (!cfg) return` guard sits between the two, and a hook after it
  // runs only on the loaded render — React error #310, blank page.
  const [rename, setRename] = useState(null);
  // Options move into a dialog for the same two reasons the names did: an option
  // is a zh/en PAIR, and the field row has no eighth-and-a-half column to put a
  // second control in. The dialog is also the only place where "equal length,
  // same order" is visible AS pairing. Hook stays up here with the others — the
  // `if (!cfg) return` guard below would make it conditional (React #310).
  const [optEdit, setOptEdit] = useState(null); // {id, label, rows:[{zh,en}], mismatch} | null

  // 所属模块未开启的记录类型（moduleOff，例如 culture 关闭时的「行为实践」，服务端 recordTypesOut 标出）不在字段设置里列出；
  // 它由 core 种入、已有记录照常显示，模块开启后在这里重新出现。
  const cfg = useMemo(
    () => (cfgQ.data ? { ...cfgQ.data, types: (cfgQ.data.types || []).filter((t) => !t.moduleOff) } : cfgQ.data),
    [cfgQ.data],
  );
  /* 只读视图 = 手机版那套只读渲染,再加上「fields 只有 read」这一种情况。设计 23
     的手机变体本来就是「只读为主」,只读档要的正是同一个东西 —— 与其新写一套禁用
     态,不如共用它:两种情况下能看的信息完全一样。 */
  const roView = narrow || !fieldsWrite;
  const inputLabel = (k) => s['input' + String(k).charAt(0).toUpperCase() + String(k).slice(1)] || k;
  const inputOpts = INPUT_KEYS.map((k) => ({ label: inputLabel(k), value: k }));
  const selKey = sel || (cfg && cfg.types.length ? cfg.types[0].key : 'user');
  // 行为实践（3+3 不涉及 AI）与员工自定义字段（任何功能都不发）不显示「发送给 AI」列（须在 selKey 声明之后，否则 AI 开启时报 TDZ）
  const showAiCol = aiOn && selKey !== 'culture-program' && selKey !== 'user';
  const selType = cfg ? cfg.types.find((t) => t.key === selKey) : null;
  const fields = useMemo(() => (cfg ? cfg.fields.filter((f) => f.typeKey === selKey) : []), [cfg, selKey]);

  if (cfgQ.error) return <div className="wrap tset-wrap"><Banner type="danger" closeIcon={null} description={`${s.loadFail} · ${cfgQ.error.message}`} /></div>;
  if (!cfg) return <div className="wrap tset-wrap" style={{ textAlign: 'center', paddingTop: 80 }}><Spin size="large" /></div>;

  // CX-143：删除类调用传 okMsg = s.deleted（原来一律提示「已保存」）
  const call = async (fn, okMsg) => { try { await fn(); Toast.success(okMsg || s.saved); } catch (err) { Toast.error(err.message); } cfgQ.reload(); };
  const patchField = (id, patch) => call(() => api.put(`/api/admin/config/record-fields/${id}`, patch));
  // Renumber 0..n instead of swapping the two neighbours' sort values: seeded
  // and imported fields routinely share a sort, and swapping equal numbers
  // moves nothing (the server tie-breaks on rowid, which we can't influence).
  const applyOrder = (next) => call(async () => {
    for (let k = 0; k < next.length; k++) {
      if (next[k].sort !== k) await api.put(`/api/admin/config/record-fields/${next[k].id}`, { sort: k });
    }
  });
  const reorder = (from, to) => {
    if (from < 0 || to < 0 || from === to || !fields[from] || !fields[to]) return;
    const next = fields.slice();
    next.splice(to, 0, ...next.splice(from, 1));
    applyOrder(next);
  };
  // Arrows stay alongside the drag grip: dragging is pointer-only, and reordering
  // must remain reachable from the keyboard.
  const moveField = (f, dir) => {
    const i = fields.findIndex((x) => x.id === f.id);
    reorder(i, i + dir);
  };
  const dropOn = (targetId) => {
    if (dragId === null) return;
    reorder(fields.findIndex((x) => x.id === dragId), fields.findIndex((x) => x.id === targetId));
    setDragId(null); setOverId(null);
  };
  const saveRename = () => {
    const payload = namePayload(rename);
    if (!payload) { Toast.warning(s.renameNeedOne); return; }
    if (rename.kind === 'type') {
      const t = cfg.types.find((x) => x.key === rename.id);
      call(() => api.post('/api/admin/config/record-types', { ...t, ...payload }));
    } else {
      patchField(rename.id, payload);
    }
    setRename(null);
  };
  const openOptions = (f) => setOptEdit({
    id: f.id,
    label: loc(f, 'label'),
    // one row per STORED option, so the rows are the alignment; an untranslated
    // option opens with an empty Chinese box rather than a guessed one
    // 绩效评级字段在说明框里显示 IA 4.8 的建议文字作占位
    rating: f.typeKey === 'performance' && f.key === 'rating',
    rows: (f.options || []).length
      ? f.options.map((o, i) => ({ en: o, zh: (f.options_zh || [])[i] || '', dz: (f.options_desc_zh || [])[i] || '', de: (f.options_desc || [])[i] || '' }))
      : [{ en: '', zh: '', dz: '', de: '' }],
    mismatch: optMismatched(f) ? { zh: (f.options_zh || []).length, en: (f.options || []).length } : null,
  });
  const optRow = (i, k, v) => setOptEdit((o) => ({ ...o, rows: o.rows.map((r, j) => (j === i ? { ...r, [k]: v } : r)) }));
  const saveOptions = () => {
    // Same rule as namePayload: either language alone is enough and the other
    // falls back to it, so a row with neither is just an empty row and drops.
    const rows = optEdit.rows
      .map((r) => ({ zh: String(r.zh || '').trim(), en: String(r.en || '').trim(), dz: String(r.dz || '').trim(), de: String(r.de || '').trim() }))
      .filter((r) => r.zh || r.en);
    const options = rows.map((r) => r.en || r.zh);
    // Duplicates are refused rather than merged: options[i] is what lands in
    // talent_records.detail, so two rows sharing one value make their two
    // Chinese labels indistinguishable on the way back out.
    const dup = options.find((o, i) => options.indexOf(o) !== i);
    if (dup) { Toast.warning(s.optDup(dup)); return; }
    // options_zh goes out equal-length and same-order by construction; the
    // server still re-aligns it against options, which is why a mismatch
    // warning above never has to block the save.
    // 选项说明（迁移 56）与选项同序、等长
    patchField(optEdit.id, { options, options_zh: rows.map((r) => r.zh || r.en), options_desc_zh: rows.map((r) => r.dz), options_desc: rows.map((r) => r.de) });
    setOptEdit(null);
  };

  return (
    <div className="wrap tset-wrap">
      <div className="tset-head">
        <div><h1 className="tset-title">{s.title}</h1><div className="tset-lead">{s.lead}</div></div>
      </div>

      {/* ---- type menu (left) + selected type editor (right) ---- */}
      <div className="ppl-card">
        <div className="tset-cols">
        <aside className="tset-menu">
          {cfg.types.map((t) => (
            <button key={t.key} className={'adm-nav-item' + (selKey === t.key ? ' on' : '') + (t.active ? '' : ' tset-off')} onClick={() => setSel(t.key)}>
              <span className="tset-dot" style={{ background: t.color || 'var(--ink-3)' }} aria-hidden="true" />{loc(t, 'label')}
            </button>
          ))}
          <button className={'adm-nav-item' + (selKey === 'user' ? ' on' : '')} onClick={() => setSel('user')}><span className="tset-dot tset-dot-user" aria-hidden="true" />{s.userTab}</button>
          {/* A record type is identified by its name and colour. There is no icon at all
              any more — the column itself is gone as of migration 43, because a dead one
              only invites emoji back in. */}
          {!roView && (
            <Button className="tset-newtype" size="small" icon={<IconPlus />} theme="light" style={{ marginTop: 8 }} onClick={() => setNewType({ zh: '', en: '', color: '#00a2c8' })}>{s.newType}</Button>
          )}
        </aside>
        <div className="tset-content">

      <div className="tset-secth">
        <span className="tset-secth-t">{selKey === 'user' ? s.userTab : (selType ? loc(selType, 'label') : '')}</span>
        <span className="tset-secth-n">· {s.fieldCfg(fields.length)}</span>
        {selType && selType.employeeVisible && <span className="pill ok">{s.empVis}</span>}
        {selType && !mgrVisibleOf(selType) && <span className="pill muted">{s.mgrHidden}</span>}
        {selType && !selType.active && <span className="pill muted">{s.offTag}</span>}
        {!roView && !adding && (
          <Button className="tset-secth-add" size="small" theme="light" icon={<IconPlus />} onClick={() => setAdding(true)}>{s.addField}</Button>
        )}
      </div>

      {newType && (
        <>
          {/* Both names up front, with the rename dialog's own labels and
              placeholders, so a type is never born half-named. The row has no
              vertical room for stacked labels, so each box carries its label as
              placeholder + aria-label and the shared hint sits underneath. */}
          <div className="tset-row tset-add">
            <Input value={newType.zh} placeholder={s.nameZh} aria-label={`${s.typeName} · ${s.nameZh}`}
              onChange={(v) => setNewType({ ...newType, zh: v })} style={{ flex: 1, minWidth: 130 }} />
            <Input value={newType.en} placeholder={s.nameEn} aria-label={`${s.typeName} · ${s.nameEn}`}
              onChange={(v) => setNewType({ ...newType, en: v })} style={{ flex: 1, minWidth: 130 }} />
            <input type="color" value={newType.color} onChange={(e) => setNewType({ ...newType, color: e.target.value })} className="tset-color" />
            <Button theme="solid" type="primary" size="small" onClick={() => {
              const payload = namePayload(newType);
              if (!payload) { Toast.warning(s.renameNeedOne); return; }
              call(async () => {
                const r = await api.post('/api/admin/config/record-types', { ...payload, color: newType.color });
                setSel(r.type.key);
                setNewType(null);
              });
            }}>{s.typeCreate}</Button>
            <Button size="small" theme="borderless" onClick={() => setNewType(null)}>{s.cancel}</Button>
          </div>
          <div className="tset-renamehint">{s.renameHint}</div>
        </>
      )}
        {selKey === 'user' ? (
          <Banner type="info" closeIcon={null} description={s.userHint} className="tset-userhint" />
        ) : selType && !roView && (
          <div className="tset-row tset-typebar">
            {/* Name as text + one edit affordance, same as the field rows below. */}
            <span className="tset-fname tset-typename">
              <b className="tset-fname-t" title={`${selType.label_zh || ''} / ${selType.label}`}>{loc(selType, 'label')}</b>
              <Button size="small" theme="borderless" className="tset-fname-edit" icon={<IconEdit />} aria-label={s.rename} title={s.rename}
                aria-label={s.renameType} title={s.renameType}
                onClick={() => setRename({ kind: 'type', id: selType.key, zh: selType.label_zh || '', en: selType.label || '' })} />
            </span>
            <input type="color" className="tset-color" value={/^#[0-9a-fA-F]{6}$/.test(selType.color || '') ? selType.color : '#86909c'}
              onChange={(e) => call(() => api.post('/api/admin/config/record-types', { ...selType, color: e.target.value }))} />
            <span className="tset-tog"><Switch size="small" checked={selType.active} onChange={(v) => call(() => api.post('/api/admin/config/record-types', { ...selType, active: v }))} /> {s.active}</span>
            {/* what this switch does is spelled out in the card footnote below, not in a tooltip */}
            <span className="tset-tog"><Switch size="small" checked={selType.employeeVisible} onChange={(v) => call(() => api.post('/api/admin/config/record-types', { ...selType, employeeVisible: v }))} /> {s.empVis}</span>
            <span className="tset-tog"><Switch size="small" checked={mgrVisibleOf(selType)} onChange={(v) => call(() => api.post('/api/admin/config/record-types', { ...selType, managerVisible: v, mgrVis: v ? 1 : 0 }))} /> {s.mgrVis}</span>
            {selType.builtin
              ? <Text type="tertiary" size="small">{s.builtinHint}</Text>
              : (
                <Popconfirm title={s.delType} content={s.delTypeDesc} okType="danger" okText={s.delete} cancelText={s.cancel}
                  onConfirm={() => call(async () => { await api.del(`/api/admin/config/record-types/${selType.key}`); setSel(null); }, s.deleted)}>
                  <Button size="small" type="danger" theme="borderless" icon={<IconDelete />} aria-label={s.delete} title={s.delete} />
                </Popconfirm>
              )}
          </div>
        )}

        {adding && !roView && (
          <>
            <div className="tset-row tset-add">
              <Input value={addName.zh} placeholder={s.nameZh} aria-label={`${s.addField} · ${s.nameZh}`} autoFocus
                onChange={(v) => setAddName((n) => ({ ...n, zh: v }))} style={{ flex: 1.3, minWidth: 150 }} />
              <Input value={addName.en} placeholder={s.nameEn} aria-label={`${s.addField} · ${s.nameEn}`}
                onChange={(v) => setAddName((n) => ({ ...n, en: v }))} style={{ flex: 1.3, minWidth: 150 }} />
              <Select value={addInput} optionList={inputOpts} style={{ width: 108 }} onChange={setAddInput} />
              <Button theme="solid" type="primary" size="small" icon={<IconPlus />} onClick={() => {
                const payload = namePayload(addName);
                if (!payload) { Toast.warning(s.renameNeedOne); return; }
                call(async () => {
                  await api.post('/api/admin/config/record-fields', { typeKey: selKey, ...payload, input: addInput });
                  setAddName({ zh: '', en: '' }); // stay open: fields are usually added several at a time
                });
              }}>{s.addField}</Button>
              <Button size="small" theme="borderless" onClick={() => { setAdding(false); setAddName({ zh: '', en: '' }); }}>{s.cancel}</Button>
            </div>
            {/* The name example used to live in the (now label-bearing) placeholder. */}
            <div className="tset-renamehint">{s.addFieldPh} · {s.renameHint}</div>
          </>
        )}

        {fields.length === 0 && <Empty description={roView ? s.noFieldsRo : s.noFields} style={{ padding: 20 }} />}
        {fields.length > 0 && (roView ? (
          /* phone (and any fields-read-only role): read-only cards — field name +
             input type, its options as chips, and the three flags as badges
             instead of checkboxes */
          fields.map((f) => (
            <div className={'tset-fcard' + (f.active ? '' : ' off')} key={f.id}>
              <div className="tset-fcard-h">
                <b>{loc(f, 'label')}</b>
                <span className="tset-fcard-type">{inputLabel(f.input)}</span>
                {!f.active && <span className="pill muted">{s.offTag}</span>}
              </div>
              {/* key 用下标而不是选项名：历史行里可能有重名选项，撞 key 会让 React 复用错节点。
                  注释放在条件外面 —— {cond && ( ... )} 里面多一个 {/* *​/} 会被当成第二个子表达式。 */}
              {f.active && HAS_OPTIONS(f.input) && (f.options || []).length > 0 && (
                <div className="tset-chips">{f.options.map((o, i) => <span className="tset-chip" key={i}>{optLabel(f, i, lang)}</span>)}</div>
              )}
              {f.active && (f.required || f.showInTimeline || f.filterable) && (
                <div className="tset-chips">
                  {f.required && <span className="pill pri">{s.thReq}</span>}
                  {f.showInTimeline && <span className="pill pri">{s.thShowLong}</span>}
                  {f.filterable && <span className="pill pri">{s.thFilter}</span>}
                </div>
              )}
            </div>
          ))
        ) : (
          <div className={'tset-ftable' + (showAiCol ? ' ai' : '')}>
            <div className="tset-fhead">
              <span />
              <span>{s.thField}</span>
              <span>{s.thInput}</span>
              <span>{s.thOptions}</span>
              <span>{s.thReq}</span>
              <span>{s.thShow}</span>
              <span>{s.thFilter}</span>
              {showAiCol && <span title={s.aiShareTip}>{s.thAi}</span>}
              <span>{s.thOps}</span>
            </div>
            {fields.map((f, i) => (
              <div key={f.id}
                className={'tset-frow' + (f.active ? '' : ' off') + (dragId !== null && dragId !== f.id && overId === f.id ? ' over' : '')}
                onDragOver={(e) => { if (dragId === null) return; e.preventDefault(); setOverId(f.id); }}
                onDragLeave={() => setOverId((cur) => (cur === f.id ? null : cur))}
                onDrop={(e) => { if (dragId === null) return; e.preventDefault(); dropOn(f.id); }}>
                <span className="tset-grip" draggable title={s.dragHint} aria-hidden="true"
                  onDragStart={(e) => { e.dataTransfer.effectAllowed = 'move'; setDragId(f.id); }}
                  onDragEnd={() => { setDragId(null); setOverId(null); }}>⋮⋮</span>
                {/* The name is TEXT, not an input. This list is for scanning and
                    toggling; renaming is rare and deliberate, so it moves to a dialog
                    where both languages get a label and room. Two inline name boxes
                    made the row a 9-column grid in an 8-column track, which pushed the
                    actions onto a second line and crushed the options tags. */}
                <span className="tset-fname">
                  <span className="tset-fname-t" title={`${f.label_zh || ''} / ${f.label}`}>{loc(f, 'label')}</span>
                  <Button size="small" theme="borderless" className="tset-fname-edit" icon={<IconEdit />} aria-label={s.rename} title={s.rename}
                    aria-label={s.renameField} title={s.renameField}
                    onClick={() => setRename({ kind: 'field', id: f.id, zh: f.label_zh || '', en: f.label || '' })} />
                </span>
                <Select value={f.input} optionList={inputOpts} onChange={(v) => patchField(f.id, { input: v })} />
                {/* A disabled field is not collected, not shown and not filterable, and its
                    options are dead too — the design shows all four columns as "—". */}
                {f.active && HAS_OPTIONS(f.input) ? (
                  /* Summary + pencil, the same shape as the name cell two columns
                     over. The TagInput that used to sit here could only ever edit
                     ONE of the two lists, and its wrapping tag box was also the
                     tallest thing in the row. Hovering shows both languages. */
                  <span className="tset-fname">
                    <span className="tset-fname-t" role="button" tabIndex={0} style={{ cursor: 'pointer' }}
                      title={(f.options || []).length
                        ? f.options.map((o, i) => `${(f.options_zh || [])[i] || o} / ${o}`).join(' · ')
                        : s.optEmpty}
                      onClick={() => openOptions(f)}
                      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openOptions(f); } }}>
                      {optMismatched(f) ? <><IcWarn />{' '}</> : ''}
                      {(f.options || []).length ? f.options.map((o, i) => optLabel(f, i, lang)).join(' · ') : s.optEmpty}
                    </span>
                    <Button size="small" theme="borderless" className="tset-fname-edit" icon={<IconEdit />} aria-label={s.rename} title={s.rename}
                      aria-label={s.optEdit} title={s.optEdit} onClick={() => openOptions(f)} />
                  </span>
                ) : <span className="tset-dash">—</span>}
                {f.active ? (
                  <>
                    <span className="tset-fcell"><Checkbox aria-label={s.thReq} checked={f.required} onChange={(e) => patchField(f.id, { required: e.target.checked })} /></span>
                    <span className="tset-fcell"><Checkbox aria-label={s.thShow} checked={f.showInTimeline} onChange={(e) => patchField(f.id, { showInTimeline: e.target.checked })} /></span>
                    <span className="tset-fcell"><Checkbox aria-label={s.thFilter} checked={f.filterable} onChange={(e) => patchField(f.id, { filterable: e.target.checked })} /></span>
                  </>
                ) : (
                  <>
                    <span className="tset-dash">—</span>
                    <span className="tset-dash">—</span>
                    <span className="tset-dash">—</span>
                  </>
                )}
                {showAiCol && (AI_NEVER.has(selKey) || f.input === 'checkbox'
                  ? <span className="tset-dash" title={AI_NEVER.has(selKey) ? s.aiShareNever : undefined}>—</span>
                  : <Select size="small" value={f.aiShare || 'omit'} aria-label={s.thAi} title={s.aiShareTip}
                      optionList={['omit', 'mask', 'send'].map((v) => ({ value: v, label: s.aiShare[v], disabled: !superAdmin && AI_RANK[v] > AI_RANK[f.aiShare || 'omit'] }))}
                      onChange={(v) => patchField(f.id, { aiShare: v })} />)}
                <span className="tset-fops">
                  <Button size="small" theme="borderless" onClick={() => patchField(f.id, { active: !f.active })}>{f.active ? s.disable : s.restore}</Button>
                  <Button size="small" theme="borderless" icon={<IconArrowUp />} aria-label={s.moveUp} title={s.moveUp} disabled={i === 0} onClick={() => moveField(f, -1)} />
                  <Button size="small" theme="borderless" icon={<IconArrowDown />} aria-label={s.moveDown} title={s.moveDown} disabled={i === fields.length - 1} onClick={() => moveField(f, 1)} />
                  <Popconfirm title={`${s.delete} “${loc(f, 'label')}”?`} content={s.hint} okType="danger" okText={s.delete} cancelText={s.cancel}
                    onConfirm={() => call(() => api.del(`/api/admin/config/record-fields/${f.id}`), s.deleted)}>
                    <Button size="small" theme="borderless" type="danger" icon={<IconDelete />} aria-label={s.delete} title={s.delete} />
                  </Popconfirm>
                </span>
              </div>
            ))}
          </div>
        ))}
        {/* 只读档:说明为什么这里只有一张只读表 —— 不是坏了,也不是手机布局。 */}
        {!fieldsWrite && <div className="tset-foot">{s.roFields}</div>}
        {narrow ? <div className="tset-foot">{s.deskOnly}</div> : (
          <>
            <Text type="tertiary" size="small">{s.hint}</Text>
            {selKey !== 'user' && <div className="tset-foot">{s.empVisHint}</div>}
            {selKey !== 'user' && <div className="tset-foot">{s.mgrVisHint}</div>}
          </>
        )}
        </div>
        </div>
      </div>

      {/* ---- job grade system 职级体系 ----
           PUT /api/admin/job-grades 是 fields 写,和上面的字段表同域 —— 所以只读档
           走同一个 roView:卡片渲染成只读行,保存/加行/删行一并消失。 */}
      {/* Layout v2：职级框架与晋升条件改成左页签右面板（SettingsWorkspace）；上面的字段配置卡保持原样 */}
      <SettingsWorkspace>
      <GradesCard data-section={s.gTitle} s={s} narrow={roView} cand={candQ.data} reloadCand={candQ.reload} />

      {/* ---- promotion criteria ----
           The whole block is talent-owned (裁定②) — the page itself is core and
           stays, but this card feeds only the talent-review defense pool, and
           its config endpoint is gone once talent is off. Route-level gating
           cannot reach an in-page block, so the gate lives here. */}
      {/* 跨域:这张卡的两个接口都在 talent 域。talent 不可读 → GET 404,卡片整张
          收起(留一行说明,免得看起来像页面少画了一块);talent 只有 read → PUT
          必 403,渲染成只读摘要(与手机变体同一套)。 */}
      {talentOn && talentRead && (
        <PromoCard data-section={s.promoTitle} s={s} cand={candQ.data} />
      )}
      </SettingsWorkspace>
      {talentOn && talentRead && !talentWrite && <div className="tset-foot">{s.roPromoRead}</div>}
      {talentOn && !talentRead && <div className="tset-foot">{s.roPromoHidden}</div>}

      {/* One rename dialog serves both types and fields: the same two names, the
          same rules, so it should not be two different interactions. */}
      <Modal visible={!!rename} title={rename && rename.kind === 'type' ? s.renameType : s.renameField}
        width={420} onCancel={() => setRename(null)} onOk={saveRename}
        okText={s.save} cancelText={s.cancel} maskClosable={false}>
        {rename && (
          <>
            <div className="ppl-flabel">{s.nameZh}</div>
            <Input value={rename.zh} autoFocus placeholder={s.nameZhPh}
              onChange={(v) => setRename((r) => ({ ...r, zh: v }))}
              onEnterPress={saveRename} />
            <div className="ppl-flabel">{s.nameEn}</div>
            <Input value={rename.en} placeholder={s.nameEnPh}
              onChange={(v) => setRename((r) => ({ ...r, en: v }))}
              onEnterPress={saveRename} />
            <div className="tset-renamehint">{s.renameHint}</div>
          </>
        )}
      </Modal>

      {/* Options dialog: one row per option with the two languages side by side,
          numbered, so "equal length, same order" is something you can see rather
          than a rule written down somewhere. A length mismatch inherited from
          older data is flagged and still saveable — this list IS the fix.
          bodyStyle: a long scale (or an HR-added list of 20) scrolls inside the
          dialog instead of pushing its own buttons off the bottom of the screen. */}
      <Modal visible={!!optEdit} title={optEdit ? `${s.optTitle} · ${optEdit.label}` : s.optTitle}
        width={520} onCancel={() => setOptEdit(null)} onOk={saveOptions}
        okText={s.save} cancelText={s.cancel} maskClosable={false}
        bodyStyle={{ maxHeight: '58vh', overflowY: 'auto' }}>
        {optEdit && (
          <>
            {optEdit.mismatch && (
              <Banner type="warning" closeIcon={null} description={s.optMismatch(optEdit.mismatch.zh, optEdit.mismatch.en)} />
            )}
            <div style={{ ...OPT_GRID, marginTop: 8 }}>
              <span />
              <div className="ppl-flabel" style={{ margin: 0 }}>{s.nameZh}</div>
              <div className="ppl-flabel" style={{ margin: 0 }}>{s.nameEn}</div>
              <span />
            </div>
            {optEdit.rows.map((r, i) => (
              <div key={i} style={{ ...OPT_GRID, marginTop: 6 }}>
                {/* the number is the pairing: row 3 is options[2] and options_zh[2] */}
                <span className="tset-dash tnum">{i + 1}</span>
                <Input value={r.zh} size="small" placeholder={s.optZhPh} autoFocus={i === 0}
                  aria-label={`${s.optTitle} ${i + 1} · ${s.nameZh}`}
                  onChange={(v) => optRow(i, 'zh', v)} />
                <Input value={r.en} size="small" placeholder={s.optEnPh}
                  aria-label={`${s.optTitle} ${i + 1} · ${s.nameEn}`}
                  onChange={(v) => optRow(i, 'en', v)} />
                <Button size="small" theme="borderless" type="danger" icon={<IconDelete />}
                  aria-label={s.delete} title={s.delete}
                  onClick={() => setOptEdit((o) => ({ ...o, rows: o.rows.filter((_, j) => j !== i) }))} />
                {/* 第二行：这一项的说明（中英各一），与选项同序 */}
                <span />
                <Input value={r.dz} size="small" placeholder={(optEdit.rating && RATING_DESC_SUGGEST[r.en] && RATING_DESC_SUGGEST[r.en][0]) || s.optDescZh}
                  aria-label={`${s.optTitle} ${i + 1} · ${s.optDescZh}`} onChange={(v) => optRow(i, 'dz', v)} />
                <Input value={r.de} size="small" placeholder={(optEdit.rating && RATING_DESC_SUGGEST[r.en] && RATING_DESC_SUGGEST[r.en][1]) || s.optDescEn}
                  aria-label={`${s.optTitle} ${i + 1} · ${s.optDescEn}`} onChange={(v) => optRow(i, 'de', v)} />
                <span />
              </div>
            ))}
            <Button size="small" theme="borderless" icon={<IconPlus />} style={{ marginTop: 8 }}
              onClick={() => setOptEdit((o) => ({ ...o, rows: [...o.rows, { zh: '', en: '', dz: '', de: '' }] }))}>{s.optAdd}</Button>
            <div className="tset-renamehint">{s.optHint}</div>
            <div className="tset-renamehint" style={{ marginTop: 6 }}>{s.optDescHint}</div>
            <div className="tset-renamehint" style={{ marginTop: 6 }}>{s.optStoreHint}</div>
          </>
        )}
      </Modal>
    </div>
  );
}

/* ---- job grade system card (Grade / Rank / Level, dual M+P track) ----
   Edited as a local draft and saved in one PUT. The server validates the whole
   catalogue at once and rejects it if any row is missing rank/grade/level, so
   per-keystroke autosave made a brand-new row impossible to ever complete. */
function GradesCard({ s, narrow, cand, reloadCand }) {
  const q = useAsync(() => api.get('/api/admin/job-grades'), []);
  const [draft, setDraft] = useState(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const ranks = draft || (q.data ? q.data.ranks : null);

  const card = (body) => (
    <div className="ppl-card">
      <div className="ppl-sec-h"><div><h2>{s.gTitle}</h2><div className="tset-lead">{s.gLead}</div></div></div>
      {body}
    </div>
  );
  if (q.error) return card(<Banner type="danger" closeIcon={null} description={`${s.loadFail} · ${q.error.message}`} />);
  if (!ranks) return card(<div style={{ textAlign: 'center', padding: 28 }}><Spin /></div>);

  const edit = (next) => { setDraft(next); setDirty(true); };
  const upd = (i, k, v) => edit(ranks.map((r, j) => (j === i ? { ...r, [k]: v } : r)));
  const del = (i) => edit(ranks.filter((_, j) => j !== i));
  // The column a row sits in *is* its track, so the new row inherits it from the
  // column's own "add" button instead of from a per-row dropdown.
  const add = (track) => edit([...ranks, { rank: '', grade: '', level: 1, track }]);
  const save = async () => {
    setSaving(true);
    try {
      const r = await api.put('/api/admin/job-grades', { ranks });
      setDraft(r.ranks); // server-normalised truth, no reload flash
      setDirty(false);
      Toast.success(s.gSaved);
      if (reloadCand) reloadCand(); // renaming/removing a rank changes who is off-catalogue
    } catch (err) {
      Toast.error(err.message); // keep the draft: a rejected row must stay editable
    }
    setSaving(false);
  };
  const byTrack = (tk) => ranks.map((r, i) => ({ ...r, _i: i })).filter((r) => r.track === tk).sort((a, b) => b.level - a.level);
  const col = (tk, title) => (
    <div style={{ flex: 1, minWidth: 280 }}>
      <div className="ppl-flabel" style={{ marginTop: 0 }}>{title}</div>
      {narrow ? (
        byTrack(tk).map((r) => (
          <div className="tset-gread" key={r._i}>
            <b>{r.rank}</b> {r.grade} <span className="tset-dash">Lv {r.level}</span>
          </div>
        ))
      ) : (
        <>
          <div className="tset-ghead"><span>{s.gThRank}</span><span>{s.gThGrade}</span><span>{s.gThLevel}</span><span /></div>
          {byTrack(tk).map((r) => (
            <div className="tset-grow" key={r._i}>
              {/* raw value through: rank/grade names carry spaces and case ("Team Lead", "C-level") */}
              <Input value={r.rank} size="small" onChange={(v) => upd(r._i, 'rank', v)} aria-label={s.gThRank} />
              <Input value={r.grade} size="small" onChange={(v) => upd(r._i, 'grade', v)} aria-label={s.gThGrade} />
              <InputNumber value={r.level} size="small" min={1} max={99} onChange={(v) => upd(r._i, 'level', v)} prefix="L" aria-label={s.gThLevel} />
              <Popconfirm title={s.delRank} content={s.delRankDesc} okType="danger" okText={s.delete} cancelText={s.cancel} onConfirm={() => del(r._i)}>
                <Button size="small" theme="borderless" type="danger" icon={<IconDelete />} aria-label={s.delete} title={s.delete} />
              </Popconfirm>
            </div>
          ))}
          <Button size="small" icon={<IconPlus />} theme="borderless" onClick={() => add(tk)}>{s.gAdd}</Button>
        </>
      )}
    </div>
  );
  // Anyone the promotion checker had to skip: their level is absent from this
  // catalogue (or absent entirely), so no ladder step can be derived for them.
  const offCat = cand ? cand.unmapped.length : 0;
  const noLevel = cand ? cand.unmapped.filter((u) => !u.jobLevel).length : 0;
  return card(
    <>
      <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap' }}>
        {col('M', s.gTrackM)}
        {col('P', s.gTrackP)}
      </div>
      {!narrow && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginTop: 14 }}>
          <Button size="small" theme="solid" type="primary" disabled={!dirty} loading={saving} onClick={save}>{s.gSave}</Button>
          {dirty && <Text type="warning" size="small">{s.gUnsaved}</Text>}
        </div>
      )}
      {offCat > 0 && (
        <div className="tset-warnbar"><IcWarn /> {s.gOffCatalog(offCat)}{noLevel > 0 ? ` ${s.gNoLevelPart(noLevel)}` : ''}</div>
      )}
    </>
  );
}

/* ---- promotion criteria → guide card（第五批 8.1） ----
   晋升条件已改为「人才盘点 › 晋升评审候选」的内置筛选（builtinKey = promotion）：条件、逐人核对、手动加入与排除都在那里。
   本卡只说明去处、给出当前人数并跳转；GET/PUT /api/admin/promotion-config 仍保留给旧客户端与测试（服务端写回带标签的叶子）。
   人数取同页 GradesCard 共用的 promotion-candidates（eligible 已计入人工名单）。 */
function PromoCard({ s, cand }) {
  const navigate = useNavigate();
  const pool = cand ? cand.rows.length + cand.unmapped.length : 0;
  const met = cand ? cand.rows.filter((r) => r.eligible).length : 0;
  return (
    <div className="ppl-card">
      <div className="ppl-sec-h"><div><h2>{s.promoTitle}</h2><div className="tset-lead">{s.promoLead}</div></div></div>
      {cand && <div className="tset-promostat">{s.promoStat(met, pool ? (met / pool * 100).toFixed(1) : '0.0')}</div>}
      <div style={{ marginTop: 12 }}>
        <Button theme="solid" type="primary" onClick={() => navigate('/admin/talent-review')}>{s.promoGo} →</Button>
      </div>
    </div>
  );
}
