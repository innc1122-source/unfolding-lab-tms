// AI 治理（系统设置 › AI 治理；NEXT-WORK/specs/03-ai-governance-spec.md 5.3）—— 审计域只读页，ai 模块关闭后只要已有调用记录仍可查看。
//   ① 状态：模块与各功能、服务商、解析后的地址、模型、证书校验、连接测试（仅超级管理员且模块开启时可用）
//   ② 本月用量与预算（按功能：次数、失败率、token；预估费用只在配置了单价时显示）
//   ③ 调用记录（可筛选、分页、导出 CSV；有数据范围限制的账号只看得到范围内员工的记录）
//   ④ 数据流向：按当前实际配置列出每个字段是否发给 AI，并标出与上线基线不同的字段（与 HANDOVER-IT §10.8 同源）
// 任何接口都不返回密钥、请求头与查询参数的值；本页也不提供编辑 —— 开关在「功能模块」页，服务商配置由 IT 维护。
import { useState } from 'react';
import { Table, Tag, Button, Toast, Banner, Spin, Select, Input, Typography, Progress, Descriptions } from '@douyinfe/semi-ui';
import { IconDownload, IconRefresh } from '@douyinfe/semi-icons';
import { api, useAsync } from '../../api.js';
import { useAuth } from '../../auth.jsx';
import { useI18n } from '../../i18n.jsx';
import { datetime as fmtDateTime } from '../../fmt.js';
import { resizableTable } from '../../cardify.js';

const { Text } = Typography;
const FEATURES = ['assistant', 'questionGen', 'grading', 'portrait', 'translate', 'talentFilter', 'test'];

const T = {
  zh: {
    title: 'AI 治理', lead: '查看 AI 服务的接入状态、用量与调用记录。调用记录只含时间、功能、模型、用量等元数据，不保存提问、作答、材料和 AI 回复的原文。开关在「功能模块」页；服务商、密钥与限额由 IT 在 config.json 维护（HANDOVER-IT §10）。',
    loadFail: '加载失败，请刷新页面重试。',
    secStatus: '接入状态', secUsage: '本月用量与预算', secCalls: '调用记录', secFlow: '数据流向（按当前配置）',
    module: 'AI 模块', on: '已开启', off: '已关闭', demo: '演示模式', prod: '生产环境',
    stateLab: { on: '可用', demo: '演示', off_module: '模块关闭', off_owner: '所属模块关闭', off_feature: '功能关闭', not_configured: '未接入', budget_exhausted: '本月用量已达上限' },
    feat: { assistant: 'AI 学习助手', questionGen: 'AI 出题', grading: '简答题 AI 初评', portrait: 'AI 人才画像', translate: 'AI 翻译', talentFilter: 'AI 条件生成（人才筛选）', test: '连接测试' },
    review: { none: '不需要', adopt: '逐题审阅后采纳', decisive: '决定是否通过时须 HR 复核', confirm: '须 HR 确认后生效' },
    colFeature: '功能', colState: '状态', colReview: '人工把关', colOwner: '所属模块',
    provider: '服务商', notConfigured: (r) => `未接入（${r}）`, url: '接口地址', protocol: '协议', auth: '认证方式', key: '密钥',
    keyYes: (src) => `已配置（来源 ${src}）`, keyNo: '未配置', headers: '附加请求头（只显示名称）', query: '附加查询参数（只显示名称）',
    proxy: '代理', clientCert: '客户端证书', yes: '已配置', none: '无', attribution: '按人归因', models: '模型',
    tlsOff: '证书校验已关闭（检测到 NODE_TLS_REJECT_UNAUTHORIZED=0）：已拒绝一切 AI 调用。请删除该环境变量并按 HANDOVER-IT §10.9 处理证书后重启。',
    envOff: '服务器设置了 LMS_DISABLE_AI=1：AI 功能按「未接入」处理，简答题由 HR 人工评分。',
    demoProd: '警告：生产环境开启了演示模式（ai.demo: true）。演示内容不是 AI 分析结果，也不计入成绩。',
    legacy: '正在使用旧字段（anthropicApiKey / geminiApiKey / aiModel），建议改为 ai.provider（HANDOVER-IT §10）。',
    configHash: '配置指纹', debugUntil: (d) => `临时排查日志开启至 ${d}`,
    test: '连接测试', testing: '测试中…', testHint: '对每个不同的模型各做一次连通性与结构化输出测试，会产生真实调用并计费。仅超级管理员可用。',
    testOk: (m, ms) => `${m}：正常（${ms} ms）`, testFail: (m, c) => `${m}：失败（${c}）`, structured: '结构化输出可用', structuredNo: '结构化输出不可用',
    budget: '月度预算', used: (u, l) => `已用 ${u.toLocaleString()} / ${l.toLocaleString()} token`, alertAt: (p) => `${p}% 时通知后台管理员`,
    colCalls: '次数', colErrors: '失败', colFailRate: '失败率', colTokens: 'token（输入 / 输出）', colDemo: '演示',
    cost: (c) => `按配置单价折算约 ${c}`, lastMonth: (m) => `上月（${m}）`, thisMonth: (m) => `本月（${m}）`, noUsage: '本月还没有调用',
    fFrom: '起始日期', fTo: '截止日期', fFeature: '功能', fStatus: '结果', fActor: '调用人工号', all: '全部',
    st: { ok: '成功', error: '失败', demo: '演示', blocked: '被拦截' },
    colTime: '时间', colActor: '调用人', colSubject: '所涉员工', colModel: '模型（请求 → 实际）', colResult: '结果', colLatency: '耗时', colTok: 'token', colRed: '脱敏次数',
    kind: { employee: '员工', admin: '后台', system: '系统' },
    exportCsv: '导出 CSV', search: '查询', noCalls: '没有符合条件的调用记录',
    flowLead: '人才画像只发送标为「原样」或「脱敏」的结构化字段；离职与 HR 备注记录整条不发，不受字段配置影响。放宽外发范围只限超级管理员，每次变更记审计。',
    colType: '记录类型', colField: '字段', colShare: '当前', colBase: '上线基线', share: { send: '原样', mask: '脱敏', omit: '不发' },
    hardEx: '整条不发', differs: '与基线不同',
  },
  en: {
    title: 'AI Governance', lead: 'Connection status, usage and the call log of the AI service. The call log holds metadata only (time, feature, model, usage) — never the questions, answers, material or AI replies. Switches live on the Modules page; the provider, key and limits are maintained by IT in config.json (HANDOVER-IT §10).',
    loadFail: 'Couldn’t load. Refresh the page to try again.',
    secStatus: 'Connection', secUsage: 'Usage and budget this month', secCalls: 'Call log', secFlow: 'Data flow (current configuration)',
    module: 'AI module', on: 'On', off: 'Off', demo: 'Demo mode', prod: 'Production',
    stateLab: { on: 'Available', demo: 'Demo', off_module: 'Module off', off_owner: 'Owning module off', off_feature: 'Feature off', not_configured: 'Not connected', budget_exhausted: 'Monthly limit reached' },
    feat: { assistant: 'AI study assistant', questionGen: 'AI question drafting', grading: 'AI pre-scoring of short answers', portrait: 'AI talent portrait', translate: 'AI translation', talentFilter: 'AI filter drafting (talent search)', test: 'Connection test' },
    review: { none: 'Not required', adopt: 'Reviewed before adoption', decisive: 'HR review when it decides pass/fail', confirm: 'Takes effect after HR confirms' },
    colFeature: 'Feature', colState: 'State', colReview: 'Human check', colOwner: 'Owning module',
    provider: 'Provider', notConfigured: (r) => `Not connected (${r})`, url: 'Endpoint', protocol: 'Protocol', auth: 'Auth', key: 'Key',
    keyYes: (src) => `Configured (from ${src})`, keyNo: 'Not configured', headers: 'Extra headers (names only)', query: 'Extra query parameters (names only)',
    proxy: 'Proxy', clientCert: 'Client certificate', yes: 'Configured', none: 'None', attribution: 'Per-user attribution', models: 'Models',
    tlsOff: 'Certificate verification is OFF (NODE_TLS_REJECT_UNAUTHORIZED=0 detected): every AI call is refused. Remove the variable, fix the certificate per HANDOVER-IT §10.9 and restart.',
    envOff: 'LMS_DISABLE_AI=1 is set on the server: AI features count as not connected and short answers go to HR scoring.',
    demoProd: 'Warning: demo mode (ai.demo: true) is on in a production deployment. Demo content is not AI analysis and never counts toward results.',
    legacy: 'Using the legacy fields (anthropicApiKey / geminiApiKey / aiModel); consider moving to ai.provider (HANDOVER-IT §10).',
    configHash: 'Config fingerprint', debugUntil: (d) => `Temporary debug logging on until ${d}`,
    test: 'Connection test', testing: 'Testing…', testHint: 'Tests connectivity and structured output once per distinct model. Makes real (billed) calls. Super admins only.',
    testOk: (m, ms) => `${m}: OK (${ms} ms)`, testFail: (m, c) => `${m}: failed (${c})`, structured: 'structured output works', structuredNo: 'structured output unavailable',
    budget: 'Monthly budget', used: (u, l) => `${u.toLocaleString()} / ${l.toLocaleString()} tokens used`, alertAt: (p) => `Admins are notified at ${p}%`,
    colCalls: 'Calls', colErrors: 'Failed', colFailRate: 'Failure rate', colTokens: 'Tokens (in / out)', colDemo: 'Demo',
    cost: (c) => `About ${c} at the configured prices`, lastMonth: (m) => `Last month (${m})`, thisMonth: (m) => `This month (${m})`, noUsage: 'No calls this month yet',
    fFrom: 'From', fTo: 'To', fFeature: 'Feature', fStatus: 'Result', fActor: 'Caller employee ID', all: 'All',
    st: { ok: 'OK', error: 'Failed', demo: 'Demo', blocked: 'Blocked' },
    colTime: 'Time', colActor: 'Caller', colSubject: 'Employee concerned', colModel: 'Model (requested → returned)', colResult: 'Result', colLatency: 'Latency', colTok: 'Tokens', colRed: 'Redactions',
    kind: { employee: 'Employee', admin: 'Console', system: 'System' },
    exportCsv: 'Export CSV', search: 'Search', noCalls: 'No calls match',
    flowLead: 'The talent portrait sends only structured fields marked “as is” or “masked”; exit and HR-note records are never sent, whatever the field settings say. Only a super admin can widen what is sent, and each change is audited.',
    colType: 'Record type', colField: 'Field', colShare: 'Current', colBase: 'Go-live baseline', share: { send: 'As is', mask: 'Masked', omit: 'Not sent' },
    hardEx: 'Never sent', differs: 'Differs from baseline',
  },
};

// embedded：嵌在「审计日志」页的「AI 治理」分节里（2026-10-06 她定：不单独占侧栏一项，并入现有页面；与审计同属 audit 域）
export default function AiGovernance({ embedded = false }) {
  const { lang, loc } = useI18n();
  const s = T[lang];
  const { user } = useAuth();
  const st = useAsync(() => api.get('/api/admin/ai-governance/status'), []);
  const us = useAsync(() => api.get('/api/admin/ai-governance/usage'), []);
  const [flt, setFlt] = useState({ from: '', to: '', feature: '', status: '', actor: '' });
  const [page, setPage] = useState(1);
  const qs = () => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(flt)) if (v) p.set(k, v);
    return p.toString();
  };
  const [applied, setApplied] = useState('');
  const calls = useAsync(() => api.get(`/api/admin/ai-governance/calls?page=${page}&pageSize=50${applied ? '&' + applied : ''}`), [page, applied]);
  const [testing, setTesting] = useState(false);
  const [testRes, setTestRes] = useState(null);

  if (st.loading) return <div className={embedded ? 'aig-embedded' : 'wrap'}><Spin /></div>;
  if (st.error || !st.data) return <div className={embedded ? 'aig-embedded' : 'wrap'}><Banner type="danger" fullMode={false} closeIcon={null} description={s.loadFail} /></div>;
  const d = st.data;
  const p = d.provider || {};
  const fmtDT = (iso) => (iso ? fmtDateTime(iso) : '—');

  const runTest = async () => {
    setTesting(true); setTestRes(null);
    try { setTestRes(await api.post('/api/admin/ai-governance/test', {})); us.reload(); calls.reload(); }
    catch (e) { Toast.error((e && e.data && e.data.error_zh && lang === 'zh' ? e.data.error_zh : e && e.message) || s.loadFail); }
    finally { setTesting(false); }
  };

  const featCols = [
    { title: s.colFeature, dataIndex: 'id', width: 200, render: (v) => s.feat[v] || v },
    { title: s.colState, dataIndex: 'state', width: 150, render: (v) => <Tag color={v === 'on' ? 'green' : v === 'demo' ? 'amber' : 'grey'} type="light" shape="circle">{s.stateLab[v] || v}</Tag> },
    { title: s.colReview, dataIndex: 'humanReview', width: 240, render: (v) => s.review[v] || v },
    { title: s.colOwner, dataIndex: 'owner', width: 120 },
  ];
  const u = us.data;
  const usageCols = [
    { title: s.colFeature, dataIndex: 'feature', width: 180, render: (v) => s.feat[v] || v },
    { title: s.colCalls, dataIndex: 'calls', width: 90, align: 'right', render: (v) => <span className="tnum">{v}</span> },
    { title: s.colErrors, dataIndex: 'errors', width: 90, align: 'right', render: (v) => <span className="tnum">{v}</span> },
    { title: s.colFailRate, dataIndex: 'failureRate', width: 100, align: 'right', render: (v) => <span className="tnum">{v}%</span> },
    { title: s.colDemo, dataIndex: 'demo', width: 80, align: 'right', render: (v) => <span className="tnum">{v}</span> },
    { title: s.colTokens, dataIndex: 'inTokens', width: 200, align: 'right', render: (_, r) => <span className="tnum">{r.inTokens.toLocaleString()} / {r.outTokens.toLocaleString()}</span> },
  ];
  const callCols = [
    { title: s.colTime, dataIndex: 'createdAt', width: 140, render: (v) => <span className="tnum">{fmtDT(v)}</span> },
    { title: s.colFeature, dataIndex: 'feature', width: 150, render: (v) => s.feat[v] || v },
    { title: s.colActor, dataIndex: 'actor', width: 170, render: (v, r) => <span>{v ? `${v.name}${v.employeeId ? ' · ' + v.employeeId : ''}` : '—'} <Text type="tertiary" size="small">{s.kind[r.actorKind] || r.actorKind}</Text></span> },
    { title: s.colSubject, dataIndex: 'subject', width: 160, render: (v) => (v ? `${v.name}${v.employeeId ? ' · ' + v.employeeId : ''}` : '—') },
    { title: s.colResult, dataIndex: 'status', width: 170, render: (v, r) => <span><Tag size="small" color={v === 'ok' ? 'green' : v === 'error' ? 'red' : v === 'demo' ? 'amber' : 'grey'} type="light" shape="circle">{s.st[v] || v}</Tag>{r.errorCode ? <Text type="tertiary" size="small"> {r.errorCode}</Text> : null}</span> },
    { title: s.colModel, dataIndex: 'modelRequested', width: 220, render: (v, r) => (v ? `${v}${r.modelReturned && r.modelReturned !== v ? ' → ' + r.modelReturned : ''}` : r.protocol || '—') },
    { title: s.colLatency, dataIndex: 'latencyMs', width: 90, align: 'right', render: (v) => <span className="tnum">{v ? `${v} ms` : '—'}</span> },
    { title: s.colTok, dataIndex: 'inTokens', width: 120, align: 'right', render: (_, r) => <span className="tnum">{(r.inTokens || 0) + (r.outTokens || 0)}{r.tokensEstimated ? '*' : ''}</span> },
    { title: s.colRed, dataIndex: 'redactions', width: 140, render: (v) => (v ? Object.entries(v).map(([k, n]) => `${k}×${n}`).join(' ') : '—') },
  ];
  const flowCols = [
    { title: s.colType, dataIndex: 'typeLabel', width: 150, render: (_, r) => loc(r, 'typeLabel') },
    { title: s.colField, dataIndex: 'label', width: 180, render: (_, r) => loc(r, 'label') },
    { title: s.colShare, dataIndex: 'aiShare', width: 140, render: (v, r) => (r.hardExcluded ? <Tag size="small" color="grey" type="light">{s.hardEx}</Tag> : <Tag size="small" color={v === 'send' ? 'blue' : v === 'mask' ? 'cyan' : 'grey'} type="light">{s.share[v] || v}</Tag>) },
    { title: s.colBase, dataIndex: 'baseline', width: 120, render: (v) => s.share[v] || v },
    { title: '', dataIndex: 'differs', width: 150, render: (v) => (v ? <Tag size="small" color="orange" type="light" shape="circle">{s.differs}</Tag> : null) },
  ];
  const cd = calls.data || { rows: [], total: 0, page: 1, pageSize: 50 };

  return (
    <div className={embedded ? 'aig-embedded' : 'wrap aig-wrap'}>
      {embedded ? (
        <div className="aig-embedded-h">
          <div className="tset-lead">{s.lead}</div>
          <Button icon={<IconRefresh />} theme="borderless" onClick={() => { st.reload(); us.reload(); calls.reload(); }} aria-label="refresh" />
        </div>
      ) : (
      <div className="tset-head">
        <div><h1 className="tset-title">{s.title}</h1><div className="tset-lead">{s.lead}</div></div>
        <Button icon={<IconRefresh />} theme="borderless" onClick={() => { st.reload(); us.reload(); calls.reload(); }} aria-label="refresh" />
      </div>
      )}

      {d.tlsVerificationDisabled && <Banner type="danger" fullMode={false} closeIcon={null} description={s.tlsOff} style={{ marginBottom: 12 }} />}
      {d.disabledByEnv && <Banner type="warning" fullMode={false} closeIcon={null} description={s.envOff} style={{ marginBottom: 12 }} />}
      {d.demo && d.production && <Banner type="danger" fullMode={false} closeIcon={null} description={s.demoProd} style={{ marginBottom: 12 }} />}

      {/* ① 状态 */}
      <div className="ppl-card">
        <div className="ppl-sec-h"><div><h2>{s.secStatus}</h2></div></div>
        <div className="aig-kv">
          <Descriptions align="left" size="small" data={[
            { key: s.module, value: <span><Tag color={d.module ? 'green' : 'grey'} type="light" shape="circle">{d.module ? s.on : s.off}</Tag>{d.demo && <Tag color="amber" type="light" shape="circle" style={{ marginLeft: 6 }}>{s.demo}</Tag>}</span> },
            { key: s.provider, value: p.configured ? `${p.providerId}${p.legacy ? ' (legacy)' : ''}` : s.notConfigured(p.reason || 'no_provider') },
            ...(p.configured ? [
              { key: s.protocol, value: p.protocol },
              { key: s.url, value: <span className="tnum aig-break">{p.url}</span> },
              { key: s.auth, value: p.auth },
              { key: s.key, value: p.keyConfigured ? s.keyYes(p.keySource) : s.keyNo },
              { key: s.headers, value: (p.headerNames || []).join(', ') || s.none },
              { key: s.query, value: (p.queryNames || []).join(', ') || s.none },
              { key: s.proxy, value: p.proxyHost || s.none },
              { key: s.clientCert, value: p.clientCert ? s.yes : s.none },
              { key: s.attribution, value: p.userAttribution },
              // 只列默认模型与按功能另配的模型（与默认相同的功能不重复列出）
              { key: s.models, value: p.models ? Object.entries(p.models).filter(([k, v]) => k === 'default' || (k !== 'test' && v !== p.models.default)).map(([k, v]) => `${k}: ${v}`).join(' · ') : '—' },
            ] : []),
            { key: s.configHash, value: <span className="tnum">{d.configHash}</span> },
          ]} />
          {p.legacy && <div className="tset-renamehint">{s.legacy}</div>}
          {d.debugLogUntil && <div className="tset-renamehint">{s.debugUntil(fmtDT(d.debugLogUntil))}</div>}
        </div>
        <Table rowKey="id" size="small" pagination={false} dataSource={d.features} {...resizableTable(featCols)} />
        {d.canTest && d.module && (
          <div className="aig-test">
            <Button onClick={runTest} loading={testing} theme="solid" type="primary">{testing ? s.testing : s.test}</Button>
            <Text type="tertiary" size="small">{s.testHint}</Text>
            {testRes && (
              <ul className="aig-testres">
                {(testRes.results || []).map((r) => (
                  <li key={r.model} className={r.ok ? 'ok' : 'bad'}>
                    {r.ok ? s.testOk(r.model + (r.modelReturned && r.modelReturned !== r.model ? ` → ${r.modelReturned}` : ''), r.latencyMs) : s.testFail(r.model, r.errorCode + (r.reason ? ` · ${r.reason}` : '') + (r.redirectHost ? ` → ${r.redirectHost}` : ''))}
                    {r.ok && <Text type="tertiary" size="small"> · {r.structuredOutput ? s.structured : s.structuredNo}</Text>}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>

      {/* ② 用量与预算 */}
      <div className="ppl-card">
        <div className="ppl-sec-h"><div><h2>{s.secUsage}</h2></div></div>
        {u && (
          <>
            <div className="aig-budget">
              <div><b>{s.budget}</b> · <span className="tnum">{s.used(u.budget.used, u.budget.limit)}</span> · <Text type="tertiary" size="small">{s.alertAt(u.budget.alertAtPercent)}</Text></div>
              <Progress percent={Math.min(100, u.budget.percent)} stroke={u.budget.percent >= 100 ? 'var(--semi-color-danger)' : u.budget.percent >= u.budget.alertAtPercent ? 'var(--semi-color-warning)' : undefined} showInfo aria-label={s.budget} />
              {u.priced && u.cost != null && <Text type="tertiary" size="small">{s.cost(u.cost)}</Text>}
            </div>
            <div className="aig-sub">{s.thisMonth(u.month)}</div>
            {u.byFeature.length ? <Table rowKey="feature" size="small" pagination={false} dataSource={u.byFeature} {...resizableTable(usageCols)} /> : <Text type="tertiary">{s.noUsage}</Text>}
            {u.prevByFeature.length > 0 && (
              <>
                <div className="aig-sub">{s.lastMonth(u.prevMonth)}</div>
                <Table rowKey="feature" size="small" pagination={false} dataSource={u.prevByFeature} {...resizableTable(usageCols)} />
              </>
            )}
          </>
        )}
      </div>

      {/* ③ 调用记录 */}
      <div className="ppl-card">
        <div className="ppl-sec-h"><div><h2>{s.secCalls}</h2></div></div>
        <div className="aig-filters">
          <label>{s.fFrom}<Input type="date" value={flt.from} onChange={(v) => setFlt({ ...flt, from: v })} /></label>
          <label>{s.fTo}<Input type="date" value={flt.to} onChange={(v) => setFlt({ ...flt, to: v })} /></label>
          <label>{s.fFeature}<Select value={flt.feature} onChange={(v) => setFlt({ ...flt, feature: v })} optionList={[{ value: '', label: s.all }, ...FEATURES.map((f) => ({ value: f, label: s.feat[f] }))]} style={{ width: 170 }} /></label>
          <label>{s.fStatus}<Select value={flt.status} onChange={(v) => setFlt({ ...flt, status: v })} optionList={[{ value: '', label: s.all }, ...['ok', 'error', 'demo', 'blocked'].map((x) => ({ value: x, label: s.st[x] }))]} style={{ width: 120 }} /></label>
          <label>{s.fActor}<Input value={flt.actor} onChange={(v) => setFlt({ ...flt, actor: v.trim() })} style={{ width: 140 }} /></label>
          <Button theme="solid" onClick={() => { setPage(1); setApplied(qs()); }}>{s.search}</Button>
          <Button icon={<IconDownload />} onClick={() => { window.location.href = '/api/admin/ai-governance/calls.csv' + (applied ? '?' + applied : ''); }}>{s.exportCsv}</Button>
        </div>
        <Table rowKey="id" size="small" loading={calls.loading} dataSource={cd.rows} {...resizableTable(callCols)}
          pagination={cd.total > cd.pageSize ? { currentPage: page, pageSize: cd.pageSize, total: cd.total, onPageChange: setPage } : false}
          empty={<Text type="tertiary">{s.noCalls}</Text>} />
      </div>

      {/* ④ 数据流向 */}
      <div className="ppl-card">
        <div className="ppl-sec-h"><div><h2>{s.secFlow}</h2><div className="tset-lead">{s.flowLead}</div></div></div>
        <Table rowKey="id" size="small" pagination={false} dataSource={d.dataflow || []} {...resizableTable(flowCols)} />
      </div>
    </div>
  );
}
