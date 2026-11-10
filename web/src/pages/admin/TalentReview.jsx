// Talent review 人才盘点 (Phase 2) — the classic 9-box grid plus cross-people
// record search. Performance axis = the employee's LATEST performance rating,
// bucketed by its position in the configured options list (top third = high),
// so HR can rename/reorder the scale in Settings and the grid follows.
// Potential axis = users.potential (set on the profile). Cells link to profiles.
// 第二批 2.4 / 3.1（10/8）：九宫格筛选全部写进地址栏（src 来源周期、dept 部门含下级、band 职级段、track 岗位序列、
// mgr 直属上级、tenure 司龄、estatus 员工状态、pot 潜力评定）。部门筛选用全站唯一口径（DeptFilter + /api/admin/dept-tree）。
// F60（10/9）：顶部筛选（src 之外的七个键）= 整页人群范围，由服务端判定（modules/talent/review-scope.js）：九宫格与未定位名单取
// GET talent-review 每行的 inScope；晋升评审候选、继任计划（?withPositions=1，关键岗位行保留并显示范围内继任者人数）、人才筛选整页
// （带同名地址栏键打开）、导出与批量操作都带同一组参数。F61（10/9）：删除「管理职责 / Role type」筛选，角色类型只用岗位序列表达。
// 第五批 8.1 / 8.2（10/8）：下方三个页签改为「晋升评审候选」（内置筛选：条件摘要、每条条件 ✓/✗、手动加入 / 排除、导出）、
// 「继任计划」（就绪度下拉显示完整文字、「批量导入」入口）、「人才筛选」（已保存的筛选列表，取代原「人才检索」）。
// 条件编辑整页在 TalentFilter.jsx；地址栏 ?tab=succession|filters 决定初始页签（整页返回时用）。
import { num } from '../../fmt.js';
import { saveCsv } from '../../csv.js';
import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Button, Select, Tag, Toast, Banner, Spin, Empty, Table, Typography, Input, Popconfirm, Modal, Switch, TextArea } from '@douyinfe/semi-ui';
import { IconSearch, IconRefresh, IconPlus, IconUpload } from '@douyinfe/semi-icons';
import { api, useAsync } from '../../api.js';
import { errText } from '../../apierr.js';
import * as TF from './talentFilter.js';
import { useAuth } from '../../auth.jsx';
import { useI18n } from '../../i18n.jsx';
import { SettingsWorkspace } from '../../v2.jsx';
import { canReadDomain, canWriteDomain } from '../../rbac.js';
import { PAGE_TIERS, DEFAULT_PAGE } from '../../pagesize.js';
import { resizableTable } from '../../cardify.js';
import DeptFilter, { dpfModalProps, deptFilterInvalidText } from '../../components/DeptFilter.jsx';
import { useDeptTree, deptMatcher } from '../../deptfilter.js';
import { useUrlState } from '../../urlstate.js';
import { localDay } from '../../deptcal.js';
import { useMedia } from './workbench/shared.jsx';   // CX-017：手机宽度名单弹窗改卡片

const { Text } = Typography;

// 九宫格筛选的地址栏键（设计 3.3）。切绩效来源时其余筛选保留。F61：删除 role（管理职责），角色类型只用 track 表达。
const TR_KEYS = ['src', 'dept', 'band', 'track', 'mgr', 'tenure', 'estatus', 'pot'];
// F60：页面人群范围的键 = src 之外的全部顶部筛选（与 talentFilter.js SCOPE_KEYS、服务端 review-scope.js 相同）；
// 判定在服务端，本页不再逐行判断（原「筛选纯函数」trRowMatch / tenureBucket / potState 已移到 modules/talent/review-scope.js）。
const SCOPE_KEYS = TF.SCOPE_KEYS;
const TENURE_KEYS = ['lt1', '1to3', '3to5', '5p', 'none'];
const ESTATUS_KEYS = ['probation', 'regular', 'exited', 'none'];
const POT_KEYS = ['fresh', 'stale', 'none'];
const TRACK_KEYS = ['M', 'P'];
const MGR_NONE = '__none';

// How many not-yet-reviewed names to draw before summarising the rest. The list
// is a worklist, not a roster dump — at company scale it was 4,400+ buttons.
const UNRATED_CAP = 60;
// Names drawn inside one 9-box cell before the rest collapse into "+N".
const CELL_CAP = 8;
// Same grouping as the other HR pages — a four-figure headcount is unreadable raw.
const fmtN = (n) => num(n || 0);

// A record field's `options` entry is BOTH the stored value and its English
// display name; `options_zh` is the same list in Chinese, index-aligned. Search
// facets and record details therefore arrive as stored values, and showing them
// in Chinese is an index lookup — never a translation of the value itself, so
// whatever goes back to the server stays the canonical `options` string.
// A value that is not in the list (an option HR renamed after the fact, a raw
// CSV import) is shown as stored: better a stale English label than a blank.
function optLabel(f, v, lang) {
  if (lang !== 'zh' || !f || !Array.isArray(f.options_zh)) return v;
  const i = (f.options || []).indexOf(v);
  return i >= 0 && f.options_zh[i] ? f.options_zh[i] : v;
}
const findField = (cfg, typeKey, key) =>
  (cfg ? (cfg.fields || []).find((f) => f.typeKey === typeKey && f.key === key) : null) || null;

const T = {
  zh: {
    refresh: '刷新',
    title: '人才盘点', lead: '九宫格横轴为绩效评级，默认取每人最近一次，也可以改为某个已关闭的评估周期；评级按「档案与职级设置」中的选项顺序分高、中、低。纵轴为潜力评级，在员工档案中录入。点击姓名查看员工档案。',
    axisPerf: '绩效 →', axisPot: '潜力 ↑',
    // 第二批 2.4 九宫格筛选（10/8）
    fSrc: '绩效来源', srcLatest: '最近一次（每人）', srcLatestShort: '最近一次（每人）', fAll: '全部',
    srcNote: (name) => `绩效轴取自「${name}」归档进员工档案的评级（含周期关闭后写明理由修改过的评级）；未参加该周期的员工归入未定位。`,
    srcGone: '该评估周期不存在或尚未关闭，绩效来源已改回「最近一次（每人）」。',
    fBand: '职级段', gradeOpt: (g) => `职等 ${g}`, noGrid: '未纳入职级体系', noLevel: '未设职级',
    fTrack: '岗位序列', trackM: '管理通道', trackP: '专业通道',
    fMgr: '直属上级', mgrNone: '无直属上级',
    fTenure: '司龄', ten_lt1: '不满 1 年', ten_1to3: '1–3 年', ten_3to5: '3–5 年', ten_5p: '5 年及以上', ten_none: '入职日期未填',
    fEstatus: '员工状态', es_probation: '试用期', es_regular: '正式', es_exited: '已离职', es_none: '未填',
    fPot: '潜力评定', potFresh: '12 个月内评定', potStale: '已过期或日期不详', potNone: '未评定',
    clearFilters: '清除筛选', scopeApplied: '已叠加页面顶部筛选', succInScope: (n) => `范围内继任者 ${n}`,
    badParams: '部分筛选条件已不适用，已清除。',
    revDone: '已定位', revUnit: (n) => '人',
    perfL: '低', perfM: '中', perfH: '高', potL: '低', potM: '中', potH: '高',
    unrated: '未定位', unratedLead: '缺少绩效评级或潜力评级，补齐后自动进入九宫格：',
    viewList: '查看名单', close: '关闭', cellMore: (n) => '还有 ' + n + ' 人，点开查看', cellDrillLead: (n) => '该格共 ' + n + ' 人', missing: '缺什么', drillSearchPh: '搜索姓名或工号…',
    tapHint: '点格子看名单',
    sumBreakdown: (p, o) => '缺绩效评级 ' + p + ' 人 · 缺潜力评级 ' + o + ' 人，补齐后自动进入九宫格',
    sumBoth: '两个维度都还没有数据：绩效评级来自已关闭的评估周期或 HR 录入的绩效记录，潜力评级在员工档案中录入。',
    unmappedTitle: '职级未纳入职级体系', unmappedLead: '这些员工的职级未纳入职级体系，晋升条件无法核对。请修改其职级，或在「档案与职级设置 › 职级体系」中补充该职级。',
    unratedCount: (n, t2) => '显示 ' + n + ' / ' + t2 + ' 人',
    missPerf: '缺绩效评级', missPot: '缺潜力评级', people: (n) => `${n} 人`,
    cells: [
      ['绩效待改进', '稳定贡献', '岗位绩效突出'],
      ['表现不稳定', '核心贡献', '高绩效'],
      ['潜力待发挥', '高潜力', '高潜力、高绩效'],
    ],
    // 第五批 8.1：原「人才检索」卡改为「人才筛选」列表（已保存的筛选）；条件编辑在整页 TalentFilter.jsx
    filtersTitle: '人才筛选', filtersLead: '按条件组合跨员工找人。筛选保存后可随时运行、导出，也可以共享给其他人才管理员。',
    fNew: '新建筛选', fQuick: '按档案记录类型新建', fName: '名称', fKind: '类型', fUpdated: '更新时间', fSummary: '条件',
    kindBuiltin: '内置', kindShared: '共享', kindMine: '私有', fOwner: (n) => `创建人：${n}`,
    open: '打开', copy: '复制', del: '删除', deleted: '已删除', delFilter: '删除这个筛选？', delFilterDesc: '删除后不可恢复；已导出的名单不受影响。', fEmpty: '还没有保存的筛选。',
    promoTitle: '晋升评审候选', promoLead: '内置的「晋升评审候选」筛选：逐人核对下列条件，满足全部条件的员工列为晋升评审候选。可以手动加入不满足条件的员工，也可以写明理由排除满足条件的员工。',
    // F62：候选名单按规则自己的时间范围计算，不随页面「绩效来源」变化
    promoCalcNote: '绩效条件按近 2 期 / 近 12 个月的绩效记录计算，不随页面顶部的「绩效来源」变化；不足 2 期评级或近 12 个月没有评级的员工不入选。',
    promoDefaultsPending: '默认条件已更新（公司晋升门槛，2026-10-09）。此筛选曾被修改，所以保留了原条件；可在条件页「恢复默认」。',
    promoGoReset: '去恢复默认', pLevelTenure: '现职级任职',
    promoEdit: '编辑条件', promoView: '查看条件', promoOnlyMet: '只看满足条件', promoExport: '导出', exported: '已导出',
    eExport: '你的角色没有导出权限（需要员工档案的查看权限）。', promoNoFilter: '晋升评审候选筛选尚未就绪，条件暂按原晋升规则显示。',
    memberInclude: '手动加入', memberExclude: '已排除', colAct: '操作',
    actExclude: '移出候选', actUninclude: '取消加入', actRestore: '恢复',
    excludeTitle: '移出晋升评审候选', excludeLead: (n) => `${n} 满足全部条件。排除后不再列为晋升评审候选，操作人、时间与理由写入审计。`,
    excludeReason: '理由（必填，写入审计）', excludeNeed: '请填写排除理由。',
    unincludeTitle: '取消手动加入', unincludeLead: (n) => `取消后，${n} 按条件判定是否列为晋升评审候选。`,
    restoreTitle: '恢复按条件判定', restoreLead: (n) => `恢复后，${n} 按条件判定是否列为晋升评审候选。`,
    memberSaved: '已更新', pHit: (n) => `条件 ${n}`,
    pCur: '当前 → 下一级', pRating: '绩效评级', pTenure: '司龄', pVio: '违纪', pResult: '结果',
    pEligible: '✓ 符合晋升评审条件', pNot: '未满足', pTop: '已到顶', pMonths: (m) => `${m} 月`,
    succTitle: '继任计划', succLead: '关键岗位的继任人与就绪度；继任人点名字进档案。',
    succVacant: '空缺', succVacancy: (n, t) => `空缺岗位 ${n} / ${t}（关键岗位清单里尚无继任者）：`, succNoVacancy: (t) => `关键岗位清单 ${t} 个岗位都已有继任者。`,
    scPos: '关键岗位', scWho: '继任人', scReady: '就绪度', scNote: '备注（可选）', scAdd: '添加', scImport: '批量导入', scKeyPositions: '关键岗位清单',
    ready: '即刻就绪', oneYear: '1–2 年内就绪', twoYears: '2 年以上就绪', scEmpty: '还没有继任计划 — 在上面添加第一条。',
    scEmptyRo: '还没有继任计划。',
    saved: '已保存', removed: '已移除', remove: '移除', cancel: '取消', delSucc: '移除这条继任安排？',
    colName: '姓名', colEmpId: '工号', colDept: '部门', colLevel: '职级',
    noResults: '没有符合条件的员工', loadFail: '加载失败，请刷新页面重试。',
    /* 只读档(talent=read):继任计划的三个写接口(POST/PUT/DELETE succession)在
       服务端都会吃 403,所以编辑控件收起,只留可查看的名单。 */
    roSucc: '你的角色对人才发展是只读权限 —— 继任计划只能查看，不能添加、改就绪度或移除。需要改动请找超级管理员。',
    /* 跨域:姓名点进去是 /admin/people/:id,属员工档案(people)域。没有该域读权限
       的角色点了会被路由守卫弹回工作台,所以姓名不做成链接。 */
    noProfileLink: '你的角色没有「员工档案」权限，姓名无法打开档案页；本页的九宫格、晋升评审候选与人才筛选结果可正常查看。',
  },
  en: {
    refresh: 'Refresh',
    title: 'Talent Review', lead: '9-box: the horizontal axis is the performance rating — by default each person’s most recent one, or a closed review cycle you choose — bucketed high, mid or low by the option order in Profile & Job Level Settings. The vertical axis is the potential rating, entered on the employee profile. Select a name to open the profile.',
    axisPerf: 'Performance →', axisPot: 'Potential ↑',
    fSrc: 'Rating source', srcLatest: 'Most recent (per person)', srcLatestShort: 'Most recent', fAll: 'All',
    srcNote: (name) => `The performance axis uses the ratings archived to employee profiles from "${name}", including any changed after the cycle closed with a reason. People who were not in that cycle are listed as not placed.`,
    srcGone: 'That review cycle no longer exists or isn’t closed yet, so the rating source is back to Most recent (per person).',
    fBand: 'Job grade', gradeOpt: (g) => `Grade ${g}`, noGrid: 'Not in job grade structure', noLevel: 'No job level',
    fTrack: 'Track', trackM: 'Management', trackP: 'Professional',
    fMgr: 'Manager', mgrNone: 'No manager',
    fTenure: 'Tenure', ten_lt1: 'Under 1 year', ten_1to3: '1–3 years', ten_3to5: '3–5 years', ten_5p: '5+ years', ten_none: 'No hire date',
    fEstatus: 'Employment status', es_probation: 'Probation', es_regular: 'Regular', es_exited: 'Separated', es_none: 'Not set',
    fPot: 'Potential assessment', potFresh: 'Assessed within 12 months', potStale: 'Out of date or date unknown', potNone: 'Not assessed',
    clearFilters: 'Clear filters', scopeApplied: 'Page filters applied', succInScope: (n) => `Successors in scope: ${n}`,
    badParams: 'Some filters no longer apply and were cleared.',
    revDone: 'Placed', revUnit: (n) => (n === 1 ? 'person' : 'people'),
    perfL: 'Low', perfM: 'Mid', perfH: 'High', potL: 'Low', potM: 'Mid', potH: 'High',
    unrated: 'Not placed', unratedLead: 'Missing a performance rating or potential rating; employees are placed automatically once both are available:',
    viewList: 'View list', close: 'Close', cellMore: (n) => n + ' more — click to view', cellDrillLead: (n) => n + (n === 1 ? ' person' : ' people') + ' in this box', missing: 'Missing', drillSearchPh: 'Search name or ID…',
    tapHint: 'Tap a box to see its list',
    sumBreakdown: (p, o) => `${p} without a performance rating · ${o} without a potential rating`,
    sumBoth: 'Neither axis has data yet: performance ratings come from closed review cycles or performance records added by HR; potential ratings are entered on the employee profile.',
    unmappedTitle: 'Job Level Not in the Job Level Framework', unmappedLead: 'Their job level is not in the Job Level Framework, so promotion criteria cannot be checked. Correct the job level, or add it under Profile & Job Level Settings › Job Level Framework.',
    unratedCount: (n, t2) => `${n} of ${t2}`,
    missPerf: 'No performance rating', missPot: 'No potential rating', people: (n) => `${n}`,
    cells: [
      ['Performance Needs Improvement', 'Steady Contribution', 'Strong Performance in Current Role'],
      ['Inconsistent Performance', 'Core Contribution', 'High Performance'],
      ['Unrealized Potential', 'High Potential', 'High Potential, High Performance'],
    ],
    filtersTitle: 'Talent Filters', filtersLead: 'Find people across the workforce by combining conditions. Saved filters can be run and exported at any time, and shared with other talent administrators.',
    fNew: 'New filter', fQuick: 'New filter by record type', fName: 'Name', fKind: 'Type', fUpdated: 'Updated', fSummary: 'Conditions',
    kindBuiltin: 'Built-in', kindShared: 'Shared', kindMine: 'Private', fOwner: (n) => `Created by ${n}`,
    open: 'Open', copy: 'Copy', del: 'Delete', deleted: 'Deleted', delFilter: 'Delete this filter?', delFilterDesc: 'This cannot be undone. Lists already exported are not affected.', fEmpty: 'No saved filters yet.',
    promoTitle: 'Promotion Panel Candidates', promoLead: 'The built-in Promotion Panel Candidates filter checks each employee against the conditions below; those who meet all of them are listed as candidates. You can add employees who do not meet them, or exclude employees who do, with a reason.',
    promoCalcNote: 'Rating conditions use the last 2 ratings / the last 12 months of ratings; they do not follow the page\'s "Performance source". Employees with fewer than 2 ratings, or none in the last 12 months, are not listed.',
    promoDefaultsPending: 'The default criteria changed (company promotion threshold, 2026-10-09). This filter had been edited, so its conditions were kept; use "Restore default" on the conditions page.',
    promoGoReset: 'Restore default', pLevelTenure: 'Time in level',
    promoEdit: 'Edit conditions', promoView: 'View conditions', promoOnlyMet: 'Only those who meet the criteria', promoExport: 'Export', exported: 'Exported',
    eExport: 'Your role cannot export (it needs read access to Employee Profiles).', promoNoFilter: 'The Promotion Panel Candidates filter is not ready yet; the previous promotion criteria are shown for now.',
    memberInclude: 'Added manually', memberExclude: 'Excluded', colAct: 'Actions',
    actExclude: 'Remove from candidates', actUninclude: 'Cancel manual addition', actRestore: 'Restore',
    excludeTitle: 'Remove from promotion panel candidates', excludeLead: (n) => `${n} meets every condition. Once excluded, they are no longer listed as a promotion panel candidate; who did it, when and why are recorded in the audit log.`,
    excludeReason: 'Reason (required; recorded in the audit log)', excludeNeed: 'Enter a reason for the exclusion.',
    unincludeTitle: 'Cancel manual addition', unincludeLead: (n) => `${n} will be listed as a candidate only if they meet the conditions.`,
    restoreTitle: 'Go back to the conditions', restoreLead: (n) => `${n} will be listed as a candidate only if they meet the conditions.`,
    memberSaved: 'Updated', pHit: (n) => `Condition ${n}`,
    pCur: 'Current → next', pRating: 'Performance Rating', pTenure: 'Tenure', pVio: 'Disciplinary records', pResult: 'Result',
    pEligible: '✓ Eligible for promotion panel', pNot: 'Not yet', pTop: 'Top level', pMonths: (m) => `${m} mo`,
    succTitle: 'Succession Plans', succLead: 'Key positions, successors and readiness; names link to profiles.',
    succVacant: 'Vacant', succVacancy: (n, t) => `Vacant positions ${n} / ${t} (key positions with no successor yet): `, succNoVacancy: (t) => `All ${t} key positions have at least one successor.`,
    scPos: 'Key Position', scWho: 'Successor', scReady: 'Readiness', scNote: 'Note (optional)', scAdd: 'Add', scImport: 'Bulk import', scKeyPositions: 'Key positions',
    ready: 'Ready now', oneYear: 'Ready in 1–2 years', twoYears: 'Ready in 2+ years', scEmpty: 'No succession plans yet — add the first above.',
    scEmptyRo: 'No succession plans yet.',
    saved: 'Saved', removed: 'Removed', remove: 'Remove', cancel: 'Cancel', delSucc: 'Remove this succession entry?',
    colName: 'Name', colEmpId: 'ID', colDept: 'Department', colLevel: 'Level',
    noResults: 'No matching employees', loadFail: 'Couldn’t load. Refresh the page to try again.',
    roSucc: 'Your role has read-only access to talent development — succession plans can be reviewed but not added, re-rated or removed. Ask a super-admin to make changes.',
    noProfileLink: 'Your role has no access to Employee Profiles, so names here do not open a profile. The 9-box, promotion panel candidates and talent filter results are still available.',
  },
};

/* ---- drill-in list ----
   The place a long roster of people actually belongs: searchable by name or ID,
   filterable by department, paginated, one click to the profile. Used for both
   "not yet reviewed" and "job level outside the catalogue", which were
   previously dumped inline as hundreds of unclickable-looking chips. */
// 部门筛选（第二批 3.1）：DeptFilter 内部状态（不进地址栏），含下级；放在 Semi Modal 里用 dpfModalProps（关动画、内容层不裁切）。
function PeopleDrill({ s, lang, tree, title, lead, rows, navigate, onClose, extraColumn, canProfile }) {
  const phone = useMedia('(max-width: 640px)');   // CX-017（2026-10-09 验收第二轮）：390 宽不用表格，改卡片（不横向滚动、工号不折行）
  const [query, setQuery] = useState('');
  const [dept, setDept] = useState(null);
  const deptOk = useMemo(() => deptMatcher(tree, dept), [tree, dept]);
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows.filter((r) => {
      if (dept && !deptOk(r.department)) return false;
      if (!q) return true;
      return String(r.name || '').toLowerCase().includes(q) || String(r.employeeId || '').toLowerCase().includes(q);
    });
  }, [rows, query, dept, deptOk]);

  return (
    <Modal {...dpfModalProps()} visible title={title} width={760} className="trev-drill-modal u-modal-visible" onCancel={onClose} footer={<Button onClick={onClose}>{s.close}</Button>}>
      <Text type="tertiary" size="small" style={{ display: 'block', marginBottom: 10 }}>{lead}</Text>
      <div className="trev-search" style={{ marginBottom: 10 }}>
        <Input prefix={<IconSearch />} showClear placeholder={s.drillSearchPh} value={query} onChange={setQuery} style={{ width: 220 }} />
        <DeptFilter options={tree ? tree.options : []} value={dept} onChange={(v) => setDept(v || null)} lang={lang} size="small"
          showNone={!!(tree && tree.hasNone)} disabled={tree === null} ready={!!tree} onInvalid={() => setDept(null)} />
        <Text type="quaternary" size="small">{s.unratedCount(shown.length, rows.length)}</Text>
      </div>
      {phone ? (
        <ul className="trev-drill-cards">
          {shown.length === 0 && <li className="trev-drill-empty">{s.noResults}</li>}
          {shown.map((r) => (
            <li key={r.id} className="trev-drill-card">
              <div className="trev-drill-card-h">
                {canProfile
                  ? <span className="emp-namelink" style={{ cursor: 'pointer' }} onClick={() => { onClose(); navigate(`/admin/people/${r.id}`); }}>{r.name}</span>
                  : <span>{r.name}</span>}
                <Text type="tertiary" size="small" className="tnum" style={{ whiteSpace: 'nowrap' }}>{r.employeeId}</Text>
              </div>
              <div className="trev-drill-card-b">
                {r.department ? <span>{r.department}</span> : null}
                {r.jobLevel ? <Tag size="small" color="indigo" type="light">{r.jobLevel}</Tag> : null}
                {extraColumn && extraColumn.render ? <span>{extraColumn.render(null, r)}</span> : null}
              </div>
            </li>
          ))}
        </ul>
      ) : (
      <Table rowKey="id" dataSource={shown} size="small" className="trev-drill-table"
        pagination={shown.length > 10 ? { pageSize: DEFAULT_PAGE, pageSizeOpts: PAGE_TIERS, showSizeChanger: true, formatPageText: false } : false}
        empty={<Empty description={s.noResults} style={{ padding: 20 }} />}
        {...resizableTable([
          // Ellipsis, not wrap: Filipino full names and "Admin and Facilities -
          // BGC Office" style department names otherwise push rows to two and
          // three lines each and the table loses its rhythm.
          // 没有 people 读权限时姓名不是链接:目标页 /admin/people/:id 属 people 域,
          // 点了只会被守卫弹回工作台。
          { title: s.colName, dataIndex: 'name', width: 165, render: (v, r) => (canProfile
            ? (
              <span className="emp-namelink emp-ellip" style={{ cursor: 'pointer' }} title={v}
                onClick={() => { onClose(); navigate(`/admin/people/${r.id}`); }}>{v}</span>
            )
            : <span className="emp-ellip" title={v}>{v}</span>
          ) },
          { title: s.colEmpId, dataIndex: 'employeeId', width: 85, render: (v) => <Text type="tertiary" size="small" className="tnum">{v}</Text> },
          { title: s.colDept, dataIndex: 'department', width: 190, render: (v) => (v
            ? <span className="emp-ellip" title={v}>{v}</span>
            : <Text type="quaternary">—</Text>) },
          { title: s.colLevel, dataIndex: 'jobLevel', width: 90, render: (v) => (v ? <Tag size="small" color="indigo" type="light">{v}</Tag> : <Text type="quaternary">—</Text>) },
          ...(extraColumn ? [extraColumn] : []),
        ])} />
      )}
    </Modal>
  );
}

// cell tone by [pot][perf] — star gets brand, risk gets danger, hipo/performer soft green.
const TONE = [
  ['bad', 'mid', 'mid'],
  ['mid', 'mid', 'good'],
  ['mid', 'good', 'star'],
];

export default function TalentReview() {
  const { lang, loc } = useI18n();
  const s = T[lang];
  const navigate = useNavigate();
  /* 授权闸门。本页所属域是 talent,页面自身的读接口(talent-review /
     promotion-candidates / succession / talent-search —— 矩阵里 talent-search 虽是
     POST 但归「读」)进得来就已经过了;GET /api/admin/config/records 是 W1b 参考目录
     白名单(多域 >=read 可读),所以**不加门**。
     真正要判的两件事:
       1) 继任计划的 POST/PUT/DELETE 是 talent 写 —— read 档必 403,收起控件;
       2) 姓名跳 /admin/people/:id 是 **people** 域,跨域 —— 无 people 读权限的角色
          点了会被 App.jsx 的守卫弹回工作台,所以姓名不做成链接。
     老服务(无 grants)与超管:两个都为 true,与改动前完全一致。 */
  const { user } = useAuth();
  const canProfile = canReadDomain(user, 'people');
  const canEditSucc = canWriteDomain(user, 'talent');
  // 第五批 8.1：筛选结果导出与「人才记录 CSV」同一判定（员工档案读权限，服务端 canExportTalentRecords）
  const canExport = canProfile;
  // 整页（人才筛选、继任导入）返回时带 ?tab=，落到对应页签
  const [searchParams] = useSearchParams();
  const tabParam = searchParams.get('tab');
  const initialTab = tabParam === 'succession' ? 1 : tabParam === 'filters' ? 2 : 0;

  // ---- 地址栏筛选（2.4）：值不合法时清掉并提示一次 ----
  const [params, patch] = useUrlState();
  const f = useMemo(() => Object.fromEntries(TR_KEYS.map((k) => [k, params[k] || ''])), [params]);
  const src = f.src && f.src !== 'latest' ? f.src : '';
  // F60：页面人群范围（地址栏里 src 之外的筛选键），所有页签与请求共用
  const scope = useMemo(() => TF.scopeOf(f), [f]);
  const scopeQs = TF.scopeQuery(scope);
  // 绩效来源：缺省 = 每人最近一条；选了已关闭周期就带 ?cycle=。周期不存在 / 未关闭时服务端回 404 cycle_not_found →
  // 不当成整页出错，改回缺省来源并提示（深链接里的旧周期 id）。
  const revQ = useAsync(() => api.get(TF.withQuery('/api/admin/talent-review', src ? `cycle=${encodeURIComponent(src)}` : '', scopeQs))
    .catch((err) => { if (src && err && err.status === 404) return { gone: true }; throw err; }), [src, scopeQs]);
  const cfgQ = useAsync(() => api.get('/api/admin/config/records'), []);
  // 职级体系目录：只用来给「职级段」排序（职等按该职等最高级数从高到低）；读不到时按字母排
  const gradeQ = useAsync(() => api.get('/api/admin/job-grades').catch(() => null), []);
  const tree = useDeptTree();

  const data = revQ.data && !revQ.data.gone ? revQ.data : null;
  const rows = useMemo(() => (data && Array.isArray(data.rows) ? data.rows : []), [data]);
  const sourceCycles = (data && data.sourceCycles) || [];
  const srcCycle = src ? sourceCycles.find((c) => c.id === src) || null : null;

  useEffect(() => {
    if (revQ.data && revQ.data.gone) { Toast.warning(s.srcGone); patch({ src: null }); }
  }, [revQ.data]); // eslint-disable-line react-hooks/exhaustive-deps

  // 下拉选项（都从 rows 推出：rows 是范围内的在职员工，与来源周期无关）
  const bandOpts = useMemo(() => {
    const rank = new Map();
    const ranks = (gradeQ.data && gradeQ.data.ranks) || [];
    for (const r of ranks) if (r && r.grade != null) rank.set(String(r.grade), Math.max(rank.get(String(r.grade)) || 0, Number(r.level) || 0));
    const grades = new Set();
    let nogrid = false, none = false;
    for (const r of rows) {
      if (!r.jobLevel) { none = true; continue; }
      if (r.jobGrade == null || r.jobGrade === '') nogrid = true;
      else grades.add(String(r.jobGrade));
    }
    const list = [...grades].sort((a, b) => (rank.get(b) || 0) - (rank.get(a) || 0) || a.localeCompare(b));
    return [
      ...list.map((g) => ({ value: 'g:' + g, label: s.gradeOpt(g) })),
      ...(nogrid ? [{ value: 'nogrid', label: s.noGrid }] : []),
      ...(none ? [{ value: 'none', label: s.noLevel }] : []),
    ];
  }, [rows, gradeQ.data, s]);
  const mgrOpts = useMemo(() => {
    const m = new Map();
    let none = false;
    for (const r of rows) {
      if (!r.managerId) { none = true; continue; }
      if (!m.has(r.managerId)) m.set(r.managerId, { value: String(r.managerId), label: (r.managerName || '—') + (r.managerEmployeeId ? ` · ${r.managerEmployeeId}` : ''), name: r.managerName || '' });
    }
    const list = [...m.values()].sort((a, b) => a.name.localeCompare(b.name));
    return [...(none ? [{ value: MGR_NONE, label: s.mgrNone }] : []), ...list.map(({ value, label }) => ({ value, label }))];
  }, [rows, s]);
  const estatusOpts = useMemo(() => {
    const seen = new Set(rows.map((r) => (ESTATUS_KEYS.includes(r.empStatus) ? r.empStatus : 'none')));
    return ESTATUS_KEYS.filter((k) => seen.has(k)).map((k) => ({ value: k, label: s['es_' + k] }));
  }, [rows, s]);

  // 地址栏里不在选项中的值（手改的、过期的深链接）→ 清掉并提示一次。部门由 DeptFilter 的 onInvalid 处理。
  useEffect(() => {
    if (!data) return;
    const bad = {};
    if (f.band && !bandOpts.some((o) => o.value === f.band)) bad.band = null;
    if (f.mgr && !mgrOpts.some((o) => o.value === f.mgr)) bad.mgr = null;
    if (f.estatus && !ESTATUS_KEYS.includes(f.estatus)) bad.estatus = null;
    if (f.track && !TRACK_KEYS.includes(f.track)) bad.track = null;
    if (params.role) bad.role = null;   // F61：旧链接里的「管理职责」已删除
    if (f.tenure && !TENURE_KEYS.includes(f.tenure)) bad.tenure = null;
    if (f.pot && !POT_KEYS.includes(f.pot)) bad.pot = null;
    if (Object.keys(bad).length) { Toast.info(s.badParams); patch(bad); }
  }, [data, f, bandOpts, mgrOpts]); // eslint-disable-line react-hooks/exhaustive-deps

  // 范围判定在服务端：inScope 为 false 的行不进九宫格与未定位名单（rows 仍是数据范围内的全部人员，下拉选项与继任录入从它推出）
  const shown = useMemo(() => rows.filter((r) => r.inScope !== false), [rows]);
  const filtering = SCOPE_KEYS.some((k) => f[k]);
  const rated = shown.filter((r) => r.perfBucket !== null && r.potBucket !== null);
  const unrated = shown.filter((r) => r.perfBucket === null || r.potBucket === null);
  const cellOf = (pot, perf) => rated.filter((r) => r.potBucket === pot && r.perfBucket === perf);
  // The performance scale is one field, so resolve it once instead of scanning
  // the field config per row of the grid and per row of the promotion table.
  const ratingField = useMemo(() => findField(cfgQ.data, 'performance', 'rating'), [cfgQ.data]);
  // users.potential is a fixed High/Medium/Low enum (not a configurable option
  // list), and the axis scale beside the grid already names the three levels.
  const potNames = { High: s.potH, Medium: s.potM, Low: s.potL };
  // Which drill-in list is open ('unrated' | 'unmapped' | null).
  const [drill, setDrill] = useState(null);
  // A 9-box cell whose overflow was clicked: { pot, perf, list }.
  const [cellDrill, setCellDrill] = useState(null);

  if (revQ.error) return <div className="wrap trev-wrap"><Banner type="danger" closeIcon={null} description={`${s.loadFail} · ${revQ.error.message}`} /></div>;
  if (!data) return <div className="wrap trev-wrap" style={{ textAlign: 'center', paddingTop: 80 }}><Spin size="large" /></div>;

  const setF = (k) => (v) => patch({ [k]: v || null });
  const sel = (k, label, optionList, cls = 'u-w-md') => (
    <Select insetLabel={label} placeholder={s.fAll} showClear value={f[k] || undefined} onChange={setF(k)}
      className={cls} optionList={optionList} />
  );

  return (
    <div className="wrap trev-wrap">
      <div className="tset-head">
        <div><h1 className="tset-title">{s.title}</h1><div className="tset-lead">{s.lead}</div></div>
      </div>
      {/* lead 里写着「点人名进档案」—— 没有 people 权限时那句话不成立,所以这里替它
          说明清楚,而不是让人对着点不动的名字反复试。 */}
      {!canProfile && <div className="tset-foot">{s.noProfileLink}</div>}

      {/* ---- 9-box ---- */}
      <div className="ppl-card">
        <div className="ppl-sec-h">
          {/* 绩效来源：缺省「最近一次（每人）」，其余为已关闭的评估周期（新的在前）。performance 模块关闭时只有缺省项。 */}
          {/* W3-C-CSS: .trev-src — 宽 340px、max-width:100%（英文「Rating source  Most recent (per person)」在 260px 里被截断）。
              手机上整行也只有约 304px，英文全称仍放不下：选中项另渲染短文案（.trev-src-short，≤640 显示），下拉里仍是全称（波次 3 复核） */}
          <Select insetLabel={s.fSrc} value={src || 'latest'} onChange={(v) => patch({ src: v && v !== 'latest' ? v : null })}
            renderSelectedItem={(o) => (o.value === 'latest'
              ? <><span className="trev-src-full">{s.srcLatest}</span><span className="trev-src-short">{s.srcLatestShort}</span></>
              : o.label)}
            className="u-w-lg trev-src" disabled={!sourceCycles.length} loading={revQ.loading}
            optionList={[{ value: 'latest', label: s.srcLatest }, ...sourceCycles.map((c) => ({ value: c.id, label: c.name }))]} />
          {/* Review progress for the roster in view. The denominator follows the
              filters, so it always reconciles with the "not yet reviewed" line at
              the foot of this card (rated + unrated = shown).
              The total hides on the phone (CSS) — there the head only has room
              for how many are done. */}
          <div className="trev-progress">
            {s.revDone}
            <b className="tnum">{fmtN(rated.length)}</b>
            <span className="trev-progress-tot tnum">/ {fmtN(shown.length)}</span>
            {s.revUnit(shown.length)}
          </div>
          <Button icon={<IconRefresh />} theme="borderless" aria-label={s.refresh} title={s.refresh} onClick={() => revQ.reload()} />
        </div>
        {/* 2.4 筛选条：部门（含下级）、职级段、岗位序列、直属上级、司龄、员工状态、潜力评定（F61 删除「管理职责」） */}
        {/* W3-C-CSS: .u-filterbar .dpf-trigger — 与同排 Semi Select 等高（v2 下 38px），现在 32px 矮一截 */}
        <div className="u-filterbar">
          <DeptFilter options={tree ? tree.options : []} value={f.dept || null} lang={lang}
            onChange={(v) => patch({ dept: v || null })} showNone={!!(tree && tree.hasNone)}
            disabled={tree === null} ready={!!tree}
            onInvalid={() => { Toast.info(deptFilterInvalidText(lang)); patch({ dept: null }); }} />
          {sel('band', s.fBand, bandOpts)}
          {sel('track', s.fTrack, TRACK_KEYS.map((k) => ({ value: k, label: k === 'M' ? s.trackM : s.trackP })))}
          <Select insetLabel={s.fMgr} placeholder={s.fAll} showClear filter value={f.mgr || undefined} onChange={setF('mgr')}
            className="u-w-lg" optionList={mgrOpts} />
          {sel('tenure', s.fTenure, TENURE_KEYS.map((k) => ({ value: k, label: s['ten_' + k] })))}
          {sel('estatus', s.fEstatus, estatusOpts, 'u-w-lg')}
          {sel('pot', s.fPot, POT_KEYS.map((k) => ({ value: k, label: k === 'fresh' ? s.potFresh : k === 'stale' ? s.potStale : s.potNone })), 'u-w-lg')}
          {filtering && (
            <Button size="small" theme="borderless" className="u-filterbar-end" onClick={() => patch(Object.fromEntries(SCOPE_KEYS.map((k) => [k, null])))}>
              {s.clearFilters}
            </Button>
          )}
        </div>
        {srcCycle && (
          <div className="u-hint" style={{ marginBottom: 12 }}>
            <div>{s.srcNote(srcCycle.name)}</div>
          </div>
        )}
        <div className="trev-gridrow">
          {/* Axis label and scale are SIBLINGS, not nested: the stylesheet sizes
              .trev-yaxis at 26px and .trev-ylab at 34px independently, so nesting
              the 34px scale inside the 26px label column squeezed it.
              The label itself is upright CJK (writing-mode + text-orientation in
              CSS) — never rotate(), which lays Chinese on its side.
              Top row is high potential, matching the [2,1,0] render order. */}
          <div className="trev-yaxis"><span>{s.axisPot}</span></div>
          <div className="trev-ylab"><span>{s.potH}</span><span>{s.potM}</span><span>{s.potL}</span></div>
          <div className="trev-grid">
            {[2, 1, 0].map((pot) => (
              [0, 1, 2].map((perf) => {
                const list = cellOf(pot, perf);
                // The whole cell opens its roster, not just the "+N" chip: the
                // phone layout hides .trev-cell-body (names AND "+N"), so
                // without this the mobile grid is nine dead numbers. Empty
                // cells stay inert — an empty modal is not an answer.
                const openCell = list.length ? () => setCellDrill({ pot, perf, list }) : undefined;
                return (
                  <div className={'trev-cell trev-' + TONE[pot][perf] + (openCell ? ' trev-cell-tap' : '')}
                    key={`${pot}-${perf}`} onClick={openCell}>
                    <div className="trev-cell-h">
                      <span className="trev-cell-name">{s.cells[pot][perf]}</span>
                      <span className="trev-cell-n tnum">{list.length}</span>
                    </div>
                    <div className="trev-cell-body">
                      {/* A populous cell would otherwise grow unboundedly and
                          break the grid's row rhythm — cap the names and let
                          "+N" carry the rest into the department-filtered view. */}
                      {/* 无 people 权限 → 不拦 stopPropagation 也不跳转,点名字等于点
                          格子(打开本格名单),而不是被守卫弹走。 */}
                      {list.slice(0, CELL_CAP).map((r) => (
                        <button className="trev-emp" key={r.id}
                          onClick={canProfile ? (e) => { e.stopPropagation(); navigate(`/admin/people/${r.id}`); } : undefined}
                          title={`${optLabel(ratingField, r.rating, lang) || ''} · ${(r.potential && potNames[r.potential]) || r.potential || ''}`}>
                          {r.name}{r.jobLevel ? <span className="trev-emp-lv">{r.jobLevel}</span> : null}
                        </button>
                      ))}
                      {list.length > CELL_CAP && (
                        <button className="trev-emp trev-emp-more" onClick={(e) => { e.stopPropagation(); openCell(); }}
                          title={s.cellMore(list.length - CELL_CAP)}>
                          +{list.length - CELL_CAP}
                        </button>
                      )}
                    </div>
                  </div>
                );
              })
            ))}
            <div className="trev-xlab"><span>{s.perfL}</span><span>{s.perfM}</span><span>{s.perfH}</span></div>
          </div>
        </div>
        <div className="trev-xaxis">{s.axisPerf}</div>
        {/* Shown only under the mobile breakpoint (CSS): there the cells carry a
            count and nothing else, so the tap has to be spelled out. */}
        <div className="trev-tap-hint">{s.tapHint}</div>
        {/* Not a wall of names. Thousands of people are "not yet reviewed" and
            nobody works through that by scanning chips — it is a status line
            with a way in. The list itself lives in a searchable, filterable,
            paginated table behind the button. */}
        {unrated.length > 0 && (
          <div className="trev-summary">
            <div className="trev-summary-txt">
              <b>{s.unrated}</b>
              <span className="trev-sum-n tnum">{fmtN(unrated.length)}</span>
              {/* When both axes are missing for everyone, repeating the same
                  number twice reads like a bug — say it once. */}
              <Text type="tertiary" size="small">{(() => {
                const noPerf = unrated.filter((r) => r.perfBucket === null).length;
                const noPot = unrated.filter((r) => r.potBucket === null).length;
                // Compare the raw counts, group the digits only on the way out.
                return noPerf === noPot && noPerf === unrated.length ? s.sumBoth : s.sumBreakdown(fmtN(noPerf), fmtN(noPot));
              })()}</Text>
            </div>
            <Button size="small" onClick={() => setDrill('unrated')}>{s.viewList} →</Button>
          </div>
        )}
      </div>

      {cellDrill && (
        <PeopleDrill s={s} lang={lang} tree={tree} title={s.cells[cellDrill.pot][cellDrill.perf]}
          lead={s.cellDrillLead(cellDrill.list.length)} rows={cellDrill.list}
          navigate={navigate} canProfile={canProfile} onClose={() => setCellDrill(null)} />
      )}

      {drill === 'unrated' && (
        <PeopleDrill s={s} lang={lang} tree={tree} title={s.unrated} lead={s.unratedLead} rows={unrated} navigate={navigate}
          canProfile={canProfile} onClose={() => setDrill(null)}
          extraColumn={{
            title: s.missing, dataIndex: 'missing', width: 150,
            render: (_, r) => (
              <span style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                {r.perfBucket === null && <Tag size="small" color="amber" type="light">{s.missPerf}</Tag>}
                {r.potBucket === null && <Tag size="small" color="blue" type="light">{s.missPot}</Tag>}
              </span>
            ),
          }} />
      )}

      {/* ---- promotion pipeline ---- */}
      {/* Layout v2：晋升评审候选、继任计划、人才筛选改成左页签右面板（SettingsWorkspace）；九宫格卡保持原样 */}
      <SettingsWorkspace initial={initialTab}>
      <PromoPipeline data-section={s.promoTitle} s={s} navigate={navigate} ratingField={ratingField} lang={lang} canProfile={canProfile}
        canWrite={canEditSucc} canExport={canExport} scope={scope} scopeQs={scopeQs} />

      {/* ---- succession plans ---- */}
      <SuccessionCard data-section={s.succTitle} s={s} navigate={navigate} employees={rows} canProfile={canProfile} canEdit={canEditSucc} scopeQs={scopeQs} />

      {/* ---- saved talent filters（第五批 8.1，取代原「人才检索」卡） ---- */}
      <FilterListCard data-section={s.filtersTitle} s={s} loc={loc} lang={lang} cfg={cfgQ.data} navigate={navigate} canWrite={canEditSucc} scopeQs={scopeQs} />
      </SettingsWorkspace>
    </div>
  );
}

/* ---- promotion panel candidates（第五批 8.1：内置筛选 builtinKey = promotion） ----
   数据仍取 GET /api/admin/promotion-candidates（基础人群每人一行：eligible 已计入人工名单，member = include|exclude，
   checks 为带标签叶子映射成的旧键，explain = 每条顶层条件的命中）；条件与摘要取内置筛选本身（GET talent-filters/:filterId）。
   每条顶层条件一列 ✓/✗；带标签的旧四项（评级、司龄、培训、违纪）照旧附展示值。筛选读不到时退回旧的四列。 */
const CHECK_OF_TAG = { rating: 'rating', ratingWindow: 'ratingWindow', levelTenure: 'levelTenure', tenure: 'tenure', trainings: 'trainings', violations: 'violations' };
// QA D5（§19）：1440 宽时卡片内表格区约 914px。姓名 150 + 当前→下一级 110 + 4 条条件 × 100 + 结果 120 + 操作 120 = 900，中英文都放得下；
// 条件列数随筛选而变，每列用固定窄宽（✓/✗ 加一个短值）；条件更多时横向滚动，操作列固定在右侧（.trev-pc-opcol）始终可见。
const PROMO_COND_W = 100;
function PromoPipeline({ s, navigate, ratingField, lang, canProfile, canWrite, canExport, scope, scopeQs }) {
  // F60：候选名单、导出、移出 / 恢复都按页面顶部筛选的范围（服务端判定）
  const q = useAsync(() => api.get(TF.withQuery('/api/admin/promotion-candidates', scopeQs)), [scopeQs]);
  const scopeBody = scopeQs ? scope : undefined;
  const filterId = q.data && q.data.filterId ? q.data.filterId : null;
  const fQ = useAsync(() => (filterId ? api.get(`/api/admin/talent-filters/${encodeURIComponent(filterId)}`).catch(() => null) : Promise.resolve(null)), [filterId]);
  const catQ = useAsync(() => (filterId ? api.get('/api/admin/talent-filters/catalog').catch(() => null) : Promise.resolve(null)), [filterId]);
  // Declared before the early return — hooks cannot be conditional.
  const [drill, setDrill] = useState(false);
  const [onlyMet, setOnlyMet] = useState(false);
  const [act, setAct] = useState(null);          // { row, kind: exclude | uninclude | restore }
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [exporting, setExporting] = useState(false);
  const tree = useDeptTree();   // 名单弹窗里的部门筛选（会话内缓存，与九宫格同一份）
  const def = useMemo(() => {
    const f = fQ.data && fQ.data.filter;
    if (!f) return null;
    let x = f.definition;
    if (typeof x === 'string') { try { x = JSON.parse(x); } catch (e) { x = null; } }
    return x ? TF.normalizeDef(x) : null;
  }, [fQ.data]);
  const d = q.data;
  if (!d) return null;
  const catalog = catQ.data || null;
  const deptLabel = (id) => {
    const o = tree && Array.isArray(tree.options) ? tree.options.find((x) => String(x.id) === String(id)) : null;
    return o ? o.name || o.path || String(id) : String(id).startsWith('name:') ? String(id).slice(5) : String(id);
  };
  const Chk = ({ c, extra }) => (
    <span>
      <Tag size="small" type="light" shape="circle" color={c.ok ? 'green' : 'red'}>{c.ok ? '✓' : '✗'}</Tag>
      {extra ? <Text type="tertiary" size="small" style={{ marginLeft: 4 }}>{extra}</Text> : null}
    </span>
  );
  const Hit = ({ h }) => (h === null
    ? <Text type="quaternary">–</Text>
    : <Tag size="small" type="light" shape="circle" color={h ? 'green' : 'red'}>{h ? '✓' : '✗'}</Tag>);
  const legacyExtra = (key, c, r) => {
    if (!c) return null;
    // CX-074：近 N 期都列出来（最近一期在前），达标的那一期看得见
    if (key === 'rating') return Array.isArray(c.values) && c.values.length > 1 ? c.values.map((v) => (v == null ? '—' : optLabel(ratingField, v, lang) || v)).join(' · ') : (optLabel(ratingField, c.value, lang) || '—');
    if (key === 'tenure' || key === 'levelTenure') return c.months !== null && c.months !== undefined ? s.pMonths(c.months) : '—';
    if (key === 'trainings') return c.total !== undefined ? `${c.passed}/${c.total}` : null;
    return null;
  };
  // 每条顶层条件一列；「有下一职级」那条由「当前 → 下一级」列表达，不重复
  const condCols = def ? def.items.map((it, i) => ({ it, i })).filter(({ it }) => !(it && it.tag === 'nextLevel')).map(({ it, i }) => {
    const title = (catalog ? TF.itemSummary(it, catalog, lang, { deptLabel }) : '') || s.pHit(i + 1);
    const key = it && it.tag ? CHECK_OF_TAG[it.tag] : null;
    return {
      title, dataIndex: 'c_' + (it.id || i), width: PROMO_COND_W,
      render: (_, r) => {
        const legacy = key && r.checks ? r.checks[key] : null;
        const h = TF.topHits({ items: [it] }, r)[0];
        if (legacy && h === null) return <Chk c={legacy} extra={legacyExtra(key, legacy, r)} />;
        if (legacy) return <Chk c={{ ok: h }} extra={legacyExtra(key, legacy, r)} />;
        return <Hit h={h} />;
      },
    };
  }) : [
    // 筛选读不到（迁移未完成或接口异常）：沿用旧的四项
    { title: s.pRating, dataIndex: 'checks', width: 110, render: (c) => (c && c.rating ? <Chk c={c.rating} extra={optLabel(ratingField, c.rating.value, lang) || '—'} /> : null) },
    { title: s.pLevelTenure, dataIndex: 'checks2', width: 100, render: (_, r) => (r.checks && r.checks.levelTenure ? <Chk c={r.checks.levelTenure} extra={r.checks.levelTenure.months !== null && r.checks.levelTenure.months !== undefined ? s.pMonths(r.checks.levelTenure.months) : '—'} /> : null) },
    { title: s.pTenure, dataIndex: 'checks3', width: 100, render: (_, r) => (r.checks && r.checks.tenure ? <Chk c={r.checks.tenure} extra={r.checks.tenure.months !== null ? s.pMonths(r.checks.tenure.months) : '—'} /> : null) },
    { title: s.pVio, dataIndex: 'checks4', width: 80, render: (_, r) => (r.checks && r.checks.violations ? <Chk c={r.checks.violations} /> : null) },
  ];
  const canMember = canWrite && !!filterId;
  const actCol = canMember ? [{
    title: s.colAct, dataIndex: '__act', width: 120, fixed: 'right', className: 'trev-pc-opcol',
    render: (_, r) => {
      const kind = TF.promoRowAction(r);
      if (!kind) return null;
      const label = kind === 'exclude' ? s.actExclude : kind === 'uninclude' ? s.actUninclude : s.actRestore;
      return <Button size="small" theme="borderless" type={kind === 'exclude' ? 'danger' : 'primary'} onClick={() => { setReason(''); setAct({ row: r, kind }); }}>{label}</Button>;
    },
  }] : [];
  const all = Array.isArray(d.rows) ? d.rows : [];
  const shown = onlyMet ? all.filter((r) => r.eligible) : all;
  const submitAct = async () => {
    if (!act) return;
    if (act.kind === 'exclude' && !reason.trim()) { Toast.warning(s.excludeNeed); return; }
    setBusy(true);
    try {
      await api.post(`/api/admin/talent-filters/${encodeURIComponent(filterId)}/members`, {
        action: act.kind === 'exclude' ? 'exclude' : 'remove', userIds: [act.row.id], note: reason.trim() || undefined, scope: scopeBody,
      });
      Toast.success(s.memberSaved);
      setAct(null);
      q.reload();
    } catch (err) { Toast.error(errText(err, { note_required: () => s.excludeNeed })); }
    setBusy(false);
  };
  const doExport = async () => {
    setExporting(true);
    try {
      const text = await api.post('/api/admin/talent-filters/export', { filterId, lang, scope: scopeBody });
      saveCsv(typeof text === 'string' ? text : '', TF.exportFileName(lang === 'zh' ? '晋升评审候选' : 'promotion-panel-candidates'));
      Toast.success(s.exported);
    } catch (err) { Toast.error(errText(err, { export_forbidden: () => s.eExport })); }
    setExporting(false);
  };
  const actName = act ? String(act.row.name || '') : '';
  return (
    <div className="ppl-card">
      <div className="ppl-sec-h">
        <div><h2>{s.promoTitle}</h2><div className="tset-lead">{s.promoLead}</div></div>
        <Button icon={<IconRefresh />} theme="borderless" aria-label={s.refresh} title={s.refresh} onClick={() => { q.reload(); fQ.reload(); }} />
      </div>
      {def && catalog && <div className="tf-summary">{TF.summarize(def, catalog, lang, { deptLabel })}</div>}
      {/* F62：候选名单按规则自己的时间范围算；迁移 92 保留了被改过的条件时提示可恢复默认 */}
      <div className="u-hint" style={{ marginBottom: 8 }}>{s.promoCalcNote}</div>
      {d.defaultsPending && filterId && (
        <div className="u-hint tf-defaults-pending" style={{ marginBottom: 10 }}>
          {s.promoDefaultsPending}
          {canWrite && <Button size="small" theme="borderless" type="primary" onClick={() => navigate(TF.withQuery(`/admin/talent-review/filter/${encodeURIComponent(filterId)}`, scopeQs))}>{s.promoGoReset}</Button>}
        </div>
      )}
      {!filterId && <div className="u-hint" style={{ marginBottom: 10 }}>{s.promoNoFilter}</div>}
      <div className="trev-search">
        {filterId && (
          <Button size="small" theme={canWrite ? 'solid' : 'light'} type="primary" onClick={() => navigate(TF.withQuery(`/admin/talent-review/filter/${encodeURIComponent(filterId)}`, scopeQs))}>
            {canWrite ? s.promoEdit : s.promoView}
          </Button>
        )}
        {filterId && canExport && <Button size="small" loading={exporting} onClick={doExport}>{s.promoExport}</Button>}
        <span className="tf-switch">
          <Switch size="small" checked={onlyMet} onChange={setOnlyMet} aria-label={s.promoOnlyMet} />
          <Text size="small">{s.promoOnlyMet}</Text>
        </span>
      </div>
      <Table rowKey="id" dataSource={shown} size="small" pagination={shown.length > 10 ? { pageSize: DEFAULT_PAGE, pageSizeOpts: PAGE_TIERS, showSizeChanger: true, formatPageText: false } : false}
        {...resizableTable([
          // Titled, not blank: cardify only labels columns with a string title,
          // so an empty header also left the phone card's first line unlabelled.
          { title: s.colName, dataIndex: 'name', width: 150, render: (v, r) => (
            <span className="tf-namecell">
              {canProfile
                ? <span className="emp-namelink" style={{ cursor: 'pointer' }} onClick={() => navigate(`/admin/people/${r.id}`)}>{v}</span>
                : <span>{v}</span>}
              {r.member === 'include' && <Tag size="small" color="blue" type="light" shape="circle">{s.memberInclude}</Tag>}
              {r.member === 'exclude' && <Tag size="small" color="grey" type="light" shape="circle">{s.memberExclude}</Tag>}
            </span>
          ) },
          { title: s.pCur, dataIndex: 'jobLevel', width: 110, render: (v, r) => (
            <span className="tnum" style={{ fontSize: 13 }}>{v || '—'} → {r.nextLevel ? <b>{r.nextLevel}</b> : <Text type="quaternary">{s.pTop}</Text>}</span>) },
          ...condCols,
          // CX-105：被人工排除的候选（条件全满足）结果列写「已排除」，不写「未满足」
          { title: s.pResult, dataIndex: 'eligible', width: 120, className: 'trev-pc-res', render: (v, r) => (r.member === 'exclude'
            ? <Tag color="grey" type="light" shape="circle">{s.memberExclude}</Tag>
            : v
            ? <Tag color="green" type="solid" shape="circle">{s.pEligible}</Tag>
            : <Tag color="grey" type="light" shape="circle">{s.pNot}</Tag>) },
          ...actCol,
        ])} />
      {/* Same treatment as the 9-box worklist: a status line, not 1,000 chips. */}
      {Array.isArray(d.unmapped) && d.unmapped.length > 0 && (
        <div className="trev-summary">
          <div className="trev-summary-txt">
            <b>{s.unmappedTitle}</b>
            <span className="trev-sum-n tnum">{d.unmapped.length}</span>
            <Text type="tertiary" size="small">{s.unmappedLead}</Text>
          </div>
          <Button size="small" onClick={() => setDrill(true)}>{s.viewList} →</Button>
        </div>
      )}
      {drill && (
        <PeopleDrill s={s} lang={lang} tree={tree} title={s.unmappedTitle} lead={s.unmappedLead} rows={d.unmapped}
          navigate={navigate} canProfile={canProfile} onClose={() => setDrill(false)} />
      )}
      {/* 行操作（短操作，弹窗）：排除满足条件的人必须写理由；取消手动加入、恢复只需确认 */}
      <Modal visible={!!act} width={480} maskClosable={false} confirmLoading={busy}
        title={act ? (act.kind === 'exclude' ? s.excludeTitle : act.kind === 'uninclude' ? s.unincludeTitle : s.restoreTitle) : ''}
        okText={act ? (act.kind === 'exclude' ? s.actExclude : act.kind === 'uninclude' ? s.actUninclude : s.actRestore) : ''}
        cancelText={s.cancel}
        okButtonProps={act && act.kind === 'exclude' ? { type: 'danger', disabled: !reason.trim() } : undefined}
        onOk={submitAct} onCancel={() => { if (!busy) setAct(null); }}>
        {act && (
          <>
            <div className="tset-lead" style={{ marginBottom: 10 }}>
              {act.kind === 'exclude' ? s.excludeLead(actName) : act.kind === 'uninclude' ? s.unincludeLead(actName) : s.restoreLead(actName)}
            </div>
            {act.kind === 'exclude' && (
              <>
                <div className="ppl-flabel">{s.excludeReason}</div>
                <TextArea value={reason} onChange={setReason} maxCount={TF.NOTE_MAX} maxLength={TF.NOTE_MAX} autosize={{ minRows: 2, maxRows: 5 }} autoFocus />
              </>
            )}
          </>
        )}
      </Modal>
    </div>
  );
}

/* ---- succession plans: key position → successors + readiness ---- */
// 第五批 8.2：就绪度下拉显示完整文字（录入行 minWidth 200、行内 minWidth 168，下拉层不跟随选择框宽度）；
// 卡片标题旁「批量导入」进整页 /admin/talent-review/succession-import（talent 写权限）。
function SuccessionCard({ s, navigate, employees, canProfile, canEdit, scopeQs }) {
  const { lang } = useI18n();   // CX-054：空缺岗位名单的分隔符按语言（原来漏取 lang，整页渲染崩溃）
  // F60：?withPositions=1 → { rows（继任人在页面范围内的行）, positions（数据范围内的全部关键岗位 + 范围内继任者人数）, scoped }
  // CX-018（2026-10-09 验收）：带 vacancies=1 → { vacancies, keyRoleCount }（按关键岗位清单计），页签顶部写「空缺岗位 n / t」
  const q = useAsync(() => api.get(TF.withQuery('/api/admin/succession', 'withPositions=1&vacancies=1', scopeQs)), [scopeQs]);
  const [pos, setPos] = useState('');
  const [who, setWho] = useState('');
  const [ready, setReady] = useState('oneYear');
  const [note, setNote] = useState('');
  const list = Array.isArray(q.data) ? q.data : (q.data && Array.isArray(q.data.rows) ? q.data.rows : []);
  const posList = q.data && Array.isArray(q.data.positions) ? q.data.positions : null;
  const scoped = !!(q.data && q.data.scoped);
  // CX-099：下拉先列关键岗位清单（含空缺岗位，q.data.keyPositions），再列已有继任岗位与员工职位；
  // 只差大小写、空格的合并为一项（原来同名异写并存，选项值重复导致个别项不渲染）
  const positions = useMemo(() => {
    const seen = new Set(), out = [];
    // 复测退回（R179）：合并口径与服务端 positionKey 相同（NFKC 全半角、大小写、空格、各种连字符）
    const push = (arr) => { for (const p of arr) { const v = String(p || '').replace(/\s+/g, ' ').trim(); const k = v.normalize('NFKC').toLowerCase().replace(/[\s\-\u2010-\u2015\u2212]+/g, ''); if (v && !seen.has(k)) { seen.add(k); out.push(v); } } };
    // CX-191：空缺的关键岗位排最前，其次其他关键岗位（各自按字母）
    const vac = new Set((q.data && Array.isArray(q.data.vacancies) ? q.data.vacancies : []).map((v) => v.positionName));
    const kp = (q.data && Array.isArray(q.data.keyPositions) ? q.data.keyPositions : []).slice().sort();
    push(kp.filter((p) => vac.has(p)));
    push(kp);
    push([...list.map((x) => x.positionName), ...(posList || []).map((x) => x.positionName), ...(employees || []).map((e) => e.position)].filter(Boolean).sort());
    return out;
  }, [employees, list, posList, q.data]);
  // 关键岗位行全部保留（posList 来自数据范围内的全部继任行）；有页面范围时，没有范围内继任者的岗位显示为空行
  const groups = useMemo(() => {
    const g = new Map();
    for (const p of posList || []) g.set(p.positionName, []);
    for (const v of (q.data && Array.isArray(q.data.vacancies)) ? q.data.vacancies : []) if (!g.has(v.positionName)) g.set(v.positionName, []);   // CX-018：清单里的空缺岗位也列出
    for (const row of list) { if (!g.has(row.positionName)) g.set(row.positionName, []); g.get(row.positionName).push(row); }
    return [...g.entries()];
  }, [list, posList, q.data]);
  // CX-098 / CX-106：服务端带 error_zh 的（已在名单、岗位名超长、找不到继任人）按界面语言显示
  const call = async (fn, msg) => { try { await fn(); Toast.success(msg); } catch (err) { Toast.error((lang === 'zh' && err && err.data && err.data.error_zh) || err.message); } q.reload(); };
  return (
    <div className="ppl-card">
      <div className="ppl-sec-h">
        <div><h2>{s.succTitle}</h2><div className="tset-lead">{s.succLead}</div>
          {q.data && Number(q.data.keyRoleCount) > 0 && (
            <div className="tset-lead trev-vacancy" data-vacancies={(q.data.vacancies || []).length}>
              {(q.data.vacancies || []).length
                ? <><b>{s.succVacancy((q.data.vacancies || []).length, q.data.keyRoleCount)}</b>{(q.data.vacancies || []).map((v) => v.positionName).join(lang === 'zh' ? '、' : ', ')}</>
                : s.succNoVacancy(q.data.keyRoleCount)}
            </div>
          )}
        </div>
        {/* 12.2：「关键岗位清单」给所有 talent 可读者（只读档在清单页只能查看）；「批量导入」仍只给 talent 写 */}
        <span style={{ display: 'inline-flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, marginLeft: 'auto' }}>
          <Button onClick={() => navigate('/admin/talent-review/key-positions')}>{s.scKeyPositions}</Button>
          {canEdit && (
            <Button icon={<IconUpload />} onClick={() => navigate('/admin/talent-review/succession-import')}>{s.scImport}</Button>
          )}
        </span>
      </div>
      {/* 新增继任条目 = POST /api/admin/succession(talent 写)。只读档整条录入行
          收起,换一行说明:留着一个必然 403 的「添加」是最典型的假按钮。 */}
      {canEdit ? (
        <div className="trev-search">
          {/* 复测退回（R179）：Semi Select 开 allowCreate 时只认首次渲染的 optionList —— 员工名单先到、继任数据后到，关键岗位就进不了下拉。
              用随选项变化的 key 让它在数据到齐后重新挂载 */}
          <Select key={'scpos-' + (q.data ? 'ready' : 'wait') + '-' + positions.length} filter allowCreate showClear placeholder={s.scPos} value={pos || undefined} dropdownStyle={{ maxWidth: 'calc(100vw - 48px)' }} onChange={(v) => setPos(v || '')} style={{ minWidth: 200 }}
            optionList={positions.map((p) => ({ label: p, value: p }))} />
          <Select filter showClear placeholder={s.scWho} value={who || undefined} onChange={(v) => setWho(v || '')} style={{ minWidth: 180 }}
            optionList={(employees || []).map((e) => ({ label: `${e.name} (${e.employeeId})`, value: e.id }))} />
          <Select value={ready} onChange={setReady} style={{ minWidth: 200 }} dropdownMatchSelectWidth={false}
            optionList={['ready', 'oneYear', 'twoYears'].map((k) => ({ label: s[k], value: k }))} />
          <Input value={note} placeholder={s.scNote} onChange={setNote} style={{ width: 180 }} />
          <Button theme="solid" type="primary" disabled={!pos || !who}
            onClick={() => call(async () => { await api.post('/api/admin/succession', { positionName: pos, userId: who, readiness: ready, note }); setWho(''); setNote(''); }, s.saved)}>{s.scAdd}</Button>
        </div>
      ) : <div className="tset-foot">{s.roSucc}</div>}
      {groups.length === 0 ? <Empty description={canEdit ? s.scEmpty : s.scEmptyRo} style={{ padding: 20 }} /> : groups.map(([p, rows]) => (
        <div className="trev-succ-group" key={p}>
          <div className="trev-succ-pos">
            {p}
            {/* CX-018：没有继任者的岗位（含清单里的空缺）标「空缺」 */}
            {(rows.length === 0 || (q.data && Array.isArray(q.data.vacancies) && q.data.vacancies.some((v) => v.positionName === p))) && <Tag size="small" color="red" type="light" shape="circle" className="trev-succ-vacant">{s.succVacant}</Tag>}
            {scoped && <Tag size="small" color="indigo" type="light" shape="circle" className="trev-succ-n">{s.succInScope(rows.length)}</Tag>}
          </div>
          <div className="trev-unrated-list">
            {rows.map((r) => (
              <span className="trev-succ-row" key={r.id}>
                <button className="trev-emp" style={canProfile ? undefined : { cursor: 'default' }}
                  onClick={canProfile ? () => navigate(`/admin/people/${r.userId}`) : undefined}>
                  {r.name}{r.jobLevel ? <span className="trev-emp-lv">{r.jobLevel}</span> : null}
                </button>
                {/* The Select IS the readiness — it used to be followed by a Tag
                    showing the same value, so every row said "1 年内" twice.
                    改就绪度 = PUT succession/:id(talent 写):只读档换成一个 Tag,
                    信息一样、不会点出 403。 */}
                {canEdit ? (
                  <Select size="small" value={r.readiness} style={{ minWidth: 168 }} dropdownMatchSelectWidth={false} className="trev-succ-ready"
                    onChange={(v) => call(() => api.put(`/api/admin/succession/${r.id}`, { readiness: v }), s.saved)}
                    optionList={['ready', 'oneYear', 'twoYears'].map((k) => ({ label: s[k], value: k }))} />
                ) : <Tag size="small" color="indigo" type="light" shape="circle">{s[r.readiness] || r.readiness}</Tag>}
                {r.note && <Text type="tertiary" size="small">{r.note}</Text>}
                {/* 移除 = DELETE succession/:id(talent 写) */}
                {canEdit && (
                  <Popconfirm title={s.delSucc} okType="danger" okText={s.remove} cancelText={s.cancel} onConfirm={() => call(() => api.del(`/api/admin/succession/${r.id}`), s.removed)}>
                    <Button size="small" theme="borderless" type="danger">✕</Button>
                  </Popconfirm>
                )}
              </span>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

/* ---- saved talent filters（第五批 8.1，取代原「人才检索」卡） ----
   列表 = 自己的私有筛选 + 全部共享筛选 + 内置筛选（服务端按权限给出 canEdit）。打开 / 复制进整页，删除用 Popconfirm。
   「按档案记录类型新建」承接原人才检索的入口：带 ?record=<类型> 打开新筛选，预置一条「有该类记录」的条件。
   类型下拉与原检索卡同一口径：所属模块未开启的类型（moduleOff，例如 culture 关闭时的「行为实践」）不列出。 */
function FilterListCard({ s, loc, lang, cfg, navigate, canWrite, scopeQs }) {
  const q = useAsync(() => api.get('/api/admin/talent-filters'), []);
  const types = cfg ? cfg.types.filter((t) => t.active && !t.moduleOff) : [];
  const list = q.data && Array.isArray(q.data.filters) ? q.data.filters : [];
  // F60：打开 / 新建 / 复制都带上页面顶部筛选（整页结果 = 顶部范围 ∩ 筛选条件）
  const open = (id, extra = '') => navigate(TF.withQuery(`/admin/talent-review/filter/${encodeURIComponent(id)}${extra}`, scopeQs));
  const del = async (f) => {
    try { await api.del(`/api/admin/talent-filters/${encodeURIComponent(f.id)}`); Toast.success(s.deleted); } catch (err) { Toast.error(err.message); }
    q.reload();
  };
  const nameOf = (f) => (lang === 'zh' ? f.name_zh || f.name : f.name || f.name_zh) || '—';
  return (
    <div className="ppl-card">
      <div className="ppl-sec-h">
        <div><h2>{s.filtersTitle}</h2><div className="tset-lead">{s.filtersLead}</div></div>
        <Button icon={<IconRefresh />} theme="borderless" aria-label={s.refresh} title={s.refresh} onClick={() => q.reload()} />
      </div>
      {scopeQs && <div className="u-hint" style={{ marginBottom: 10 }}>{s.scopeApplied}</div>}
      <div className="trev-search">
        <Button theme="solid" type="primary" icon={<IconPlus />} onClick={() => open('new')}>{s.fNew}</Button>
        <Select showClear placeholder={s.fQuick} value={undefined} className="u-w-lg"
          onChange={(v) => { if (v) navigate(TF.withQuery(`/admin/talent-review/filter/new?record=${encodeURIComponent(v)}`, scopeQs)); }}
          optionList={types.map((t) => ({ label: `${t.icon || ''} ${loc(t, 'label')}`.trim(), value: t.key }))} />
      </div>
      {q.error ? <Banner type="danger" closeIcon={null} description={`${s.loadFail} · ${q.error.message}`} />
        : !q.data ? <div style={{ textAlign: 'center', padding: 24 }}><Spin /></div>
          : list.length === 0 ? <Empty description={s.fEmpty} style={{ padding: 20 }} /> : (
            <Table rowKey="id" dataSource={list} size="small"
              pagination={list.length > 10 ? { pageSize: DEFAULT_PAGE, pageSizeOpts: PAGE_TIERS, showSizeChanger: true, formatPageText: false } : false}
              {...resizableTable([
                { title: s.fName, dataIndex: 'name', width: 220, render: (_, f) => (
                  <span className="emp-namelink emp-ellip" style={{ cursor: 'pointer' }} title={nameOf(f)} onClick={() => open(f.id)}>{nameOf(f)}</span>
                ) },
                { title: s.fKind, dataIndex: 'visibility', width: 150, render: (v, f) => (
                  <span className="tf-namecell">
                    <Tag size="small" type="light" shape="circle" color={f.builtinKey ? 'violet' : v === 'shared' ? 'blue' : 'grey'}>
                      {f.builtinKey ? s.kindBuiltin : v === 'shared' ? s.kindShared : s.kindMine}
                    </Tag>
                    {!f.mine && f.owner && f.owner.name ? <Text type="tertiary" size="small" className="emp-ellip" title={s.fOwner(f.owner.name)}>{f.owner.name}</Text> : null}
                  </span>
                ) },
                { title: s.fUpdated, dataIndex: 'updatedAt', width: 110, render: (v) => <Text type="tertiary" size="small" className="u-date">{v ? localDay(v) : '—'}</Text> },
                { title: s.fSummary, dataIndex: 'summary', width: 360, render: (_, f) => {
                  const t = (lang === 'zh' ? f.summary_zh || f.summary : f.summary || f.summary_zh) || '';
                  return <span className="emp-ellip" title={t}>{t || '—'}</span>;
                } },
                { title: s.colAct, dataIndex: '__act', width: 190, render: (_, f) => (
                  <span className="tf-rowacts">
                    <Button size="small" theme="borderless" onClick={() => open(f.id)}>{s.open}</Button>
                    {canWrite && <Button size="small" theme="borderless" onClick={() => open('new', `?from=${encodeURIComponent(f.id)}`)}>{s.copy}</Button>}
                    {canWrite && f.canEdit && !f.builtinKey && (
                      <Popconfirm title={s.delFilter} content={s.delFilterDesc} okType="danger" okText={s.del} cancelText={s.cancel} onConfirm={() => del(f)}>
                        <Button size="small" theme="borderless" type="danger">{s.del}</Button>
                      </Popconfirm>
                    )}
                  </span>
                ) },
              ])} />
          )}
    </div>
  );
}
