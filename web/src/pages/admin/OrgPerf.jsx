// 组织绩效（后台，负责人 2026-10-10）：一级部门负责人不走个人绩效，用组织绩效。
//   页签「部门互评」：按季度开一轮互评（草稿 → 开放 → 结束），看各负责人的提交情况、提醒未提交的人、退回已提交的答卷，
//                    看各被评部门三个维度的平均分与「最需解决的卡点」（匿名：不显示谁评了谁），可导出 CSV。
//   建轮时可设「卡点题必填」（轮次级，默认关，开放前可改；负责人 10/10）：打开后负责人给某部门打了分就必须写卡点。没打分的部门 = 跳过。
//   页签「季度结果」：HR 导入每季度各一级部门的组织绩效评级（预览 → 确认），同时写进当时负责人本人的绩效档案；看近 4 个季度。
// 接口：/api/admin/orgperf/*（绩效读 = 查看，绩效写 = 操作；数据范围受限的角色只读）。维度与规则见 modules/performance/orgperf.js。
import { useUrlState } from '../../urlstate.js';
import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Button, Tag, Modal, Input, TextArea, Select, Empty, Spin, Banner, Typography, Toast, Popconfirm, DatePicker, Checkbox, Switch } from '@douyinfe/semi-ui';
import { api, useAsync } from '../../api.js';
import DataTable from '../../components/DataTable.jsx';
import { useI18n } from '../../i18n.jsx';
import { useAuth } from '../../auth.jsx';
import { canWriteDomain } from '../../rbac.js';

const { Text } = Typography;

const T = {
  zh: {
    title: '组织绩效', lead: '一级部门负责人的绩效按组织绩效评定：部门互评在系统里完成，季度结果由 HR 导入并写进负责人的绩效档案。',
    tabPeer: '部门互评', tabResults: '季度结果', loadFail: '加载失败，请刷新页面重试。', ro: '只读：你的角色可以查看、不能操作。',
    newRound: '新建互评', colQuarter: '季度', colName: '名称', colStatus: '状态', colProgress: '已提交', colDue: '截止日期', colOps: '',
    stDraft: '草稿', stOpen: '进行中', stClosed: '已结束', none: '还没有互评。', open: '查看',
    fQuarter: '季度（如 2026-Q3）', fName: '名称（选填）', fDue: '截止日期（选填）', create: '创建', cancel: '取消', created: '已创建草稿',
    fIssueReq: '卡点题必填', fIssueReqHint: '打开后，负责人给某个部门打了分就必须填写「最需解决的卡点」；没打分的部门按跳过处理，不受影响。默认选填，开放前可改。',
    issueReqTag: (on) => (on ? '卡点题：必填' : '卡点题：选填'), issueReqSaved: '已更新卡点题设置',
    back: '返回列表', actOpen: '开放互评', actClose: '结束互评', actDelete: '删除草稿', actRemind: '提醒未提交的人', actExport: '导出 CSV',
    askOpen: '开放后，系统按当前组织快照把每个一级部门的负责人设为评分人，并通知他们。确认开放？', askClose: '结束后负责人不能再填写或修改。确认结束？', askDelete: '删除这个草稿？',
    actPublish: '发布结果', askPublish: '发布后，各一级部门负责人可以在员工端看到本部门的互评得分（各维度平均与总平均，不受评分部门数量限制）和匿名卡点，并收到通知。发布后不能撤回。确认发布？', publishedOk: '已发布并通知负责人',
    publishedAt: (d) => `结果已于 ${d} 发布，负责人可查看本部门得分。`, notPublished: '结果尚未发布，负责人还看不到本部门得分。核对无误后点「发布结果」。',
    opened: '已开放并通知负责人', closedOk: '已结束', deleted: '已删除', reminded: (n, k) => `已提醒 ${n} 人${k ? `；另有 ${k} 人 1 小时内已提醒过（含开放时的通知），本次跳过` : ''}`, returned: '已退回，负责人可修改后重新提交',
    raters: '评分人（一级部门负责人）', rDept: '一级部门', rName: '负责人', rState: '状态', rSubmitted: '已提交', rPending: '未提交', rReturn: '退回', askReturn: '退回后该负责人可以修改并重新提交。确认退回？',
    sum: '被评部门汇总', sumLead: '只计已提交的答卷；跳过或选「不适用」的不进平均，也不算有效评分部门。不显示评分部门与评分人。', sDept: '被评部门', sRaters: '有效评分部门', sOverall: '总平均', sIssues: '卡点', viewIssues: (n) => `查看 ${n} 条`, issuesTitle: (d) => `${d} · 最需解决的卡点`, noIssues: '没有填写。',
    qPick: '季度', noResults: '还没有导入任何季度结果。', resDept: '一级部门', resRating: '组织绩效评级', resHod: '负责人（写入档案）', resNote: '备注', trend: '近 4 个季度',
    impTitle: '导入季度结果', impLead: '每行一个一级部门：部门名称, 评级, 备注（备注选填；逗号或 Tab 分隔，可直接从表格复制）。导入后写进当时负责人本人的绩效档案；再次导入同一季度时，只更新这次出现的部门，其余部门保留原评级。',
    impQuarter: '季度（如 2026-Q3）', impPh: 'Marketing Department, A\nLegal and Compliance Department, B+, 跨部门响应改善', preview: '预览', confirmImp: '确认导入', imported: (n, r) => `已导入 ${n} 个部门，写入档案 ${r} 条`,
    ownHidden: '本部门不足 3 个评分部门，对你隐藏', keptNote: (list) => `本季度已导入、这次没有出现的部门保留原评级：${list}`,
    pLine: '行', pDept: '填写的部门', pMatched: '对应一级部门', pRating: '评级', pPrev: '原评级', pHod: '负责人', pErr: '问题',
    errs: { unknown_dept: '找不到这个一级部门', bad_rating: '评级不在评级选项里', duplicate: '同一部门重复' }, noHod: '无负责人，不写档案',
  },
  en: {
    title: 'Organisational Performance', lead: 'Heads of top-level departments are assessed on organisational performance: department peer reviews happen here, and HR imports each quarter\'s results, which are also written to each head\'s performance record.',
    tabPeer: 'Department peer review', tabResults: 'Quarterly results', loadFail: 'Couldn’t load. Refresh the page to try again.', ro: 'Read-only: your role can view but not change this.',
    newRound: 'New peer review', colQuarter: 'Quarter', colName: 'Name', colStatus: 'Status', colProgress: 'Submitted', colDue: 'Due', colOps: '',
    stDraft: 'Draft', stOpen: 'Open', stClosed: 'Closed', none: 'No peer reviews yet.', open: 'View',
    fQuarter: 'Quarter (e.g. 2026-Q3)', fName: 'Name (optional)', fDue: 'Due date (optional)', create: 'Create', cancel: 'Cancel', created: 'Draft created',
    fIssueReq: 'Blocker question required', fIssueReqHint: 'When on, a head who scores a department must also write its blocker. Departments left unscored are skipped and not affected. Optional by default; can be changed until the review opens.',
    issueReqTag: (on) => (on ? 'Blocker: required' : 'Blocker: optional'), issueReqSaved: 'Blocker setting updated',
    back: 'Back to list', actOpen: 'Open the review', actClose: 'Close the review', actDelete: 'Delete draft', actRemind: 'Remind those not submitted', actExport: 'Export CSV',
    askOpen: 'Opening sets each top-level department\'s current head as a rater (from the current org snapshot) and notifies them. Open it?', askClose: 'After closing, heads can no longer fill in or change answers. Close it?', askDelete: 'Delete this draft?',
    actPublish: 'Publish results', askPublish: 'Once published, each head of department can see their department\'s peer review scores (dimension and overall averages, shown whatever the number of rating departments) and the anonymous blockers, and is notified. This cannot be undone. Publish?', publishedOk: 'Published and heads notified',
    publishedAt: (d) => `Results published on ${d}; heads can see their department's scores.`, notPublished: 'Results not published yet; heads cannot see their department\'s scores. Check them, then select Publish results.',
    opened: 'Opened and heads notified', closedOk: 'Closed', deleted: 'Deleted', reminded: (n, k) => `Reminded ${n} ${n === 1 ? 'person' : 'people'}${k ? `; ${k} reminded within the last hour (including the notice sent when it opened) ${k === 1 ? 'was' : 'were'} skipped` : ''}`, returned: 'Returned; the head can change and resubmit',
    raters: 'Raters (heads of top-level departments)', rDept: 'Department', rName: 'Head', rState: 'Status', rSubmitted: 'Submitted', rPending: 'Not submitted', rReturn: 'Return', askReturn: 'The head will be able to change and resubmit. Return it?',
    sum: 'Rated departments', sumLead: 'Submitted answers only; skipped and N/A scores are left out of averages and do not count as rating departments. Rating departments and raters are never shown.', sDept: 'Rated department', sRaters: 'Rating departments', sOverall: 'Overall', sIssues: 'Blockers', viewIssues: (n) => `View ${n}`, issuesTitle: (d) => `${d} · blockers to fix`, noIssues: 'None written.',
    qPick: 'Quarter', noResults: 'No quarterly results imported yet.', resDept: 'Department', resRating: 'Org rating', resHod: 'Head (record written)', resNote: 'Note', trend: 'Last 4 quarters',
    impTitle: 'Import quarterly results', impLead: 'One top-level department per line: department name, rating, note (note optional; comma- or tab-separated, paste straight from a spreadsheet). Results are written to the current head\'s performance record; re-importing a quarter updates only the departments in that batch; the others keep their rating.',
    impQuarter: 'Quarter (e.g. 2026-Q3)', impPh: 'Marketing Department, A\nLegal and Compliance Department, B+, faster cross-team response', preview: 'Preview', confirmImp: 'Import', imported: (n, r) => `Imported ${n} departments; ${r} records written`,
    ownHidden: 'Your department: fewer than 3 rating departments, hidden from you', keptNote: (list) => `Departments already imported for this quarter and not in this batch keep their rating: ${list}`,
    pLine: 'Line', pDept: 'Entered', pMatched: 'Matched department', pRating: 'Rating', pPrev: 'Previous', pHod: 'Head', pErr: 'Problem',
    errs: { unknown_dept: 'No such top-level department', bad_rating: 'Not a rating option', duplicate: 'Department repeated' }, noHod: 'No head; no record written',
  },
};

const errMsg = (lang, e) => (e && e.data && (lang === 'zh' ? e.data.error_zh || e.data.error : e.data.error)) || (e && e.message) || '';

function PeerTab({ s, lang, canWrite }) {
  const [sp] = useSearchParams();
  const [, patchUrl] = useUrlState();
  const roundId = sp.get('round');
  const setRound = (id) => patchUrl({ round: id || null }, { push: false });
  const listQ = useAsync(() => api.get('/api/admin/orgperf/rounds'), []);
  const oneQ = useAsync(() => (roundId ? api.get(`/api/admin/orgperf/rounds/${encodeURIComponent(roundId)}`) : Promise.resolve(null)), [roundId]);
  const [form, setForm] = useState(null);
  const [issues, setIssues] = useState(null);
  const stText = (st) => (st === 'open' ? <Tag color="green" type="light">{s.stOpen}</Tag> : st === 'closed' ? <Tag type="light">{s.stClosed}</Tag> : <Tag color="grey" type="light">{s.stDraft}</Tag>);
  const run = async (fn, ok) => { try { const r = await fn(); if (ok) Toast.success(typeof ok === 'function' ? ok(r) : ok); listQ.reload(); oneQ.reload(); return r; } catch (e) { Toast.error(errMsg(lang, e)); return null; } };
  const create = async () => {
    const r = await run(() => api.post('/api/admin/orgperf/rounds', { quarter: (form.quarter || '').trim(), name: (form.name || '').trim() || undefined, dueOn: form.dueOn || undefined, issueRequired: !!form.issueRequired }), s.created);
    if (r && r.round) { setForm(null); setRound(r.round.id); }
  };
  if (listQ.loading) return <Spin />;
  if (listQ.error) return <Banner type="danger" fullMode={false} closeIcon={null} description={s.loadFail} />;
  const rounds = (listQ.data && listQ.data.rounds) || [];
  const r = oneQ.data && oneQ.data.round;
  if (roundId && r) {
    const dims = r.dims || [];
    return (
      <div className="op-detail">
        <div className="rvc-filters">
          <Button theme="borderless" onClick={() => setRound(null)}>{s.back}</Button>
          <b>{r.name}</b>{stText(r.status)}<Text type="tertiary" className="tnum">{r.quarter}{r.dueOn ? ` · ${s.colDue} ${r.dueOn}` : ''}</Text>
          <Tag type="light" color={r.issueRequired ? 'orange' : 'grey'}>{s.issueReqTag(r.issueRequired)}</Tag>
          {canWrite && r.status === 'draft' && (
            <label className="op-switch"><Switch size="small" checked={!!r.issueRequired} onChange={(v) => run(() => api.put(`/api/admin/orgperf/rounds/${r.id}`, { issueRequired: v }), s.issueReqSaved)} aria-label={s.fIssueReq} /><Text size="small">{s.fIssueReq}</Text></label>
          )}
        </div>
        {r.status === 'draft' && <div className="tset-lead">{s.fIssueReqHint}</div>}
        {canWrite && (
          <div className="rvc-filters">
            {r.status === 'draft' && <Popconfirm title={s.actOpen} content={s.askOpen} onConfirm={() => run(() => api.put(`/api/admin/orgperf/rounds/${r.id}`, { action: 'open' }), s.opened)}><Button theme="solid" type="primary">{s.actOpen}</Button></Popconfirm>}
            {r.status === 'draft' && <Popconfirm title={s.actDelete} content={s.askDelete} onConfirm={async () => { const x = await run(() => api.del(`/api/admin/orgperf/rounds/${r.id}`), s.deleted); if (x) setRound(null); }}><Button type="danger">{s.actDelete}</Button></Popconfirm>}
            {r.status === 'open' && <Button onClick={() => run(() => api.post(`/api/admin/orgperf/rounds/${r.id}/remind`, {}), (x) => s.reminded(x.reminded, x.skipped || 0))}>{s.actRemind}</Button>}
            {r.status === 'open' && <Popconfirm title={s.actClose} content={s.askClose} onConfirm={() => run(() => api.put(`/api/admin/orgperf/rounds/${r.id}`, { action: 'close' }), s.closedOk)}><Button>{s.actClose}</Button></Popconfirm>}
            {/* 负责人 10/12：结束后另行发布，被评部门负责人才看到本部门得分 */}
            {r.status === 'closed' && !r.publishedAt && <Popconfirm title={s.actPublish} content={s.askPublish} onConfirm={() => run(() => api.put(`/api/admin/orgperf/rounds/${r.id}`, { action: 'publish' }), s.publishedOk)}><Button theme="solid" type="primary">{s.actPublish}</Button></Popconfirm>}
          </div>
        )}
        {r.status === 'closed' && <div className="tset-lead">{r.publishedAt ? s.publishedAt(String(r.publishedAt).slice(0, 10)) : s.notPublished}</div>}
        {r.status !== 'draft' && (
          <div className="rvc-filters">
            <Button theme="borderless" onClick={() => { window.location.href = `/api/admin/orgperf/rounds/${encodeURIComponent(r.id)}/export.csv`; }}>{s.actExport}</Button>
          </div>
        )}
        {r.status !== 'draft' && (
          <>
            <div className="rvc-sub">{s.raters} · <span className="tnum">{r.submittedCount} / {r.raterCount}</span></div>
            <DataTable rowKey="dept1Id" titleKey="dept1" opsKey="op" size="small" pagination={false} dataSource={r.raters || []}
              columns={[
                { title: s.rDept, dataIndex: 'dept1', width: 240 },
                { title: s.rName, dataIndex: 'name', width: 160, render: (v) => v || '—' },
                { title: s.rState, dataIndex: 'submittedAt', width: 130, render: (v) => (v ? <Tag color="green" type="light">{s.rSubmitted}</Tag> : <Tag type="light">{s.rPending}</Tag>) },
                ...(canWrite && r.status === 'open' ? [{ title: '', dataIndex: 'op', width: 100, render: (_, x) => (x.submittedAt ? <Popconfirm title={s.rReturn} content={s.askReturn} onConfirm={() => run(() => api.post(`/api/admin/orgperf/rounds/${r.id}/return`, { dept1Id: x.dept1Id }), s.returned)}><Button size="small" theme="borderless">{s.rReturn}</Button></Popconfirm> : null) }] : []),
              ]} />
            <div className="rvc-sub">{s.sum}</div>
            <div className="tset-lead">{s.sumLead}</div>
            <DataTable rowKey="dept1Id" titleKey="dept1" size="small" pagination={false} dataSource={r.summary || []}
              columns={[
                { title: s.sDept, dataIndex: 'dept1', width: 240 },
                { title: s.sRaters, dataIndex: 'raters', width: 110, render: (v, x) => (x.hidden ? <Tag size="small" type="light">{s.ownHidden}</Tag> : <span className="tnum">{v}</span>) },
                ...dims.map((d) => ({ title: lang === 'zh' ? d.zh : d.en, dataIndex: 'd_' + d.key, width: 130, render: (_, x) => <span className="tnum">{x.dims[d.key] && x.dims[d.key].avg != null ? x.dims[d.key].avg : '—'}</span> })),
                { title: s.sOverall, dataIndex: 'overall', width: 100, render: (v) => <b className="tnum">{v == null ? '—' : v}</b> },
                { title: s.sIssues, dataIndex: 'issues', width: 110, render: (v, x) => (v && v.length ? <button type="button" className="u-num-link" onClick={() => setIssues(x)}>{s.viewIssues(v.length)}</button> : <Text type="quaternary">—</Text>) },
              ]} />
          </>
        )}
        <Modal visible={!!issues} title={issues ? s.issuesTitle(issues.dept1) : ''} footer={null} onCancel={() => setIssues(null)} width="min(720px, calc(100vw - 24px))">
          {issues && (issues.issues.length ? <ol className="op-issues">{issues.issues.map((t, k) => <li key={k}>{t}</li>)}</ol> : <Text type="tertiary">{s.noIssues}</Text>)}
        </Modal>
      </div>
    );
  }
  return (
    <div>
      {canWrite && <div className="rvc-filters"><Button theme="solid" type="primary" onClick={() => setForm({ quarter: '', name: '', dueOn: '', issueRequired: false })}>{s.newRound}</Button></div>}
      {rounds.length === 0 ? <Empty description={s.none} style={{ padding: 30 }} /> : (
        <DataTable rowKey="id" titleKey="name" opsKey="op" size="small" pagination={false} dataSource={rounds}
          columns={[
            { title: s.colQuarter, dataIndex: 'quarter', width: 110, render: (v) => <span className="tnum">{v}</span> },
            { title: s.colName, dataIndex: 'name', width: 260 },
            { title: s.colStatus, dataIndex: 'status', width: 110, render: stText },
            { title: s.colProgress, dataIndex: 'submittedCount', width: 110, render: (v, x) => (x.status === 'draft' ? '—' : <span className="tnum">{v} / {x.raterCount}</span>) },
            { title: s.colDue, dataIndex: 'dueOn', width: 120, render: (v) => <span className="tnum">{v || '—'}</span> },
            { title: s.colOps, dataIndex: 'op', width: 90, render: (_, x) => <Button size="small" theme="borderless" onClick={() => setRound(x.id)}>{s.open}</Button> },
          ]} />
      )}
      <Modal visible={!!form} title={s.newRound} onCancel={() => setForm(null)} onOk={create} okText={s.create} cancelText={s.cancel}>
        {form && (
          <div className="op-form">
            <Input value={form.quarter} onChange={(v) => setForm({ ...form, quarter: v })} placeholder={s.fQuarter} />
            <Input value={form.name} onChange={(v) => setForm({ ...form, name: v })} placeholder={s.fName} />
            <DatePicker value={form.dueOn || undefined} onChange={(_d, str) => setForm({ ...form, dueOn: str || '' })} placeholder={s.fDue} style={{ width: '100%' }} />
            <Checkbox checked={!!form.issueRequired} onChange={(e) => setForm({ ...form, issueRequired: e.target.checked })}>{s.fIssueReq}</Checkbox>
            <Text type="tertiary" size="small">{s.fIssueReqHint}</Text>
          </div>
        )}
      </Modal>
    </div>
  );
}

// 「部门, 评级, 备注」逐行解析（逗号或 Tab；备注里可以再有逗号）
export function parseResultLines(text) {
  return String(text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((l) => {
    const parts = l.includes('\t') ? l.split('\t') : l.split(',');
    return { dept: (parts[0] || '').trim(), rating: (parts[1] || '').trim(), note: parts.slice(2).join(l.includes('\t') ? '\t' : ',').trim() };
  });
}

function ResultsTab({ s, lang, canWrite }) {
  const [quarter, setQuarter] = useState(null);
  const q = useAsync(() => api.get('/api/admin/orgperf/results' + (quarter ? `?quarter=${encodeURIComponent(quarter)}` : '')), [quarter]);
  const [impQ, setImpQ] = useState('');
  const [text, setText] = useState('');
  const [prev, setPrev] = useState(null);
  const d = q.data;
  const rows = useMemo(() => parseResultLines(text), [text]);
  const doPreview = async () => { try { setPrev(await api.post('/api/admin/orgperf/results/import', { quarter: impQ.trim(), rows, dryRun: true })); } catch (e) { Toast.error(errMsg(lang, e)); } };
  const doImport = async () => {
    try {
      const r = await api.post('/api/admin/orgperf/results/import', { quarter: impQ.trim(), rows });
      Toast.success(s.imported(r.written, r.records)); setPrev(null); setText(''); setQuarter(r.quarter); q.reload();
    } catch (e) { Toast.error(errMsg(lang, e)); if (e && e.data && e.data.rows) setPrev({ ...prev, rows: e.data.rows }); }
  };
  if (q.loading && !d) return <Spin />;
  if (q.error) return <Banner type="danger" fullMode={false} closeIcon={null} description={s.loadFail} />;
  return (
    <div>
      {d && d.quarters.length > 0 ? (
        <>
          <div className="rvc-filters">
            <Select value={d.quarter || undefined} onChange={setQuarter} insetLabel={s.qPick} style={{ width: 220 }} optionList={d.quarters.map((x) => ({ value: x, label: x }))} />
          </div>
          <DataTable rowKey="dept1Id" titleKey="dept1" size="small" pagination={false} dataSource={d.rows}
            columns={[
              { title: s.resDept, dataIndex: 'dept1', width: 240 },
              { title: s.resRating, dataIndex: 'rating', width: 130, render: (v) => <Tag color="indigo" type="light" shape="circle">{v}</Tag> },
              { title: s.resHod, dataIndex: 'hodName', width: 170, render: (v) => v || <Text type="tertiary" size="small">{s.noHod}</Text> },
              { title: s.resNote, dataIndex: 'note', width: 260, render: (v) => v || '—' },
            ]} />
          <div className="rvc-sub">{s.trend}</div>
          <DataTable rowKey="dept1Id" titleKey="dept1" size="small" pagination={false} dataSource={d.trend}
            columns={[{ title: s.resDept, dataIndex: 'dept1', width: 240 }, ...d.recent.map((x) => ({ title: x, dataIndex: 'q_' + x, width: 100, render: (_, r) => <span className="tnum">{r.byQuarter[x] || '—'}</span> }))]} />
        </>
      ) : <Empty description={s.noResults} style={{ padding: 24 }} />}
      {canWrite && (
        <div className="op-import">
          <div className="rvc-sub">{s.impTitle}</div>
          <div className="tset-lead">{s.impLead}</div>
          <Input value={impQ} onChange={(v) => { setImpQ(v); setPrev(null); }} placeholder={s.impQuarter} style={{ width: 220, marginBottom: 8 }} />
          <TextArea value={text} onChange={(v) => { setText(v); setPrev(null); }} rows={6} placeholder={s.impPh} />
          <div className="rvc-filters" style={{ marginTop: 8 }}>
            <Button onClick={doPreview} disabled={!rows.length || !impQ.trim()}>{s.preview}</Button>
            {prev && <Button theme="solid" type="primary" onClick={doImport} disabled={prev.bad > 0}>{s.confirmImp}</Button>}
          </div>
          {prev && Array.isArray(prev.kept) && prev.kept.length > 0 && <div className="tset-lead">{s.keptNote(prev.kept.map((x) => `${x.dept1} ${x.rating}`).join(lang === 'zh' ? '、' : ', '))}</div>}
          {prev && (
            <DataTable rowKey="line" titleKey="dept" size="small" pagination={false} dataSource={prev.rows}
              columns={[
                { title: s.pLine, dataIndex: 'line', width: 60 },
                { title: s.pDept, dataIndex: 'dept', width: 200 },
                { title: s.pMatched, dataIndex: 'dept1', width: 200, render: (v) => v || '—' },
                { title: s.pRating, dataIndex: 'rating', width: 80 },
                { title: s.pPrev, dataIndex: 'prev', width: 80, render: (v) => v || '—' },
                { title: s.pHod, dataIndex: 'hod', width: 150, render: (v) => v || <Text type="tertiary" size="small">{s.noHod}</Text> },
                { title: s.pErr, dataIndex: 'error', width: 180, render: (v) => (v ? <Text type="danger">{s.errs[v] || v}</Text> : '—') },
              ]} />
          )}
        </div>
      )}
    </div>
  );
}

export default function OrgPerf() {
  const { lang } = useI18n();
  const s = T[lang === 'zh' ? 'zh' : 'en'];
  const { user } = useAuth();
  const canWrite = canWriteDomain(user, 'performance');
  const [sp] = useSearchParams();
  const [, patchUrl] = useUrlState();
  const tab = sp.get('tab') === 'results' ? 'results' : 'peer';
  // 换页签时清掉轮次（与原来整串重建同效果）
  const setTab = (k) => patchUrl({ tab: k === 'results' ? 'results' : null, round: null }, { push: false });
  return (
    <div className="wrap tset-wrap op-wrap">
      {/* CX-085：标题与说明包一层，与其他页面同一结构（窄屏上下排列） */}
      <div className="tset-head">
        <div><h1 className="tset-title">{s.title}</h1><div className="tset-lead">{s.lead}</div></div>
      </div>
      {!canWrite && <div className="tset-foot">{s.ro}</div>}
      <div className="ptabs pd-tabs" role="tablist">
        {[['peer', s.tabPeer], ['results', s.tabResults]].map(([k, label]) => (
          <button key={k} type="button" role="tab" aria-selected={tab === k} className={'pd-tab' + (tab === k ? ' on' : '')} onClick={() => setTab(k)}>{label}</button>
        ))}
      </div>
      {tab === 'peer' ? <PeerTab s={s} lang={lang} canWrite={canWrite} /> : <ResultsTab s={s} lang={lang} canWrite={canWrite} />}
    </div>
  );
}
