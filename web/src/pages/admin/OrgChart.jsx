// 组织架构 Org chart — powered by d3-org-chart (the de-facto standard library,
// pattern learned from Chelsea's org-chart-studio reference):
//   smooth pan/zoom · compact layout · animated expand/collapse with per-node
//   ± buttons · fit-to-screen · locate&center a person · PNG export ·
//   diagnosis flags drawn ON the node cards (wide/narrow span, deep chain).
// A virtual company root ties the company's multiple top nodes into one tree
// (labelled with the white-label brand wordmark, never a hard-coded vendor name).
// Click a card → actions (profile / change manager). Diagnostics tab unchanged.
import { useMedia } from '../../useMedia.js';
import { useMemo, useState, useRef, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Banner, Spin, Tag, Select, Typography, Empty, Button, Input, Modal, Toast, Tooltip } from '@douyinfe/semi-ui';
import { IconSearch, IconRefresh, IconHelpCircle } from '@douyinfe/semi-icons';
import { api, useAsync } from '../../api.js';
import { useI18n } from '../../i18n.jsx';
import { useAuth } from '../../auth.jsx';
import { canWriteDomain, isDomainReadOnly } from '../../rbac.js';
import { brandWordmark } from '../../brand.js';
import DeptFilter, { deptFilterInvalidText } from '../../components/DeptFilter.jsx';
import { useDeptTree, deptMatcher } from '../../deptfilter.js';
import { useUrlState } from '../../urlstate.js';
import { IcWarn, IcInfo } from '../../components/LineIcons.jsx';
import ReadOnlyPill from '../../components/ReadOnlyPill.jsx';

const { Text } = Typography;

const T = {
  zh: {
    outOfScopeNode: '范围外上级', title: '组织架构', lead: '默认按部门组织：部门卡显示负责人与人数，展开部门看下级部门与成员（成员按部门内汇报线排列）；「人员视图」按全公司汇报线。滚轮缩放、拖动平移；点人员卡可进档案或调整汇报线。',
    deptNone: '未归入部门', deptOwner: (n) => `负责人 ${n}`, deptOwnerGuess: (n) => `${n} · 推定负责人`, deptOwnerGuessTip: (n) => `部门页未指定负责人，按本部门汇报线最上层推定为 ${n}。到「部门」页填写负责人后以填写为准。`, deptOwnerNone: '未指定负责人', collapseAny: (n) => `− 收起 ${n}`, expandAny: (n) => `+ 展开 ${n}`,
    companyDeptSub: (d, p) => `${d} 个部门 · ${p} 人`, deptPickHint: '顶层部门较多：请在「全部部门」里选一个部门，或搜索姓名 / 部门名定位。',
    tabChart: '架构图', tabDiag: '组织诊断',
    viewPeople: '人员视图', viewDept: '部门视图',
    deptHeadN: (n) => `本部 ${n}`, deptTotalN: (n) => `含下级部门 ${n}`,
    deptAll: '全部部门', searchPh: '搜索并定位…', locate: '定位', refresh: '刷新',
    fit: '适应画布', expand2: '展开两层', expandAll: '全部展开', collapseAll: '全部收起', exportPng: '导出 PNG',
    zoomIn: '放大', zoomOut: '缩小', zoomReset: '恢复 100%',
    companySub: '全公司', directs: (n) => `直接下属 ${n}`, team: (n) => `汇报线 ${n.toLocaleString()}`,
    span: (n) => `管理幅度 ${n}`, collapseN: (n) => `− 收起 ${n} 人`, expandN: (n) => `+ 展开 ${n} 人`,
    openProfile: '查看员工档案', editMgr: '更换直属上级', noMgr: '（设为顶层，无上级）',
    // 本页唯一的写操作是 PUT /api/admin/employees/:id { managerId }(员工与组织域/写),
    // 与本页同域,所以只需一道「只读档」的门 —— 架构图与诊断本身是读,照旧可看。
    // 11.4（F49 / F51 ①）：不再放说明文字，只读档在标题右侧放「只读」胶囊，悬停给这一句；页面用法说明收进标题旁的「?」。
    roTip: '你对「员工与组织」只有查看权限，不能调整汇报线；架构图与诊断照常查看。', help: '页面说明',
    moveDesc: (a, b) => `把「${a}」的直属上级改为「${b}」?`, move: '确认调整', moved: '汇报线已调整', cancel: '取消',
    wWide: '管理幅度过宽', wNarrow: '管理幅度过窄（=1）', wDeep: '层级过深',
    notFound: '没找到这个名字', empty: '还没有在职员工。',
    kHead: '在职人数', kMgr: '管理者', kIc: '独立贡献者', kSpan: '平均管理幅度', kDepth: '组织层级', kRoots: '顶层节点',
    spanTitle: '管理幅度明细', spanMore: (n) => `… 另有 ${n} 人`, wide: '过宽 ≥10', narrow: '过窄 =1', ok: '合理',
    compTitle: '职业通道与职等构成', trackM: 'M 管理通道', trackP: 'P 专业通道', trackNone: '职级未纳入职级体系',
    deptTitle: '部门规模', talentTitle: '人才覆盖',
    tHipo: '高潜人数', tPot: '已评潜力', tSuccP: '关键岗位（继任）', tSuccE: '继任安排',
    findTitle: '诊断发现', noFindings: '没有发现异常 — 结构健康 ✓',
    f_multiRoots: (p) => `有 ${p.n} 个顶层节点（未设上级）:${(p.names || []).join('、')}——确认是否都应为顶层`,
    f_wideSpan: (p) => `${p.name} 直属 ${p.n} 人，管理幅度过宽（警戒线 ≥10），考虑增设中层或拆分团队`,
    f_narrowSpan: (p) => `${p.n} 名管理者只带 1 人，管理幅度过窄，考虑合并汇报线`,
    f_deepOrg: (p) => `组织层级达 ${p.n} 层（建议 ≤6），信息传递链路偏长`,
    f_unmappedLevels: (p) => `${p.n} 人的职级未纳入职级体系，职业通道与职等分析不完整`,
    f_probationManagers: (p) => `${p.n} 名试用期员工负责管理团队（${(p.names || []).join('、')}），请关注其管理准备度`,
    mxIn: (n) => `${n} 人虚线汇报给他/她`, mxOut: (n) => `另有 ${n} 条虚线汇报`, mxConc: (n) => `兼任 ${n} 个岗位`,
    lgSolid: '实线汇报', lgDotted: '虚线汇报', lgNone: '还没有虚线汇报 — 在员工档案的「汇报关系」里添加',
    lgHint: '两端都展开时才会画出虚线', spanTip: (n) => '管理幅度 ' + n + ' 人',
    lgWide: '幅度过宽 ≥10', lgNarrow: '幅度过窄 =1', lgOk: '合理',
    listLead: '逐层下钻：点右侧箭头看下属，点条目进档案。缩放平移请在桌面端使用。',
    up: '上一层', noDirects: '没有直属下属', matchesN: (n) => `${n} 条匹配`,
    mxTitle: '矩阵汇报', mxDotted: '虚线关系', mxConcPosts: '兼任岗位', mxPeopleDotted: '有虚线的人', mxPeopleConc: '有兼任的人', mxManagers: '虚线上级',
    f_matrixOverload: (p) => `${p.name} 实线 ${p.solid} 人 + 虚线 ${p.dotted} 人 = 实际带 ${p.total} 人，单看实线看不出这个负荷`,
    loadFail: '加载失败，请刷新页面重试。',
  },
  en: {
    outOfScopeNode: 'Manager outside your scope', title: 'Org Chart', lead: 'Organised by department by default: a department card shows its head and headcount; expand it for sub-departments and members (members follow the reporting line inside the department). “People” shows the company-wide reporting line. Wheel to zoom, drag to pan; click a person for profile / reporting-line actions.',
    deptNone: 'No department', deptOwner: (n) => `Head: ${n}`, deptOwnerGuess: (n) => `${n} · presumed head`, deptOwnerGuessTip: (n) => `No head is set on the Departments page; ${n} is inferred as the top of this department's reporting line. A head set on the Departments page takes precedence.`, deptOwnerNone: 'No head set', collapseAny: (n) => `− Collapse ${n}`, expandAny: (n) => `+ Expand ${n}`,
    companyDeptSub: (d, p) => `${d} departments · ${p} people`, deptPickHint: 'Many top-level departments: pick one in “All departments”, or search a name / department to locate it.',
    tabChart: 'Chart', tabDiag: 'Org Diagnostics',
    viewPeople: 'People', viewDept: 'Departments',
    deptHeadN: (n) => `${n} direct`, deptTotalN: (n) => `${n} incl. sub-departments`,
    deptAll: 'All departments', searchPh: 'Search & locate…', locate: 'Locate', refresh: 'Refresh',
    fit: 'Fit', expand2: '2 levels', expandAll: 'Expand all', collapseAll: 'Collapse all', exportPng: 'Export PNG',
    zoomIn: 'Zoom in', zoomOut: 'Zoom out', zoomReset: 'Reset to 100%',
    companySub: 'Whole company', directs: (n) => `${n} direct`, team: (n) => `total ${n.toLocaleString()}`,
    span: (n) => `Span of control ${n}`, collapseN: (n) => `− Collapse ${n}`, expandN: (n) => `+ Expand ${n}`,
    openProfile: 'Open employee profile', editMgr: 'Change manager', noMgr: '(top level, no manager)',
    roTip: 'You have view-only access to People & Organization, so you cannot change reporting lines. The chart and diagnostics are still available.', help: 'About this page',
    moveDesc: (a, b) => `Move "${a}" under "${b}"?`, move: 'Confirm', moved: 'Reporting line updated', cancel: 'Cancel',
    wWide: 'Span too wide', wNarrow: 'Span too narrow (=1)', wDeep: 'Chain too deep',
    notFound: 'No match for that name', empty: 'No active employees yet.',
    kHead: 'Headcount', kMgr: 'Managers', kIc: 'Individual contributors', kSpan: 'Avg span', kDepth: 'Org depth', kRoots: 'Root nodes',
    spanTitle: 'Span of control', spanMore: (n) => `… ${n} more`, wide: 'Wide ≥10', narrow: 'Narrow =1', ok: 'Healthy',
    compTitle: 'Career Track and Grade Composition', trackM: 'M · Management', trackP: 'P · Professional', trackNone: 'Not in Job Level Framework',
    deptTitle: 'Department sizes', talentTitle: 'Talent coverage',
    tHipo: 'HiPo', tPot: 'Potential rated', tSuccP: 'Key Positions (Succession)', tSuccE: 'Succession Entries',
    findTitle: 'Findings', noFindings: 'No anomalies — structure looks healthy ✓',
    f_multiRoots: (p) => `${p.n} root nodes without a manager: ${(p.names || []).join(', ')} — confirm they should all be top-level`,
    f_wideSpan: (p) => `${p.name} has ${p.n} directs — span too wide (threshold ≥10); consider a mid layer or a split`,
    f_narrowSpan: (p) => `${p.n} managers have exactly 1 direct — consider merging lines`,
    f_deepOrg: (p) => `Org depth is ${p.n} layers (aim ≤6) — long communication chains`,
    f_unmappedLevels: (p) => `${p.n} ${p.n === 1 ? 'person has a job level' : 'people have job levels'} not in the Job Level Framework, so the track and grade analysis is incomplete`,
    f_probationManagers: (p) => `${p.n} probationary employee${p.n === 1 ? ' manages a team' : 's manage teams'} (${(p.names || []).join(', ')}). Review their readiness to manage.`,
    mxIn: (n) => `${n} dotted reports`, mxOut: (n) => `${n} dotted line(s) out`, mxConc: (n) => `${n} concurrent post(s)`,
    lgSolid: 'Solid line', lgDotted: 'Dotted line', lgNone: 'No dotted lines yet — add them on a profile under Reporting relationships',
    lgHint: 'A dashed link draws when both people are expanded', spanTip: (n) => 'Span of control: ' + n,
    lgWide: 'Span ≥10 (wide)', lgNarrow: 'Span =1 (narrow)', lgOk: 'Healthy',
    listLead: 'Drill down a level with the arrow, tap a row for the profile. Zoom & pan stay on desktop.',
    up: 'Up a level', noDirects: 'No direct reports', matchesN: (n) => `${n} matches`,
    mxTitle: 'Matrix reporting', mxDotted: 'Dotted relationships', mxConcPosts: 'Concurrent posts', mxPeopleDotted: 'People with dotted lines', mxPeopleConc: 'People with concurrent posts', mxManagers: 'Dotted-line managers',
    f_matrixOverload: (p) => `${p.name} carries ${p.solid} solid + ${p.dotted} dotted = ${p.total} people; the solid span alone hides this load`,
    loadFail: 'Couldn’t load. Refresh the page to try again.',
  },
};

const DEPT_COLORS = ['#4636e3', '#00a2c8', '#009a29', '#e07600', '#b8860b', '#7c5cff', '#e0453f', '#0e7c66'];
const ROOT_ID = '__company__';
// One source of truth for the dotted/matrix colour: the chart links, their
// arrow markers, the legend swatch and the node badges all use it.
const MATRIX_COLOR = '#00a2c8';
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[c]));

// 部门徽标:线性图标,沿用 svg.ic 约定(stroke 取徽标自身的 --brand 色)。
// Two spellings of the same mark, because the two layouts build markup two ways:
// the canvas cards are an HTML string handed to d3-org-chart, the narrow list is JSX.
// The string one repeats fill/stroke as presentation attributes: 导出 PNG
// serialises the chart SVG on its own, without app.css, and an .ic that loses its
// rule would export as filled black blobs. CSS still wins wherever it is present.
const DEPT_ICON_HTML = '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"'
  + ' fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">'
  + '<path d="M4 21V5a1 1 0 0 1 1-1h8a1 1 0 0 1 1 1v16"/>'
  + '<path d="M14 10h5a1 1 0 0 1 1 1v10"/>'
  + '<path d="M3 21h18M7.5 8h3M7.5 12h3M7.5 16h3"/>'
  + '</svg>';
const DeptIcon = () => (
  <svg className="ic" viewBox="0 0 24 24" aria-hidden="true">
    <path d="M4 21V5a1 1 0 0 1 1-1h8a1 1 0 0 1 1 1v16" />
    <path d="M14 10h5a1 1 0 0 1 1 1v10" />
    <path d="M3 21h18M7.5 8h3M7.5 12h3M7.5 16h3" />
  </svg>
);

// 直属 / 全编 only say different things once there are grandchildren — a leaf
// manager would read「直属 11 · 全编 11」, which the design writes as「管理幅度 11」.
const countParts = (s, r) => (!r.directs ? []
  : r.team > r.directs ? [s.directs(r.directs), s.team(r.team)] : [s.span(r.directs)]);

// F51 ③（2026-10-09）「适应画布」：打开页面时与点按钮时都走这里。d3-org-chart 自带的 fit() 最多放大到 8 倍，
// 节点少时（部门视图只有公司卡与几个部门）卡片被放大到 2~3 倍，负责人与人数字号过大、两侧节点名被画布裁掉。
// 这里按同一套边界（四周各留 50）计算，但缩放上限为 FIT_MAX = 1：整张图放得下就按设计尺寸居中，放不下才缩小。
// 画布宽度在首次绘制后可能变化（11.1 去掉限宽、侧栏收起），所以先按容器当前宽度更新画布宽度再计算。
const FIT_MAX = 1;
function fitChart(chart, animate = true) {
  try {
    const st = chart.getChartState();
    const { root, layoutBindings, layout, svg, zoomBehavior, centerG, duration, container } = st;
    const el = container && (typeof container === 'string' ? document.querySelector(container) : container);
    const cw = el ? el.getBoundingClientRect().width : 0;
    if (cw > 0 && Math.abs(cw - st.svgWidth) > 1) { st.svgWidth = cw; svg.attr('width', cw); }
    const w = st.svgWidth, h = st.svgHeight;
    const lb = layoutBindings[layout];
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const d of root.descendants()) {
      x0 = Math.min(x0, d.x + lb.nodeLeftX(d)); x1 = Math.max(x1, d.x + lb.nodeRightX(d));
      y0 = Math.min(y0, d.y + lb.nodeTopY(d)); y1 = Math.max(y1, d.y + lb.nodeBottomY(d));
    }
    x0 -= 50; x1 += 50; y0 -= 50; y1 += 50;
    const k = Math.min(FIT_MAX, 0.9 / Math.max((x1 - x0) / w, (y1 - y0) / h));
    // d3-zoom 的 Transform 构造器取自画布上现成的 __zoom（不为一个构造器再引一份 d3-zoom）
    const cur = svg.node().__zoom;
    if (!(k > 0) || !Number.isFinite(k) || !cur) throw new Error('fit');
    const t = new cur.constructor(k, w / 2 - (k * (x0 + x1)) / 2, h / 2 - (k * (y0 + y1)) / 2);
    const ms = animate ? duration : 0;
    svg.transition().duration(ms).call(zoomBehavior.transform, t);
    if (centerG) centerG.transition().duration(ms).attr('transform', 'translate(0,0)');
  } catch {
    try { chart.fit({ animate }); } catch { /* chart not drawn yet */ }
  }
  return chart;
}

// The chart can't be CSS-downgraded: a 232px card canvas on a 390px screen is
// unusable, and hiding it would still pay for building the d3 tree. So the
// breakpoint is read in JS and the narrow layout swaps the canvas for a
// level-by-level list (design: 缩放操作留给桌面端).
const NARROW_Q = '(max-width:900px)';
const useNarrow = () => useMedia(NARROW_Q);

export default function OrgChart() {
  const { lang } = useI18n();
  const { user } = useAuth();
  // The virtual root card is labelled with the white-label brand name (the
  // same wordmark the top bar renders) — the generic default when unbranded.
  const s = useMemo(
    () => ({ ...T[lang], company: brandWordmark((user && user.brand) || null, lang) }),
    [lang, user],
  );
  const navigate = useNavigate();
  // The only write on this page (doMove → PUT /employees/:id { managerId }) is
  // people 写, the page's own domain — no cross-domain control here. So the one
  // gate needed is the read-only档: reading the chart is fine, editing is a 403.
  const canWritePeople = canWriteDomain(user, 'people');
  const peopleReadOnly = isDomainReadOnly(user, 'people');
  const q = useAsync(() => api.get('/api/admin/org-chart'), []);
  const dq = useAsync(() => api.get('/api/admin/departments'), []);
  // CX-126：工作台「管理幅度」的「去处理」带 ?tab=diag，直接打开诊断视图
  const [tab, setTab] = useState(() => {
    try { return new URLSearchParams((window.location.hash.split('?')[1]) || '').get('tab') === 'diag' ? 'diag' : 'chart'; } catch { return 'chart'; }
  });
  const [view, setView] = useState('dept'); // dept (org units, default since 2026-10-06) | people (reporting lines)
  // 部门筛选（第二批 3.1，10/8）：地址栏 dept=<部门 id>，全站唯一口径（/api/admin/dept-tree，含下级）。人员视图按 deptMatcher
  // 过滤并往上带出上级链；部门视图以所选部门为根画子树；「name:」伪 id、无部门或已停用部门 → 只画「未归入部门」里匹配的人。
  const [urlParams, patchUrl] = useUrlState();
  const dept = urlParams.dept || '';
  const setDept = (v) => patchUrl({ dept: v || null });
  const deptTree = useDeptTree();
  const deptOk = useMemo(() => deptMatcher(deptTree, dept || null), [deptTree, dept]);
  const [query, setQuery] = useState('');
  const [picked, setPicked] = useState(null);   // clicked node → action modal
  const [movePlan, setMovePlan] = useState(null); // {node, target|null|undefined}
  const [showDotted, setShowDotted] = useState(true);
  const [zoomK, setZoomK] = useState(1); // live scale, fed by the chart's zoom events
  const narrow = useNarrow();
  const [focusId, setFocusId] = useState(ROOT_ID); // narrow layout: current level
  const containerRef = useRef(null);
  const chartRef = useRef(null);
  const pendingFocus = useRef(null); // 部门视图：切到某部门后要高亮的节点 id
  // The endpoint returns { nodes, secondary }; tolerate the old bare-array shape
  // so a stale cached chunk cannot blank the page.
  const nodes = Array.isArray(q.data) ? q.data : (q.data && q.data.nodes) || [];
  const secondary = (q.data && q.data.secondary) || [];

  const departments = useMemo(() => [...new Set(nodes.map((n) => n.department).filter(Boolean))].sort(), [nodes]);
  const deptColor = useCallback((d) => {
    if (!d) return '#c9cdd6';
    const i = departments.indexOf(d);
    if (i >= 0) return DEPT_COLORS[i % DEPT_COLORS.length];
    let h = 0; for (const ch of d) h = (h * 31 + ch.charCodeAt(0)) >>> 0; // names outside the people list (dept view)
    return DEPT_COLORS[h % DEPT_COLORS.length];
  }, [departments]);

  // Flatten → d3-org-chart rows under one virtual company root, with per-node
  // diagnosis flags (span wide/narrow, deep chain) computed from the edges.
  // Matrix tallies keyed by person: dotted lines in (their matrix team), dotted
  // lines out (who they also report to), and concurrent posts held.
  const { dottedIn, dottedOut, concurrentOf } = useMemo(() => {
    const inM = new Map(); const outM = new Map(); const conc = new Map();
    for (const r of secondary) {
      if (r.kind === 'concurrent') { conc.set(r.userId, (conc.get(r.userId) || 0) + 1); continue; }
      outM.set(r.userId, (outM.get(r.userId) || 0) + 1);
      if (r.managerId) inM.set(r.managerId, (inM.get(r.managerId) || 0) + 1);
    }
    return { dottedIn: inM, dottedOut: outM, concurrentOf: conc };
  }, [secondary]);

  const chartData = useMemo(() => {
    if (!nodes.length) return [];
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const kids = new Map();
    for (const n of nodes) {
      if (n.managerId && byId.has(n.managerId)) {
        if (!kids.has(n.managerId)) kids.set(n.managerId, []);
        kids.get(n.managerId).push(n);
      }
    }
    const counts = new Map();
    const teamOf = (id) => {
      if (counts.has(id)) return counts.get(id);
      counts.set(id, 0);
      const c = (kids.get(id) || []).reduce((a, k) => a + 1 + teamOf(k.id), 0);
      counts.set(id, c);
      return c;
    };
    const depths = new Map();
    const roots = nodes.filter((n) => !n.managerId || !byId.has(n.managerId));
    const walk = (list, d) => { for (const n of list) { if (depths.has(n.id)) continue; depths.set(n.id, d); walk(kids.get(n.id) || [], d + 1); } };
    walk(roots, 1);
    // 本人部门命中，或下属链里有人命中（保留往上的上级链）；按 id 记忆，避免大名册上反复递归
    const scopeMemo = new Map();
    const inScope = (n) => {
      if (!dept) return true;
      if (scopeMemo.has(n.id)) return scopeMemo.get(n.id);
      scopeMemo.set(n.id, false);   // 成环防御
      const v = deptOk(n.department) || (kids.get(n.id) || []).some(inScope);
      scopeMemo.set(n.id, v);
      return v;
    };
    const rows = [{ id: ROOT_ID, parentId: null, virtual: true }];
    for (const n of nodes) {
      if (dept && !inScope(n)) continue;
      const parentVisible = n.managerId && byId.has(n.managerId) && (!dept || inScope(byId.get(n.managerId)));
      const directs = (kids.get(n.id) || []).length;
      const flags = [];
      if (directs >= 10) flags.push('wide');
      else if (directs === 1) flags.push('narrow');
      if ((depths.get(n.id) || 1) > 6) flags.push('deep');
      rows.push({
        id: n.id, parentId: parentVisible ? n.managerId : ROOT_ID,
        name: n.outOfScope && !n.name ? s.outOfScopeNode : n.name, position: n.position, department: n.department, jobLevel: n.jobLevel,
        directs, team: teamOf(n.id), flags,
        // Matrix counts, so a card shows its dotted load even when the dashed
        // link itself is off-screen or collapsed away.
        dottedIn: dottedIn.get(n.id) || 0,
        dottedOut: dottedOut.get(n.id) || 0,
        concurrent: concurrentOf.get(n.id) || 0,
      });
    }
    return rows;
  }, [nodes, dept, deptOk, dottedIn, dottedOut, concurrentOf]);

  // Dashed cross-links for d3-org-chart. It only draws a connection when BOTH
  // endpoints are currently visible nodes, so collapsed branches simply drop
  // their links instead of drawing lines into nowhere.
  const connections = useMemo(() => {
    if (view !== 'people' || !showDotted) return [];
    const inScope = new Set(chartData.map((r) => r.id));
    return secondary
      .filter((r) => r.kind === 'dotted' && inScope.has(r.userId) && inScope.has(r.managerId))
      .map((r) => ({ from: r.userId, to: r.managerId, label: r.position || '' }));
  }, [secondary, chartData, view, showDotted]);
  const dottedCount = useMemo(() => secondary.filter((r) => r.kind === 'dotted').length, [secondary]);

  // Department hierarchy view: company → business unit → department. Headcount
  // rolls up so a BU card shows its own people plus everyone underneath.
  // 部门视图（2026-10-06 负责人决定：架构图按部门组织，默认视图）：公司 → 部门树（departments.parentId）→ 每个部门下挂本部门成员。
  // 成员归属按部门名匹配（先原文、再不区分大小写），与名册 / 范围解析同一口径；部门内成员按汇报线排列（直属上级在同一部门 → 挂在上级下，
  // 否则挂在部门节点下），负责人（ownerId）排最前。部门卡显示负责人、本部人数与含下级合计；归不进任何部门的人集中在「未归入部门」。
  const deptChartData = useMemo(() => {
    let deps = (dq.data || []).filter((d) => d.active !== 0);
    if (!deps.length) return [];
    const byId = new Map(deps.map((d) => [d.id, d]));
    const kids = new Map();
    for (const d of deps) {
      if (d.parentId && byId.has(d.parentId)) {
        if (!kids.has(d.parentId)) kids.set(d.parentId, []);
        kids.get(d.parentId).push(d);
      }
    }
    const byName = new Map();
    for (const d of deps) { if (!byName.has(d.name)) byName.set(d.name, d); const k = String(d.name).trim().toLowerCase(); if (!byName.has(k)) byName.set(k, d); }
    const members = new Map(); const orphans = [];
    for (const n of nodes) {
      const d = n.department ? (byName.get(n.department) || byName.get(String(n.department).trim().toLowerCase())) : null;
      if (d) { if (!members.has(d.id)) members.set(d.id, []); members.get(d.id).push(n); } else orphans.push(n);
    }
    const own = (d) => (members.get(d.id) || []).length;
    const totals = new Map();
    const totalOf = (d) => {
      if (totals.has(d.id)) return totals.get(d.id);
      totals.set(d.id, own(d)); // cycle-safe placeholder
      const t = own(d) + (kids.get(d.id) || []).reduce((acc, k) => acc + totalOf(k), 0);
      totals.set(d.id, t);
      return t;
    };
    deps.forEach(totalOf);
    // A tree that already has a single top department (e.g. the company itself,
    // synced from Lark) uses that department as the root — a virtual company
    // card above it would only repeat it. Several top departments keep the
    // virtual root that ties them together.
    // 选了部门（dept 为部门 id）：只画这个部门的子树，并以它为根 —— 顶层部门很多时这是主要的浏览方式
    const picked = dept ? deps.find((d) => String(d.id) === String(dept)) || null : null;
    if (picked) {
      const keep = new Set([picked.id]); const stack = [picked.id];
      while (stack.length) for (const k of kids.get(stack.pop()) || []) if (!keep.has(k.id)) { keep.add(k.id); stack.push(k.id); }
      for (const id of [...byId.keys()]) if (!keep.has(id)) byId.delete(id);
      deps = deps.filter((d) => keep.has(d.id));
    }
    // 伪 id（部门不在部门表）、无部门、已停用部门：部门表里没有这棵子树，只画「未归入部门」里与筛选匹配的人
    const pseudo = !!dept && !picked;
    if (pseudo) { byId.clear(); deps = []; }
    const tops = deps.filter((d) => !(d.parentId && byId.has(d.parentId)));
    const single = tops.length === 1 ? tops[0] : null;
    const rowId = (d) => (single && d.id === single.id ? ROOT_ID : 'dept:' + d.id);
    const rows = single ? [] : [{ id: ROOT_ID, parentId: null, virtual: true }];
    // 全公司直属下属数，给人员卡的幅度徽标用（与人员视图同口径）
    const directsOf = new Map();
    for (const n of nodes) if (n.managerId) directsOf.set(n.managerId, (directsOf.get(n.managerId) || 0) + 1);
    const pushPeople = (list, parentRowId, ownerId, explicit = true) => {
      const ids = new Set(list.map((n) => n.id));
      const byIdN = new Map(list.map((n) => [n.id, n]));
      const sorted = list.slice().sort((x, y) => (x.id === ownerId ? -1 : y.id === ownerId ? 1 : 0) || (directsOf.get(y.id) || 0) - (directsOf.get(x.id) || 0) || String(x.name).localeCompare(String(y.name)));
      for (const n of sorted) {
        // 上级在同一部门且不成环 → 挂在上级下；否则挂在部门节点下
        let parent = parentRowId;
        if (n.managerId && n.managerId !== n.id && ids.has(n.managerId)) {
          const seen = new Set([n.id]); let cur = byIdN.get(n.managerId); let cyc = false;
          while (cur) { if (seen.has(cur.id)) { cyc = true; break; } seen.add(cur.id); cur = cur.managerId && ids.has(cur.managerId) ? byIdN.get(cur.managerId) : null; }
          if (!cyc) parent = n.managerId;
        }
        const directs = directsOf.get(n.id) || 0;
        rows.push({
          id: n.id, parentId: parent,
          name: n.outOfScope && !n.name ? s.outOfScopeNode : n.name, position: n.position, department: n.department, jobLevel: n.jobLevel,
          directs, team: directs, flags: directs >= 10 ? ['wide'] : directs === 1 ? ['narrow'] : [],
          dottedIn: dottedIn.get(n.id) || 0, dottedOut: dottedOut.get(n.id) || 0, concurrent: concurrentOf.get(n.id) || 0,
          isHead: explicit && n.id === ownerId,
        });
      }
    };
    // 部门页没填负责人时：取本部门内汇报线最上层（上级不在本部门）里直属下属最多的人，卡上标「推定」
    const guessHead = (list) => {
      if (!list.length) return null;
      const ids = new Set(list.map((n) => n.id));
      const tops = list.filter((n) => !(n.managerId && n.managerId !== n.id && ids.has(n.managerId)));
      const pool = tops.length ? tops : list;
      return pool.slice().sort((x, y) => (directsOf.get(y.id) || 0) - (directsOf.get(x.id) || 0) || String(x.name).localeCompare(String(y.name)))[0];
    };
    for (const d of deps) {
      const mem = members.get(d.id) || [];
      const guess = d.ownerId ? null : guessHead(mem);
      rows.push({
        id: rowId(d),
        parentId: single && d.id === single.id ? null : d.parentId && byId.has(d.parentId) ? rowId(byId.get(d.parentId)) : ROOT_ID,
        isDept: true, name: d.name, headcount: own(d), total: totals.get(d.id) || 0, ownerName: d.ownerName || (guess ? guess.name : null), ownerGuess: !d.ownerName && !!guess, ownerId: d.ownerId || null,
      });
      pushPeople(mem, rowId(d), d.ownerId || (guess ? guess.id : null), !!d.ownerId);
    }
    const orphanList = pseudo ? orphans.filter((n) => deptOk(n.department)) : orphans;
    if (orphanList.length && !picked) {
      rows.push({ id: 'dept:__none', parentId: ROOT_ID, isDept: true, name: s.deptNone, headcount: orphanList.length, total: orphanList.length, ownerName: null, ownerId: null });
      pushPeople(orphanList, 'dept:__none', null);
    }
    return rows;
  }, [dq.data, nodes, dottedIn, dottedOut, concurrentOf, s, dept, deptOk]);

  const activeData = view === 'dept' ? deptChartData : chartData;
  // 顶层部门很多（本地扁平测试数据 78 个；Lark 树只有几个）时，部门视图先只画公司节点，由部门下拉 / 搜索定位展开，避免一排几十张卡缩到 5%
  const topDeptCount = useMemo(() => deptChartData.filter((r) => r.isDept && (r.parentId === ROOT_ID || r.parentId == null)).length, [deptChartData]);

  // Same rows the canvas draws, indexed for the narrow list: parent lookup for
  // the breadcrumb, children lookup for the level being shown.
  const { byRowId, childrenOf } = useMemo(() => {
    const byRowId = new Map(); const childrenOf = new Map();
    for (const r of activeData) {
      byRowId.set(r.id, r);
      const p = r.parentId || ROOT_ID;
      if (r.id === ROOT_ID) continue;
      if (!childrenOf.has(p)) childrenOf.set(p, []);
      childrenOf.get(p).push(r);
    }
    return { byRowId, childrenOf };
  }, [activeData]);
  // Switching view or narrowing the department scope invalidates the drill path.
  useEffect(() => { setFocusId(ROOT_ID); }, [view, dept]);
  const focus = byRowId.has(focusId) ? byRowId.get(focusId) : (byRowId.get(ROOT_ID) || null);
  const trail = useMemo(() => {
    const out = []; let cur = focus; const seen = new Set();
    while (cur && !seen.has(cur.id)) { seen.add(cur.id); out.unshift(cur); cur = byRowId.get(cur.parentId); }
    return out;
  }, [focus, byRowId]);
  // The search box drives the list too: a hit list replaces the current level
  // rather than adding a second, parallel filter.
  const listRows = useMemo(() => {
    const t = query.trim().toLowerCase();
    const level = (focus && childrenOf.get(focus.id)) || [];
    if (!t) return level;
    return activeData.filter((r) => !r.virtual && [r.name, r.position, r.department].some((v) => v && String(v).toLowerCase().includes(t))).slice(0, 60);
  }, [query, focus, childrenOf, activeData]);

  const nodeCard = useCallback((d) => {
    if (d.virtual) {
      return `<div class="orgd2 orgd2--root"><div class="orgd2__body">
        <div class="orgd2__name">${esc(s.company)}</div>
        <div class="orgd2__sub">${view === 'dept' ? esc(s.companyDeptSub(activeData.filter((r) => r.isDept).length, activeData.filter((r) => !r.isDept && !r.virtual).length)) : esc(s.companySub) + ' · ' + (activeData.length - 1)}</div>
      </div></div>`;
    }
    if (d.isDept) {
      return `<div class="orgd2 orgd2--dept" style="--dc:${deptColor(d.name)}">
        <div class="orgd2__bar"></div>
        <div class="orgd2__body">
          <div class="orgd2__head"><span class="orgd2__ava">${DEPT_ICON_HTML}</span>
            <span class="orgd2__name" title="${esc(d.name)}">${esc(d.name)}</span></div>
          ${d.ownerName
            ? (d.ownerGuess
              ? `<div class="orgd2__sub orgd2__sub--guess" title="${esc(s.deptOwnerGuessTip(d.ownerName))}">${esc(s.deptOwnerGuess(d.ownerName))}</div>`
              : `<div class="orgd2__sub" title="${esc(s.deptOwner(d.ownerName))}">${esc(s.deptOwner(d.ownerName))}</div>`)
            : (d.headcount > 0 || d.total > 0 ? `<div class="orgd2__sub orgd2__sub--guess">${esc(s.deptOwnerNone)}</div>` : '<div class="orgd2__sub">&nbsp;</div>')}
          <div class="orgd2__meta"><b>${esc(s.deptHeadN(d.headcount))}</b>${d.total > d.headcount ? `<i></i>${esc(s.deptTotalN(d.total))}` : ''}</div>
        </div></div>`;
    }
    const warn = d.flags.includes('wide')
      ? `<span class="orgd2__alert orgd2__alert--red" title="${esc(s.wWide)}">! ${d.directs}</span>`
      : d.flags.includes('narrow')
        ? `<span class="orgd2__alert orgd2__alert--amber" title="${esc(s.wNarrow)}">! 1</span>` : '';
    const deep = d.flags.includes('deep') ? `<span class="orgd2__dot" title="${esc(s.wDeep)}"></span>` : '';
    // Matrix markers: ⇠ people who dotted-report here, ⇢ lines this person has
    // out, ⊕ concurrent posts. Kept as one quiet row so the card stays scannable.
    // Span-of-control badge (handoff 05): the number of directs is already
    // shown; this classifies it so a too-wide or too-narrow span is visible on
    // the card itself, matching the diagnostics thresholds (>=10 wide, ==1 narrow).
    const spanTone = d.directs >= 10 ? 'wide' : d.directs === 1 ? 'narrow' : 'ok';
    const span = d.directs
      ? `<span class="orgd2__span orgd2__span--${spanTone}" title="${esc(s.spanTip(d.directs))}">${d.directs}</span>`
      : '';
    const mx = [
      d.dottedIn ? `<span class="orgd2__mx" title="${esc(s.mxIn(d.dottedIn))}">⇠${d.dottedIn}</span>` : '',
      d.dottedOut ? `<span class="orgd2__mx" title="${esc(s.mxOut(d.dottedOut))}">⇢${d.dottedOut}</span>` : '',
      d.concurrent ? `<span class="orgd2__mx orgd2__mx--conc" title="${esc(s.mxConc(d.concurrent))}">⊕${d.concurrent}</span>` : '',
    ].join('');
    // 职级不进架构图：这张图讲汇报结构，职级是档案信息。
    const meta = [...countParts(s, d).map(esc)]
      .filter(Boolean).join('<i></i>');
    return `<div class="orgd2" style="--dc:${deptColor(d.department)}">
      <div class="orgd2__bar"></div>
      <div class="orgd2__body">
        <div class="orgd2__head"><span class="orgd2__ava">${esc((d.name || '?').trim()[0] || '?')}</span>
          <span class="orgd2__name" title="${esc(d.name)}">${esc(d.name)}</span>${deep}${warn}</div>
        <div class="orgd2__sub" title="${esc([d.position, d.department].filter(Boolean).join(' · '))}">${esc([d.position, d.department].filter(Boolean).join(' · ') || '—')}</div>
        <div class="orgd2__meta">${meta}${mx}${span}</div>
      </div></div>`;
  }, [activeData, deptColor, s, view]);

  // Build / update the chart. Switching people↔dept view swaps the whole id
  // space, and d3-org-chart leaves the old nodes behind on a data swap — so a
  // view change tears the instance down and rebuilds it clean.
  // Crossing the narrow breakpoint unmounts the stage div, so the cached chart
  // would keep a container that is no longer in the document — same teardown.
  const modeRef = useRef(view + ':' + narrow + ':' + dept);
  useEffect(() => {
    const mode = view + ':' + narrow + ':' + (view === 'dept' ? dept : '');
    if (modeRef.current !== mode) {
      modeRef.current = mode;
      try { chartRef.current && chartRef.current.clear(); } catch {}
      chartRef.current = null;
      if (containerRef.current) containerRef.current.innerHTML = '';
    }
    let cancelled = false;
    (async () => {
      if (narrow || !containerRef.current || !activeData.length || tab !== 'chart') return;
      const { OrgChart: D3OrgChart } = await import('d3-org-chart');
      if (cancelled || !containerRef.current) return;
      const chart = chartRef.current || new D3OrgChart()
        .container(containerRef.current)
        .svgHeight(Math.max(560, window.innerHeight - 320))
        .nodeWidth(() => 232)
        .nodeHeight(() => 96)
        .childrenMargin(() => 54)
        .siblingsMargin(() => 24)
        .neighbourMargin(() => 32)
        // compact(false): siblings of the same level stay on ONE horizontal row
        // (Chelsea's requirement) instead of d3-org-chart's 2-column compact packing.
        // 部门视图成员多，用紧凑排布（同级分两列）；人员视图保持同级一排（Chelsea 的要求）
        .compact(view === 'dept')
        .duration(320)
        .initialExpandLevel(view === 'dept' ? (dept ? 2 : topDeptCount > 12 ? 0 : 1) : 2)
        // The ± hit box has to fit the design's「− 收起 11 人」label; the library
        // sizes both the click rect and the foreignObject from these.
        .nodeButtonWidth(() => 112)
        .nodeButtonHeight(() => 24)
        .nodeButtonX(() => -56)
        .nodeButtonY(() => -12)
        // Pan raises the same event as zoom, so bail out unless the ratio moved.
        .onZoom((e) => {
          const k = e && e.transform ? e.transform.k : 1;
          setZoomK((p) => (Math.abs(p - k) < 0.005 ? p : k));
        })
        .onNodeClick((d) => { if (!d.data.virtual && !d.data.isDept) setPicked(d.data); });
      chartRef.current = chart;
      // Re-applied every run, not just at construction: the label is translated,
      // and a language switch reuses the same chart instance.
      chart.buttonContent(({ node }) => {
        const n = node.data._directSubordinates || node.data.directs || 0;
        const label = view === 'dept' ? (node.children ? s.collapseAny(n) : s.expandAny(n)) : (node.children ? s.collapseN(n) : s.expandN(n));
        return `<div class="orgd2-toggle">${esc(label)}</div>`;
      });
      chart.data(activeData).nodeContent(({ data }) => nodeCard(data));
      // Dashed matrix links. d3-org-chart draws connections as thick solid pink
      // arrows by default — indistinguishable in weight from a real reporting
      // line — so both the marker <defs> and the path styling are restyled to
      // the cyan dashed treatment used by the legend and the profile card.
      // The library's marker wiring is preserved (arrowhead = direction,
      // marker-start = the scope label), only recoloured.
      if (typeof chart.connections === 'function') {
        chart.connections(connections);
        if (typeof chart.defs === 'function' && !chart.__mxDefs) {
          const originalDefs = chart.defs();
          chart.defs(function (...a) {
            return String(originalDefs.apply(this, a)).split('#E27396').join(MATRIX_COLOR);
          });
          chart.__mxDefs = true;
        }
        if (typeof chart.connectionsUpdate === 'function') {
          chart.connectionsUpdate(function (d) {
            // `this` is the path element d3-org-chart just drew.
            try {
              this.setAttribute('stroke', MATRIX_COLOR);
              this.setAttribute('stroke-width', '1.8');
              this.setAttribute('stroke-dasharray', '6,4');
              this.setAttribute('stroke-linecap', 'round');
              this.setAttribute('fill', 'none');
              this.setAttribute('pointer-events', 'none');
              this.setAttribute('marker-start', `url(#${d.from}_${d.to})`);
              this.setAttribute('marker-end', `url(#arrow-${d.from}_${d.to})`);
            } catch {}
          });
        }
      }
      chart.render();
      window.setTimeout(() => {
        try {
          const pend = pendingFocus.current;
          if (pend && activeData.some((r) => r.id === pend)) { pendingFocus.current = null; chart.clearHighlighting().setExpanded(pend, true).setHighlighted(pend).setCentered(pend).render(); }
          else fitChart(chart); // F51 ③ 打开即「适应画布」（不放大超过 100%）
        } catch {}
      }, 120);
    })();
    return () => { cancelled = true; };
  }, [activeData, nodeCard, tab, connections, narrow, view, s, topDeptCount, dept]);
  useEffect(() => () => { try { chartRef.current && chartRef.current.clear(); } catch {} chartRef.current = null; }, []);

  // 部门名 → 部门表里的在用部门（先原文、再不区分大小写，与部门视图归属同一口径）
  const deptRecByName = (name) => {
    const list = (dq.data || []).filter((d) => d.active !== 0);
    const k = String(name || '').trim().toLowerCase();
    return list.find((d) => d.name === name) || list.find((d) => String(d.name).trim().toLowerCase() === k) || null;
  };
  // 部门 id → 部门筛选里可选的那一级：四级及以下并入所属三级、集团层不是选项，所以沿 parentId 往上找第一个在选项里的；
  // 部门树还没加载（或不可用）时原样返回
  const filterIdOf = (id) => {
    const opts = deptTree && Array.isArray(deptTree.options) ? new Set(deptTree.options.map((o) => String(o.id))) : null;
    if (!opts) return String(id);
    const all = new Map((dq.data || []).map((d) => [String(d.id), d]));
    let cur = all.get(String(id));
    const seen = new Set();
    while (cur && !seen.has(String(cur.id))) {
      if (opts.has(String(cur.id))) return String(cur.id);
      seen.add(String(cur.id));
      cur = cur.parentId ? all.get(String(cur.parentId)) : null;
    }
    return null;
  };
  const locate = () => {
    const t = query.trim().toLowerCase();
    if (!t) return;
    // 部门视图里全量找（当前只画了一个部门的子树时也能定位到别处）
    const pool = view === 'dept' ? [...deptChartData, ...nodes.map((n) => ({ ...n, person: true }))] : activeData;
    const hitNode = pool.find((n) => !n.virtual && n.name && n.name.toLowerCase().includes(t));
    if (!hitNode) { Toast.warning(s.notFound); return; }
    if (view === 'dept') {
      const deptName = hitNode.isDept ? hitNode.name : hitNode.department;
      const rec = deptName ? deptRecByName(deptName) : null;
      const target = rec ? filterIdOf(rec.id) : null;
      // 切到命中部门所在的筛选项（深层部门切到所属三级），画完后高亮命中的人或部门
      if (target && dept !== target) {
        pendingFocus.current = hitNode.isDept ? (String(rec.id) === target ? null : 'dept:' + rec.id) : hitNode.id;
        setDept(target);
        return;
      }
      const row = deptChartData.find((r) => r.isDept && r.name === deptName);
      if (row) {
        if (!hitNode.isDept) pendingFocus.current = hitNode.id;
        if (narrow) { setFocusId(hitNode.isDept ? row.id : hitNode.id); return; }
        if (chartRef.current) try { chartRef.current.clearHighlighting().setExpanded(hitNode.isDept ? row.id : hitNode.id, true).setHighlighted(hitNode.isDept ? row.id : hitNode.id).setCentered(hitNode.isDept ? row.id : hitNode.id).render(); } catch {}
        pendingFocus.current = null;
        return;
      }
    }
    // No canvas to centre on narrow screens — jump the drill-down to that node.
    if (narrow) { setFocusId(hitNode.id); setQuery(''); return; }
    if (!chartRef.current) return;
    try { chartRef.current.clearHighlighting().setExpanded(hitNode.id, true).setHighlighted(hitNode.id).setCentered(hitNode.id).render(); } catch {}
  };
  const cc = (fn) => { try { const c = chartRef.current; c && fn(c); } catch {} };
  // zoomIn/zoomOut are the only zoom API the library exposes — no way to read or
  // set an absolute ratio — so the readout drives the chart's own d3 behaviour.
  const zoomTo = (k) => cc((c) => {
    const st = c.getChartState();
    st.svg.transition().duration(240).call(st.zoomBehavior.scaleTo, k);
  });

  const doMove = async () => {
    const { node, target } = movePlan;
    try {
      await api.put(`/api/admin/employees/${node.id}`, { managerId: target ? target.id : null });
      Toast.success(s.moved);
      setMovePlan(null);
      q.reload();
    } catch (err) { Toast.error(err.message); }
  };

  if (q.error) return <div className="wrap tset-wrap"><Banner type="danger" closeIcon={null} description={q.error.message} /></div>;
  if (!q.data) return <div className="wrap tset-wrap" style={{ textAlign: 'center', paddingTop: 80 }}><Spin size="large" /></div>;

  return (
    <div className="wrap">{/* 11.1 / F51 ②：画布撑满内容区，不再限宽 1400 */}
      <div className="tset-head" style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', alignItems: 'flex-start' }}>
        {/* F51 ① / 11.4：顶部三行说明收进标题旁的「?」，只读档在标题右侧放「只读」胶囊 */}
        <div className="u-title-line">
          <h1 className="tset-title">{s.title}</h1>
          <Tooltip content={<div className="u-help-tip">{s.lead}</div>} position="bottomLeft">
            <button type="button" className="u-help-btn" aria-label={s.help}><IconHelpCircle size="small" /></button>
          </Tooltip>
          {peopleReadOnly && <ReadOnlyPill tip={s.roTip} />}
        </div>
        <div className="ppl-filters" style={{ marginBottom: 0 }}>
          <button className={'ppl-chip' + (tab === 'chart' ? ' on' : '')} onClick={() => setTab('chart')}>{s.tabChart}</button>
          <button className={'ppl-chip' + (tab === 'diag' ? ' on' : '')} onClick={() => setTab('diag')}>{s.tabDiag}</button>
        </div>
      </div>

      {tab === 'chart' ? (
        <div className="ppl-card" style={{ padding: 12 }}>
          <div className="trev-search" style={{ marginBottom: 10 }}>
            <span className="ppl-filters" style={{ marginBottom: 0 }}>
              <button className={'ppl-chip' + (view === 'people' ? ' on' : '')} onClick={() => setView('people')}>{s.viewPeople}</button>
              <button className={'ppl-chip' + (view === 'dept' ? ' on' : '')} onClick={() => setView('dept')}>{s.viewDept}</button>
            </span>
            <Input prefix={<IconSearch />} placeholder={s.searchPh} value={query} onChange={setQuery} onEnterPress={locate} showClear style={{ width: 210 }} />
            <Button size="small" onClick={locate}>{s.locate}</Button>
            {/* filter: there are 270+ departments — scrolling to one is not a UI. */}
            <DeptFilter options={deptTree ? deptTree.options : []} value={dept || null} lang={lang} size="small"
              onChange={(v) => setDept(v)} showNone={!!(deptTree && deptTree.hasNone)}
              disabled={deptTree === null} ready={!!deptTree}
              onInvalid={() => { Toast.info(deptFilterInvalidText(lang)); setDept(null); }} />
            {/* Fit / expand / export all act on the canvas — nothing for them to
                drive in the narrow list layout. Zoom lives on the canvas itself,
                next to its percentage readout. */}
            {!narrow && (
              <>
                <Button size="small" onClick={() => cc((c) => fitChart(c))}>{s.fit}</Button>
                <Button size="small" theme="borderless" onClick={() => cc((c) => { activeData.forEach((n) => c.setExpanded(n.id, false)); c.setExpanded(ROOT_ID, true); fitChart(c.render()); })}>{s.collapseAll}</Button>
                <Button size="small" theme="borderless" onClick={() => cc((c) => { c.expandAll(); setTimeout(() => fitChart(c), 400); })}>{s.expandAll}</Button>
                <Button size="small" theme="borderless" onClick={() => cc((c) => c.exportImg({ full: true, scale: 2, backgroundColor: '#f6f7f9' }))}>{s.exportPng}</Button>
              </>
            )}
            <Button size="small" theme="borderless" icon={<IconRefresh />} aria-label={s.refresh} title={s.refresh} onClick={() => q.reload()} />
          </div>
          {view === 'dept' && !dept && topDeptCount > 12 && (
            <div className="orgd2-legend"><Text type="tertiary" size="small">{s.deptPickHint}</Text></div>
          )}
          {view === 'people' && (
            <div className="orgd2-legend">
              {!narrow && (
                <>
                  <span className="orgd2-lg"><i className="orgd2-lg__solid" />{s.lgSolid}</span>
                  <button className={'ppl-chip' + (showDotted ? ' on' : '')} onClick={() => setShowDotted((v) => !v)}>
                    <i className="orgd2-lg__dotted" />{s.lgDotted}
                    {dottedCount ? ` (${dottedCount})` : ''}
                  </button>
                </>
              )}
              {/* The red/amber/green span badge on every card had nothing
                  explaining it; thresholds match the diagnostics (≥10 / =1). */}
              <span className="orgd2-lg"><i className="orgd2-lg__sw orgd2-lg__sw--wide" />{s.lgWide}</span>
              <span className="orgd2-lg"><i className="orgd2-lg__sw orgd2-lg__sw--narrow" />{s.lgNarrow}</span>
              <span className="orgd2-lg"><i className="orgd2-lg__sw orgd2-lg__sw--ok" />{s.lgOk}</span>
              {/* The count is how many exist in scope, NOT how many are on screen:
                  a link only draws when both people are expanded. Saying so beats
                  a number that disagrees with what the user can see. */}
              {!narrow && <Text type="quaternary" size="small">{dottedCount ? s.lgHint : s.lgNone}</Text>}
            </div>
          )}
          {narrow ? (
            activeData.length > 1 && (
              <OrgList s={s} focus={focus} trail={trail} rows={listRows} searching={!!query.trim()}
                childrenOf={childrenOf} deptColor={deptColor} total={activeData.filter((r) => !r.isDept && !r.virtual).length /* CX-083：只数人，不数部门节点（与桌面同口径） */}
                onDrill={setFocusId} onPick={setPicked} />
            )
          ) : (
            <div className="orgd2-canvas">
              <div ref={containerRef} className="orgd2-stage" />
              {/* Wheel zooming used to leave no trace of the current ratio, and
                  no way back to 1:1 — the readout is the reset button. */}
              <div className="orgd2-zoom">
                <button className="orgd2-zoom__b" title={s.zoomOut} aria-label={s.zoomOut} onClick={() => cc((c) => c.zoomOut())}>−</button>
                <button className="orgd2-zoom__v tnum" title={s.zoomReset} aria-label={s.zoomReset} onClick={() => zoomTo(1)}>{Math.round(zoomK * 100)}%</button>
                <button className="orgd2-zoom__b" title={s.zoomIn} aria-label={s.zoomIn} onClick={() => cc((c) => c.zoomIn())}>+</button>
              </div>
            </div>
          )}
          {activeData.length <= 1 && <Empty description={s.empty} style={{ padding: 30 }} />}
        </div>
      ) : (
        <Diagnostics s={s} navigate={navigate} />
      )}

      {picked && (
        <Modal visible title={picked.name} width={380} footer={null} onCancel={() => setPicked(null)}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, paddingBottom: 8 }}>
            <Text type="tertiary" size="small">{[picked.position, picked.department].filter(Boolean).join(' · ')}</Text>
            <Button theme="solid" type="primary" onClick={() => navigate(`/admin/people/${picked.id}`)}>{s.openProfile}</Button>
            {/* 更换直属上级 writes managerId — people 写. Hidden for a read-only档;
                11.4：不再补一行说明，页头的「只读」胶囊已经说明。 */}
            {canWritePeople && <Button onClick={() => { setMovePlan({ node: picked, target: undefined }); setPicked(null); }}>{s.editMgr}</Button>}
          </div>
        </Modal>
      )}
      {movePlan && (
        <Modal visible title={s.editMgr} width={440} maskClosable={false}
          onCancel={() => setMovePlan(null)} onOk={doMove} okText={s.move} cancelText={s.cancel}
          okButtonProps={{ disabled: movePlan.target === undefined }}>
          {movePlan.target !== undefined ? (
            <Text>{s.moveDesc(movePlan.node.name, movePlan.target ? movePlan.target.name : s.noMgr)}</Text>
          ) : (
            <>
              <div className="ppl-flabel">{s.editMgr} · {movePlan.node.name}</div>
              <Select style={{ width: '100%' }} filter showClear placeholder={s.noMgr}
                onChange={(v) => setMovePlan({ node: movePlan.node, target: v ? nodes.find((x) => x.id === v) : null })}
                optionList={nodes.filter((x) => x.id !== movePlan.node.id)
                  .map((x) => ({ label: `${x.name} (${x.employeeId})`, value: x.id }))} />
            </>
          )}
        </Modal>
      )}
    </div>
  );
}

// Narrow-screen stand-in for the canvas: one level at a time with a breadcrumb
// back up, built from the same rows the chart would have drawn. While the search
// box has text it shows flat matches instead of a level.
function OrgList({ s, focus, trail, rows, searching, childrenOf, deptColor, total, onDrill, onPick }) {
  if (!focus) return null;
  const parent = trail.length > 1 ? trail[trail.length - 2] : null;
  const label = (r) => (r.virtual ? s.company : r.name);
  const subOf = (r) => (r.isDept
    ? [s.deptHeadN(r.headcount), r.total > r.headcount ? s.deptTotalN(r.total) : null].filter(Boolean).join(' · ')
    : [r.position, r.department].filter(Boolean).join(' · ') || '—');
  return (
    <div className="orgl">
      {searching ? (
        <div className="orgl-lead">{s.matchesN(rows.length)}</div>
      ) : (
        <>
          <div className="orgl-crumbs">
            {trail.map((r, i) => (
              <span className="orgl-crumb" key={r.id}>
                {i > 0 && <i className="orgl-crumb__sep">/</i>}
                <button className="orgl-crumb__b" disabled={r.id === focus.id} onClick={() => onDrill(r.id)}>{label(r)}</button>
              </span>
            ))}
          </div>
          <div className="orgl-focus">
            <div className="orgl-focus__t">
              <div className="orgl-focus__n">{label(focus)}</div>
              <div className="orgl-focus__m">{focus.virtual
                ? `${s.companySub} · ${total}`
                : [subOf(focus), ...countParts(s, focus)].filter(Boolean).join(' · ')}</div>
            </div>
            {parent && <button className="ppl-chip orgl-up" onClick={() => onDrill(parent.id)}>↑ {s.up}</button>}
          </div>
          <div className="orgl-lead">{s.listLead}</div>
        </>
      )}
      <div className="orgl-rows">
        {rows.length === 0 && <Text type="tertiary" size="small">{searching ? s.notFound : s.noDirects}</Text>}
        {rows.map((r) => {
          const kids = (childrenOf.get(r.id) || []).length;
          const tone = r.isDept || !r.directs ? null : r.directs >= 10 ? 'wide' : r.directs === 1 ? 'narrow' : 'ok';
          return (
            <div className="orgl-row" key={r.id} style={{ '--dc': deptColor(r.isDept ? r.name : r.department) }}>
              <button className="orgl-row__main" disabled={r.isDept && !kids} onClick={() => (r.isDept ? onDrill(r.id) : onPick(r))}>
                <span className="orgl-ava">{r.isDept ? <DeptIcon /> : ((r.name || '?').trim()[0] || '?')}</span>
                <span className="orgl-txt">
                  <span className="orgl-n"><span className="orgl-n__t">{r.name}</span></span>
                  <span className="orgl-s">{subOf(r)}</span>
                </span>
                {tone && <span className={'orgd2__span orgd2__span--' + tone} title={s.spanTip(r.directs)}>{r.directs}</span>}
              </button>
              {/* Navigation only — the count lives on the span badge, and under a
                  department filter the visible children are a subset of it. */}
              {kids > 0 && (
                <button className="orgl-drill" onClick={() => onDrill(r.id)} title={s.directs(kids)} aria-label={s.directs(kids)}>›</button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Diagnostics({ s, navigate }) {
  const q = useAsync(() => api.get('/api/admin/org-diagnostics'), []);
  const d = q.data;
  if (!d) return <div className="ppl-card" style={{ textAlign: 'center', padding: 40 }}><Spin /></div>;
  const kpis = [
    [s.kHead, d.kpis.headcount], [s.kMgr, d.kpis.managers], [s.kIc, d.kpis.ics],
    [s.kSpan, d.kpis.avgSpan], [s.kDepth, d.kpis.maxDepth], [s.kRoots, d.kpis.roots],
  ];
  const maxDept = Math.max(1, ...d.depts.map(([, n]) => n));
  const gradeOrder = ['O', 'V', 'A', 'B', 'C', 'D'];
  const maxGrade = Math.max(1, ...Object.values(d.grades || { x: 1 }));
  const FLAG = { wide: ['red', s.wide], narrow: ['amber', s.narrow], ok: ['green', s.ok] };
  // d.spans is every manager, not just the 15 shown below — so the three tallies
  // describe the whole org even though the bar list is truncated.
  const spanTally = d.spans.reduce((a, m) => { a[m.flag] = (a[m.flag] || 0) + 1; return a; }, { wide: 0, narrow: 0, ok: 0 });
  return (
    <>
      <div className="dash-kpis">
        {kpis.map(([k, v]) => <div className="dash-kpi" key={k} style={{ cursor: 'default' }}><div className="k">{k}</div><div className="v tnum">{v}</div></div>)}
      </div>
      {/* 诊断发现 sits inside the grid (full-width on desktop, unchanged) so the
          phone rules can reorder it against the other cards: 管理幅度 → 诊断发现
          → 矩阵汇报, the design's 诊断优先 order. */}
      <div className="dash-grid orgd-diag">
        <div className="ppl-card orgd-card--find">
          <h2 style={{ fontSize: 15, marginBottom: 8 }}>{s.findTitle}</h2>
          {d.findings.length === 0 ? <Text type="tertiary">{s.noFindings}</Text> : d.findings.map((f, i) => (
            <div key={i} className="orgd-finding" style={{ borderColor: f.level === 'warn' ? 'var(--warning)' : 'var(--line)' }}>
              <Tag size="small" color={f.level === 'warn' ? 'amber' : 'blue'} type="light" shape="circle">{f.level === 'warn' ? <IcWarn /> : <IcInfo />}</Tag>
              <span>{(s['f_' + f.key] || (() => f.key))(f.params || {})}</span>
            </div>
          ))}
        </div>
        <div className="ppl-card orgd-card--span">
          <h2 style={{ fontSize: 15, marginBottom: 10 }}>{s.spanTitle}</h2>
          <div className="orgd-spantally">
            <span className="pill fail">{s.wide} <b className="tnum">{spanTally.wide}</b></span>
            <span className="pill warn">{s.narrow} <b className="tnum">{spanTally.narrow}</b></span>
            <span className="pill ok">{s.ok} <b className="tnum">{spanTally.ok}</b></span>
          </div>
          {d.spans.slice(0, 15).map((m) => (
            <div className="dash-bar" key={m.id}>
              <span className="n emp-namelink" style={{ cursor: 'pointer' }} onClick={() => navigate(`/admin/people/${m.id}`)}>{m.name}</span>
              <span className="track"><span className="fill" style={{ width: `${Math.min(100, (m.directs / 10) * 100)}%`, background: m.flag === 'wide' ? 'var(--danger)' : m.flag === 'narrow' ? 'var(--warning)' : 'var(--brand)' }} /></span>
              <span className="c tnum">{m.directs}</span>
              <Tag size="small" color={FLAG[m.flag][0]} type="light" shape="circle">{FLAG[m.flag][1]}</Tag>
            </div>
          ))}
          {d.spans.length > 15 && <Text type="tertiary" size="small">{s.spanMore(d.spans.length - 15)}</Text>}   {/* CX-136：按界面语言 */}
        </div>
        <div className="ppl-card">
          <h2 style={{ fontSize: 15, marginBottom: 10 }}>{s.compTitle}</h2>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
            <span className="pill pri">{s.trackM} <b className="tnum">{d.tracks.M || 0}</b></span>
            <span className="pill ok">{s.trackP} <b className="tnum">{d.tracks.P || 0}</b></span>
            {d.tracks.none > 0 && <span className="pill warn">{s.trackNone} <b className="tnum">{d.tracks.none}</b></span>}
          </div>
          {gradeOrder.filter((g) => d.grades[g]).map((g) => (
            <div className="dash-bar" key={g}>
              <span className="n">Grade {g}</span>
              <span className="track"><span className="fill" style={{ width: `${(d.grades[g] / maxGrade) * 100}%` }} /></span>
              <span className="c tnum">{d.grades[g]}</span>
            </div>
          ))}
        </div>
        <div className="ppl-card">
          <h2 style={{ fontSize: 15, marginBottom: 10 }}>{s.deptTitle}</h2>
          {d.depts.map(([name, n]) => (
            <div className="dash-bar" key={name}>
              <span className="n">{name}</span>
              <span className="track"><span className="fill" style={{ width: `${(n / maxDept) * 100}%` }} /></span>
              <span className="c tnum">{n}</span>
            </div>
          ))}
        </div>
        <div className="ppl-card">
          <h2 style={{ fontSize: 15, marginBottom: 10 }}>{s.talentTitle}</h2>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <span className="pill warn">{s.tHipo} <b className="tnum">{d.talent.hipo}</b></span>
            <span className="pill ok">{s.tPot} <b className="tnum">{d.talent.potentialSet}</b></span>
            <span className="pill pri">{s.tSuccP} <b className="tnum">{d.talent.successionPositions}</b></span>
            <span className="pill muted">{s.tSuccE} <b className="tnum">{d.talent.successionEntries}</b></span>
          </div>
        </div>

        {/* Matrix layer — what the solid-line span numbers above cannot show. */}
        {d.matrix && (
          <div className="ppl-card orgd-card--matrix">
            <h2 style={{ fontSize: 15, marginBottom: 10 }}>⇢ {s.mxTitle}</h2>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <span className="pill pri">{s.mxDotted} <b className="tnum">{d.matrix.dottedLines}</b></span>
              <span className="pill muted">{s.mxConcPosts} <b className="tnum">{d.matrix.concurrentPosts}</b></span>
              <span className="pill muted">{s.mxPeopleDotted} <b className="tnum">{d.matrix.peopleWithDotted}</b></span>
              <span className="pill muted">{s.mxPeopleConc} <b className="tnum">{d.matrix.peopleWithConcurrent}</b></span>
              <span className="pill muted">{s.mxManagers} <b className="tnum">{d.matrix.matrixManagers}</b></span>
            </div>
            {d.matrix.overloaded.length > 0 && (
              <div className="orgd-spans" style={{ marginTop: 10 }}>
                {d.matrix.overloaded.map((m) => (
                  <div className="orgd-span" key={m.employeeId}>
                    <span className="orgd-span__n">{m.name}</span>
                    <span className="pill warn">{m.solid} + {m.dotted} = <b className="tnum">{m.total}</b></span>
                  </div>
                ))}
              </div>
            )}
            {!d.matrix.dottedLines && !d.matrix.concurrentPosts && (
              <Text type="quaternary" size="small">{s.lgNone}</Text>
            )}
          </div>
        )}
      </div>
    </>
  );
}
