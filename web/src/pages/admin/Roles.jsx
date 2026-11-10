// Roles & access 角色与授权 — the RBAC console page. A super-admin builds
// admin roles here: each role carries a 10-domain grant map (manage | read |
// none), and staff are attached to a role from their employee profile (PUT
// /api/admin/employees/:id body.adminRoleId — NOT this page). This page is the
// role definitions, not the assignment surface.
//   GET    /api/admin/roles       → listRoles(): [{id,key,name,name_zh,grants,scope,builtin,memberCount}]
//   POST   /api/admin/roles       {name,name_zh,grants,scope?}  → create (roles never grantable)
//   PUT    /api/admin/roles/:id   {name,name_zh,grants,scope}   → update (super-admin builtin is locked)
//   DELETE /api/admin/roles/:id                                 → delete (blocked while memberCount>0)
// The whole page is super-admin-only (the roles domain — D6: it took over the
// lock that used to sit on accounts); a non-super admin who deep-links
// /admin/roles gets the no-permission notice below. The accounts domain (员工
// 账号: 建号/重置/启停) is now grantable and scoped, so it is an ordinary row.
import { isSuperAdmin as rbacIsSuperAdmin } from '../../rbac.js';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Button, Input, Banner, Spin, Toast, Tag, Empty, RadioGroup, Radio, Popconfirm,
  TreeSelect, Switch, Modal, Select,
} from '@douyinfe/semi-ui';
import { IconPlus, IconDelete, IconCopy, IconLock } from '@douyinfe/semi-icons';
import { api, useAsync } from '../../api.js';
import { useI18n } from '../../i18n.jsx';
import { useAuth } from '../../auth.jsx';

/* ---------------- co-located bilingual strings ---------------- */
const T = {
  zh: {
    title: '角色与授权',
    lead: '定义后台角色，并为每个能力域设置授权级别。成员在员工档案页指派后台角色，本页仅用于定义角色。',
    noPerm: '只有超级管理员可以管理角色与授权。',
    loadFail: '加载失败，请刷新页面重试。',
    newRole: '新建角色',
    builtin: '内置',
    locked: '锁定',
    members: (n) => `${n} 名成员`,
    memberOne: '1 名成员',
    nameZh: '角色名（中文）', nameEn: '角色名（英文）',
    nameZhPh: '例：培训管理员', nameEnPh: 'e.g. Learning admin',
    matrixTitle: '能力授权',
    matrixLead: '九个能力域，每个可设为管理、只读或无权限。「角色与授权」域为超级管理员专属，不可授予。',
    lvManage: '管理', lvRead: '只读', lvNone: '无',
    rolesNote: '「角色与授权」为超级管理员专属，不可授予其他角色；「员工账号」可授予，并受数据范围约束。',
    cultureNote: '「行为实践」：内置「管理员」为管理权限；只负责运营 Action 3+3 挑战的人员（HR、培训发展）请新建角色，仅将「行为实践」设为管理。',
    superNote: '超级管理员拥有全部权限，不可编辑或删除。',
    scopeTitle: '数据范围',
    scopeLead: '按部门限定该角色可见的员工数据。不选任何部门即为全公司范围。',
    scopeAll: '全公司',
    scopeSelectPh: '选择部门（可搜索、可多选）',
    scopeSelectedLead: '已选部门',
    scopeIncludeChildren: '含下级',
    scopeAllHint: '未选择部门，该角色可见全公司范围的数据。',
    scopeSuperNote: '超级管理员不受数据范围限制，始终为全公司。',
    save: '保存', saved: '已保存', saveFail: '保存失败',
    create: '创建', created: '已创建',
    del: '删除', deleted: '已删除', delFail: '删除失败',
    delConfirm: '删除此角色？此操作不可撤销。',
    delHasMembers: '该角色仍有成员，请先把他们改派到其他角色。',
    clone: '复制',
    cloneSuffix: ' 副本',
    nameRequired: '请先填写角色名。',
    memberListTitle: '成员',
    memberEmpty: '暂无成员',
    memberEmptyHint: '点右上角「添加成员」指派。',
    memberHint: '拥有这个后台角色的人。与上面的数据范围无关，需要单独指派。',
    memberAssignHint: '也可以在「员工档案」页逐人指派：打开该员工 → 编辑 → 后台角色。一个人同一时间只有一个后台角色，添加到这里会替换他原来的角色。',
    memberAdd: '添加成员', memberAddTitle: '添加成员', memberAddPh: '搜索姓名（可多选）',
    memberAddPeople: '按人添加', memberAddDepts: '按部门添加', memberAddDeptPh: '选择部门（可多选，可搜索）',
    memberAddDeptKids: '含下级部门', memberAddTotal: (n) => `将添加 ${n} 人`,
    memberAddReplace: (n) => `其中 ${n} 人现有其他后台角色，添加后会被替换。`,
    memberAddBusy: (i, n) => `正在添加 ${i}/${n}…`,
    memberAddOk: (n) => `已添加 ${n} 名成员`, memberAddPart: (ok, n) => `已添加 ${ok}/${n} 名，其余失败：`,
    memberRemove: '移除', memberRemoveConfirm: '移除后此人不再拥有该后台角色（账号保留）。确定移除？',
    memberRemoved: '已移除', memberHasRole: (r) => `现为：${r}`,
    scopePeople: (n) => `范围内员工 ${n} 人`, scopePeopleShow: '查看名单', scopePeopleHide: '收起',
    scopePeopleHint: '这是该角色能看到的员工（数据范围），不是角色成员。',
    scopePeopleUnsaved: '（按当前未保存的选择计算）',
    memberUnavailable: '成员清单暂不可用，当前仅显示人数。',
    memberInactive: '已停用',
    unsaved: '未保存',
    domains: {
      people: '员工与组织', learning: '培训', performance: '绩效', talent: '人才发展', culture: '行为实践',
      fields: '档案与职级设置', brand: '品牌设置', audit: '审计日志', accounts: '员工账号', roles: '角色与授权',
    },
  },
  en: {
    title: 'Roles & Access',
    lead: 'Define admin roles and set an access level for each capability domain. Assign admin roles to people from Employee Profiles; this page only defines roles.',
    noPerm: 'Only a Super Admin can manage roles and access.',
    loadFail: 'Couldn’t load. Refresh the page to try again.',
    newRole: 'New role',
    builtin: 'Built-in',
    locked: 'Locked',
    members: (n) => `${n} members`,
    memberOne: '1 member',
    nameZh: 'Role name (Chinese)', nameEn: 'Role name (English)',
    nameZhPh: 'e.g. 培训管理员', nameEnPh: 'e.g. Learning admin',
    matrixTitle: 'Capability grants',
    matrixLead: 'Nine capability domains, each set to Manage, Read or None. The Roles & Access domain is Super Admin only and cannot be granted.',
    lvManage: 'Manage', lvRead: 'Read', lvNone: 'None',
    rolesNote: 'Roles & Access is Super Admin only and cannot be granted; Employee Accounts can be granted and is scoped by data range.',
    cultureNote: 'Behavior Practice: the built-in Admin role has Manage. For people who only run the Action 3+3 Challenge (HR, training and development), create a role with just Behavior Practice set to Manage.',
    superNote: 'The Super Admin has every permission and cannot be edited or deleted.',
    scopeTitle: 'Data scope',
    scopeLead: 'Limit the employee data this role can see, by department. No departments selected means company-wide.',
    scopeAll: 'Company-wide',
    scopeSelectPh: 'Select departments (searchable, multi-select)',
    scopeSelectedLead: 'Selected departments',
    scopeIncludeChildren: 'Include sub-departments',
    scopeAllHint: 'No departments selected — this role sees company-wide data.',
    scopeSuperNote: 'The Super Admin is never limited by data scope — always company-wide.',
    save: 'Save', saved: 'Saved', saveFail: 'Save failed',
    create: 'Create', created: 'Created',
    del: 'Delete', deleted: 'Deleted', delFail: 'Delete failed',
    delConfirm: 'Delete this role? This cannot be undone.',
    delHasMembers: 'This role still has members — reassign them to another role first.',
    clone: 'Duplicate',
    cloneSuffix: ' copy',
    nameRequired: 'Enter a role name first.',
    memberListTitle: 'Members',
    memberEmpty: 'No members yet',
    memberEmptyHint: 'Use "Add members" to assign it.',
    memberHint: 'People who hold this admin role. Separate from the data scope above; assign them explicitly.',
    memberAssignHint: 'You can also assign one person at a time from Employee profiles: open the person → Edit → Admin role. A person holds one admin role at a time — adding them here replaces their current role.',
    memberAdd: 'Add members', memberAddTitle: 'Add members', memberAddPh: 'Search by name (multi-select)',
    memberAddPeople: 'Add people', memberAddDepts: 'Add by department', memberAddDeptPh: 'Select departments (searchable, multi-select)',
    memberAddDeptKids: 'Include sub-departments', memberAddTotal: (n) => `${n} ${n === 1 ? 'person' : 'people'} will be added`,
    memberAddReplace: (n) => `${n} of them currently hold another admin role, which will be replaced.`,
    memberAddBusy: (i, n) => `Adding ${i}/${n}…`,
    memberAddOk: (n) => `Added ${n} member${n === 1 ? '' : 's'}`, memberAddPart: (ok, n) => `Added ${ok}/${n}; the rest failed: `,
    memberRemove: 'Remove', memberRemoveConfirm: 'This person will no longer hold this admin role (the account stays). Remove?',
    memberRemoved: 'Removed', memberHasRole: (r) => `Currently: ${r}`,
    scopePeople: (n) => `${n} employee${n === 1 ? '' : 's'} in scope`, scopePeopleShow: 'Show list', scopePeopleHide: 'Hide',
    scopePeopleHint: 'These are the employees this role can see (data scope), not its members.',
    scopePeopleUnsaved: '(based on the current, unsaved selection)',
    memberUnavailable: 'The member list is unavailable here — showing the count only.',
    memberInactive: 'Inactive',
    unsaved: 'Unsaved',
    domains: {
      people: 'People & Organization', learning: 'Learning', performance: 'Performance', talent: 'Talent Development', culture: 'Behavior Practice',
      fields: 'Profile & Job Level Settings', brand: 'Brand Settings', audit: 'Audit Log', accounts: 'Employee Accounts', roles: 'Roles & Access',
    },
  },
};

// The ten capability domains, in the fixed display order the design uses (D6;
// culture — 行为实践 / Behavior Practice — joined between talent and fields on
// 2026-09-26 when the culture module was registered).
// roles is last — it is the super-admin-only row, rendered locked (it took over
// the lock that used to sit on accounts). accounts now precedes it as an
// ordinary grantable row (员工账号: 建号/重置/启停, scoped by department).
const DOMAINS = ['people', 'learning', 'performance', 'talent', 'fields', 'brand', 'audit', 'accounts', 'roles'];
const LEVELS = ['manage', 'read', 'none'];
const NEW = '__new__'; // sentinel id for an unsaved draft (create / clone)

// A full grant map (every domain) with every domain at `none` — the shape the server
// stores (all domains listed), so a create/clone never sends a partial map.
const emptyGrants = () => DOMAINS.reduce((o, d) => { o[d] = 'none'; return o; }, {});
const isSuperRole = (r) => !!(r && r.builtin && r.key === 'super-admin');
const BUILTIN_ORDER = ['super-admin', 'admin', 'learning-admin', 'performance-talent-admin'];

export default function Roles() {
  const { lang } = useI18n();
  const { user } = useAuth();
  const s = T[lang];

  // Super-admin gate. Old /api/me carries no grants block → treat as super-admin
  // (backward-compat, same rule as the sidebar); otherwise trust isSuperAdmin.
  const isSuperAdmin = rbacIsSuperAdmin(user);

  const q = useAsync(() => api.get('/api/admin/roles'), []);
  // GET /api/admin/roles answers with an ENVELOPE — { roles: [...] } — which
  // test/rbac.test.js pins. Reading q.data as a bare array made `roles` always
  // empty: the page rendered its heading, the 新建角色 button and an empty editor
  // card, with no role list and therefore no member list at all. The array form
  // stays as a fallback so either shape renders.
  const roles = useMemo(() => {
    const list = Array.isArray(q.data) ? q.data : (q.data && Array.isArray(q.data.roles) ? q.data.roles : []);
    // 内置角色按固定顺序排在前（负责人 2026-10-06 收敛为 4 个）；自定义角色保持接口顺序
    const rank = (r) => { const i = BUILTIN_ORDER.indexOf(r.builtin ? r.key : ''); return i < 0 ? BUILTIN_ORDER.length : i; };
    return list.map((r, i) => [r, i]).sort((a, b) => rank(a[0]) - rank(b[0]) || a[1] - b[1]).map(([r]) => r);
  }, [q.data]);

  const [selId, setSelId] = useState(null); // selected role id, or NEW for a draft
  const [draft, setDraft] = useState(null);  // editable working copy of the selection
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);

  // Member list: staff are tagged with adminRoleId, which the roster endpoint
  // may or may not carry yet (added by the RBAC server work). Fetch once; if the
  // field is present we resolve names, otherwise we fall back to memberCount.
  const roster = useAsync(() => (isSuperAdmin ? api.get('/api/admin/roster') : Promise.resolve([])), [isSuperAdmin]);
  const rosterList = useMemo(() => (Array.isArray(roster.data) ? roster.data : []), [roster.data]);

  // Departments feed the data-scope selector (P2 阶段 C). GET /api/admin/departments
  // answers a bare array of {id,name,parentId,active,...}; parentId assembles the
  // tree (≤3 levels). Only fetched for a super-admin (the page's only audience).
  const deptsQ = useAsync(() => (isSuperAdmin ? api.get('/api/admin/departments') : Promise.resolve([])), [isSuperAdmin]);
  // TreeSelect treeData: {label,value,key,children?}. Empty `children` arrays are
  // stripped so leaf rows show no expander. checkRelation="unRelated" on the
  // TreeSelect keeps parent/child selection independent — a parent does NOT drag
  // its subtree in; whether a subtree is covered is the per-row 含下级 switch.
  const deptTree = useMemo(() => {
    const list = Array.isArray(deptsQ.data) ? deptsQ.data : [];
    const byId = new Map(list.map((d) => [d.id, { label: d.name, value: d.id, key: d.id, children: [] }]));
    const roots = [];
    for (const d of list) {
      const node = byId.get(d.id);
      if (!node) continue;
      if (d.parentId && byId.has(d.parentId)) byId.get(d.parentId).children.push(node);
      else roots.push(node);
    }
    const clean = (n) => { if (!n.children.length) delete n.children; else n.children.forEach(clean); return n; };
    roots.forEach(clean);
    return roots;
  }, [deptsQ.data]);
  // id → name, for labelling the selected-departments list (a scope entry stores
  // only the id, and a since-renamed/removed id falls back to showing the id).
  const deptNameById = useMemo(() => {
    const list = Array.isArray(deptsQ.data) ? deptsQ.data : [];
    return new Map(list.map((d) => [d.id, d.name]));
  }, [deptsQ.data]);

  // After a save the list reloads; stay on the role just saved (it used to fall
  // back to the first role — Super Admin — which read as "save jumped away").
  const reselectRef = useRef(null);
  // Auto-select the first role once the list lands (keeps a panel on screen).
  useEffect(() => {
    if (reselectRef.current != null) {
      const keep = roles.find((r) => r.id === reselectRef.current);
      if (keep) { reselectRef.current = null; selectRole(keep); return; }
    }
    if (selId == null && roles.length) selectRole(roles[0]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roles]);

  const selectRole = (r) => {
    setSelId(r.id);
    setDraft({
      id: r.id, key: r.key, builtin: r.builtin,
      name: r.name || '', name_zh: r.name_zh || '',
      grants: { ...emptyGrants(), ...(r.grants && typeof r.grants === 'object' ? r.grants : {}) },
      scope: r.scope && typeof r.scope === 'object' ? r.scope : {},
    });
  };
  const startNew = () => {
    setSelId(NEW);
    setDraft({ id: NEW, key: null, builtin: 0, name: '', name_zh: '', grants: emptyGrants(), scope: {} });
  };
  const startClone = () => {
    if (!draft) return;
    setSelId(NEW);
    setDraft({
      id: NEW, key: null, builtin: 0,
      name: (draft.name || '') + (draft.name ? s.cloneSuffix : ''),
      name_zh: (draft.name_zh || '') + (draft.name_zh ? s.cloneSuffix : ''),
      grants: { ...draft.grants, roles: 'none' }, // roles never rides a clone (accounts can)
      scope: { ...draft.scope },
    });
  };

  const locked = isSuperRole(draft);          // super-admin builtin — read-only
  const isNew = selId === NEW;

  const setLevel = (domain, level) => {
    if (locked || domain === 'roles') return; // roles is never grantable (D6)
    setDraft((d) => ({ ...d, grants: { ...d.grants, [domain]: level } }));
  };

  // --- data scope (department range) ---
  // Storage contract: draft.scope = { departments: [{ id, includeChildren }] };
  // an empty array (or {}) is company-wide (the backend treats both the same).
  const scopeDepts = (draft && draft.scope && Array.isArray(draft.scope.departments)) ? draft.scope.departments : [];
  const scopeIds = scopeDepts.map((x) => x.id);
  // TreeSelect hands back the full id array. Keep the includeChildren flag of ids
  // that survive; a freshly-added department defaults to 含下级 = true (selecting
  // a branch usually means "this unit and everything under it").
  const setScopeIds = (ids) => {
    if (locked) return;
    setDraft((d) => {
      const prev = (d.scope && Array.isArray(d.scope.departments)) ? d.scope.departments : [];
      const prevMap = new Map(prev.map((x) => [x.id, x]));
      const next = (ids || []).map((id) => (prevMap.has(id) ? prevMap.get(id) : { id, includeChildren: true }));
      return { ...d, scope: { departments: next } };
    });
  };
  const setScopeInc = (id, inc) => {
    if (locked) return;
    setDraft((d) => {
      const prev = (d.scope && Array.isArray(d.scope.departments)) ? d.scope.departments : [];
      return { ...d, scope: { departments: prev.map((x) => (x.id === id ? { ...x, includeChildren: inc } : x)) } };
    });
  };

  const memberCountOf = (r) => (r && typeof r.memberCount === 'number' ? r.memberCount : 0);
  // Does the roster payload actually carry adminRoleId? An older server omits
  // the field entirely — then we cannot resolve names and fall back to the
  // count. Key PRESENCE is the test, not a non-null value (a fresh install has
  // the field on every row with nothing assigned yet).
  const rosterHasRoleField = useMemo(
    () => rosterList.some((u) => u && Object.prototype.hasOwnProperty.call(u, 'adminRoleId')),
    [rosterList]
  );
  // Resolved members of the selected role, when the roster carries adminRoleId.
  // Client-side filter on purpose: the roster is one cached fetch (900+ rows),
  // and only the handful attached to this role is ever rendered.
  // Keyed on the selected id alone — editing the name inputs or the grant
  // matrix replaces `draft`, and that must not re-filter 900 roster rows (nor
  // re-render the list) on every keystroke.
  const draftId = draft ? draft.id : null;
  const members = useMemo(() => {
    if (isNew || draftId == null || !rosterHasRoleField) return [];
    return rosterList
      .filter((u) => u && u.adminRoleId != null && u.adminRoleId === draftId)
      .sort((a, b) => String(a.employeeId || '').localeCompare(String(b.employeeId || ''), 'en', { numeric: true }));
  }, [rosterList, draftId, isNew, rosterHasRoleField]);
  const selRole = roles.find((r) => r.id === selId) || null;

  // Who the selected departments cover — mirrors store.scopeCollectSubtree
  // (each picked department, plus its whole subtree when 含下级 is on) and
  // scopeAllowsDepartment (users.department name, case/space-insensitive).
  // Computed on the DRAFT, so HR sees the effect before saving. null = company-wide.
  const [showScopePeople, setShowScopePeople] = useState(false);
  // picked = [{ id, includeChildren }] → 这些部门（含下级时连同整棵子树）里的在职员工。数据范围预览与「按部门添加成员」共用。
  const peopleInDepts = (picked) => {
    const list = Array.isArray(deptsQ.data) ? deptsQ.data : [];
    const byId = new Map(list.map((d) => [d.id, d]));
    const kids = new Map();
    for (const d of list) if (d.parentId) { if (!kids.has(d.parentId)) kids.set(d.parentId, []); kids.get(d.parentId).push(d.id); }
    const names = new Set();
    for (const p of picked) {
      const root = byId.get(p.id);
      if (!root) continue;
      names.add(String(root.name).trim().toLowerCase());
      if (p.includeChildren === false) continue;
      const queue = [p.id], seen = new Set(queue);
      for (let i = 0; i < queue.length; i++) {
        for (const cid of kids.get(queue[i]) || []) {
          if (seen.has(cid)) continue;
          seen.add(cid); queue.push(cid);
          const c = byId.get(cid); if (c) names.add(String(c.name).trim().toLowerCase());
        }
      }
    }
    return rosterList
      .filter((u) => u && u.active !== false && u.department && names.has(String(u.department).trim().toLowerCase()))
      .sort((a, b) => String(a.department).localeCompare(String(b.department)) || String(a.name || '').localeCompare(String(b.name || '')));
  };
  const scopePeople = useMemo(() => {
    const picked = (draft && draft.scope && Array.isArray(draft.scope.departments)) ? draft.scope.departments : [];
    if (!picked.length) return null;
    return peopleInDepts(picked);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, deptsQ.data, rosterList]);
  const scopeDirty = !!(draft && selRole && JSON.stringify(draft.scope || {}) !== JSON.stringify(selRole.scope || {}));

  // Member add / remove — the same per-person PUT the employee profile uses
  // (PUT /api/admin/employees/:id {adminRoleId}, super-admin only; the server
  // keeps the last-super-admin guard and writes role.assign to the audit log).
  const [addOpen, setAddOpen] = useState(false);
  const [addIds, setAddIds] = useState([]);
  const [addDeptIds, setAddDeptIds] = useState([]);
  const [addDeptKids, setAddDeptKids] = useState(true);
  const [addProgress, setAddProgress] = useState(null);
  const [memberBusy, setMemberBusy] = useState(false);
  const roleNameById = useMemo(() => new Map(roles.map((r) => [r.id, lang === 'zh' ? (r.name_zh || r.name) : (r.name || r.name_zh)])), [roles, lang]);
  // 2026-10-05 反馈：下拉只显示、只搜索名字（不要工号、部门）。有 Lark 账号的显示 Lark 名（larkName，每日同步写入），
  // 没有的显示 BIPO 姓名；两个名字都能搜到。已有其他后台角色的人在名字后标出。
  const addOptions = useMemo(() => rosterList
    .filter((u) => u && u.active !== false && u.adminRoleId !== draftId)
    .map((u) => ({
      value: u.id,
      label: u.larkName || u.name || '—',
      search: `${u.larkName || ''} ${u.name || ''}`.toLowerCase(),
      roleNote: u.adminRoleId != null ? s.memberHasRole(roleNameById.get(u.adminRoleId) || u.adminRoleId) : '',
    })), [rosterList, draftId, roleNameById, s]);
  // 按人选的 + 按部门选的（去重；已是本角色成员、停用的不算）
  const addFinal = useMemo(() => {
    if (!addOpen) return [];
    const ids = new Set(addIds);
    if (addDeptIds.length) for (const u of peopleInDepts(addDeptIds.map((id) => ({ id, includeChildren: addDeptKids })))) if (u.adminRoleId !== draftId) ids.add(u.id);
    const byId = new Map(rosterList.map((u) => [u.id, u]));
    return [...ids].map((id) => byId.get(id)).filter(Boolean);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [addOpen, addIds, addDeptIds, addDeptKids, rosterList, draftId, deptsQ.data]);
  const addReplaceN = addFinal.filter((u) => u.adminRoleId != null).length;
  const afterMemberChange = () => {
    reselectRef.current = draftId;
    setSelId(null);
    q.reload();
    roster.reload();
  };
  const addMembers = async () => {
    const list = addFinal.map((u) => u.id);
    if (!list.length || isNew) return;
    setMemberBusy(true);
    let ok = 0; const errs = [];
    // 整个部门一次可能上百人：4 路并发逐人 PUT（同一个接口、每人一条审计），进度按完成数显示。
    let next = 0, finished = 0;
    const worker = async () => {
      while (next < list.length) {
        const id = list[next++];
        try { await api.put('/api/admin/employees/' + encodeURIComponent(id), { adminRoleId: draftId }); ok++; }
        catch (err) { errs.push((err && err.message) || id); }
        setAddProgress(s.memberAddBusy(++finished, list.length));
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, list.length) }, worker));
    setMemberBusy(false); setAddProgress(null);
    if (errs.length) Toast.error({ content: s.memberAddPart(ok, list.length) + errs[0], duration: 5 });
    else Toast.success(s.memberAddOk(ok));
    setAddOpen(false); setAddIds([]); setAddDeptIds([]);
    if (ok) afterMemberChange();
  };
  const removeMember = async (m) => {
    setMemberBusy(true);
    try {
      await api.put('/api/admin/employees/' + encodeURIComponent(m.id), { adminRoleId: null });
      Toast.success(s.memberRemoved);
      afterMemberChange();
    } catch (err) { Toast.error((err && err.message) || s.saveFail); }
    setMemberBusy(false);
  };

  const save = async () => {
    if (!draft) return;
    const name = String(draft.name || '').trim();
    const name_zh = String(draft.name_zh || '').trim();
    if (!name && !name_zh) { Toast.warning(s.nameRequired); return; }
    // Custom roles never carry roles=manage — force it none before sending
    // (the server rejects it too, this just keeps the request clean). accounts
    // now flows through as an ordinary grant (D6).
    const grants = { ...draft.grants };
    if (!locked) grants.roles = 'none';
    const payload = { name, name_zh, grants, scope: draft.scope || {} };
    setSaving(true);
    try {
      if (isNew) {
        const res = await api.post('/api/admin/roles', payload);
        reselectRef.current = (res && res.role && res.role.id) || null;
        Toast.success(s.created);
      } else {
        await api.put('/api/admin/roles/' + encodeURIComponent(draft.id), payload);
        reselectRef.current = draft.id;
        Toast.success(s.saved);
      }
      setSelId(null); // the list reload re-selects reselectRef (or the first role)
      q.reload();
      roster.reload();
    } catch (err) { Toast.error((err && err.message) || s.saveFail); }
    setSaving(false);
  };

  const remove = async () => {
    if (!draft || isNew) return;
    setDeleting(true);
    try {
      await api.del('/api/admin/roles/' + encodeURIComponent(draft.id));
      Toast.success(s.deleted);
      setSelId(null);
      q.reload();
    } catch (err) { Toast.error((err && err.message) || s.delFail); }
    setDeleting(false);
  };

  /* ---------- gate & load states ---------- */
  if (!isSuperAdmin) {
    return (
      <div className="wrap tset-wrap">
        <Banner type="warning" closeIcon={null} description={s.noPerm} />
      </div>
    );
  }
  if (q.error) {
    return (
      <div className="wrap tset-wrap">
        <Banner type="danger" closeIcon={null} description={`${s.loadFail} · ${q.error.message}`} />
      </div>
    );
  }
  if (!q.data) {
    return <div className="wrap tset-wrap" style={{ textAlign: 'center', paddingTop: 80 }}><Spin size="large" /></div>;
  }

  /* ---------- layout helpers (inline — app.css scope is out of bounds here) ---------- */
  const roleName = (r) => (lang === 'zh' ? (r.name_zh || r.name) : (r.name || r.name_zh)) || '—';
  // CX-047（2026-10-10 验收）：英文界面不再显示中文副名（验收视为中文残留）；中文界面仍显示英文名做参照
  const roleSub = (r) => (lang === 'zh' ? r.name : '') || '';
  const memberCount = isNew ? 0 : memberCountOf(selRole);
  // Graceful degradation — never a blank card and never an error toast: when the
  // roster call failed, or it landed without adminRoleId, or it disagrees with
  // the server's memberCount, we show the count tag and a quiet note instead of
  // claiming "no members yet".
  const membersLoading = !isNew && roster.loading && !roster.error;
  const membersDegraded = !isNew && !membersLoading && (
    !!roster.error || (rosterList.length > 0 && !rosterHasRoleField) || (memberCount > 0 && members.length === 0)
  );

  return (
    <div className="wrap tset-wrap">
      <div className="tset-head">
        <div><h1 className="tset-title">{s.title}</h1><div className="tset-lead">{s.lead}</div></div>
        <div className="tset-head-act">
          <Button theme="solid" type="primary" icon={<IconPlus />} onClick={startNew}>{s.newRole}</Button>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start', flexWrap: 'wrap' }}>
        {/* -------- left: role list -------- */}
        <div className="ppl-card role-list" style={{ flex: '0 0 260px', minWidth: 220, padding: 8 }}>
          {roles.map((r) => {
            const active = r.id === selId;
            return (
              <button
                key={r.id}
                onClick={() => selectRole(r)}
                className={'adm-nav-item role-item' + (active ? ' on' : '')}
                style={{ display: 'block', width: '100%', textAlign: 'left', border: 'none', background: active ? undefined : 'transparent', cursor: 'pointer', marginBottom: 2, padding: '8px 10px' }}
              >
                <span className="role-item-name" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ fontWeight: 600, fontSize: 14, color: 'var(--ink)' }}>{roleName(r)}</span>
                  {isSuperRole(r) && <IconLock style={{ fontSize: 12, color: 'var(--ink-3)' }} />}
                  {r.builtin ? <Tag size="small" color="blue" type="light">{s.builtin}</Tag> : null}
                </span>
                <span className="role-item-sub" style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 2 }}>
                  {/* `lang-pair`: 副标题是「另一种语言的角色名」—— 中文界面显示英文名、
                      英文界面显示中文名，成对出现是本意。标记类与本页中英名输入框、
                      BrandSettings.jsx 的成对编辑器一致（纯标记，无样式），冒烟的
                      latin-in-zh / cjk-in-en 据此跳过这半边；同一行里的「内置 /
                      N 名成员」等 T 文案仍照旧受检，漏翻仍会被抓到。 */}
                  {roleSub(r) && <span className="lang-pair" style={{ fontSize: 12, color: 'var(--ink-3)' }}>{roleSub(r)}</span>}
                  <span style={{ fontSize: 12, color: 'var(--ink-3)', marginLeft: 'auto' }}>
                    {memberCountOf(r) === 1 ? s.memberOne : s.members(memberCountOf(r))}
                  </span>
                </span>
              </button>
            );
          })}
          {/* the unsaved draft shows in the list too, so it never feels lost */}
          {isNew && (
            <div className={'adm-nav-item role-item on'} style={{ padding: '8px 10px', marginTop: 2 }}>
              <span style={{ fontWeight: 600, fontSize: 14, color: 'var(--ink)' }}>{roleName(draft) === '—' ? s.newRole : roleName(draft)}</span>
              <Tag size="small" color="amber" type="light" style={{ marginLeft: 6 }}>{s.unsaved}</Tag>
            </div>
          )}
        </div>

        {/* -------- right: editor -------- */}
        <div style={{ flex: '1 1 420px', minWidth: 300 }}>
          {!draft ? (
            <div className="ppl-card"><Empty description={s.newRole} /></div>
          ) : (
            <>
              {/* names */}
              <div className="ppl-card">
                <div className="ppl-sec-h"><div><h2>{isNew ? s.newRole : roleName(draft)}</h2>
                  {locked && <div className="tset-lead">{s.superNote}</div>}</div></div>
                {/* `lang-pair`: 中英成对输入,每个框的占位符举的例子就是它自己那门语言的
                    —— 跨语言是本意,不是漏翻译。标记类与 BrandSettings.jsx 的成对编辑器
                    一致(纯标记,无样式),冒烟检查据此放过这两个占位符。 */}
                <div className="lang-pair" style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                  <label style={{ flex: '1 1 200px', minWidth: 180 }}>
                    <div style={{ fontSize: 13, color: 'var(--ink-2)', fontWeight: 500, marginBottom: 4 }}>{s.nameZh}</div>
                    <Input value={draft.name_zh} placeholder={s.nameZhPh} disabled={locked}
                      onChange={(v) => setDraft((d) => ({ ...d, name_zh: v }))} />
                  </label>
                  <label style={{ flex: '1 1 200px', minWidth: 180 }}>
                    <div style={{ fontSize: 13, color: 'var(--ink-2)', fontWeight: 500, marginBottom: 4 }}>{s.nameEn}</div>
                    <Input value={draft.name} placeholder={s.nameEnPh} disabled={locked}
                      onChange={(v) => setDraft((d) => ({ ...d, name: v }))} />
                  </label>
                </div>
              </div>

              {/* grants matrix — 8 rows × 3 levels */}
              <div className="ppl-card">
                <div className="ppl-sec-h"><div><h2>{s.matrixTitle}</h2><div className="tset-lead">{s.matrixLead}</div></div></div>
                {DOMAINS.map((d) => {
                  const isRoles = d === 'roles'; // D6: the locked, non-grantable row
                  const val = locked ? 'manage' : (isRoles ? 'none' : (draft.grants[d] || 'none'));
                  const disabled = locked || isRoles;
                  return (
                    <div key={d} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '8px 0', borderTop: '1px solid var(--line)', flexWrap: 'wrap' }}>
                      <span style={{ flex: '0 0 160px', minWidth: 140, fontSize: 13, fontWeight: 500, color: 'var(--ink)', display: 'flex', alignItems: 'center', gap: 6 }}>
                        {s.domains[d]}
                        {isRoles && <IconLock style={{ fontSize: 12, color: 'var(--ink-3)' }} />}
                      </span>
                      <RadioGroup
                        type="button"
                        value={val}
                        disabled={disabled}
                        onChange={(e) => setLevel(d, e.target.value)}
                      >
                        <Radio value="manage">{s.lvManage}</Radio>
                        <Radio value="read">{s.lvRead}</Radio>
                        <Radio value="none">{s.lvNone}</Radio>
                      </RadioGroup>
                    </div>
                  );
                })}
                <div className="tset-renamehint" style={{ marginTop: 8 }}>{s.rolesNote}</div>
                {/* Unfolding Lab 版：行为实践（3+3）模块已删除，不再显示 cultureNote */}
              </div>

              {/* scope — department data-range selector (P2 阶段 C) */}
              <div className="ppl-card">
                <div className="ppl-sec-h"><div><h2>{s.scopeTitle}</h2><div className="tset-lead">{s.scopeLead}</div></div></div>
                {locked ? (
                  /* super-admin is unconstrained — read-only, always company-wide */
                  <div>
                    <Tag color="grey" type="light" size="large">{s.scopeAll}</Tag>
                    <div className="tset-renamehint" style={{ marginTop: 8 }}>{s.scopeSuperNote}</div>
                  </div>
                ) : (
                  <>
                    <TreeSelect
                      multiple
                      checkRelation="unRelated"
                      filterTreeNode
                      showFilteredOnly
                      treeData={deptTree}
                      value={scopeIds}
                      onChange={setScopeIds}
                      placeholder={s.scopeSelectPh}
                      maxTagCount={3}
                      style={{ width: '100%' }}
                      dropdownStyle={{ maxHeight: 360, overflow: 'auto' }}
                    />
                    {scopeDepts.length === 0 ? (
                      /* explicit company-wide affordance — never a blank block */
                      <div style={{ marginTop: 10, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                        <Tag color="grey" type="light" size="large">{s.scopeAll}</Tag>
                        <span style={{ fontSize: 13, color: 'var(--ink-3)' }}>{s.scopeAllHint}</span>
                      </div>
                    ) : (
                      /* one row per selected department, each with its own 含下级 switch */
                      <div style={{ marginTop: 12 }}>
                        <div style={{ fontSize: 13, color: 'var(--ink-2)', fontWeight: 500, marginBottom: 4 }}>{s.scopeSelectedLead}</div>
                        <div style={{ maxHeight: 240, overflowY: 'auto', margin: '0 -4px', padding: '0 4px' }}>
                          {scopeDepts.map((sc, i) => (
                            <div
                              key={sc.id}
                              style={{
                                display: 'flex', alignItems: 'center', gap: 10, padding: '7px 2px',
                                borderTop: i === 0 ? 'none' : '1px solid var(--line)',
                              }}
                            >
                              <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--ink)', flex: '1 1 auto' }}>{deptNameById.get(sc.id) || sc.id}</span>
                              <span style={{ fontSize: 12, color: 'var(--ink-3)' }}>{s.scopeIncludeChildren}</span>
                              <Switch checked={sc.includeChildren !== false} size="small" onChange={(v) => setScopeInc(sc.id, v)} />
                            </div>
                          ))}
                        </div>
                        {scopePeople && (
                          <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px solid var(--line)' }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                              <Tag color="cyan" type="light" size="large">{s.scopePeople(scopePeople.length)}</Tag>
                              {scopePeople.length > 0 && (
                                <Button theme="borderless" size="small" onClick={() => setShowScopePeople((v) => !v)}>
                                  {showScopePeople ? s.scopePeopleHide : s.scopePeopleShow}
                                </Button>
                              )}
                              <span style={{ fontSize: 12, color: 'var(--ink-3)' }}>{s.scopePeopleHint}{scopeDirty ? ' ' + s.scopePeopleUnsaved : ''}</span>
                            </div>
                            {showScopePeople && (
                              <div style={{ maxHeight: 264, overflowY: 'auto', marginTop: 6 }}>
                                {scopePeople.map((u, i) => (
                                  <div key={u.id} style={{ display: 'flex', gap: 10, padding: '6px 2px', borderTop: i === 0 ? 'none' : '1px solid var(--line)' }}>
                                    <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--ink)' }}>{u.name || '—'}</span>
                                    <span className="tnum" style={{ fontSize: 12, color: 'var(--ink-3)' }}>{u.employeeId || ''}</span>
                                    <span style={{ fontSize: 12, color: 'var(--ink-3)' }}>{u.department}</span>
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    )}
                  </>
                )}
              </div>

              {/* members */}
              {!isNew && (
                <div className="ppl-card">
                  <div className="ppl-sec-h"><div><h2>{s.memberListTitle}</h2><div className="tset-lead">{s.memberHint}</div></div>
                    <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center' }}>
                      <Tag className="role-count" color="blue" type="light" size="large">{memberCount === 1 ? s.memberOne : s.members(memberCount)}</Tag>
                      <Button theme="light" type="primary" icon={<IconPlus />} disabled={membersLoading || membersDegraded || memberBusy} onClick={() => { setAddIds([]); setAddDeptIds([]); setAddDeptKids(true); setAddOpen(true); }}>{s.memberAdd}</Button>
                    </div>
                  </div>
                  {membersLoading ? (
                    <div style={{ padding: '6px 0' }}><Spin size="small" /></div>
                  ) : membersDegraded ? (
                    <div style={{ fontSize: 13, color: 'var(--ink-3)' }}>{s.memberUnavailable}</div>
                  ) : members.length ? (
                    /* Real member list — capped height so a 200-strong role
                       scrolls inside the card instead of stretching the page. */
                    <div style={{ maxHeight: 264, overflowY: 'auto', margin: '0 -4px', padding: '0 4px' }}>
                      {members.map((m, i) => (
                        <div
                          key={m.id}
                          style={{
                            display: 'flex', alignItems: 'center', gap: 10, padding: '7px 2px',
                            borderTop: i === 0 ? 'none' : '1px solid var(--line)',
                          }}
                        >
                          <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--ink)' }}>{m.name || '—'}</span>
                          <span className="tnum" style={{ fontSize: 12, color: 'var(--ink-3)' }}>{m.employeeId || ''}</span>
                          {m.department && <span style={{ fontSize: 12, color: 'var(--ink-3)' }}>{m.department}</span>}
                          {m.active === false && (
                            <Tag size="small" color="grey" type="light" style={{ marginLeft: 'auto' }}>{s.memberInactive}</Tag>
                          )}
                          <Popconfirm title={s.memberRemoveConfirm} onConfirm={() => removeMember(m)} okType="danger">
                            <Button theme="borderless" type="danger" size="small" disabled={memberBusy} style={{ marginLeft: m.active === false ? 0 : 'auto' }}>{s.memberRemove}</Button>
                          </Popconfirm>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div style={{ fontSize: 13, color: 'var(--ink-3)' }}>
                      {s.memberEmpty}
                      <span style={{ marginLeft: 6, color: 'var(--ink-3)' }}>{s.memberEmptyHint}</span>
                    </div>
                  )}
                  {/* Cross-entry: this page defines roles, the employee profile
                      attaches people to them (PUT /api/admin/employees/:id
                      body.adminRoleId). Spelled out as a click path because
                      there is no member-add control here by design — bulk
                      membership editing is out of scope for P1. */}
                  <div className="tset-renamehint" style={{ marginTop: 10 }}>{s.memberAssignHint}</div>
                  <Modal
                    title={s.memberAddTitle}
                    visible={addOpen}
                    onCancel={() => setAddOpen(false)}
                    onOk={addMembers}
                    okButtonProps={{ disabled: !addFinal.length, loading: memberBusy }}
                    width={560}
                  >
                    <div className="tset-addlab">{s.memberAddPeople}</div>
                    <Select
                      multiple
                      filter={(input, opt) => opt.search.includes(String(input || '').trim().toLowerCase())}
                      value={addIds}
                      onChange={(v) => setAddIds(Array.isArray(v) ? v : [])}
                      optionList={addOptions}
                      renderOptionItem={(o) => (
                        <div
                          className={'semi-select-option' + (o.selected ? ' semi-select-option-selected' : '') + (o.focused ? ' semi-select-option-focused' : '')}
                          style={o.style} onClick={() => o.onClick()} onMouseEnter={(e) => o.onMouseEnter(e)}
                        >
                          <span>{o.label}</span>
                          {o.roleNote && <span style={{ marginLeft: 8, fontSize: 12, color: 'var(--semi-color-text-2)' }}>{o.roleNote}</span>}
                        </div>
                      )}
                      placeholder={s.memberAddPh}
                      maxTagCount={6}
                      style={{ width: '100%' }}
                      virtualize={addOptions.length > 200 ? { height: 300, width: '100%', itemSize: 36 } : undefined}
                    />
                    <div className="tset-addlab" style={{ marginTop: 14 }}>{s.memberAddDepts}</div>
                    <TreeSelect
                      multiple filterTreeNode showFilteredOnly searchAutoFocus={false}
                      checkRelation="unRelated"
                      treeData={deptTree}
                      value={addDeptIds}
                      onChange={(v) => setAddDeptIds(Array.isArray(v) ? v : [])}
                      placeholder={s.memberAddDeptPh}
                      maxTagCount={4}
                      style={{ width: '100%' }}
                      dropdownStyle={{ maxHeight: 320, overflow: 'auto' }}
                    />
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
                      <Switch size="small" checked={addDeptKids} onChange={setAddDeptKids} />
                      <span style={{ fontSize: 13 }}>{s.memberAddDeptKids}</span>
                    </div>
                    {addFinal.length > 0 && (
                      <div style={{ marginTop: 12, fontSize: 13 }}>
                        <b>{addProgress || s.memberAddTotal(addFinal.length)}</b>
                        {addReplaceN > 0 && <div style={{ color: 'var(--semi-color-warning)', marginTop: 4 }}>{s.memberAddReplace(addReplaceN)}</div>}
                      </div>
                    )}
                    <div className="tset-renamehint" style={{ marginTop: 10 }}>{s.memberAssignHint}</div>
                  </Modal>
                </div>
              )}

              {/* actions */}
              <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                {!locked && (
                  <Button theme="solid" type="primary" loading={saving} onClick={save}>
                    {isNew ? s.create : s.save}
                  </Button>
                )}
                {!isNew && !locked && (
                  <Button theme="light" icon={<IconCopy />} onClick={startClone}>{s.clone}</Button>
                )}
                {locked && (
                  <Button theme="light" icon={<IconCopy />} onClick={startClone}>{s.clone}</Button>
                )}
                {!isNew && !locked && (
                  memberCount > 0 ? (
                    <Button theme="borderless" type="danger" icon={<IconDelete />} disabled title={s.delHasMembers}>{s.del}</Button>
                  ) : (
                    <Popconfirm title={s.delConfirm} onConfirm={remove} okType="danger">
                      <Button theme="borderless" type="danger" icon={<IconDelete />} loading={deleting}>{s.del}</Button>
                    </Popconfirm>
                  )
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
