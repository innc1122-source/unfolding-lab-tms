// HRBP 分工（第二批 2.8，2026-10-08；设计 appeal-design §2、§8.5，负责人 10/8 决定）
//   /admin/hrbp-coverage[?q=&uncovered=1] —— 仅超级管理员（rbac.js domain:'roles'；服务端非超管一律 403 super_admin_only）。
// 部门 → HRBP 是独立设置、不是角色：一个账号仍只有一个后台角色；HRBP 只能看、只能处理所负责部门员工的绩效申诉，
// 指定向下覆盖下级部门，下级部门另有指定时以下级为准（最近的已指定上级生效），利益相关的申诉自动回避。
// 数据：GET /api/admin/review-appeals/coverage；保存：PUT 同一地址，{ deptId, userIds }（按部门）或 { userId, deptIds }（按人）。
// 负责人原则：设置是短操作，用弹窗；页面本身是两个分节（SettingsWorkspace），不用抽屉。
// 审查意见：未覆盖部门红色提示；名称重复的部门（ambiguousNames）与名称未匹配的人员（unmatched）若服务端给出就提示；
// 调整分工会让「处理中」的申诉需要转交时，保存前提示条数（hrbps[].handling 若服务端给出）。
import { useMemo, useState } from 'react';
import {
  Button, Input, Select, Switch, Tag, Toast, Banner, Spin, Empty, Modal, TreeSelect, Tooltip,
} from '@douyinfe/semi-ui';
import { IconSearch, IconRefresh, IconPlus } from '@douyinfe/semi-icons';
import { api, useAsync } from '../../api.js';
import { useAuth } from '../../auth.jsx';
import { useI18n } from '../../i18n.jsx';
import { isSuperAdmin } from '../../rbac.js';
import { SettingsWorkspace } from '../../v2.jsx';
import { useUrlState } from '../../urlstate.js';
// CX-047（2026-10-10）：角色名按界面语言（roleName_zh 缺省回退英文名）
let ROLE_LANG = 'zh';
const roleOf = (x) => (ROLE_LANG === 'zh' ? (x.roleName_zh || x.roleName) : (x.roleName || x.roleName_zh)) || '';

const T = {
  zh: {
    title: 'HRBP 分工',
    lead: '为每个部门指定负责的 HRBP。指定后自动覆盖下级部门；下级部门另有指定时以下级为准。HRBP 只能查看和处理所负责部门员工的绩效申诉，利益相关的申诉自动回避。',
    notSuper: '只有超级管理员可以查看和修改 HRBP 分工。', loadFail: '加载失败，请刷新页面重试。', refresh: '刷新',
    uncovered: (n, m) => `有 ${n} 个部门（共 ${m} 人）没有指定 HRBP（只计有员工的部门）。这些员工的申诉将交由拥有绩效管理权限的管理员处理。`,
    noDeptOnly: (m) => `有 ${m} 名员工未归入部门，没有对应的 HRBP。他们的申诉将交由拥有绩效管理权限的管理员处理。`,
    uncoveredOnly: '只看未覆盖',
    ineffTitle: '以下指定当前未生效：',
    ineff: (n, issue, dept) => `${n}：${issue}，对 ${dept} 的指定未生效。`,
    issue: { inactive: '账号已停用', exited: '已离职', no_console: '没有后台角色', system: '系统账号' },
    orphanTitle: '指向已不存在部门的指定',
    orphanRow: (id, names) => `部门编号 ${id}：${names}`, orphanClear: '清除',
    ambiguous: (list) => `以下部门名称在部门表中出现不止一次，员工的申诉无法按部门确定 HRBP，将交由拥有绩效管理权限的管理员处理：${list}`,
    unmatched: (m, list) => `有 ${m} 名员工的部门名称与部门表不一致（${list}），他们的申诉将交由拥有绩效管理权限的管理员处理。`,
    secDept: '按部门', secHrbp: '按 HRBP',
    searchPh: '搜索部门名称', count: (n) => `${n} 个部门`,
    cDept: '部门', cPeople: '人数（本部门 / 含下级）', cAssigned: '指定的 HRBP', cEffect: '生效', cAct: '操作',
    inactiveDept: '已停用', groupNode: '分组', expand: '展开', collapse: '收起',
    inherited: (p) => `继承自 ${p}`, notCovered: '未覆盖', noDept: '未归入部门', edit: '设置',
    deptModalT: (d) => `设置「${d}」的 HRBP`, pick: 'HRBP', pickPh: '按姓名或工号搜索', max5: '每个部门最多指定 5 名 HRBP。',
    leaveEmpty: '不选则该部门沿用上级部门的 HRBP。',
    outsideScope: (n) => `${n}：该部门不在此账号的数据范围内；申诉处理不受影响，但该 HRBP 在其他后台页面看不到这些员工。`,
    staleWarn: (n) => `该调整将使 ${n} 条处理中的申诉需要转交。`,
    roleHint: 'HRBP 须持有后台角色。若该账号只负责申诉，可授予一个最小权限的后台角色（注意：任何后台角色都能打开发展项目与活动的附件）。',
    save: '保存', cancel: '取消', saved: '已保存', notEffective: '未生效',
    hrbpHead: (n) => `${n} 名 HRBP`, addHrbp: '添加 HRBP', direct: '直接负责', coveredPeople: '覆盖人数', openAppeals: '待处理申诉',
    editDepts: '调整负责部门', none: '无', noHrbps: '还没有指定任何 HRBP。',
    userModalT: (n) => `调整 ${n} 负责的部门`, addModalT: '添加 HRBP', person: '人员', personPh: '选择人员', depts: '负责的部门', deptsPh: '选择部门',
    deptsHint: '选上级部门即覆盖其全部下级部门（下级部门另有指定的除外）。已停用的部门不能新增。',
    candEmpty: '没有可指定的人员：须为在职、拥有后台角色的账号。',
    err: {
      super_admin_only: '只有超级管理员可以修改 HRBP 分工。', bad_body: '提交的内容不完整，请刷新后重试。', dept_not_found: '未找到该部门。',
      dept_inactive: '已停用的部门不能新增 HRBP。', hrbp_not_eligible: '只能指定在职、拥有后台角色的账号。', too_many_hrbps: '每个部门最多指定 5 名 HRBP。',
    },
  },
  en: {
    title: 'HRBP Coverage',
    lead: 'Assign HRBPs to departments. An assignment also covers sub-departments unless a sub-department has its own. HRBPs can see and handle performance appeals only from the departments they cover; appeals where they have a conflict of interest are excluded automatically.',
    notSuper: 'Only the super admin can view and change HRBP coverage.', loadFail: 'Couldn’t load. Refresh the page to try again.', refresh: 'Refresh',
    uncovered: (n, m) => `${n} department${n === 1 ? '' : 's'} with employees (${m} people) have no HRBP. Appeals from these employees go to administrators with performance management access.`,
    noDeptOnly: (m) => `${m} employee${m === 1 ? ' is' : 's are'} not assigned to a department and have no HRBP. Their appeals go to administrators with performance management access.`,
    uncoveredOnly: 'Uncovered only',
    ineffTitle: 'These assignments are not in effect:',
    ineff: (n, issue, dept) => `${n}: ${issue}; the assignment to ${dept} is not in effect.`,
    issue: { inactive: 'Account deactivated', exited: 'Exited', no_console: 'No console role', system: 'System account' },
    orphanTitle: 'Assignments to departments that no longer exist',
    orphanRow: (id, names) => `Department ID ${id}: ${names}`, orphanClear: 'Remove',
    ambiguous: (list) => `These department names appear more than once in the department list, so appeals from their employees cannot be matched to an HRBP and go to administrators with performance management access: ${list}`,
    unmatched: (m, list) => `${m} employee${m === 1 ? '' : 's'} have a department name that does not match the department list (${list}). Their appeals go to administrators with performance management access.`,
    secDept: 'By department', secHrbp: 'By HRBP',
    searchPh: 'Search departments', count: (n) => `${n} department${n === 1 ? '' : 's'}`,
    cDept: 'Department', cPeople: 'People (direct / incl. sub)', cAssigned: 'Assigned HRBPs', cEffect: 'In effect', cAct: 'Action',
    inactiveDept: 'Inactive', groupNode: 'Group', expand: 'Expand', collapse: 'Collapse',
    inherited: (p) => `Inherited from ${p}`, notCovered: 'Not covered', noDept: 'No department', edit: 'Edit',
    deptModalT: (d) => `Set HRBPs for ${d}`, pick: 'HRBPs', pickPh: 'Search by name or employee ID', max5: 'A department can have at most 5 HRBPs.',
    leaveEmpty: 'Leave empty to use the parent department’s HRBP.',
    outsideScope: (n) => `${n}: this department is outside the account’s data scope. Appeal handling is not affected, but the HRBP cannot see these employees on other console pages.`,
    staleWarn: (n) => `This change leaves ${n} appeal${n === 1 ? '' : 's'} in progress that need reassignment.`,
    roleHint: 'An HRBP needs a console role. If the account only handles appeals, give it a minimal console role (note: any console role can open program and activity attachments).',
    save: 'Save', cancel: 'Cancel', saved: 'Saved', notEffective: 'Not in effect',
    hrbpHead: (n) => `${n} HRBP${n === 1 ? '' : 's'}`, addHrbp: 'Add HRBP', direct: 'Directly assigned', coveredPeople: 'People covered', openAppeals: 'Open appeals',
    editDepts: 'Edit departments', none: 'None', noHrbps: 'No HRBP has been assigned yet.',
    userModalT: (n) => `Edit departments for ${n}`, addModalT: 'Add HRBP', person: 'Person', personPh: 'Select a person', depts: 'Departments covered', deptsPh: 'Select departments',
    deptsHint: 'Selecting a department covers all of its sub-departments, except those with their own HRBP. You cannot add a deactivated department.',
    candEmpty: 'No one can be assigned: the account must be active and hold a console role.',
    err: {
      super_admin_only: 'Only the super-admin can change HRBP coverage.', bad_body: 'The request was incomplete. Refresh and try again.', dept_not_found: 'Department not found.',
      dept_inactive: 'You cannot add an HRBP to a deactivated department.', hrbp_not_eligible: 'Only active employees with a console role can be assigned.', too_many_hrbps: 'A department can have at most 5 HRBPs.',
    },
  },
};

const MAX_HRBPS = 5;
const errOf = (s, err) => {
  const code = err && err.data && err.data.code;
  return (code && s.err[code]) || (err && err.message) || '';
};
const joinNames = (lang, list) => list.filter(Boolean).join(lang === 'zh' ? '、' : ', ');
const issueText = (s, lang, issues) => joinNames(lang, (Array.isArray(issues) ? issues : []).map((k) => s.issue[k] || k));
// 候选人的数据范围：服务端给 scopeDeptIds（null = 全公司）或 outsideScopeDeptIds（已知在范围外的部门）
function outsideScope(person, deptId) {
  if (!person) return false;
  if (Array.isArray(person.outsideScopeDeptIds) && person.outsideScopeDeptIds.includes(deptId)) return true;
  if (Array.isArray(person.scopeDeptIds)) return !person.scopeDeptIds.includes(deptId);
  return false;
}

export default function HrbpCoverage() {
  const { lang } = useI18n();
  ROLE_LANG = lang;   // CX-047：roleOf 按当前语言
  const s = T[lang] || T.en;
  const { user } = useAuth();
  const allowed = isSuperAdmin(user);
  const [params, patch] = useUrlState();
  const q = useAsync(() => (allowed ? api.get('/api/admin/review-appeals/coverage') : Promise.resolve(null)), [allowed]);
  const [override, setOverride] = useState(null);
  const data = override || q.data;
  const reload = () => { setOverride(null); q.reload(); };
  const onSaved = (res) => { if (res && res.coverage) setOverride(res.coverage); else reload(); };

  if (!allowed) {
    return <div className="wrap hrbp-page"><h1 className="tset-title">{s.title}</h1><Banner type="warning" fullMode={false} closeIcon={null} description={s.notSuper} /></div>;
  }
  if (q.error && !override) return <div className="wrap hrbp-page"><h1 className="tset-title">{s.title}</h1><Banner type="danger" fullMode={false} closeIcon={null} description={`${s.loadFail} · ${q.error.message}`} /></div>;
  if (!data) return <div className="wrap hrbp-page"><div className="hrbp-loading"><Spin size="large" /></div></div>;
  return <CoverageBody s={s} lang={lang} data={data} params={params} patch={patch} onSaved={onSaved} reload={reload} />;
}

function CoverageBody({ s, lang, data, params, patch, onSaved, reload }) {
  const depts = useMemo(() => (Array.isArray(data.departments) ? data.departments : []), [data]);
  const hrbps = useMemo(() => (Array.isArray(data.hrbps) ? data.hrbps : []), [data]);
  const candidates = useMemo(() => (Array.isArray(data.candidates) ? data.candidates : []), [data]);
  const byId = useMemo(() => new Map(depts.map((d) => [String(d.id), d])), [depts]);
  const people = useMemo(() => {
    const m = new Map();
    for (const c of candidates) m.set(String(c.id), { ...c });
    for (const h of hrbps) m.set(String(h.id), { ...(m.get(String(h.id)) || {}), ...h });
    return m;
  }, [candidates, hrbps]);
  const uncovered = data.uncovered || { deptCount: 0, headcount: 0, deptIds: [] };
  const noDept = data.noDepartment || { headcount: 0 };
  const orphans = Array.isArray(data.orphans) ? data.orphans : [];
  const ambiguous = Array.isArray(data.ambiguousNames) ? data.ambiguousNames : [];
  const unmatched = data.unmatched && Number(data.unmatched.headcount) > 0 ? data.unmatched : null;
  const ineffective = [];
  for (const d of depts) for (const a of d.assigned || []) if (!a.effective) ineffective.push({ key: `${d.id}:${a.id}`, name: a.name, issues: a.issues, dept: d.name });

  const [deptEdit, setDeptEdit] = useState(null);   // department row
  const [userEdit, setUserEdit] = useState(null);   // { hrbp } | { add: true }
  const [busy, setBusy] = useState('');
  const put = async (body, key) => {
    setBusy(key || 'put');
    try {
      const res = await api.put('/api/admin/review-appeals/coverage', body);
      Toast.success(s.saved);
      onSaved(res);
      return true;
    } catch (err) {
      Toast.error(errOf(s, err) || s.loadFail);
      return false;
    } finally { setBusy(''); }
  };
  const noDeptUncovered = Number(noDept.headcount) > 0 && !noDept.cover;

  return (
    <div className="wrap hrbp-page">
      <div className="tset-head hrbp-head">
        <div><h1 className="tset-title">{s.title}</h1><div className="tset-lead">{s.lead}</div></div>
        <Button icon={<IconRefresh />} theme="borderless" aria-label={s.refresh} title={s.refresh} onClick={reload} />
      </div>
      {(Number(uncovered.deptCount) > 0 || noDeptUncovered) && (
        <Banner type="danger" fullMode={false} closeIcon={null} className="hrbp-banner"
          description={(
            <div className="hrbp-banner-row">
              <span>{Number(uncovered.deptCount) > 0
                ? s.uncovered(Number(uncovered.deptCount) || 0, (Number(uncovered.headcount) || 0) + (noDeptUncovered ? Number(noDept.headcount) || 0 : 0))
                : s.noDeptOnly(Number(noDept.headcount) || 0)}</span>
              {Number(uncovered.deptCount) > 0 && (
                <label className="hrbp-toggle"><Switch size="small" checked={params.uncovered === '1'} aria-label={s.uncoveredOnly}
                  onChange={(v) => patch({ uncovered: v ? '1' : null }, { push: false })} />{s.uncoveredOnly}</label>
              )}
            </div>
          )} />
      )}
      {ineffective.length > 0 && (
        <Banner type="warning" fullMode={false} closeIcon={null} className="hrbp-banner" description={(
          <div><div>{s.ineffTitle}</div><ul className="hrbp-list">{ineffective.map((x) => <li key={x.key}>{s.ineff(x.name, issueText(s, lang, x.issues), x.dept)}</li>)}</ul></div>
        )} />
      )}
      {ambiguous.length > 0 && <Banner type="warning" fullMode={false} closeIcon={null} className="hrbp-banner" description={s.ambiguous(joinNames(lang, ambiguous))} />}
      {unmatched && <Banner type="warning" fullMode={false} closeIcon={null} className="hrbp-banner" description={s.unmatched(Number(unmatched.headcount) || 0, joinNames(lang, Array.isArray(unmatched.names) ? unmatched.names.slice(0, 8) : []))} />}
      {orphans.length > 0 && (
        <Banner type="warning" fullMode={false} closeIcon={null} className="hrbp-banner" description={(
          <div>
            <div>{s.orphanTitle}</div>
            <ul className="hrbp-list">
              {orphans.map((o) => (
                <li key={o.deptId} className="hrbp-orphan">
                  <span>{s.orphanRow(o.deptId, joinNames(lang, (o.userIds || []).map((id) => (people.get(String(id)) || {}).name || id)))}</span>
                  <Button size="small" theme="borderless" type="danger" loading={busy === 'orphan:' + o.deptId}
                    onClick={() => put({ deptId: o.deptId, userIds: [] }, 'orphan:' + o.deptId)}>{s.orphanClear}</Button>
                </li>
              ))}
            </ul>
          </div>
        )} />
      )}

      <SettingsWorkspace>
        <div className="ppl-card hrbp-sec" data-section={s.secDept}>
          <DeptTree s={s} lang={lang} depts={depts} byId={byId} noDept={noDept} params={params} patch={patch}
            uncoveredIds={new Set((uncovered.deptIds || []).map(String))} onEdit={setDeptEdit} />
        </div>
        <div className="ppl-card hrbp-sec" data-section={s.secHrbp}>
          <HrbpList s={s} lang={lang} hrbps={hrbps} onEdit={(h) => setUserEdit({ hrbp: h })} onAdd={() => setUserEdit({ add: true })} />
        </div>
      </SettingsWorkspace>

      {deptEdit && (
        <DeptModal s={s} lang={lang} dept={deptEdit} people={people} candidates={candidates} hrbps={hrbps} busy={busy === 'dept'}
          onCancel={() => setDeptEdit(null)}
          onSave={async (userIds) => { if (await put({ deptId: deptEdit.id, userIds }, 'dept')) setDeptEdit(null); }} />
      )}
      {userEdit && (
        <UserModal s={s} lang={lang} edit={userEdit} depts={depts} byId={byId} people={people} candidates={candidates} hrbps={hrbps} busy={busy === 'user'}
          onCancel={() => setUserEdit(null)}
          onSave={async (userId, deptIds) => { if (await put({ userId, deptIds }, 'user')) setUserEdit(null); }} />
      )}
    </div>
  );
}

function AssignedTags({ s, lang, list }) {
  const arr = Array.isArray(list) ? list : [];
  if (!arr.length) return <span className="u-hint">—</span>;
  return (
    <span className="u-tag-wrap hrbp-tags">
      {arr.map((a) => (a.effective === false ? (
        <Tooltip key={a.id} content={issueText(s, lang, a.issues) || s.notEffective}>
          <Tag size="small" type="light" color="grey" className="u-tag-gap hrbp-tag-off">{a.name}</Tag>
        </Tooltip>
      ) : <Tag key={a.id} size="small" type="light" color="violet" className="u-tag-gap">{a.name}</Tag>))}
    </span>
  );
}

function EffectCell({ s, lang, d }) {
  const c = d.cover;
  if (!c || !Array.isArray(c.hrbps) || !c.hrbps.length) return <span className="hrbp-uncovered">{s.notCovered}</span>;
  const names = joinNames(lang, c.hrbps.map((h) => h.name));
  if (c.inherited) return <span className="hrbp-inherit"><span>{names}</span><span className="u-hint">{s.inherited(c.fromDeptName || '—')}</span></span>;
  return <span>{names}</span>;
}

function DeptTree({ s, lang, depts, byId, noDept, params, patch, uncoveredIds, onEdit }) {
  const query = params.q ? String(params.q) : '';
  const onlyUncovered = params.uncovered === '1';
  // 树：按原始 parentId（与服务端解析同一口径）；根 = parentId 为空或不在表里
  const kids = useMemo(() => {
    const m = new Map();
    for (const d of depts) {
      const p = d.parentId && byId.has(String(d.parentId)) ? String(d.parentId) : '';
      if (!m.has(p)) m.set(p, []);
      m.get(p).push(d);
    }
    for (const list of m.values()) list.sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
    return m;
  }, [depts, byId]);
  const [open, setOpen] = useState(() => new Set((kids.get('') || []).map((d) => String(d.id))));
  const toggle = (id) => setOpen((o) => { const n = new Set(o); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const flatMode = !!(query.trim() || onlyUncovered);
  const rows = useMemo(() => {
    if (flatMode) {
      const qq = query.trim().toLowerCase();
      return depts
        .filter((d) => (!onlyUncovered || uncoveredIds.has(String(d.id))))   // CX-132：与横幅同一口径
        .filter((d) => !qq || String(d.name || '').toLowerCase().includes(qq) || (Array.isArray(d.path) && d.path.join(' ').toLowerCase().includes(qq)))
        .map((d) => ({ d, depth: 0 }));
    }
    const out = [];
    const seen = new Set();
    const walk = (pid, depth) => {
      for (const d of kids.get(pid) || []) {
        const id = String(d.id);
        if (seen.has(id)) continue;
        seen.add(id);
        out.push({ d, depth });
        if (open.has(id)) walk(id, depth + 1);
      }
    };
    walk('', 0);
    return out;
  }, [flatMode, query, onlyUncovered, depts, kids, open, uncoveredIds]);
  return (
    <>
      <div className="u-filterbar">
        <Input prefix={<IconSearch />} showClear placeholder={s.searchPh} value={query} className="rap-search" aria-label={s.searchPh}
          onChange={(v) => patch({ q: v || null }, { push: false })} />
        <span className="u-count">{s.count(flatMode ? rows.length : depts.length)}</span>   {/* CX-132：树视图写部门总数，不写当前展开的行数 */}
      </div>
      <div className="hrbp-tree" role="table" aria-label={s.secDept}>
        <div className="hrbp-row hrbp-row-h" role="row">
          <span role="columnheader">{s.cDept}</span><span role="columnheader">{s.cPeople}</span><span role="columnheader">{s.cAssigned}</span>
          <span role="columnheader">{s.cEffect}</span><span role="columnheader">{s.cAct}</span>
        </div>
        {rows.length === 0 && <Empty description={s.none} />}
        {rows.map(({ d, depth }) => {
          const id = String(d.id);
          const has = (kids.get(id) || []).length > 0;
          const path = Array.isArray(d.path) && d.path.length > 1 ? d.path.slice(0, -1).join(' / ') : '';
          return (
            <div className={'hrbp-row' + (d.active === false ? ' is-off' : '')} role="row" key={id}>
              <span role="cell" className="hrbp-c-dept" data-label={s.cDept}>
                <span className="hrbp-dept" style={{ paddingLeft: flatMode ? 0 : depth * 18 }}>
                  {!flatMode && (has ? (
                    <button type="button" className="hrbp-caret" aria-expanded={open.has(id)} aria-label={open.has(id) ? s.collapse : s.expand} onClick={() => toggle(id)}>
                      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6" /></svg>
                    </button>
                  ) : <span className="hrbp-caret-sp" />)}
                  <span className="hrbp-dept-t">
                    {path ? <span className={'u-hint hrbp-path' + (!flatMode && depth > 0 ? ' is-tree' : '')}>{path}</span> : null}
                    <span className="u-tag-wrap"><b>{d.name}</b>
                      {d.active === false && <Tag size="small" type="light" color="grey" className="u-tag-gap">{s.inactiveDept}</Tag>}
                      {d.group && <Tag size="small" type="light" color="blue" className="u-tag-gap">{s.groupNode}</Tag>}
                    </span>
                  </span>
                </span>
              </span>
              <span role="cell" className="tnum" data-label={s.cPeople}>{Number(d.headcount) || 0} / {Number(d.subtreeHeadcount) || 0}</span>
              <span role="cell" data-label={s.cAssigned}><AssignedTags s={s} lang={lang} list={d.assigned} /></span>
              <span role="cell" data-label={s.cEffect}><EffectCell s={s} lang={lang} d={d} /></span>
              <span role="cell" className="hrbp-c-act"><Button size="small" theme="light" onClick={() => onEdit(d)}>{s.edit}</Button></span>
            </div>
          );
        })}
        {!flatMode && Number(noDept.headcount) > 0 && (
          <div className="hrbp-row is-pseudo" role="row">
            <span role="cell" className="hrbp-c-dept" data-label={s.cDept}><span className="hrbp-dept"><span className="hrbp-caret-sp" /><b>{s.noDept}</b></span></span>
            <span role="cell" className="tnum" data-label={s.cPeople}>{Number(noDept.headcount) || 0}</span>
            <span role="cell" data-label={s.cAssigned}><span className="u-hint">—</span></span>
            <span role="cell" data-label={s.cEffect}>{noDept.cover && Array.isArray(noDept.cover.hrbps) && noDept.cover.hrbps.length
              ? joinNames(lang, noDept.cover.hrbps.map((h) => h.name)) : <span className="hrbp-uncovered">{s.notCovered}</span>}</span>
            <span role="cell" className="hrbp-c-act" />
          </div>
        )}
      </div>
    </>
  );
}

function HrbpList({ s, lang, hrbps, onEdit, onAdd }) {
  return (
    <>
      <div className="ppl-sec-h hrbp-sec-h">
        <div><h2>{s.hrbpHead(hrbps.length)}</h2></div>
        <Button icon={<IconPlus />} theme="light" type="primary" onClick={onAdd}>{s.addHrbp}</Button>
      </div>
      <div className="u-hint hrbp-rolehint">{s.roleHint}</div>
      {!hrbps.length ? <Empty description={s.noHrbps} /> : (
        <div className="hrbp-cards">
          {hrbps.map((h) => (
            <div key={h.id} className={'hrbp-card' + (h.effective === false ? ' is-off' : '')}>
              <div className="hrbp-card-h">
                <div className="hrbp-card-id">
                  <b>{h.name}</b>
                  <span className="u-hint tnum">{[h.employeeId, roleOf(h)].filter(Boolean).join(' · ')}</span>
                </div>
                {h.effective === false && <Tag size="small" type="light" color="red">{s.notEffective}{h.issues && h.issues.length ? ` · ${issueText(s, lang, h.issues)}` : ''}</Tag>}
              </div>
              <dl className="hrbp-kv">
                <dt>{s.direct}</dt>
                <dd>{(h.depts || []).length ? (
                  <span className="u-tag-wrap">{h.depts.map((d) => <Tag key={d.id} size="small" type="light" color="violet" className="u-tag-gap">{d.name}</Tag>)}</span>
                ) : <span className="u-hint">{s.none}</span>}</dd>
                <dt>{s.coveredPeople}</dt><dd className="tnum">{Number(h.coveredHeadcount) || 0}</dd>
                <dt>{s.openAppeals}</dt><dd className="tnum">{Number(h.openAppeals) || 0}</dd>
              </dl>
              <Button size="small" theme="light" className="hrbp-card-act" onClick={() => onEdit(h)}>{s.editDepts}</Button>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

// 处理中的申诉在调整后需要转交的条数（服务端给 hrbps[].handling = [{ id, coverDeptId }] 时才算；没有就不提示）
function staleCount(hrbps, removed) {
  let n = 0;
  for (const [userId, deptIds] of removed) {
    const h = hrbps.find((x) => String(x.id) === String(userId));
    if (!h || !Array.isArray(h.handling)) continue;
    n += h.handling.filter((a) => deptIds.has(String(a.coverDeptId))).length;
  }
  return n;
}

function DeptModal({ s, lang, dept, people, candidates, hrbps, busy, onCancel, onSave }) {
  const initial = useMemo(() => (dept.assigned || []).map((a) => String(a.id)), [dept]);
  const [ids, setIds] = useState(initial);
  const options = useMemo(() => {
    const seen = new Set();
    const out = [];
    for (const c of candidates) {
      const id = String(c.id);
      if (seen.has(id)) continue;
      seen.add(id);
      const label = [c.name, c.employeeId, c.department, roleOf(c)].filter(Boolean).join(' · ');
      out.push({ value: id, label, search: `${c.name || ''} ${c.employeeId || ''}`.toLowerCase() });
    }
    // 已指定但不再合格的人（停用、离职、没有后台角色）：保留为选项，才能把他移除
    for (const a of dept.assigned || []) {
      const id = String(a.id);
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({ value: id, label: `${a.name}${a.employeeId ? ` · ${a.employeeId}` : ''} · ${issueText(s, lang, a.issues) || s.notEffective}`, search: `${a.name || ''} ${a.employeeId || ''}`.toLowerCase() });
    }
    return out;
  }, [candidates, dept, s, lang]);
  const added = ids.filter((id) => !initial.includes(id));
  const removedIds = initial.filter((id) => !ids.includes(id));
  const outside = ids.map((id) => people.get(id)).filter((p) => p && outsideScope(p, String(dept.id)));
  const stale = staleCount(hrbps, removedIds.map((id) => [id, new Set([String(dept.id)])]));
  const changed = added.length > 0 || removedIds.length > 0;
  return (
    <Modal visible title={s.deptModalT(dept.name)} width={560} maskClosable={false} onCancel={() => !busy && onCancel()}
      okText={s.save} cancelText={s.cancel} confirmLoading={busy} okButtonProps={{ disabled: !changed || ids.length > MAX_HRBPS }}
      onOk={() => onSave(ids)}>
      <div className="rap-field">
        <label className="rap-label" htmlFor="hrbp-pick">{s.pick}</label>
        <Select id="hrbp-pick" multiple value={ids} placeholder={s.pickPh} style={{ width: '100%' }} max={MAX_HRBPS}
          onExceed={() => Toast.info(s.max5)} onChange={(v) => setIds((Array.isArray(v) ? v : []).map(String))}
          optionList={options} emptyContent={s.candEmpty}
          filter={(input, opt) => String(opt.search || '').includes(String(input || '').trim().toLowerCase())} />
      </div>
      <div className="u-hint">{s.leaveEmpty}</div>
      <div className="u-hint">{s.max5}</div>
      {outside.length > 0 && <div className="hrbp-note">{outside.map((p) => <div key={p.id}>{s.outsideScope(p.name)}</div>)}</div>}
      {stale > 0 && <div className="hrbp-note hrbp-note-warn">{s.staleWarn(stale)}</div>}
    </Modal>
  );
}

function UserModal({ s, lang, edit, depts, byId, people, candidates, hrbps, busy, onCancel, onSave }) {
  const adding = !!edit.add;
  const [userId, setUserId] = useState(adding ? '' : String(edit.hrbp.id));
  const current = useMemo(() => {
    const h = hrbps.find((x) => String(x.id) === String(userId));
    return h && Array.isArray(h.depts) ? h.depts.map((d) => String(d.id)) : [];
  }, [hrbps, userId]);
  const [deptIds, setDeptIds] = useState(adding ? [] : current);
  const [touched, setTouched] = useState(false);
  const shownIds = touched ? deptIds : current;
  // 部门树（已停用的部门不可新选，已有的保留可见以便移除）
  const treeData = useMemo(() => {
    const nodes = new Map(depts.map((d) => [String(d.id), {
      label: d.active === false ? `${d.name} (${s.inactiveDept})` : d.name, value: String(d.id), key: String(d.id), children: [],
      disabled: d.active === false && !current.includes(String(d.id)),
    }]));
    const roots = [];
    for (const d of depts) {
      const n = nodes.get(String(d.id));
      const p = d.parentId ? nodes.get(String(d.parentId)) : null;
      if (p && p !== n) p.children.push(n); else roots.push(n);
    }
    const clean = (n, seen) => { if (seen.has(n.key)) return n; seen.add(n.key); if (!n.children.length) delete n.children; else n.children.forEach((c) => clean(c, seen)); return n; };
    const seen = new Set();
    roots.forEach((r) => clean(r, seen));
    return roots;
  }, [depts, current, s]);
  const hrbpIds = new Set(hrbps.map((h) => String(h.id)));
  const personOpts = candidates.filter((c) => !hrbpIds.has(String(c.id)))
    .map((c) => ({ value: String(c.id), label: [c.name, c.employeeId, c.department, roleOf(c)].filter(Boolean).join(' · ') }));
  const person = people.get(String(userId));
  const removed = current.filter((id) => !shownIds.includes(id));
  const stale = staleCount(hrbps, userId ? [[userId, new Set(removed)]] : []);
  const outside = person ? shownIds.filter((id) => outsideScope(person, id)).map((id) => (byId.get(id) || {}).name || id) : [];
  const changed = touched && (shownIds.length !== current.length || shownIds.some((id) => !current.includes(id)));
  const title = adding ? s.addModalT : s.userModalT(edit.hrbp.name);
  return (
    <Modal visible title={title} width={560} maskClosable={false} onCancel={() => !busy && onCancel()}
      okText={s.save} cancelText={s.cancel} confirmLoading={busy} okButtonProps={{ disabled: !userId || !changed }}
      onOk={() => onSave(userId, shownIds)}>
      {adding && (
        <div className="rap-field">
          <label className="rap-label" htmlFor="hrbp-person">{s.person}</label>
          {personOpts.length ? (
            <Select id="hrbp-person" filter value={userId || undefined} placeholder={s.personPh} style={{ width: '100%' }}
              onChange={(v) => { setUserId(v ? String(v) : ''); setDeptIds([]); setTouched(false); }} optionList={personOpts} />
          ) : <div className="u-hint">{s.candEmpty}</div>}
        </div>
      )}
      <div className="rap-field">
        <label className="rap-label" htmlFor="hrbp-depts">{s.depts}</label>
        <TreeSelect id="hrbp-depts" multiple checkRelation="unRelated" filterTreeNode showFilteredOnly treeData={treeData}
          value={shownIds} disabled={!userId} placeholder={s.deptsPh} maxTagCount={4} style={{ width: '100%' }}
          dropdownStyle={{ maxHeight: 360, overflow: 'auto' }}
          onChange={(v) => { setTouched(true); setDeptIds((Array.isArray(v) ? v : []).map(String)); }} />
      </div>
      <div className="u-hint">{s.deptsHint}</div>
      {outside.length > 0 && person && <div className="hrbp-note">{s.outsideScope(`${person.name} · ${joinNames(lang, outside)}`)}</div>}
      {stale > 0 && <div className="hrbp-note hrbp-note-warn">{s.staleWarn(stale)}</div>}
    </Modal>
  );
}
