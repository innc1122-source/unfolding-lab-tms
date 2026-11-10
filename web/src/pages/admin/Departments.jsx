// 部门 Departments — the managed org dimension, now a real hierarchy:
// parentId builds the tree (业务单元 → 部门 → 子部门…). Rename cascades to all
// employees; delete is guarded by headcount; new names auto-register from
// employee forms and imports.
// HoD 名单 is a full page at #/admin/departments?view=hod (2026-10-07: was a drawer;
// 负责人「短操作弹窗、长编辑整页」). The address bar is the only source of truth.
import { num } from '../../fmt.js';
import { useMedia } from '../../useMedia.js';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Button, Input, Select, Table, Toast, Banner, Empty, Popconfirm, Typography, Modal, Tag, Spin } from '@douyinfe/semi-ui';
import { IconArrowLeft, IconPlus, IconUpload, IconUserGroup, IconDownload, IconSearch } from '@douyinfe/semi-icons';
import { api, useAsync } from '../../api.js';
import { useAuth } from '../../auth.jsx';
import { canWriteDomain, isDomainReadOnly } from '../../rbac.js';
import { useI18n } from '../../i18n.jsx';
import { PAGE_TIERS, DEFAULT_PAGE, useDataVersion, clampPage } from '../../pagesize.js';
import { resizableTable } from '../../cardify.js';
// 第二批 3.1（10/8）：部门有写操作后让全站部门筛选的缓存（/api/admin/dept-tree，会话内 5 分钟）失效，其他页的 DeptFilter 立即拿到新树
import { invalidateDeptTree } from '../../deptfilter.js';
import ReadOnlyPill from '../../components/ReadOnlyPill.jsx';

const { Text } = Typography;

// Thousands separators on the summary line: at DigiPlus scale it reads "4,469",
// not "4469". Fixed locale so zh and en group identically.
const fmt = (n) => num(n || 0);

const T = {
  zh: {
    title: '部门', lead: '支持多级层级：用「上级部门」把部门挂进树里（业务单元 → 部门 → 子部门…）。改名自动同步所有员工；员工表单和批量导入出现的新部门名会自动登记。',
    name: '部门', parent: '上级部门', parentPh: '上级部门（可空）', rootOpt: '—（一级）', head: '在职人数', subHead: (n) => `含下级 ${n}`,
    owner: '负责人', noOwner: '未指定', inactive: '已停用',
    rename: '改名', renameTitle: '改名部门', renameNote: '改名会级联到所有员工档案、报表与 CSV 导出。',
    move: '移动', moveTitle: '移动上级', moveNote: '移动上级只影响组织架构图与按部门汇总，不改动员工的部门字段。',
    enable: '启用', disable: '停用', save: '保存',
    addPh: '新部门名', add: '添加', addTitle: '添加部门', bulkBtn: '批量导入', bulkTitle: '批量导入部门', bulkLead: '每行一个部门；写「上级 > 子部门」可以直接建层级（上级不存在会自动创建），已存在的自动跳过。', bulkRun: '导入', bulkDone: (c, k) => `导入 ${c} 个，跳过 ${k} 个`,
    del: '删除该部门？（下级部门会升为顶级）', delRule: '只有在职人数为 0 的部门可以删除', saved: '已保存', deleted: '已删除', loadFail: '加载失败，请刷新页面重试。', cancel: '取消', delete: '删除',
    deptSearch: '搜索部门名称', deptNoMatch: '没有名称匹配的部门',
    empty: '还没有部门 — 添加一个，或在员工资料里填部门名会自动登记。', totalText: (n) => `共 ${n} 条`,
    sumDepts: (n) => `共 ${n} 个部门`, sumHead: (n) => `在职 ${n} 人`,
    mobileHint: '批量导入与移动上级建议在桌面端操作。',
    // 本页所有写操作都是 /api/admin/departments(员工与组织域/写),没有跨域控件;
    // 所以只需一道「只读档」的门,读权限照旧能看列表与在编人数。
    // 11.4（F49）：不再放说明段落，只读档在标题右侧放「只读」胶囊，悬停给这一句。
    roTip: '你对「员工与组织」只有查看权限，部门的新增、改名、移动、启停与删除不显示。',
    // 负责人(ownerId):一级部门的负责人即 HoD,覆盖按汇报线推算的结果。
    setOwner: '设负责人', ownerTitle: '设置部门负责人', ownerPh: '选择员工（可清空）', ownerInactiveOpt: '（已停用）',
    ownerNote: '一级部门的负责人即 HoD，会覆盖按汇报线推算的结果；清空后恢复自动推算。',
    // HoD 名单(GET /api/admin/departments/hods)
    hodBtn: 'HoD（一级部门负责人）名单', hodTitle: 'HoD（一级部门负责人）名单',
    hodLead: 'HoD 为员工所属一级部门的负责人。一级部门已设负责人且负责人在职的，以负责人为准；未设置或负责人已离职的，按汇报线推算：一级部门内没有上级、或上级不在本部门的在职员工。三级及更深的部门并入所属二级部门统计。',
    hodHint: '在部门列表设置负责人可覆盖推算结果。',
    hodExport: '导出 CSV', hodSearch: '搜索部门、姓名或工号', hodAll: '全部',
    hodSrc: { owner: '负责人', derived: '自动推算', ambiguous: '需确认', none: '无在职人员' },
    hodOwnerGone: '负责人已离职', hodLoop: '汇报线成环', hodFormer: (n) => `原负责人：${n}`, hodDirect: '本部',
    colL1: '一级部门', colHod: 'HoD 姓名', colEmpId: '工号', colSource: '来源', colCand: '候选人', colMembers: '成员数',
    hodSetHead: '设为负责人', hodSetOk: '设为负责人', hodSetConfirm: (p, d) => `将 ${p} 设为「${d}」的负责人？`, hodSetDone: '已设为负责人',
    hodNoRows: '没有符合条件的一级部门', hodEmpty: '暂无在用的一级部门',
    // 范围受限的角色:服务端只返回整棵子树都在其范围内的一级部门(scoped = true)。
    hodEmptyScoped: '你的数据范围内没有完整的一级部门：HoD 名单只列出整棵子树都在你数据范围内的一级部门。',
    hodScopedNote: '名单已按你的数据范围裁剪：只列出整棵子树都在范围内的一级部门。',
    hodUnassigned: (n) => `${n} 名在职员工未计入任何在用的一级部门（部门为空、不在部门表中、上级部门成环，或所属一级部门已停用），请调整其部门：`,
    hodNoDept: '未填部门', hodMore: (n) => `等另外 ${n} 人`,
    // n 为空:那个停用的一级部门不在你的数据范围内,服务端不给名字。
    hodWhyUnknown: '不在部门表中', hodWhyCycle: '上级部门成环', hodWhyInactive: (n) => (n ? `一级部门「${n}」已停用` : '所属一级部门已停用'),
    hodDup: (list) => `以下部门名只差大小写，员工会按写法分别归到其中一条，建议合并或改名：${list}`,
    backList: '返回部门列表',
  },
  en: {
    title: 'Departments', lead: 'Hierarchy-aware: use "Parent" to place a department in the tree (business unit → department → sub-department…). Renames cascade to every employee; new names from forms/imports auto-register.',
    name: 'Department', parent: 'Parent', parentPh: 'Parent (optional)', rootOpt: '— (top level)', head: 'Headcount', subHead: (n) => `subtree ${n}`,
    owner: 'Head', noOwner: 'Unassigned', inactive: 'Inactive',
    rename: 'Rename', renameTitle: 'Rename department', renameNote: 'A rename cascades to every employee record, report and CSV export.',
    move: 'Move', moveTitle: 'Move under', moveNote: 'Moving a parent only changes the org chart and by-department rollups; employees keep their department field.',
    enable: 'Activate', disable: 'Deactivate', save: 'Save',
    addPh: 'New department', add: 'Add', addTitle: 'Add department', bulkBtn: 'Bulk import', bulkTitle: 'Bulk import departments', bulkLead: 'One per line; "Parent > Child" builds hierarchy (parent auto-created). Existing ones are skipped.', bulkRun: 'Import', bulkDone: (c, k) => `${c} created, ${k} skipped`,
    del: 'Delete this department? (children become top-level)', delRule: 'Only departments with zero headcount can be deleted', saved: 'Saved', deleted: 'Deleted', loadFail: 'Couldn’t load. Refresh the page to try again.', cancel: 'Cancel', delete: 'Delete',
    deptSearch: 'Search department names', deptNoMatch: 'No department name matches',
    empty: 'No departments yet — add one, or they auto-register from employee forms.', totalText: (n) => `${n} total`,
    sumDepts: (n) => `${n} departments`, sumHead: (n) => `headcount ${n}`,
    mobileHint: 'Bulk import and re-parenting are best done on a desktop.',
    roTip: 'You have view-only access to People & Organization, so adding, renaming, moving, activating and deleting departments are not shown.',
    setOwner: 'Set head', ownerTitle: 'Set department head', ownerPh: 'Pick an employee (clear to unset)', ownerInactiveOpt: '(inactive)',
    ownerNote: 'For a level-1 department the head is its HoD and overrides the derived result; clear it to return to derivation.',
    hodBtn: 'Heads of Department (HoD)', hodTitle: 'Heads of Department (HoD)',
    hodLead: 'The HoD is the head of an employee\'s level-1 department. Where a level-1 department has an active head, that head is used; where none is set or the head has left, the HoD is derived from reporting lines: the active employee in that department who has no manager, or whose manager is outside the department. Level-3 and deeper departments roll up into their level-2 department.',
    hodHint: 'Set a head in the department list to override the derived result.',
    hodExport: 'Export CSV', hodSearch: 'Search department, name or ID', hodAll: 'All',
    hodSrc: { owner: 'Head', derived: 'Derived', ambiguous: 'Needs review', none: 'No active staff' },
    hodOwnerGone: 'Head has left', hodLoop: 'reporting loop', hodFormer: (n) => `Former head: ${n}`, hodDirect: 'Direct',
    colL1: 'Level-1 department', colHod: 'HoD', colEmpId: 'Employee ID', colSource: 'Source', colCand: 'Candidates', colMembers: 'Members',
    hodSetHead: 'Make head', hodSetOk: 'Set as head', hodSetConfirm: (p, d) => `Make ${p} the head of "${d}"?`, hodSetDone: 'Head set',
    hodNoRows: 'No level-1 departments match', hodEmpty: 'No active level-1 departments yet',
    hodEmptyScoped: 'No level-1 department lies entirely inside your data scope: the HoD list only shows level-1 departments whose whole subtree is in your scope.',
    hodScopedNote: 'Filtered to your data scope: only level-1 departments whose whole subtree is in your scope are listed.',
    hodUnassigned: (n) => `${n} active employee(s) count toward no active level-1 department (blank department, one missing from the department list, a looped parent chain, or an inactive level-1 department). Move them to a department:`,
    hodNoDept: 'no department', hodMore: (n) => `and ${n} more`,
    hodWhyUnknown: 'not in the department list', hodWhyCycle: 'looped parent chain', hodWhyInactive: (n) => (n ? `level-1 "${n}" is inactive` : 'its level-1 department is inactive'),
    hodDup: (list) => `These department names differ only in letter case, and employees are split between them by spelling. Consider merging or renaming: ${list}`,
    backList: 'Back to departments',
  },
};

/* Below the card breakpoint the HoD list swaps its table for a card list in JS.
   Written when the list was a drawer in a portal outside .adm-main, where
   app.css's card-table rules could not reach; kept for the full page (now inside
   .adm-main, same 900px breakpoint, so there is no gap between the two). Same
   query and shape as Dashboard.jsx / OrgChart.jsx. */
const NARROW_Q = '(max-width:900px)';
const useNarrow = () => useMedia(NARROW_Q);

const HOD_COLOR = { owner: 'blue', derived: 'green', ambiguous: 'orange', none: 'grey' };
const HOD_FILTERS = ['all', 'ambiguous', 'owner', 'derived', 'none', 'ownerInactive'];

// HoD 名单 — GET /api/admin/departments/hods. One row per active level-1
// department; the server has already applied the data scope (a scoped role only
// gets level-1 departments whose whole subtree is in its scope). Opens on
// 「需确认」 when there is anything to review, since that is the list HR works
// through; otherwise on 全部 so the page never opens empty. The CSV button
// downloads the whole (scoped) list regardless of the on-screen filter.
// Full page (#/admin/departments?view=hod): it fetches its own list and does not
// depend on the department list, so the parent renders it before that list's
// error branch. No form, so no unsaved-changes guard — 设为负责人 is a Popconfirm.
function HodPage({ s, canWrite, onBack, onChanged }) {
  const narrow = useNarrow();
  const q = useAsync(() => api.get('/api/admin/departments/hods'), []);
  const [filter, setFilter] = useState(null); // null = not picked yet → default decided from the data
  const [kw, setKw] = useState('');
  const data = q.data;
  const items = (data && data.items) || [];
  const sum = data && data.summary;
  const unassigned = (data && data.unassignedPeople) || [];
  const dups = (data && data.duplicateNames) || [];
  const emptyText = data && data.scoped ? s.hodEmptyScoped : s.hodEmpty;
  // Why a person counts toward no level-1 department (org.js unassignedPeople.reason).
  const whyUnassigned = (p) => (p.reason === 'blank' ? s.hodNoDept
    : p.reason === 'inactive_level1' ? `${p.department} · ${s.hodWhyInactive(p.level1)}`
      : `${p.department} · ${p.reason === 'cycle' ? s.hodWhyCycle : s.hodWhyUnknown}`);
  const eff = filter || (sum && sum.ambiguous > 0 ? 'ambiguous' : 'all');
  const countOf = (f) => (!sum ? 0 : f === 'all' ? sum.total : sum[f] || 0);
  const needle = kw.trim().toLowerCase();
  const hit = (p) => !!p && `${p.name} ${p.employeeId}`.toLowerCase().includes(needle);
  const rows = items.filter((it) => {
    if (eff === 'ownerInactive' ? !it.ownerInactive : eff !== 'all' && it.source !== eff) return false;
    if (!needle) return true;
    return it.deptName.toLowerCase().includes(needle) || hit(it.hod) || it.candidates.some(hit);
  });
  const label = (f) => (f === 'all' ? s.hodAll : f === 'ownerInactive' ? s.hodOwnerGone : s.hodSrc[f]);

  const setHead = async (it, c) => {
    try {
      await api.put(`/api/admin/departments/${it.deptId}`, { ownerId: c.id });
      Toast.success(s.hodSetDone);
      q.reload();
      onChanged();
    } catch (err) { Toast.error(err.message); }
  };
  const srcTags = (it) => (
    <span style={{ display: 'inline-flex', gap: 4, flexWrap: 'wrap' }}>
      <Tag size="small" color={HOD_COLOR[it.source]}>{s.hodSrc[it.source]}{it.reason === 'loop' || it.reason === 'loop_with_top' ? ` · ${s.hodLoop}` : ''}</Tag>
      {it.ownerInactive && <Tag size="small" color="red">{s.hodOwnerGone}</Tag>}
    </span>
  );
  const hodCell = (it) => (
    <span style={{ minWidth: 0, overflowWrap: 'anywhere' }}>
      {it.hod ? <b>{it.hod.name}</b> : <span className="dept-none">—</span>}
      {it.ownerInactive && it.owner && it.owner.name && (
        <Text type="tertiary" size="small" style={{ display: 'block' }}>{s.hodFormer(it.owner.name)}</Text>
      )}
    </span>
  );
  // One candidate per line: the name (and 本部 tag) wraps inside its own track,
  // the 设为负责人 action keeps a fixed track on the right, so a long name never
  // pushes the action onto a line of its own.
  const candCell = (it) => (it.candidates.length ? (
    <span style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0, flex: 1 }}>
      {it.candidates.map((c) => (
        <span key={c.id} style={{ display: 'grid', gridTemplateColumns: canWrite ? 'minmax(0, 1fr) auto' : 'minmax(0, 1fr)', alignItems: 'center', columnGap: 6 }}>
          <span style={{ overflowWrap: 'anywhere' }}>
            {c.name} <Text type="tertiary" size="small" className="tnum" style={{ whiteSpace: 'nowrap' }}>{c.employeeId}</Text>
            {c.direct && <Tag size="small" style={{ marginLeft: 6 }}>{s.hodDirect}</Tag>}
          </span>
          {canWrite && (
            <Popconfirm title={s.hodSetConfirm(c.name, it.deptName)} okText={s.hodSetOk} cancelText={s.cancel} onConfirm={() => setHead(it, c)}>
              <Button size="small" theme="borderless" style={{ padding: '0 4px', height: 22 }}>{s.hodSetHead}</Button>
            </Popconfirm>
          )}
        </span>
      ))}
    </span>
  ) : <span className="dept-none">—</span>);

  const lbl = { fontSize: 11.5, fontWeight: 600, color: 'var(--ink-3)', flex: 'none', minWidth: 64 };
  const line = { display: 'flex', gap: 10, alignItems: 'flex-start', marginTop: 6, minWidth: 0 };

  return (
    <div className="wrap tset-wrap dept-hod-page">
      <div className="co-page-bar">
        <Button theme="borderless" icon={<IconArrowLeft />} onClick={onBack}>{s.backList}</Button>
        <div className="co-page-titles">
          <h1 className="co-page-title" title={s.hodTitle}>{s.hodTitle}</h1>
          <div className="co-page-sub">{s.hodLead}</div>
        </div>
      </div>
      <div className="ppl-card">
        <div className="tset-lead" style={{ marginBottom: data && data.scoped ? 6 : 12, fontWeight: 600 }}>{s.hodHint}</div>
        {data && data.scoped && <div className="tset-lead" style={{ marginBottom: 12 }}>{s.hodScopedNote}</div>}
        {q.error && <Banner type="danger" closeIcon={null} description={`${s.loadFail} · ${q.error.message}`} />}
        {q.loading && !data && <div style={{ display: 'flex', justifyContent: 'center', padding: 40 }}><Spin /></div>}
        {data && (
          <>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 12 }}>
              {HOD_FILTERS.filter((f) => f !== 'ownerInactive' || countOf(f) > 0).map((f) => (
                <Button key={f} size="small" theme={eff === f ? 'solid' : 'light'} type={eff === f ? 'primary' : 'tertiary'}
                  onClick={() => setFilter(f)}>{label(f)} <span className="tnum" style={{ marginLeft: 4 }}>{fmt(countOf(f))}</span></Button>
              ))}
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 12 }}>
              <Input value={kw} onChange={setKw} prefix={<IconSearch />} showClear placeholder={s.hodSearch} style={{ flex: '1 1 200px', minWidth: 0, maxWidth: 360 }} />
              <Button icon={<IconDownload />} theme="light" onClick={() => { window.location.href = '/api/admin/departments/hods.csv'; }}>{s.hodExport}</Button>
            </div>
            {narrow ? (
              rows.length ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  {rows.map((it) => (
                    <div key={it.deptId} style={{ border: '1px solid var(--line)', borderRadius: 'var(--radius-lg)', background: 'var(--card)', padding: '10px 12px', minWidth: 0 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'flex-start', flexWrap: 'wrap' }}>
                        <b className="dept-name" style={{ minWidth: 0, overflowWrap: 'anywhere' }}>{it.deptName}</b>
                        {srcTags(it)}
                      </div>
                      <div style={line}><span style={lbl}>{s.colHod}</span>{hodCell(it)}</div>
                      {it.hod && <div style={line}><span style={lbl}>{s.colEmpId}</span><span className="tnum">{it.hod.employeeId}</span></div>}
                      {it.candidates.length > 0 && <div style={line}><span style={lbl}>{s.colCand}</span>{candCell(it)}</div>}
                      <div style={line}><span style={lbl}>{s.colMembers}</span><span className="tnum">{fmt(it.memberCount)}</span></div>
                    </div>
                  ))}
                </div>
              ) : <Empty description={items.length ? s.hodNoRows : emptyText} style={{ padding: 24 }} />
            ) : (
              <Table rowKey="deptId" dataSource={rows} size="small" pagination={false}
                empty={<Empty description={items.length ? s.hodNoRows : emptyText} style={{ padding: 24 }} />}
                columns={[
                  { title: s.colL1, dataIndex: 'deptName', width: 180, render: (v) => <b className="dept-name">{v}</b> },
                  // 表头全局大写（app.css 的 .semi-table-row-head）会把「HoD」显示成「HOD」：只给这一列的标题关掉大写转换
                  { title: <span style={{ textTransform: 'none' }}>{s.colHod}</span>, dataIndex: 'hod', width: 140, render: (_, it) => hodCell(it) },
                  { title: s.colEmpId, dataIndex: 'empId', width: 100, render: (_, it) => (it.hod ? <span className="tnum">{it.hod.employeeId}</span> : <span className="dept-none">—</span>) },
                  { title: s.colSource, dataIndex: 'source', width: 130, render: (_, it) => srcTags(it) },
                  { title: s.colCand, dataIndex: 'candidates', render: (_, it) => candCell(it) },
                  { title: s.colMembers, dataIndex: 'memberCount', width: 80, align: 'center', render: (v) => <span className="tnum">{fmt(v)}</span> },
                ]} />
            )}
            {unassigned.length > 0 && (
              <Banner type="warning" closeIcon={null} style={{ marginTop: 12 }}
                description={(
                  <span style={{ overflowWrap: 'anywhere' }}>
                    {s.hodUnassigned(fmt(unassigned.length))}{' '}
                    {unassigned.slice(0, 10).map((p) => `${p.name} (${p.employeeId} · ${whyUnassigned(p)})`).join('; ')}
                    {unassigned.length > 10 ? ` ${s.hodMore(fmt(unassigned.length - 10))}` : ''}
                  </span>
                )} />
            )}
            {dups.length > 0 && (
              <Banner type="warning" closeIcon={null} style={{ marginTop: 12 }}
                description={<span style={{ overflowWrap: 'anywhere' }}>{s.hodDup(dups.map((g) => g.departments.map((d) => d.name).join(' / ')).join('; '))}</span>} />
            )}
          </>
        )}
      </div>
    </div>
  );
}

export default function Departments() {
  const { lang } = useI18n();
  const s = T[lang];
  // Every write on this page is POST/PUT/DELETE /api/admin/departments, i.e. the
  // people (员工与组织) domain — the same domain as the page itself, so there is no
  // cross-domain control here. What was missing is the read-only档: people=read
  // can reach the page (and should — the list and the headcounts are the point)
  // but every write button on it can only ever 403, so they come off. No grants
  // block (older server) → manage → the page renders exactly as before.
  const { user } = useAuth();
  const canWrite = canWriteDomain(user, 'people');
  const readOnly = isDomainReadOnly(user, 'people');
  const q = useAsync(() => api.get('/api/admin/departments'), []);
  const [name, setName] = useState('');
  const [newParent, setNewParent] = useState(null);
  const [bulk, setBulk] = useState(null); // null closed | '' textarea content
  const [ren, setRen] = useState(null); // {id, was, name} — rename dialog
  const [mov, setMov] = useState(null); // {id, was, parentId} — move dialog
  const [addOpen, setAddOpen] = useState(false); // narrow screens: the add bar as a dialog
  // HoD 名单整页：?view=hod。进入前记下列表滚动位置，回列表时滚回原处（同 Exams 整页）。
  const [searchParams, setSearchParams] = useSearchParams();
  const hodPage = searchParams.get('view') === 'hod';
  const listScroll = useRef(null);
  const rememberScroll = () => { try { listScroll.current = window.scrollY || 0; } catch { /* no window */ } };
  useEffect(() => {
    if (hodPage) { try { window.scrollTo(0, 0); } catch { /* no window */ } }
    else if (listScroll.current != null) {
      const y = listScroll.current;
      listScroll.current = null;
      try { window.scrollTo(0, y); } catch { /* no window */ }
    }
  }, [hodPage]);
  // 部门表离开整页再回来（表格重挂）、或行操作后重载时，留在原来的页码与每页条数
  const [listPage, setListPage] = useState(1);
  const [listSize, setListSize] = useState(DEFAULT_PAGE);
  const listVer = useDataVersion(q.data);
  const [own, setOwn] = useState(null); // {id, was, ownerId, ownerName} — set-head dialog
  // The head picker's people list: fetched the first time the dialog opens, not
  // on page load (the roster is the whole company; most visits never set a head).
  const [roster, setRoster] = useState(null);
  const openOwner = (d) => {
    setOwn({ id: d.id, was: d.ownerId || '', ownerId: d.ownerId || '', ownerName: d.ownerName, ownerEmployeeId: d.ownerEmployeeId });
    if (!roster) api.get('/api/admin/roster').then(setRoster, (err) => { Toast.error(err.message); setRoster([]); });
  };

  const rows = q.data || [];
  // Every employee carries exactly one department name, so own headcounts sum
  // across the whole list without double-counting a parent's subtree.
  const headTotal = rows.reduce((a, d) => a + (d.headcount || 0), 0);
  // parentId → tree, then flattened back out in depth-first order: own headcount
  // plus a subtree total for branch nodes, and a depth for the branch marker.
  const { flat, blockedParents } = useMemo(() => {
    const byId = new Map(rows.map((d) => [d.id, { ...d, children: [] }]));
    const roots = [];
    for (const d of byId.values()) {
      if (d.parentId && byId.has(d.parentId)) byId.get(d.parentId).children.push(d);
      else roots.push(d);
    }
    const total = (n) => { n.total = n.children.reduce((a, c) => a + total(c), n.headcount || 0); return n.total; };
    roots.forEach(total);
    // For each node, the set of ids it can't choose as parent (itself + descendants).
    const blocked = new Map();
    const collect = (n, acc) => { acc.add(n.id); n.children.forEach((c) => collect(c, acc)); };
    for (const d of byId.values()) { const acc = new Set(); collect(d, acc); blocked.set(d.id, acc); }
    // Hand the Table plain rows with no `children` key: with one it switches to
    // tree mode and renders each subtree a second time under its parent.
    const out = [];
    const walk = (n, depth) => {
      const { children, ...row } = n;
      out.push({ ...row, depth });
      (children || []).forEach((c) => walk(c, depth + 1));
    };
    roots.forEach((r) => walk(r, 0));
    return { flat: out, blockedParents: blocked };
  }, [rows]);
  // CX-221：按地址栏 ?q= 搜索部门名称（评估周期部门明细的「去部门页指定负责人」链接带上部门名直达）
  const dq = (searchParams.get('q') || '').trim().toLowerCase();
  const shown = useMemo(() => (dq ? flat.filter((d) => String(d.name || '').toLowerCase().includes(dq)) : flat), [flat, dq]);
  const nameById = useMemo(() => new Map(rows.map((d) => [d.id, d.name])), [rows]);

  // After every hook; before the list's error branch — the HoD page loads its own data.
  if (hodPage) return <HodPage s={s} canWrite={canWrite} onBack={() => setSearchParams({})} onChanged={q.reload} />;

  if (q.error) return <div className="wrap tset-wrap"><Banner type="danger" closeIcon={null} description={`${s.loadFail} · ${q.error.message}`} /></div>;

  const call = async (fn, msg) => { try { await fn(); Toast.success(msg); } catch (err) { Toast.error(err.message); } q.reload(); invalidateDeptTree(); };
  // Shared by the desktop add bar and the narrow-screen add dialog. The parent
  // stays selected on purpose: sub-teams are almost always added in a run.
  const addDept = () => call(async () => {
    await api.post('/api/admin/departments', { name: name.trim(), parentId: newParent || undefined });
    setName('');
  }, s.saved);
  const parentOptions = (self) => [
    { value: '', label: s.rootOpt },
    ...rows.filter((d) => !self || !(blockedParents.get(self) || new Set()).has(d.id)).map((d) => ({ value: d.id, label: d.name })),
  ];
  // Active people only — the same "in service" test the HoD derivation uses
  // (org.js isInService: account on AND empStatus not exited; an exit record that
  // never switched the account off still counts as gone). System accounts hold no
  // position. The current head is added back when that person has since left —
  // otherwise the Select would show a bare id for the value it already holds.
  const ownerOptions = (() => {
    const list = (roster || []).filter((u) => u.active !== false && u.empStatus !== 'exited' && u.role !== 'admin')
      .map((u) => ({ value: u.id, label: `${u.name} · ${u.employeeId}${u.department ? ` · ${u.department}` : ''}` }));
    if (own && own.was && !list.some((o) => o.value === own.was))
      list.unshift({ value: own.was, label: `${own.ownerName || own.was}${own.ownerEmployeeId ? ` · ${own.ownerEmployeeId}` : ''} ${s.ownerInactiveOpt}` });
    return list;
  })();

  return (
    <div className="wrap tset-wrap">
      <div className="tset-head" style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'flex-start', flexWrap: 'wrap' }}>
        <div>
          <div className="u-title-line"><h1 className="tset-title">{s.title}</h1>{readOnly && <ReadOnlyPill tip={s.roTip} />}</div>
          <div className="tset-lead">{s.lead}</div>
        </div>
        <span style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          {/* HoD 名单 is a read (people domain, same as this page), so every
              visitor gets it — read-only档 included. */}
          <Button icon={<IconUserGroup />} theme="light" onClick={() => { rememberScroll(); setSearchParams({ view: 'hod' }); }}>{s.hodBtn}</Button>
          {/* Name first, then where to hang it: that is the order HR speaks it in.
              Below the card breakpoint the whole bar collapses to one button. */}
          {canWrite && (
          <span className="dept-addbar">
            <Input value={name} placeholder={s.addPh} onChange={setName} style={{ width: 180 }} />
            <Select value={newParent} placeholder={s.parentPh} optionList={parentOptions(null)} showClear filter
              onChange={setNewParent} style={{ width: 200 }} />
            <Button theme="solid" type="primary" icon={<IconPlus />} disabled={!name.trim()} onClick={addDept}>{s.add}</Button>
            <Button icon={<IconUpload />} theme="light" onClick={() => setBulk('')}>{s.bulkBtn}</Button>
          </span>
          )}
          {canWrite && <Button className="dept-addm" theme="solid" type="primary" icon={<IconPlus />} onClick={() => setAddOpen(true)}>{s.addTitle}</Button>}
        </span>
      </div>
      {own && (
        <Modal visible title={s.ownerTitle} width={420} maskClosable={false} onCancel={() => setOwn(null)} okText={s.save} cancelText={s.cancel}
          onOk={() => {
            const nv = own.ownerId || '';
            setOwn(null);
            if (nv !== own.was) call(() => api.put(`/api/admin/departments/${own.id}`, { ownerId: nv }), s.saved);
          }}>
          <Select value={own.ownerId || undefined} placeholder={s.ownerPh} optionList={ownerOptions} filter showClear
            loading={!roster} onChange={(v) => setOwn({ ...own, ownerId: v || '' })} style={{ width: '100%' }} />
          <Text type="tertiary" size="small" style={{ display: 'block', marginTop: 8 }}>{s.ownerNote}</Text>
        </Modal>
      )}
      {addOpen && (
        <Modal visible title={s.addTitle} width={340} onCancel={() => setAddOpen(false)} okText={s.add} cancelText={s.cancel}
          okButtonProps={{ disabled: !name.trim() }} onOk={() => { addDept(); setAddOpen(false); }}>
          <Input value={name} placeholder={s.addPh} onChange={setName} style={{ marginBottom: 10 }} />
          <Select value={newParent} placeholder={s.parentPh} optionList={parentOptions(null)} showClear filter
            onChange={setNewParent} style={{ width: '100%' }} />
        </Modal>
      )}
      {ren && (
        <Modal visible title={s.renameTitle} width={380} maskClosable={false} onCancel={() => setRen(null)} okText={s.save} cancelText={s.cancel}
          okButtonProps={{ disabled: !ren.name.trim() }}
          onOk={() => {
            const nv = ren.name.trim();
            setRen(null);
            if (nv && nv !== ren.was) call(() => api.put(`/api/admin/departments/${ren.id}`, { name: nv }), s.saved);
          }}>
          <Input value={ren.name} onChange={(v) => setRen({ ...ren, name: v })} autoFocus />
          <Text type="tertiary" size="small" style={{ display: 'block', marginTop: 8 }}>{s.renameNote}</Text>
        </Modal>
      )}
      {mov && (
        <Modal visible title={s.moveTitle} width={380} maskClosable={false} onCancel={() => setMov(null)} okText={s.save} cancelText={s.cancel}
          onOk={() => {
            const nv = mov.parentId || null;
            setMov(null);
            if (nv !== (mov.was || null)) call(() => api.put(`/api/admin/departments/${mov.id}`, { parentId: nv }), s.saved);
          }}>
          <Select value={mov.parentId} optionList={parentOptions(mov.id)} filter style={{ width: '100%' }}
            onChange={(v) => setMov({ ...mov, parentId: v })} />
          <Text type="tertiary" size="small" style={{ display: 'block', marginTop: 8 }}>{s.moveNote}</Text>
        </Modal>
      )}
      {bulk !== null && (
        <Modal visible title={s.bulkTitle} width={440} maskClosable={false} onCancel={() => setBulk(null)} okText={s.bulkRun} cancelText={s.cancel}
          onOk={async () => {
            const lines = [...new Set(bulk.split(/\r?\n/).map((x) => x.trim()).filter(Boolean))];
            let created = 0, skipped = 0;
            // CX-133：多级路径「父 > 中 > 子」逐级建：上级不存在时先建上级（原来只取最后两段，顶层丢失、「中」被建成一级）。
            // 中间各级已存在（dept_exists）不算跳过；只有最后一级已存在或建失败才计入跳过。
            const made = new Set();
            for (const ln of lines) {
              const parts = ln.split('>').map((x) => x.trim()).filter(Boolean);
              if (!parts.length) continue;
              let ok = true;
              for (let i = 0; i < parts.length - 1 && ok; i++) {
                const key = parts.slice(0, i + 1).join('>').toLowerCase();
                if (made.has(key)) continue;
                try { await api.post('/api/admin/departments', { name: parts[i], parentName: i ? parts[i - 1] : undefined }); created++; made.add(key); }
                catch (e) { if (e && e.data && e.data.code === 'dept_exists') made.add(key); else ok = false; }
              }
              if (!ok) { skipped++; continue; }
              const last = parts[parts.length - 1];
              try { await api.post('/api/admin/departments', { name: last, parentName: parts.length > 1 ? parts[parts.length - 2] : undefined }); created++; made.add(parts.join('>').toLowerCase()); } catch { skipped++; }
            }
            Toast.success(s.bulkDone(created, skipped));
            setBulk(null);
            q.reload();
            invalidateDeptTree();
          }}>
          <Text type="tertiary" size="small" style={{ display: 'block', marginBottom: 8 }}>{s.bulkLead}</Text>
          <textarea value={bulk} onChange={(e) => setBulk(e.target.value)} rows={8}
            placeholder={'Customer Care > Davao Hub\nOperations > Payments\nOperations > Payments > Settlement\nFinance & Treasury\nPeople & Culture > Talent Acquisition'}
            style={{ width: '100%', border: '1px solid var(--line)', borderRadius: 8, padding: '9px 12px', font: 'inherit', fontSize: 14 }} />
        </Modal>
      )}
      <div className="ppl-card">
        {rows.length > 0 && (
          <Input prefix={<IconSearch />} showClear value={searchParams.get('q') || ''} placeholder={s.deptSearch} aria-label={s.deptSearch}
            onChange={(v) => setSearchParams(v ? { q: v } : {}, { replace: true })} style={{ maxWidth: 320, marginBottom: 10 }} />
        )}
        {rows.length > 0 && (
          <div className="dept-sum">
            <span>{s.sumDepts(fmt(rows.length))}</span>
            <span className="pg-dot">·</span>
            <span>{s.sumHead(fmt(headTotal))}</span>
          </div>
        )}
        {/* One page = one page of DEPARTMENTS, every level included, because that
            is the unit HR counts in ("共 34 条") and the unit an import creates.
            The earlier shape paginated roots and started collapsed, which made the
            footer total disagree with the page count and hid whole branches behind
            an arrow; it also bounded nothing, since expanding one root rendered its
            entire subtree of live inputs regardless of page size. Flat rows cap the
            controls on screen at the page size instead. */}
        <Table key={listVer + ':' + dq} rowKey="id" loading={q.loading} dataSource={shown} size="small" className="dept-table"
          pagination={shown.length ? {
            pageSize: listSize, defaultCurrentPage: dq ? 1 : clampPage(listPage, shown.length, listSize), onPageChange: setListPage, onPageSizeChange: setListSize,
            pageSizeOpts: PAGE_TIERS, showSizeChanger: true, formatPageText: () => s.totalText(shown.length),
          } : false}
          empty={<Empty description={dq ? s.deptNoMatch : s.empty} style={{ padding: 24 }} />}
          {...resizableTable([
            // A list to read, with the editing behind named actions: an input and
            // a select on all 270 rows read as a wall of form controls, and on a
            // phone the same cells came out as editable cards nobody wanted to
            // tap. Rename and Move are now dialogs off the action column, which
            // also gives each one room for its "what this actually changes" note.
            // The └ marker and the indent are drawn here rather than by Semi's
            // tree indent, which no longer renders now that no row carries children.
            { title: s.name, dataIndex: 'name', width: 340, render: (v, d) => (
              <span className="dept-namecell" style={d.depth ? { paddingLeft: (d.depth - 1) * 14 } : undefined}>
                {d.depth > 0 && <i className="dept-branch" aria-hidden="true">└</i>}
                <b className="dept-name">{v}</b>
                {!d.active && <Tag size="small" style={{ marginLeft: 2 }}>{s.inactive}</Tag>}
              </span>
            ) },
            { title: s.parent, dataIndex: 'parentId', width: 180, render: (v) => (
              nameById.get(v) || <span className="dept-none">{s.rootOpt}</span>
            ) },
            { title: s.head, dataIndex: 'headcount', width: 130, align: 'center', render: (v, d) => (
              <span><b className="tnum">{v}</b>{d.total > (v || 0) && <Tag size="small" style={{ marginLeft: 6 }}>{s.subHead(d.total)}</Tag>}</span>
            ) },
            { title: s.owner, dataIndex: 'ownerName', width: 150, render: (v) => v || <span className="dept-none">{s.noOwner}</span> },
            // Deactivate keeps its place here rather than in a column of its own:
            // it is the only exit for a department that still has people in it,
            // which is exactly what the delete guard tells HR to reach for.
            // 改名 / 移动 / 启停 / 删除 are all departments 写 — the whole column
            // goes rather than leaving an empty one for a read-only档.
            ...(canWrite ? [{ title: '', dataIndex: 'op', width: 270, align: 'right', render: (_, d) => (
              <span className="dept-ops">
                <Button size="small" theme="borderless" onClick={() => setRen({ id: d.id, was: d.name, name: d.name })}>{s.rename}</Button>
                {/* A parentId pointing at a deleted department is a root row here,
                    so the dialog opens on the same answer the table shows. */}
                <Button size="small" theme="borderless" onClick={() => { const p = nameById.has(d.parentId) ? d.parentId : ''; setMov({ id: d.id, was: p, parentId: p }); }}>{s.move}</Button>
                {/* Where the HoD page's 「在部门列表设置负责人」 points (the page itself can only promote a candidate). */}
                <Button size="small" theme="borderless" onClick={() => openOwner(d)}>{s.setOwner}</Button>
                <Button size="small" theme="borderless" type="tertiary"
                  onClick={() => call(() => api.put(`/api/admin/departments/${d.id}`, { active: !d.active }), s.saved)}>{d.active ? s.disable : s.enable}</Button>
                {d.headcount === 0 && (
                  <Popconfirm title={s.del} okType="danger" okText={s.delete} cancelText={s.cancel}
                    onConfirm={() => call(() => api.del(`/api/admin/departments/${d.id}`), s.deleted)}>
                    <Button size="small" theme="borderless" type="danger">{s.delete}</Button>
                  </Popconfirm>
                )}
              </span>
            ) }] : []),
          ], { skip: ['name'] })} />
        {rows.length > 0 && <div className="dept-foot">{s.delRule}</div>}
        <div className="dept-mobilehint">{s.mobileHint}</div>
      </div>
    </div>
  );
}
