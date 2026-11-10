// AI 人才画像卡（员工档案页右栏；AI 治理方案 2.5「画像流程」、4.4、5.3）。
//   GET  /api/admin/talent-portraits?userId=  → { state, canGenerate, self, current, drafts, history }
//   POST /api/admin/employees/:id/ai-portrait → { draft }（结果一律先存为草稿）
//   POST /api/admin/talent-portraits/:id/confirm { content? } | /discard { reason? } | /objection { summary, outcome }
// 草稿标注「AI 草稿，未经确认，不作为人才决策依据」；对应不上输入记录的判断标为「无依据」，确认前须删除或改写；
// 每条判断附依据（记录月份 + 类型）；档案在生成后有更新时提示「此画像基于旧数据」。ai 模块或画像功能关闭时，只读显示已确认版本。
// 生成、查看要求人才发展（talent）权限与数据范围（服务端判定；负责人 2026-09-30 决定不再另要求员工档案读权限）；不能为本人生成或确认。
// CX-103：AI 服务未接入或本月用量已满时「生成草稿」置灰，并写明原因（原来可点，点了才报错）。
import { datetime as fmtDateTime } from '../fmt.js';
import { useState } from 'react';
import { Button, Banner, Tag, Toast, Modal, Input, TextArea, Select, Typography, Spin } from '@douyinfe/semi-ui';
import { api, useAsync } from '../api.js';
import { errText } from '../apierr.js';
import { useI18n } from '../i18n.jsx';

const { Text } = Typography;
const LEVELS = ['ready_now', 'one_year', 'two_years', 'not_yet', 'insufficient_evidence'];

const T = {
  zh: {
    title: 'AI 人才画像', gen: '生成草稿', genning: '生成中…（约 1 分钟）', regen: '重新生成草稿',
    sends: '将发送：职位、职级、在职状态、司龄月数，以及按字段配置发送的结构化记录（绩效评级、培训成绩、荣誉名称、晋升结果、违纪严重程度等，日期精确到月）；部门以占位符发送。不发送姓名、工号、邮箱、潜力评级、人才标签与自由文本评语。',
    draftBanner: 'AI 草稿，未经确认，不作为人才决策依据。', demoBanner: '演示模式：未接入 AI 服务，以下不是 AI 分析结果。',
    stale: '员工档案在生成之后有更新，此画像基于旧数据。', excluded: (n) => `${n} 条记录因含疑似指令文本未纳入分析。`,
    prov: (m, d, who) => `模型 ${m} · 生成于 ${d}${who ? ` · ${who}` : ''}`, confirmedBy: (who, d) => `已确认 · ${who || '—'} · ${d}`,
    summary: '综合评价', strengths: '优势', risks: '风险', development: '发展建议', readiness: '晋升准备度',
    level: { ready_now: '现在即可', one_year: '约一年', two_years: '约两年', not_yet: '尚需培养', insufficient_evidence: '依据不足，不做判断' },
    unsupported: '无依据', evidence: '依据', edited: 'HR 改写', none: '（无）',
    confirm: '确认', editConfirm: '编辑后确认', discard: '丢弃', save: '确认此版本', cancel: '取消', del: '删除此条', add: '添加一条',
    discardT: '丢弃草稿', discardReason: '原因（可选）', discarded: '已丢弃，正文已清空', confirmedOk: '已确认，旧版本已转为历史',
    unsupportedLeft: (n) => `还有 ${n} 条「无依据」的判断，请删除或改写后再确认。`,
    history: '历史版本', superseded: '已被替代', discardedSt: '已丢弃', expired: '30 天未处理，已自动失效', noText: '正文已清空',
    objection: '记录异议', objectionT: '记录员工的更正或异议', objSummary: '员工提出的内容摘要', objOutcome: '处理结果', objSaved: '已记录',
    objections: '异议记录', featureOff: 'AI 人才画像功能未开启，暂无已确认的画像。超级管理员可在「审计日志 › AI 治理」中开启。', genBlockedNc: 'AI 服务尚未接入，暂时不能生成草稿。', genBlockedBudget: '本月 AI 用量已达上限，暂时不能生成草稿。', readOnly: 'AI 模块或画像功能已关闭：以下为已确认版本，只读。', empty: '暂无画像。',
    self: '不能为本人生成或确认人才画像。',
    errs: {
      portrait_unsupported: (d) => `还有 ${d.unsupported} 条判断没有依据，请删除或改写后再确认。`,
      ai_self_subject: () => '不能为本人生成或确认人才画像。',
     
      ai_feature_off: () => 'AI 人才画像未开启。', ai_not_configured: () => 'AI 服务尚未接入。',
      ai_rate_limited: (d) => `生成过于频繁，请 ${Math.max(1, Math.ceil((d.retryAfterSec || 60) / 60))} 分钟后再试。`,
      ai_budget_exhausted: () => '本月 AI 用量已达上限。', ai_timeout: () => 'AI 服务响应超时，请稍后再试（画像超时后不会自动重试）。',
      ai_output_invalid: () => 'AI 生成内容不完整，请重试。', ai_output_truncated: () => 'AI 生成内容不完整，请重试。',
    },
  },
  en: {
    title: 'AI Talent Portrait', gen: 'Generate draft', genning: 'Generating… (about 1 min)', regen: 'Generate a new draft',
    sends: 'Sent: position, level, employment status, tenure in months, and the structured records each field is set to send (performance ratings, training scores, award names, promotion results, disciplinary severity…, dated to the month); departments go out as placeholders. Not sent: name, employee ID, email, potential rating, talent tags or free-text comments.',
    draftBanner: 'AI draft — not confirmed, not a basis for talent decisions.', demoBanner: 'Demo mode: no AI service is connected; this is not AI analysis.',
    stale: 'The profile changed after this was generated; the portrait is based on older data.', excluded: (n) => `${n} record(s) were left out because they contained instruction-like text.`,
    prov: (m, d, who) => `Model ${m} · generated ${d}${who ? ` · ${who}` : ''}`, confirmedBy: (who, d) => `Confirmed · ${who || '—'} · ${d}`,
    summary: 'Summary', strengths: 'Strengths', risks: 'Risks', development: 'Development', readiness: 'Promotion readiness',
    level: { ready_now: 'Ready now', one_year: 'In about a year', two_years: 'In about two years', not_yet: 'Not yet', insufficient_evidence: 'Not enough evidence' },
    unsupported: 'No evidence', evidence: 'Evidence', edited: 'Edited by HR', none: '(none)',
    confirm: 'Confirm', editConfirm: 'Edit, then confirm', discard: 'Discard', save: 'Confirm this version', cancel: 'Cancel', del: 'Delete', add: 'Add one',
    discardT: 'Discard draft', discardReason: 'Reason (optional)', discarded: 'Discarded — the text was cleared', confirmedOk: 'Confirmed; the previous version moved to history',
    unsupportedLeft: (n) => `${n} judgement(s) still have no evidence. Delete or rewrite them before confirming.`,
    history: 'History', superseded: 'Superseded', discardedSt: 'Discarded', expired: 'Expired after 30 days without action', noText: 'Text cleared',
    objection: 'Record objection', objectionT: 'Record the employee’s correction or objection', objSummary: 'Summary of what the employee raised', objOutcome: 'Outcome', objSaved: 'Recorded',
    objections: 'Objections', featureOff: 'The AI talent portrait feature is off and there is no confirmed portrait. A super admin can turn it on under Audit Log › AI Governance.', genBlockedNc: 'The AI service is not connected yet, so drafts cannot be generated.', genBlockedBudget: "This month's AI usage limit has been reached, so drafts cannot be generated.", readOnly: 'The AI module or the portrait feature is off: the confirmed version below is read-only.', empty: 'No portrait yet.',
    self: 'You cannot generate or confirm a portrait of yourself.',
    errs: {
      portrait_unsupported: (d) => `${d.unsupported} judgement(s) have no evidence. Delete or rewrite them before confirming.`,
      ai_self_subject: () => 'You cannot generate or confirm a portrait of yourself.',
     
      ai_feature_off: () => 'The AI talent portrait is not enabled.', ai_not_configured: () => 'The AI service is not connected yet.',
      ai_rate_limited: (d) => `Too many requests. Try again in ${Math.max(1, Math.ceil((d.retryAfterSec || 60) / 60))} min.`,
      ai_budget_exhausted: () => "This month's AI usage limit has been reached.", ai_timeout: () => 'The AI service timed out. Try again later (portraits are not retried automatically).',
      ai_output_invalid: () => 'The AI response was incomplete. Please retry.', ai_output_truncated: () => 'The AI response was incomplete. Please retry.',
    },
  },
};

const fmt = (iso) => (iso ? fmtDateTime(iso) : '—');;

export default function PortraitCard({ userId, canWrite, className }) {
  const { lang, loc } = useI18n();
  const s = T[lang];
  const q = useAsync(() => api.get(`/api/admin/talent-portraits?userId=${encodeURIComponent(userId)}`), [userId]);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(null); // { id, content }
  const [objFor, setObjFor] = useState(null);
  const [objSum, setObjSum] = useState('');
  const [objOut, setObjOut] = useState('');
  const [showHist, setShowHist] = useState(false);

  if (q.loading) return <div className={'ppl-card ppl-ai ' + (className || '')}><Spin /></div>;
  if (q.error) return null;
  const d = q.data;
  const aiOn = !['off_module', 'off_owner', 'off_feature'].includes(d.state);
  // CX-134：AI 模块开着、画像功能关闭且没有已确认版本时，页签里写明原因（原来整块空白）
  if (!aiOn && !d.current) return <div className={'ppl-card ppl-ai ' + (className || '')}><div className="ppl-sec-h"><h2>{s.title}</h2></div><Text type="tertiary" size="small">{s.featureOff}</Text></div>;
  const genBlocked = !d.canGenerate && !d.self && (d.state === 'not_configured' ? s.genBlockedNc : d.state === 'budget_exhausted' ? s.genBlockedBudget : '');

  const gen = async () => {
    setBusy(true);
    try { await api.post(`/api/admin/employees/${userId}/ai-portrait`, {}); q.reload(); }
    catch (e) { Toast.error(errText(e, s.errs)); }
    setBusy(false);
  };
  const act = async (id, action, body, ok) => {
    setBusy(true);
    try { await api.post(`/api/admin/talent-portraits/${id}/${action}`, body || {}); Toast.success(ok); setEditing(null); q.reload(); return true; }
    catch (e) { Toast.error(errText(e, s.errs)); return false; }
    finally { setBusy(false); }
  };
  const discard = (p) => {
    let reason = '';
    Modal.confirm({
      title: s.discardT, okText: s.discard, cancelText: s.cancel, okButtonProps: { type: 'danger' },
      content: <Input placeholder={s.discardReason} onChange={(v) => { reason = v; }} />,
      onOk: () => act(p.id, 'discard', { reason }, s.discarded),
    });
  };
  const unsupportedIn = (c) => [c.summary, c.readiness, ...(c.strengths || []), ...(c.risks || []), ...(c.development || [])].filter((x) => x && x.unsupported).length;

  const Evidence = ({ ev }) => (ev && ev.length ? (
    <span className="ppt-ev">{s.evidence}: {ev.map((e) => <Tag key={e.ref} size="small" type="ghost" shape="circle">{e.date} · {lang === 'zh' ? e.typeLabel_zh || e.typeLabel : e.typeLabel}</Tag>)}</span>
  ) : null);
  const Item = ({ it }) => (
    <div className={'ppt-item' + (it.unsupported ? ' bad' : '')}>
      <span>{loc(it, 'text') || s.none}</span>
      {it.unsupported && <Tag size="small" color="red" type="light" shape="circle">{s.unsupported}</Tag>}
      {it.edited && <Tag size="small" color="grey" type="light" shape="circle">{s.edited}</Tag>}
      <Evidence ev={it.evidence} />
    </div>
  );
  const View = ({ c }) => (
    <div className="ppl-ai-out">
      <div className="ppl-ai-row ppl-ai-sum"><span className="k">{s.summary}</span><div><Item it={c.summary} /></div></div>
      {[['strengths', 'str'], ['risks', 'risk'], ['development', 'dev']].map(([k, tone]) => (
        <div className={'ppl-ai-row ppl-ai-' + tone} key={k}><span className="k">{s[k]}</span><div>{(c[k] || []).length ? c[k].map((it, i) => <Item key={i} it={it} />) : <Text type="tertiary">{s.none}</Text>}</div></div>
      ))}
      <div className="ppl-ai-row ppl-ai-ready"><span className="k">{s.readiness}</span><div><b>{s.level[c.readiness.level] || c.readiness.level}</b><Item it={c.readiness} /></div></div>
      {c.excludedInjection > 0 && <Text type="tertiary" size="small">{s.excluded(c.excludedInjection)}</Text>}
    </div>
  );
  // 编辑：逐条改写或删除；改写过的判断由 HR 负责，不再算「无依据」（服务端逐字比对判定）
  // 渲染函数而不是组件：组件在每次渲染时都是新类型，输入框会在每个按键后失焦
  const renderEditor = () => {
    const c = editing.content;
    const set = (next) => setEditing({ ...editing, content: next });
    const field = (it, onChange) => (
      <div className="ppt-edit">
        <TextArea autosize value={it.text} onChange={(v) => onChange({ ...it, text: v, unsupported: false, edited: true })} placeholder="English" />
        <TextArea autosize value={it.text_zh} onChange={(v) => onChange({ ...it, text_zh: v, unsupported: false, edited: true })} placeholder="中文" />
        {it.unsupported && <Tag size="small" color="red" type="light" shape="circle">{s.unsupported}</Tag>}
      </div>
    );
    return (
      <div className="ppl-ai-out">
        <div className="ppl-ai-row"><span className="k">{s.summary}</span>{field(c.summary, (v) => set({ ...c, summary: v }))}</div>
        {['strengths', 'risks', 'development'].map((k) => (
          <div className="ppl-ai-row" key={k}><span className="k">{s[k]}</span>
            <div>
              {(c[k] || []).map((it, i) => (
                <div key={i} className="ppt-edit-row">
                  {field(it, (v) => set({ ...c, [k]: c[k].map((x, j) => (j === i ? v : x)) }))}
                  <Button size="small" theme="borderless" type="danger" onClick={() => set({ ...c, [k]: c[k].filter((_, j) => j !== i) })}>{s.del}</Button>
                </div>
              ))}
              <Button size="small" theme="borderless" onClick={() => set({ ...c, [k]: [...(c[k] || []), { text: '', text_zh: '', evidence: [], unsupported: false, edited: true }] })}>{s.add}</Button>
            </div>
          </div>
        ))}
        <div className="ppl-ai-row"><span className="k">{s.readiness}</span>
          <div>
            <Select value={c.readiness.level} onChange={(v) => set({ ...c, readiness: { ...c.readiness, level: v, edited: true } })} optionList={LEVELS.map((l) => ({ value: l, label: s.level[l] }))} style={{ width: 200, marginBottom: 6 }} />
            {field(c.readiness, (v) => set({ ...c, readiness: { ...v, level: c.readiness.level } }))}
          </div>
        </div>
        {unsupportedIn(c) > 0 && <Banner type="warning" fullMode={false} closeIcon={null} description={s.unsupportedLeft(unsupportedIn(c))} />}
        <div className="ppt-acts">
          <Button theme="solid" type="primary" loading={busy} disabled={unsupportedIn(c) > 0} onClick={() => act(editing.id, 'confirm', { content: c }, s.confirmedOk)}>{s.save}</Button>
          <Button onClick={() => setEditing(null)}>{s.cancel}</Button>
        </div>
      </div>
    );
  };

  return (
    <div className={'ppl-card ppl-ai ' + (className || '')}>
      <div className="ppl-sec-h">
        <h2>{s.title}</h2>
        {aiOn && (d.canGenerate || genBlocked) && canWrite && <Button theme="solid" type="primary" loading={busy} disabled={!!genBlocked} onClick={gen}>{busy ? s.genning : d.drafts.length ? s.regen : s.gen}</Button>}
      </div>
      {aiOn && d.canGenerate && canWrite && <div className="ppt-sends">{s.sends}</div>}
      {aiOn && genBlocked && canWrite && <div className="ppt-sends">{genBlocked}</div>}
      {d.self && <Text type="tertiary" size="small">{s.self}</Text>}
      {!aiOn && <Banner type="info" fullMode={false} closeIcon={null} description={s.readOnly} />}

      {d.drafts.map((p) => (
        <div className="ppt-draft" key={p.id}>
          <Banner type="warning" fullMode={false} closeIcon={null} description={p.demo ? s.demoBanner : s.draftBanner} />
          <div className="ppt-prov">{s.prov(p.provenance.modelReturned || p.provenance.model || 'demo', fmt(p.generatedAt), p.generatedBy)}</div>
          {p.inputChanged && <Text type="warning" size="small">{s.stale}</Text>}
          {editing && editing.id === p.id ? renderEditor() : (
            <>
              <View c={p.content} />
              {canWrite && !d.self && (
                <div className="ppt-acts">
                  <Button theme="solid" type="primary" loading={busy} disabled={p.unsupportedCount > 0} onClick={() => act(p.id, 'confirm', {}, s.confirmedOk)}>{s.confirm}</Button>
                  <Button onClick={() => setEditing({ id: p.id, content: JSON.parse(JSON.stringify(p.content)) })}>{s.editConfirm}</Button>
                  <Button type="danger" theme="borderless" onClick={() => discard(p)}>{s.discard}</Button>
                  {p.unsupportedCount > 0 && <Text type="warning" size="small">{s.unsupportedLeft(p.unsupportedCount)}</Text>}
                </div>
              )}
            </>
          )}
        </div>
      ))}

      {d.current ? (
        <div className="ppt-current">
          <div className="ppt-prov">{s.confirmedBy(d.current.confirmedBy, fmt(d.current.confirmedAt))} · {s.prov(d.current.provenance.modelReturned || d.current.provenance.model || 'demo', fmt(d.current.generatedAt))}</div>
          {d.current.inputChanged && <Text type="warning" size="small">{s.stale}</Text>}
          <View c={d.current.content} />
          {(d.current.objections || []).length > 0 && (
            <div className="ppt-obj">
              <b>{s.objections}</b>
              {d.current.objections.map((o, i) => <div key={i}><Text type="tertiary" size="small">{fmt(o.at)} · {o.by}</Text><div>{o.summary}</div>{o.outcome && <div><Text type="tertiary" size="small">{s.objOutcome}：</Text>{o.outcome}</div>}</div>)}
            </div>
          )}
          {canWrite && <Button size="small" theme="borderless" onClick={() => { setObjFor(d.current.id); setObjSum(''); setObjOut(''); }}>{s.objection}</Button>}
        </div>
      ) : (!d.drafts.length && <Text type="tertiary" size="small">{s.empty}</Text>)}

      {d.history.length > 0 && (
        <div className="ppt-hist">
          <Button size="small" theme="borderless" onClick={() => setShowHist((v) => !v)}>{s.history} · {d.history.length}</Button>
          {showHist && d.history.map((h) => (
            <div key={h.id} className="ppt-hist-row">
              <Text size="small">{fmt(h.generatedAt)} · {h.status === 'superseded' ? s.superseded : s.discardedSt}{h.discardReason === 'expired' ? ` · ${s.expired}` : h.discardReason ? ` · ${h.discardReason}` : ''}</Text>
              {h.content ? <View c={h.content} /> : <Text type="tertiary" size="small"> · {s.noText}</Text>}
            </div>
          ))}
        </div>
      )}

      <Modal title={s.objectionT} visible={!!objFor} onCancel={() => setObjFor(null)} okText={s.save} cancelText={s.cancel}
        onOk={async () => { if (await act(objFor, 'objection', { summary: objSum, outcome: objOut }, s.objSaved)) setObjFor(null); }}>
        <TextArea autosize value={objSum} onChange={setObjSum} placeholder={s.objSummary} maxLength={1000} />
        <TextArea autosize value={objOut} onChange={setObjOut} placeholder={s.objOutcome} maxLength={500} style={{ marginTop: 8 }} />
      </Modal>
    </div>
  );
}
