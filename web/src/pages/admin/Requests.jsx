import { useMedia } from '../../useMedia.js';
import { useEffect, useMemo, useState } from 'react';
import { Table, Button, Toast, Typography, Empty, Popconfirm, Modal, TextArea, Banner, Spin, Tag } from '@douyinfe/semi-ui';
import { IconTick, IconClose } from '@douyinfe/semi-icons';
import { api, useAsync } from '../../api.js';
import { useAuth } from '../../auth.jsx';
import { useI18n } from '../../i18n.jsx';
import { PAGE_TIERS, DEFAULT_PAGE, useDataVersion, clampPage } from '../../pagesize.js';
import { resizableTable } from '../../cardify.js';
import { dataTableColumns } from '../../components/DataTable.jsx';   // 一致性整改 2
import { canUseAction } from '../../rbac.js';
import { BULK_SEL_EXTRA, useBulkSelection, BulkBar, BulkConfirmModal, useBulkRunner } from '../../components/BulkActions.jsx';
import DeptFilter, { deptFilterInvalidText } from '../../components/DeptFilter.jsx';
import { useDeptTree, deptMatcher } from '../../deptfilter.js';
import { useUrlState } from '../../urlstate.js';

const { Text } = Typography;
// Stable fallback while a list is loading or failed: useBulkSelection needs a
// referentially stable `rows`, and a fresh [] each render would read as new data.
const NONE = [];

// Unified approvals center: elective-course requests AND project nominations,
// one entrance (both ride the same approvals engine).
const T = {
  zh: {
    title: '申请审批', lead: '统一审批选修课程申请与发展项目申请。通过后自动生效，驳回时可附理由。',
    secEnroll: '选修课程申请', secNom: '发展项目申请',
    segEnroll: '选修课程', segNom: '发展项目', pending: '待审',
    colEmp: '员工', colDept: '部门', colProgram: '课程', colProject: '发展项目', colCohort: '期次',
    colNote: '申请说明', colTime: '提交时间',
    approve: '通过', reject: '驳回',
    approveEnroll: (n, p) => `通过 ${n} 的选修课程申请《${p}》？将自动为其指派该课程。`,
    approveNom: (n, p) => `通过 ${n} 的发展项目申请《${p}》？将自动加入期次并指派发展项目内的课程。`,
    rejectTitle: '驳回申请', rejectPh: '驳回理由（可选，员工可见）', rejectPhReq: '驳回理由（必填，员工可见）', rejectOk: '确认驳回', cancel: '取消',
    approved: '已通过', rejected: '已驳回', empty: '暂无待审批的申请', loadFail: '加载失败，请刷新页面重试。', none: '—',
    noteNone: '无', totalText: (n) => `共 ${n} 条`,
    overCapTitle: '超出期次容量', overCapOk: '仍然通过',
    overCapAsk: (cap, cur) => `该期次容量 ${cap} 人，已满（${cur} 人）。通过这条申请会超出容量，仍要继续吗？`,
    // 只读档(learning=read)的说明:写接口服务端一律 403,按钮留着就是「假按钮」。
    roWrite: '只读权限：当前角色对培训只能查看、不能修改，写操作不可用；如需操作请联系超级管理员调整授权。',
    // 批量审批（2026-10-06 SPEC-bulk-ops B1）：驳回理由必填，所选申请共用一条
    bulkApprove: '批量通过', bulkReject: '批量驳回',
    bulkRejectPh: '驳回理由（必填，员工可见；所选申请共用这一条）',
    bulkApproveNoteEnroll: '通过后将自动为申请人指派对应课程。',
    bulkApproveNoteNom: '通过后自动加入期次并指派发展项目内的课程；期次已满的会在结果中列出。',
    forceApprove: (n) => `仍然通过超出容量的 ${n} 条`,
    nameEnroll: (n, id, p) => `${n}（${id}）·《${p}》`,
    nameNom: (n, id, p) => `${n}（${id}）·《${p}》`,
    // 部门筛选（第二批 3.1）：两张表共用一个
    deptLabel: '部门', deptAll: '全部部门',
    deptShown: (n, total) => `当前部门 ${n} 条，共 ${total} 条待审`,
    emptyDept: '所选部门没有待审批的申请',
  },
  en: {
    title: 'Application Approvals', lead: 'Approve elective course applications and development program applications in one place. Approvals take effect automatically; rejections can include a reason.',
    secEnroll: 'Elective Course Applications', secNom: 'Development Program Applications',
    segEnroll: 'Electives', segNom: 'Development Programs', pending: 'Pending',
    colEmp: 'Employee', colDept: 'Department', colProgram: 'Course', colProject: 'Development Program', colCohort: 'Cohort',
    colNote: 'Reason for Applying', colTime: 'Submitted',
    approve: 'Approve', reject: 'Reject',
    approveEnroll: (n, p) => `Approve ${n}’s application for “${p}”? The course will be assigned automatically.`,
    approveNom: (n, p) => `Approve ${n}’s application for “${p}”? They will join the cohort and get the program’s courses assigned.`,
    rejectTitle: 'Reject application', rejectPh: 'Reason (optional, shown to the employee)', rejectPhReq: 'Reason (required, shown to the employee)', rejectOk: 'Reject', cancel: 'Cancel',
    approved: 'Approved', rejected: 'Rejected', empty: 'No applications awaiting approval', loadFail: 'Couldn’t load. Refresh the page to try again.', none: '—',
    noteNone: 'None', totalText: (n) => `${n} total`,
    overCapTitle: 'Over cohort capacity', overCapOk: 'Approve anyway',
    overCapAsk: (cap, cur) => `This cohort holds ${cap} people and is full (${cur}). Approving this application will exceed the capacity. Continue?`,
    roWrite: 'Read-only: your role can view training but not change it, so the write actions are unavailable. Ask a super-admin to widen the grant.',
    bulkApprove: 'Approve selected', bulkReject: 'Reject selected',
    bulkRejectPh: 'Reason (required, shown to the employee; used for every selected application)',
    bulkApproveNoteEnroll: 'Approved applicants get the course assigned automatically.',
    bulkApproveNoteNom: 'Approved applicants join the cohort and get the program’s courses assigned; any that would exceed a cohort’s capacity are listed in the result.',
    forceApprove: (n) => `Approve the ${n} over-capacity application${n === 1 ? '' : 's'} anyway`,
    nameEnroll: (n, id, p) => `${n} (${id}) · “${p}”`,
    nameNom: (n, id, p) => `${n} (${id}) · “${p}”`,
    deptLabel: 'Department', deptAll: 'All departments',
    deptShown: (n, total) => `${n} in this department · ${total} pending in total`,
    emptyDept: 'No applications awaiting approval in the selected department',
  },
};

/* The phone shows one list at a time behind a segmented switch instead of both
   tables stacked, so the breakpoint has to be readable from JS. Same query and
   shape as OrgChart.jsx / Dashboard.jsx, and the same 900px the admin tables
   turn into card lists at (app.css). */
const NARROW_Q = '(max-width:900px)';
const useNarrow = () => useMedia(NARROW_Q);

// Submitted-at as "08-16 14:22": a pending queue never holds anything old
// enough for the year to matter, and toLocaleString() spent the column on it.
const p2 = (n) => String(n).padStart(2, '0');
function fmtSubmitted(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso).slice(0, 16).replace('T', ' ');
  return `${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
}

export default function Requests() {
  const { lang, loc } = useI18n();
  const s = T[lang];
  // 两个审批动作都是培训域写(矩阵 5193 enroll-requests/:id/decide、5573
  // nominations/:id/decide),与本页同域 —— manage 档照旧,只读档整列收起。
  const { user } = useAuth();
  const canWrite = canUseAction(user, { domain: 'learning', module: 'learning', write: true });
  const enrollQ = useAsync(() => api.get('/api/admin/enroll-requests'), []);
  const nomQ = useAsync(() => api.get('/api/admin/nominations'), []);
  const [busy, setBusy] = useState(null);
  const [rejectRow, setRejectRow] = useState(null); // { row, kind }
  const [rejectNote, setRejectNote] = useState('');
  const narrow = useNarrow();
  const [seg, setSeg] = useState('enroll'); // phone only — which of the two lists is on screen
  // 部门筛选（第二批 3.1）：两张表上方共用一个 DeptFilter，按行的 department（申请人部门原文）在前端过滤，含全部下级；
  // 值写进地址栏 ?dept=。待审数、批量勾选、批量确认窗都只算筛选后的行（看到的就是要处理的）。
  const [urlp, patchUrl] = useUrlState();
  const fDept = urlp.dept || null;
  const tree = useDeptTree();
  const deptOk = useMemo(() => deptMatcher(tree, fDept), [tree, fDept]);
  const onDeptInvalid = () => { Toast.warning(deptFilterInvalidText(lang)); patchUrl({ dept: null }); };
  const enrollRows = useMemo(() => {
    const all = enrollQ.data || NONE;
    return fDept ? all.filter((r) => deptOk(r.department)) : all;
  }, [enrollQ.data, fDept, deptOk]);
  const nomRows = useMemo(() => {
    const all = nomQ.data || NONE;
    return fDept ? all.filter((r) => deptOk(r.department)) : all;
  }, [nomQ.data, fDept, deptOk]);
  const enrollN = enrollRows.length;
  const nomN = nomRows.length;
  const allN = (enrollQ.data || NONE).length + (nomQ.data || NONE).length;

  // Every hook for the two sections lives here, at the top level: section() is
  // called conditionally on phones (only the visible segment), so a hook inside
  // it would change the hook order whenever HR flips the switch.
  // Page and page size survive a reload (spec rule 6): each fresh list bumps the
  // version, the table remounts under that key and reopens on the remembered
  // page, clamped in case the list got shorter (same wiring as Questions.jsx).
  const [enrollPage, setEnrollPage] = useState(1);
  const [enrollSize, setEnrollSize] = useState(DEFAULT_PAGE);
  const [nomPage, setNomPage] = useState(1);
  const [nomSize, setNomSize] = useState(DEFAULT_PAGE);
  const enrollVer = useDataVersion(enrollQ.data);
  const nomVer = useDataVersion(nomQ.data);
  // Bulk selection, one per table. `ready` keeps the selection through a failed
  // reload (useAsync sets data to null on error); decided rows drop out of the
  // selection once the reloaded list no longer has them.
  const enrollSel = useBulkSelection({ rows: enrollRows, ready: !!enrollQ.data, resetOn: [fDept] });
  const nomSel = useBulkSelection({ rows: nomRows, ready: !!nomQ.data, resetOn: [fDept] });
  const runner = useBulkRunner();
  // The confirm dialog. `bulk` keeps its content while the dialog animates
  // closed; `bulkOpen` drives visibility. Ids and labels are snapshotted when
  // the dialog opens, so what HR reads is exactly what is submitted.
  const [bulk, setBulk] = useState(null); // { kind: 'enroll'|'nom', decision, ids, names, nameMap }
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkNote, setBulkNote] = useState('');

  const decide = async (row, kind, decision, note, force) => {
    setBusy(row.id);
    try {
      const path = kind === 'nom' ? `/api/admin/nominations/${row.id}/decide` : `/api/admin/enroll-requests/${row.id}/decide`;
      await api.post(path, { decision, note: note || '', ...(force ? { force: true } : {}) });
      Toast.success(decision === 'approve' ? s.approved : s.rejected);
      enrollQ.reload(); nomQ.reload();
      window.dispatchEvent(new Event('tms:pending-changed'));   // CX-151：侧栏角标随之刷新
    } catch (e) {
      // Approving into a full cohort is refused server-side — let HR override
      // deliberately rather than leaving them stuck.
      const d = e && e.data;
      if (e && e.status === 409 && d && d.code === 'over_capacity') {
        Modal.confirm({
          title: s.overCapTitle,
          content: s.overCapAsk(d.capacity, d.current),
          okText: s.overCapOk, cancelText: s.cancel,
          onOk: () => decide(row, kind, decision, note, true),
        });
      } else {
        Toast.error((lang === 'zh' && d && d.error_zh) || e.message);   // CX-119
        // CX-197：已被别人处理（already_decided）时刷新列表，那一行不再留着「通过 / 驳回」
        if (d && d.code === 'already_decided') { enrollQ.reload(); nomQ.reload(); window.dispatchEvent(new Event('tms:pending-changed')); }
      }
    } finally {
      setBusy(null); setRejectRow(null); setRejectNote('');
    }
  };

  /* ---- bulk approve / reject (SPEC-bulk-ops B1) ----
     Each item goes through the same server path as a single decision (same
     assignment, notification and audit row). The confirm dialog lists the
     selection in on-screen order: rows on the current page in their DOM order
     first, then the rest in list order (the tables are unsorted, so list order
     is page order). Ids are submitted in that same order, so the result list and
     a "selected item #N" error line up with what the dialog showed. */
  const openBulk = (kind, decision) => {
    const sel = kind === 'nom' ? nomSel : enrollSel;
    const rows = kind === 'nom' ? nomRows : enrollRows;
    const dataAt = new Map(rows.map((r, i) => [String(r.id), i]));
    const domAt = new Map();
    const el = sel.wrapRef.current;
    if (el) el.querySelectorAll('tbody tr[data-row-key]').forEach((tr) => {
      const k = tr.getAttribute('data-row-key');
      if (!domAt.has(k)) domAt.set(k, domAt.size);
    });
    const rank = (m, k) => (m.has(k) ? m.get(k) : Infinity);
    const ids = sel.keys.map(String).filter((k) => dataAt.has(k))
      .sort((a, b) => (rank(domAt, a) - rank(domAt, b)) || (dataAt.get(a) - dataAt.get(b)) || 0);
    if (!ids.length) return;
    const label = (r) => (kind === 'nom'
      ? s.nameNom(r.name, r.employeeId, loc(r, 'project') || r.project)
      : s.nameEnroll(r.name, r.employeeId, loc(r, 'program') || r.program));
    const names = ids.map((k) => label(rows[dataAt.get(k)]));
    const nameMap = {};
    ids.forEach((k, i) => { nameMap[k] = names[i]; });
    setBulk({ kind, decision, ids, names, nameMap });
    setBulkNote('');
    setBulkOpen(true);
  };
  const closeBulk = () => { if (!runner.busy) { setBulkOpen(false); setBulkNote(''); } };

  const runBulk = async () => {
    if (!bulk || runner.busy) return;
    const { kind, decision, ids, nameMap } = bulk;
    // Bulk reject needs a reason (the server answers note_required otherwise);
    // the note is sent as typed, the same value a single rejection stores.
    if (decision === 'reject' && !bulkNote.trim()) return;
    const sel = kind === 'nom' ? nomSel : enrollSel;
    const url = kind === 'nom' ? '/api/admin/nominations/bulk-decide' : '/api/admin/enroll-requests/bulk-decide';
    const outcome = await runner.run({
      op: decision === 'approve' ? s.approve : s.reject,
      names: nameMap,
      request: () => api.post(url, { ids, decision, note: decision === 'reject' ? bulkNote : '' }),
      onSettled: () => { sel.clear(); enrollQ.reload(); nomQ.reload(); window.dispatchEvent(new Event('tms:pending-changed')); },   // CX-151
      // A full cohort refuses the approvals that would overfill it, item by item.
      // The result dialog then offers to approve exactly those anyway — the bulk
      // form of the single 409 over_capacity → 仍然通过 prompt.
      followUp: kind === 'nom' && decision === 'approve'
        ? (resp) => {
          const over = ((resp && resp.results) || []).filter((x) => x && !x.ok && x.code === 'over_capacity').map((x) => x.id);
          return over.length
            ? { label: s.forceApprove(over.length), request: () => api.post(url, { ids: over, decision: 'approve', force: true }) }
            : null;
        }
        : undefined,
    });
    // A whole-batch error (out of scope, rolled back, …) changes nothing: keep the
    // dialog and the typed reason so HR can retry or cancel.
    if (outcome !== 'error') { setBulkOpen(false); setBulkNote(''); }
  };

  const empCol = { title: s.colEmp, dataIndex: 'name', width: 190, render: (v, r) => (
    <div><div className="emp-name">{v}</div><Text type="tertiary" size="small" className="tnum">{r.employeeId}</Text></div>
  ) };
  // No header on the action column (design 17 L26/L59): the two buttons name
  // themselves, and an empty title also keeps the phone card from growing an
  // "操作:" label line.
  const actionCol = (kind, approveText) => ({
    title: '', dataIndex: 'op', width: 200, render: (_, r) => (
      <div style={{ display: 'flex', gap: 8 }}>
        <Popconfirm title={s.approve} content={approveText(r)} okText={s.approve} cancelText={s.cancel} onConfirm={() => decide(r, kind, 'approve')}>
          <Button theme="solid" type="primary" size="small" icon={<IconTick />} loading={busy === r.id}>{s.approve}</Button>
        </Popconfirm>
        <Button theme="borderless" type="danger" size="small" icon={<IconClose />} onClick={() => { setRejectRow({ row: r, kind }); setRejectNote(''); }}>{s.reject}</Button>
      </div>
    ),
  });

  // A plain function, NOT a component. Defined in the component body it closes
  // over busy / rejectRow / narrow / seg / s / loc / decide, so hoisting it out
  // would mean threading six props through; but used as <Section/> it was a new
  // component TYPE on every render, so React unmounted both tables on every
  // setState — page reset to 1, dragged column widths back to default, and the
  // reject dialog remounting on each keystroke. Calling it returns the same JSX
  // without ever becoming an element type.
  // `paging` = { ver, page, size, setPage, setSize } and `sel` come from the
  // top-level hooks above; this function only reads them.
  // `rows` = this table's rows after the department filter (the whole list when no filter is set).
  const section = ({ kind, title, q, rows, columns, sel, paging }) => {
    const hiddenByDept = !!fDept && rows.length === 0 && (q.data || NONE).length > 0;
    return (
      <div style={{ marginBottom: 26 }}>
        {/* The phone's segmented switch already carries both names and counts. */}
        {!narrow && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '0 0 10px' }}>
            <b style={{ fontSize: 15 }}>{title}</b>
            <Tag color={rows.length ? 'red' : 'grey'} type="light" shape="circle">{s.pending} {rows.length}</Tag>
          </div>
        )}
        {q.error && <Banner type="danger" closeIcon={null} description={`${s.loadFail} · ${q.error.message}`} />}
        {/* Spinner on the first load only. A reload keeps the table mounted (with
            its loading veil) so the page and the selection stay where they were. */}
        {q.loading && !q.data ? (
          <div style={{ padding: 24, textAlign: 'center' }}><Spin /></div>
        ) : rows.length === 0 ? (
          <Empty description={hiddenByDept ? s.emptyDept : s.empty} style={{ padding: '20px 0' }} />
        ) : (
          <>
            {/* Read-only roles get no checkboxes and no bar. On a phone the table
                header (and its select-all box) is hidden, so the bar offers
                "select this page" even before anything is selected. */}
            {canWrite && (
              <BulkBar count={sel.count} onClear={sel.clear} busy={runner.busy} selectPage={sel.togglePage}>
                <Button theme="solid" type="primary" size="small" icon={<IconTick />} disabled={runner.busy}
                  onClick={() => openBulk(kind, 'approve')}>{s.bulkApprove}</Button>
                <Button type="danger" size="small" icon={<IconClose />} disabled={runner.busy}
                  onClick={() => openBulk(kind, 'reject')}>{s.bulkReject}</Button>
              </BulkBar>
            )}
            <div ref={sel.wrapRef}>
              {/* Pagination stays put at three rows: the per-page tiers and the 共 N 条
                  total are how HR reads the size of the queue (design 17 L45-52). */}
              <Table key={paging.ver} rowKey="id" {...resizableTable(dataTableColumns(columns, { titleKey: 'name', opsKey: 'op' }), { extra: canWrite ? BULK_SEL_EXTRA : 0 })}
                dataSource={rows} loading={q.loading}
                rowSelection={canWrite ? sel.rowSelection : undefined}
                pagination={{
                  pageSize: paging.size, defaultCurrentPage: clampPage(paging.page, rows.length, paging.size),
                  onPageChange: paging.setPage, onPageSizeChange: paging.setSize,
                  pageSizeOpts: PAGE_TIERS, showSizeChanger: true, formatPageText: () => s.totalText(rows.length),
                }} />
            </div>
          </>
        )}
      </div>
    );
  };

  return (
    <div className="wrap emp-wrap">
      <div className="emp-head">
        <div>
          <h1 className="emp-title">
            {s.title}
            {narrow && !!(enrollN + nomN) && <span className="req-total tnum">{enrollN + nomN}</span>}
          </h1>
          <div className="emp-lead">{s.lead}</div>
          {!canWrite && <div className="emp-lead" style={{ color: 'var(--semi-color-text-2)' }}>{s.roWrite}</div>}
        </div>
      </div>

      {/* 部门筛选（第二批 3.1）：两张表共用，选上级即含全部下级。筛选中时在行尾说明当前部门几条、总共几条待审。 */}
      <div className="u-filterbar">
        <DeptFilter options={tree ? tree.options : NONE} value={fDept} onChange={(v) => patchUrl({ dept: v || null })}
          lang={lang} label={s.deptLabel} placeholder={s.deptAll} ready={!!tree} disabled={tree === null}
          showNone={!!(tree && tree.hasNone)} onInvalid={onDeptInvalid} />
        {fDept && <span className="u-count u-filterbar-end">{s.deptShown(enrollN + nomN, allN)}</span>}
      </div>

      {/* Phone: one list at a time. Both counts stay visible on the switch, so
          nothing is hidden behind a tap. */}
      {narrow && (
        <div className="ml-filters req-seg" role="group" aria-label={s.title}>
          {[['enroll', s.segEnroll, enrollN], ['nom', s.segNom, nomN]].map(([key, label, n]) => (
            <button key={key} type="button" aria-pressed={seg === key}
              className={'ml-chip' + (seg === key ? ' active' : '')} onClick={() => setSeg(key)}>
              {label}<span className="ml-chip-n tnum">{n}</span>
            </button>
          ))}
        </div>
      )}

      {(!narrow || seg === 'enroll') && section({
        kind: 'enroll', title: s.secEnroll, q: enrollQ, rows: enrollRows, sel: enrollSel,
        paging: { ver: enrollVer, page: enrollPage, size: enrollSize, setPage: setEnrollPage, setSize: setEnrollSize },
        columns: [
          empCol,
          { title: s.colDept, dataIndex: 'department', width: 120, render: (v) => v || s.none },
          { title: s.colProgram, dataIndex: 'program', width: 200, render: (v, r) => loc(r, 'program') || v },
          { title: s.colNote, dataIndex: 'note', width: 180, render: (v) => v || <Text type="quaternary">{s.noteNone}</Text> },
          { title: s.colTime, dataIndex: 'requestedAt', width: 120, render: (v) => <span className="tnum">{fmtSubmitted(v) || s.none}</span> },
          ...(canWrite ? [actionCol('enroll', (r) => s.approveEnroll(r.name, loc(r, 'program') || r.program))] : []),
        ],
      })}

      {/* No note column here: the applicant's own words already sit on the
          project's 提名审批 tab, and the design keeps this table to five. */}
      {(!narrow || seg === 'nom') && section({
        kind: 'nom', title: s.secNom, q: nomQ, rows: nomRows, sel: nomSel,
        paging: { ver: nomVer, page: nomPage, size: nomSize, setPage: setNomPage, setSize: setNomSize },
        columns: [
          empCol,
          { title: s.colDept, dataIndex: 'department', width: 120, render: (v) => v || s.none },
          { title: s.colProject, dataIndex: 'project', width: 240, render: (v, r) => loc(r, 'project') || v },
          { title: s.colCohort, dataIndex: 'cohort', width: 140, render: (v) => v || s.none },
          { title: s.colTime, dataIndex: 'requestedAt', width: 120, render: (v) => <span className="tnum">{fmtSubmitted(v) || s.none}</span> },
          ...(canWrite ? [actionCol('nom', (r) => s.approveNom(r.name, loc(r, 'project') || r.project))] : []),
        ],
      })}

      <Modal
        title={s.rejectTitle}
        visible={!!rejectRow}
        onCancel={() => { setRejectRow(null); setRejectNote(''); }}
        onOk={() => decide(rejectRow.row, rejectRow.kind, 'reject', rejectNote)}
        okText={s.rejectOk}
        cancelText={s.cancel}
        okButtonProps={{ type: 'danger', disabled: !!rejectRow && rejectRow.kind === 'nom' && !rejectNote.trim() }}   /* CX-113：发展项目申请驳回理由必填（选修课报名单条驳回仍可不填） */
        confirmLoading={!!rejectRow && busy === rejectRow.row.id}
      >
        <TextArea value={rejectNote} onChange={setRejectNote} placeholder={rejectRow && rejectRow.kind === 'nom' ? s.rejectPhReq : s.rejectPh} rows={3} maxLength={500} />
      </Modal>

      {/* Bulk confirm: "将对 N 项执行「…」" + the first five names (BulkConfirmModal).
          Rejecting needs the shared reason before OK enables. */}
      {canWrite && bulk && (
        <BulkConfirmModal
          visible={bulkOpen}
          op={bulk.decision === 'approve' ? s.approve : s.reject}
          names={bulk.names}
          danger={bulk.decision === 'reject'}
          okDisabled={bulk.decision === 'reject' && !bulkNote.trim()}
          loading={runner.busy}
          onOk={runBulk}
          onCancel={closeBulk}
        >
          {bulk.decision === 'reject' ? (
            <div style={{ marginTop: 12 }}>
              <TextArea value={bulkNote} onChange={setBulkNote} placeholder={s.bulkRejectPh} aria-label={s.bulkRejectPh}
                rows={3} maxLength={500} />
            </div>
          ) : (
            <div style={{ marginTop: 12 }}>
              <Text type="secondary">{bulk.kind === 'nom' ? s.bulkApproveNoteNom : s.bulkApproveNoteEnroll}</Text>
            </div>
          )}
        </BulkConfirmModal>
      )}
      {runner.modal}
    </div>
  );
}
