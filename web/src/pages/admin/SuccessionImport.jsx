// 继任计划批量导入（第 5 批 8.2，设计 §9 / §10；2026-10-08）。整页：/admin/talent-review/succession-import（路由由 D 组在 App.jsx 登记）。
//
// 流程：下载模板 → 选择文件（浏览器端解析，successionImport.js）→ 服务端逐行校验并预览
//   POST /api/admin/succession/import/preview { rows } → { rows:[{line, action, codes:[{code,level}], positionName, employeeId, name, readiness, note}], summary, previewHash }
// → 「导入 N 行」确认弹窗（写明有错误、将跳过的行数）→ 一次提交、单事务写入
//   POST /api/admin/succession/import { rows, previewHash }
// 预览后数据有变化（409 preview_stale）时自动重新预览并请 HR 再确认；有范围外的行时服务端整批拒绝（404 out_of_scope），
// 页面在预览阶段就提示并停用导入按钮。两个接口都要 talent 写权限，只读档只显示说明。
// 只用现有 class 与 Semi 组件，不新增样式。
import { num } from '../../fmt.js';
import { useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button, Table, Tag, Toast, Banner, Spin, Modal, Typography } from '@douyinfe/semi-ui';
import { IconArrowLeft, IconUpload, IconExport, IconRefresh } from '@douyinfe/semi-icons';
import { api } from '../../api.js';
import { useAuth } from '../../auth.jsx';
import { useI18n } from '../../i18n.jsx';
import { canWriteDomain } from '../../rbac.js';
import { PAGE_TIERS, DEFAULT_PAGE } from '../../pagesize.js';
import { resizableTable } from '../../cardify.js';
import { errText } from '../../apierr.js';
import { useLeaveGuard, confirmLeave } from '../../components/useLeaveGuard.js';
import {
  succParseGrid, succSheetGrid, succSplitCsv, succPayloadRows, succCodeLevel, succSummary,
  SUCC_CODE_TEXT, SUCC_READINESS_TEXT,
} from './successionImport.js';

const { Text } = Typography;
const BACK_PATH = '/admin/talent-review';
const fmtN = (n) => num(n || 0);

/* ---------------- co-located bilingual strings ---------------- */
const T = {
  zh: {
    back: '返回人才盘点',
    title: '批量导入继任计划',
    sub: '按模板填写关键岗位、继任人工号与就绪度，预览核对后一次导入。',
    roHint: '你的角色对人才发展只有查看权限，不能导入继任计划。如需导入，请联系超级管理员调整权限。',
    step1: '选择文件',
    step1Lead: '下载模板并按「填写说明」页填写，然后上传。支持 .xlsx 与 .csv。',
    tmpl: '下载 Excel 模板',
    pick: '上传表格（.xlsx / .csv）',
    repick: '重新选择文件',
    limitHint: `每次最多 2,000 行。已有的「岗位 + 继任人」组合会更新就绪度和备注；备注留空时保留原备注。有错误的行不会导入。`,
    fileFail: '文件读取失败，请确认是 .xlsx 或 .csv 格式',
    empty: '文件里没有可导入的数据行',
    headerOk: (n) => `已识别表头 ${n} 列`,
    noHeader: '未识别到表头，按模板列序读取',
    rowsN: (n) => `${fmtN(n)} 行数据`,
    overCap: (n) => `文件有 ${fmtN(n)} 行数据，超过每次 2,000 行的上限。请拆分成多个文件分批导入。`,
    step2: '预览与核对',
    step2Lead: '系统已逐行核对工号、就绪度与岗位名称。请确认每行的处理结果后再导入。',
    previewing: '正在核对…',
    previewFail: '预览失败',
    retry: '重新预览',
    tabAll: '全部', tabCreate: '将新增', tabUpdate: '将更新', tabUnchanged: '无变化', tabError: '有错误',
    tablist: '按处理结果筛选',
    actCreate: '将新增', actUpdate: '将更新', actUnchanged: '无变化', actError: '有错误',
    colLine: '行号', colAction: '处理结果', colPos: '关键岗位', colEmp: '工号', colName: '姓名',
    colReady: '就绪度', colNote: '备注', colCodes: '说明',
    noRows: '没有符合的行',
    scopeBlock: (n) => `有 ${fmtN(n)} 行的员工不在你的数据范围内。只要有这类行，整个文件都不能导入；请在文件中删除这些行后重新上传。`,
    nothingToDo: '没有需要写入的行（全部无变化或有错误）。',
    importN: (n) => `导入 ${fmtN(n)} 行`,
    confirmTitle: '确认导入继任计划',
    confirmBody: (c, u) => `将导入 ${fmtN(c + u)} 行：新增 ${fmtN(c)} 行，更新 ${fmtN(u)} 行。`,
    confirmSkip: (e) => `${fmtN(e)} 行有错误，将跳过，不会导入。`,
    confirmSame: (n) => `${fmtN(n)} 行与现有记录相同，不做修改。`,
    confirmTx: '所有行在一次操作中写入；任一行写入失败时整批回滚，不会只导入一部分。',
    confirmOk: '确认导入',
    cancel: '取消',
    stale: '预览之后继任计划或员工数据有变化，已重新预览，请核对后再次确认。',
    outOfScope: (n) => `有 ${fmtN(n)} 行的员工不在你的数据范围内，本次未导入任何数据。`,
    overCapSrv: `超过每次 2,000 行的上限，本次未导入任何数据。`,
    batchFailed: (line) => (line ? `导入在第 ${line} 行出错，整批已回滚，未写入任何数据。请检查该行后重试。` : '导入出错，整批已回滚，未写入任何数据。请重试。'),
    importFail: '导入失败',
    doneTitle: '导入完成',
    doneBody: (r) => `新增 ${fmtN(r.created)} 行，更新 ${fmtN(r.updated)} 行，无变化 ${fmtN(r.unchanged)} 行，跳过 ${fmtN(r.skipped)} 行（有错误）。`,
    doneToast: (n) => `已导入 ${fmtN(n)} 行继任计划`,
    backSucc: '返回继任计划',
    again: '继续导入其他文件',
    leaveAsk: '已选择的文件尚未导入，离开后需要重新上传。确定离开吗？',
  },
  en: {
    back: 'Back to Talent Review',
    title: 'Import succession plans',
    sub: 'Fill in key positions, successor employee IDs and readiness using the template, check the preview, then import in one step.',
    roHint: 'Your role has read-only access to talent development and cannot import succession plans. Ask a super-admin if you need this access.',
    step1: 'Choose a file',
    step1Lead: 'Download the template, fill it in as described on the Instructions sheet, then upload it. .xlsx and .csv are supported.',
    tmpl: 'Download Excel template',
    pick: 'Upload spreadsheet (.xlsx / .csv)',
    repick: 'Choose another file',
    limitHint: `Up to 2,000 rows per import. An existing key position + successor pair has its readiness and notes updated; a blank note keeps the existing note. Rows with errors are not imported.`,
    fileFail: 'Could not read the file — make sure it is .xlsx or .csv',
    empty: 'The file has no data rows to import',
    headerOk: (n) => `Header recognized · ${n} columns`,
    noHeader: 'No header recognized — read in template column order',
    rowsN: (n) => `${fmtN(n)} data rows`,
    overCap: (n) => `The file has ${fmtN(n)} data rows, more than the limit of 2,000 per import. Split it into several files and import them one by one.`,
    step2: 'Preview and check',
    step2Lead: 'Each row has been checked for employee ID, readiness and position name. Review the result for each row before importing.',
    previewing: 'Checking…',
    previewFail: 'Preview failed',
    retry: 'Preview again',
    tabAll: 'All', tabCreate: 'To add', tabUpdate: 'To update', tabUnchanged: 'Unchanged', tabError: 'Errors',
    tablist: 'Filter by result',
    actCreate: 'To add', actUpdate: 'To update', actUnchanged: 'Unchanged', actError: 'Error',
    colLine: 'Row', colAction: 'Result', colPos: 'Key position', colEmp: 'Employee ID', colName: 'Name',
    colReady: 'Readiness', colNote: 'Notes', colCodes: 'Details',
    noRows: 'No matching rows',
    scopeBlock: (n) => `${fmtN(n)} row(s) point at employees outside your data scope. The file cannot be imported while such rows remain — delete them from the file and upload it again.`,
    nothingToDo: 'There are no rows to write (every row is unchanged or has an error).',
    importN: (n) => `Import ${fmtN(n)} row${n === 1 ? '' : 's'}`,
    confirmTitle: 'Confirm succession plan import',
    confirmBody: (c, u) => `${fmtN(c + u)} row(s) will be imported: ${fmtN(c)} added and ${fmtN(u)} updated.`,
    confirmSkip: (e) => `${fmtN(e)} row(s) have errors and will be skipped.`,
    confirmSame: (n) => `${fmtN(n)} row(s) match the existing records and will not change.`,
    confirmTx: 'All rows are written in a single operation; if any row fails, the whole import is rolled back and nothing is saved.',
    confirmOk: 'Import',
    cancel: 'Cancel',
    stale: 'Succession plans or employee data changed after the preview. The preview has been refreshed — check it and confirm again.',
    outOfScope: (n) => `${fmtN(n)} row(s) point at employees outside your data scope. Nothing was imported.`,
    overCapSrv: `More than 2,000 rows. Nothing was imported.`,
    batchFailed: (line) => (line ? `Import failed at row ${line} — the whole batch was rolled back and nothing was saved. Check that row and try again.` : 'Import failed — the whole batch was rolled back and nothing was saved. Try again.'),
    importFail: 'Import failed',
    doneTitle: 'Import complete',
    doneBody: (r) => `${fmtN(r.created)} added, ${fmtN(r.updated)} updated, ${fmtN(r.unchanged)} unchanged, ${fmtN(r.skipped)} skipped (errors).`,
    doneToast: (n) => `${fmtN(n)} succession plan row(s) imported`,
    backSucc: 'Back to succession plans',
    again: 'Import another file',
    leaveAsk: 'The selected file has not been imported. If you leave, you will need to upload it again. Leave this page?',
  },
};

const ACTIONS = ['create', 'update', 'unchanged', 'error'];
const ACTION_TAG = { create: 'green', update: 'blue', unchanged: 'grey', error: 'red' };
const ACTION_KEY = { create: 'actCreate', update: 'actUpdate', unchanged: 'actUnchanged', error: 'actError' };
const TAB_KEY = { all: 'tabAll', create: 'tabCreate', update: 'tabUpdate', unchanged: 'tabUnchanged', error: 'tabError' };

const codeOf = (c) => (c && typeof c === 'object' ? c.code : c);
const n0 = (v, d) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : d);

export default function SuccessionImport() {
  const { lang } = useI18n();
  const s = T[lang === 'zh' ? 'zh' : 'en'];
  const codeText = SUCC_CODE_TEXT[lang === 'zh' ? 'zh' : 'en'];
  const readyText = SUCC_READINESS_TEXT[lang === 'zh' ? 'zh' : 'en'];
  const navigate = useNavigate();
  const { user } = useAuth();
  const canWrite = canWriteDomain(user, 'talent');

  const fileRef = useRef(null);
  const [fileName, setFileName] = useState('');
  const [parsed, setParsed] = useState(null);      // { rows, headerCols, overCap }
  const [preview, setPreview] = useState(null);    // 服务端预览结果
  const [previewing, setPreviewing] = useState(false);
  const [previewErr, setPreviewErr] = useState('');
  const [tab, setTab] = useState('all');
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState(null);      // { created, updated, unchanged, skipped }
  const seq = useRef(0);                           // 只认最后一次预览请求的结果

  // 已选文件、尚未导入：离开时提示
  useLeaveGuard(!!(parsed && parsed.rows.length && !result), s.leaveAsk);

  // 服务端错误 → 本地化文案（中文界面优先 error_zh；表里没有的 code 回落到服务端原话）
  const errMap = {
    out_of_scope: (d) => s.outOfScope(n0(d.outOfScope, 0)),
    over_cap: () => s.overCapSrv,
    batch_failed: (d) => s.batchFailed(d.line),
    preview_stale: () => s.stale,
  };
  const msgOf = (err) => {
    const d = (err && err.data) || {};
    if (d.code && errMap[d.code]) return errText(err, errMap);
    if (lang === 'zh' && d.error_zh) return d.error_zh;
    return errText(err, errMap);
  };

  const runPreview = async (rows) => {
    const my = ++seq.current;
    setPreviewing(true);
    setPreviewErr('');
    try {
      const res = await api.post('/api/admin/succession/import/preview', { rows: succPayloadRows(rows) });
      if (my !== seq.current) return;
      setPreview(res || { rows: [], summary: {}, previewHash: '' });
    } catch (err) {
      if (my !== seq.current) return;
      setPreview(null);
      setPreviewErr(msgOf(err) || s.previewFail);
    } finally {
      if (my === seq.current) setPreviewing(false);
    }
  };

  const reset = () => {
    seq.current += 1;
    setFileName(''); setParsed(null); setPreview(null); setPreviewErr(''); setPreviewing(false);
    setTab('all'); setConfirmOpen(false); setResult(null);
  };

  const handleFile = async (file) => {
    if (!file) return;
    try {
      const buf = await file.arrayBuffer();
      let grid;
      if (/\.csv$/i.test(file.name)) {
        let text = new TextDecoder('utf-8').decode(buf);
        if (text.includes('�')) { try { text = new TextDecoder('gb18030').decode(buf); } catch { /* 保留 UTF-8 结果 */ } }
        grid = succSplitCsv(text);
      } else {
        const XLSX = await import('xlsx');
        const wb = XLSX.read(buf, { type: 'array' });
        grid = succSheetGrid(XLSX, wb.Sheets[wb.SheetNames[0]]);
      }
      const out = succParseGrid(grid);
      if (!out.rows.length) { Toast.warning(s.empty); return; }
      seq.current += 1;
      setResult(null);
      setPreview(null);
      setPreviewErr('');
      setTab('all');
      setFileName(file.name);
      setParsed(out);
      // 超过上限：只提示，不截断、不发预览请求
      if (!out.overCap) runPreview(out.rows);
    } catch {
      Toast.error(s.fileFail);
    } finally {
      if (fileRef.current) fileRef.current.value = '';
    }
  };
  const pickFile = () => { if (fileRef.current) fileRef.current.click(); };

  const sm = useMemo(() => succSummary(preview), [preview]);
  const pRows = (preview && Array.isArray(preview.rows)) ? preview.rows : [];
  const shown = tab === 'all' ? pRows : pRows.filter((r) => r && r.action === tab);
  const scopeRows = pRows.filter((r) => (r.codes || []).some((c) => codeOf(c) === 'employee_out_of_scope')).length;
  const toWrite = sm.create + sm.update;
  const canImport = !!(preview && preview.previewHash) && toWrite > 0 && !scopeRows && !previewing;

  const submit = async () => {
    if (!parsed || !preview) return;
    setSubmitting(true);
    try {
      const res = (await api.post('/api/admin/succession/import', { rows: succPayloadRows(parsed.rows), previewHash: preview.previewHash })) || {};
      const done = {
        created: n0(res.created, sm.create),
        updated: n0(res.updated, sm.update),
        unchanged: n0(res.unchanged, sm.unchanged),
        skipped: n0(res.skipped, sm.error),
      };
      setConfirmOpen(false);
      setResult(done);
      Toast.success(s.doneToast(done.created + done.updated));
    } catch (err) {
      const code = err && err.data && err.data.code;
      setConfirmOpen(false);
      if (err && err.status === 409 && code === 'preview_stale') {
        // 预览后数据变了：自动重新预览，请 HR 再看一遍
        Toast.warning(s.stale);
        setTab('all');
        runPreview(parsed.rows);
      } else {
        Toast.error(msgOf(err) || s.importFail);
      }
    } finally {
      setSubmitting(false);
    }
  };

  const goBack = () => { if (!confirmLeave()) return; navigate(BACK_PATH); };

  const cut = { display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' };
  const columns = [
    { title: s.colLine, dataIndex: 'line', width: 64, render: (v) => <span className="tnum">{v}</span> },
    { title: s.colAction, dataIndex: 'action', width: 104, render: (v) => (ACTION_TAG[v]
      ? <Tag size="small" type="light" color={ACTION_TAG[v]}>{s[ACTION_KEY[v]]}</Tag>
      : <Text type="tertiary">—</Text>) },
    { title: s.colPos, dataIndex: 'positionName', width: 180, render: (v) => (v ? <span style={cut} title={v}>{v}</span> : <Text type="tertiary">—</Text>) },
    { title: s.colEmp, dataIndex: 'employeeId', width: 110, render: (v) => (v ? <span className="tnum">{v}</span> : <Text type="tertiary">—</Text>) },
    { title: s.colName, dataIndex: 'name', width: 130, render: (v) => (v ? <span style={cut} title={v}>{v}</span> : <Text type="tertiary">—</Text>) },
    { title: s.colReady, dataIndex: 'readiness', width: 150, render: (v) => (v ? (readyText[v] || v) : <Text type="tertiary">—</Text>) },
    { title: s.colNote, dataIndex: 'note', width: 180, render: (v) => (v ? <span style={cut} title={v}>{v}</span> : <Text type="tertiary">—</Text>) },
    { title: s.colCodes, dataIndex: 'codes', width: 300, render: (codes) => {
      const list = Array.isArray(codes) ? codes : [];
      if (!list.length) return <Text type="tertiary">—</Text>;
      return list.map((c, i) => {
        const k = codeOf(c);
        const err = succCodeLevel(c) === 'error';
        return (
          <Tag key={`${k}-${i}`} size="small" type="light" color={err ? 'red' : 'blue'} className="u-tag-wrap" style={{ margin: '0 4px 4px 0' }}>
            {err ? '✗ ' : ''}{codeText[k] || k}
          </Tag>
        );
      });
    } },
  ];

  const head = (
    <div className="co-page-bar">
      <Button theme="borderless" icon={<IconArrowLeft />} onClick={goBack}>{s.back}</Button>
      <div className="co-page-titles">
        <h1 className="co-page-title" title={s.title}>{s.title}</h1>
        <div className="co-page-sub">{s.sub}</div>
      </div>
    </div>
  );

  if (!canWrite) {
    return (
      <div className="wrap trev-wrap">
        {head}
        <Banner type="warning" fullMode={false} closeIcon={null} description={s.roHint} />
      </div>
    );
  }

  return (
    <div className="wrap trev-wrap">
      {head}

      {/* ① 下载模板、选择文件 */}
      <div className="ppl-card">
        <div className="ppl-sec-h">
          <div><h2>{s.step1}</h2><div className="tset-lead">{s.step1Lead}</div></div>
        </div>
        <input ref={fileRef} type="file" accept=".xlsx,.xls,.csv" style={{ display: 'none' }}
          onChange={(e) => handleFile(e.target.files && e.target.files[0])} />
        <div className="u-filterbar">
          <Button icon={<IconExport />} onClick={() => window.open(`${import.meta.env.BASE_URL}templates/succession-import-template.xlsx`, '_blank')}>
            {s.tmpl}
          </Button>
          <Button theme="solid" type="primary" icon={<IconUpload />} disabled={submitting} onClick={pickFile}>
            {parsed ? s.repick : s.pick}
          </Button>
          {parsed && (
            <span className="u-tag-wrap" style={{ display: 'inline-flex', flexWrap: 'wrap', gap: 6, alignItems: 'center', minWidth: 0 }}>
              <Text strong ellipsis={{ showTooltip: true }} style={{ maxWidth: 260 }}>{fileName}</Text>
              <span className="pill muted">{s.rowsN(parsed.rows.length)}</span>
              <span className={'pill ' + (parsed.headerCols ? 'ok' : 'muted')}>
                {parsed.headerCols ? s.headerOk(parsed.headerCols) : s.noHeader}
              </span>
            </span>
          )}
        </div>
        <div className="u-hint">{s.limitHint}</div>
      </div>

      {/* ③ 导入结果 */}
      {result && (
        <div className="ppl-card">
          <Banner type="success" fullMode={false} closeIcon={null} title={s.doneTitle} description={s.doneBody(result)} style={{ marginBottom: 12 }} />
          <div className="u-filterbar">
            <Button theme="solid" type="primary" onClick={() => navigate(BACK_PATH)}>{s.backSucc}</Button>
            <Button onClick={() => { reset(); pickFile(); }}>{s.again}</Button>
          </div>
        </div>
      )}

      {/* ② 预览与核对 */}
      {parsed && !result && (
        <div className="ppl-card">
          <div className="ppl-sec-h">
            <div><h2>{s.step2}</h2><div className="tset-lead">{s.step2Lead}</div></div>
          </div>

          {parsed.overCap ? (
            <Banner type="danger" fullMode={false} closeIcon={null} description={s.overCap(parsed.rows.length)} />
          ) : previewErr ? (
            <>
              <Banner type="danger" fullMode={false} closeIcon={null} description={`${s.previewFail} · ${previewErr}`} style={{ marginBottom: 12 }} />
              <Button icon={<IconRefresh />} onClick={() => runPreview(parsed.rows)}>{s.retry}</Button>
            </>
          ) : !preview ? (
            <div style={{ textAlign: 'center', padding: '32px 0' }}>
              <Spin size="large" tip={s.previewing} />
            </div>
          ) : (
            <Spin spinning={previewing} tip={s.previewing}>
              {scopeRows > 0 && (
                <Banner type="danger" fullMode={false} closeIcon={null} description={s.scopeBlock(scopeRows)} style={{ marginBottom: 12 }} />
              )}
              {!scopeRows && toWrite === 0 && (
                <Banner type="warning" fullMode={false} closeIcon={null} description={s.nothingToDo} style={{ marginBottom: 12 }} />
              )}

              <div className="ppl-chips" role="tablist" aria-label={s.tablist}>
                {['all', ...ACTIONS].map((k) => (
                  <button key={k} type="button" role="tab" aria-selected={tab === k}
                    className={'ppl-chip' + (tab === k ? ' on' : '')} onClick={() => setTab(k)}>
                    {s[TAB_KEY[k]]} <span className="tnum">{fmtN(k === 'all' ? sm.total : sm[k])}</span>
                  </button>
                ))}
              </div>

              <Table
                size="small"
                rowKey={(r) => String(r.line)}
                dataSource={shown}
                empty={<Text type="tertiary">{s.noRows}</Text>}
                pagination={shown.length > DEFAULT_PAGE
                  ? { pageSize: DEFAULT_PAGE, pageSizeOpts: PAGE_TIERS, showSizeChanger: true, formatPageText: false }
                  : false}
                {...resizableTable(columns)}
              />

              <div className="u-filterbar" style={{ marginTop: 16, marginBottom: 0 }}>
                <Button theme="solid" type="primary" disabled={!canImport} onClick={() => setConfirmOpen(true)}>
                  {s.importN(toWrite)}
                </Button>
                <Button icon={<IconRefresh />} disabled={previewing} onClick={() => runPreview(parsed.rows)}>{s.retry}</Button>
                {sm.error > 0 && <Text type="danger">{s.confirmSkip(sm.error)}</Text>}
              </div>
            </Spin>
          )}
        </div>
      )}

      {/* 确认弹窗：写明将新增 / 更新 / 跳过的行数，跳过不是静默的 */}
      <Modal
        visible={confirmOpen}
        title={s.confirmTitle}
        maskClosable={false}
        closable={!submitting}
        onCancel={() => { if (!submitting) setConfirmOpen(false); }}
        footer={(
          <>
            <Button theme="borderless" disabled={submitting} onClick={() => setConfirmOpen(false)}>{s.cancel}</Button>
            <Button theme="solid" type="primary" loading={submitting} disabled={!canImport} onClick={submit}>{s.confirmOk}</Button>
          </>
        )}
      >
        <p style={{ margin: '0 0 8px' }}><b>{s.confirmBody(sm.create, sm.update)}</b></p>
        {sm.error > 0 && <p style={{ margin: '0 0 8px' }}><Text type="danger">{s.confirmSkip(sm.error)}</Text></p>}
        {sm.unchanged > 0 && <p style={{ margin: '0 0 8px' }}>{s.confirmSame(sm.unchanged)}</p>}
        <div className="u-hint">{s.confirmTx}</div>
      </Modal>
    </div>
  );
}
