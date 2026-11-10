// 功能模块 —— 超级管理员在后台开关可售模块与 AI 的各项功能（负责人 9/28 决定，取代 AI 治理方案 8.3「开关只在配置文件」）。
//   GET /api/admin/modules-config → { modules:[{id,name,on,configured,defaultOn,forcedOff}], ai:{features:[…], providerConfigured, providerReason, demo} }
//   PUT /api/admin/modules-config  { modules:{id:bool}, aiFeatures:{id:bool} } → 写回 config.json（原子写、其它键原样保留），审计 module.config.change
// 关闭前弹出影响说明（入口全部隐藏、数据保留、随时可再开）；密钥类（AI 密钥、culture.raterKey）不在本页编辑，由 IT 按 HANDOVER-IT 配置。
// 环境变量 LMS_MODULES_OFF 强制关闭的模块只读显示（优先于 config.json，改后需重启）。
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Switch, Toast, Banner, Spin, Modal, Tag, Typography } from '@douyinfe/semi-ui';
import { api, useAsync } from '../../api.js';
import { useAuth } from '../../auth.jsx';
import { useI18n } from '../../i18n.jsx';
import { SettingsWorkspace } from '../../v2.jsx';
import { isSuperAdmin } from '../../rbac.js';

const { Text } = Typography;

const T = {
  zh: {
    title: '功能模块', lead: '开关可售模块与 AI 各项功能。保存立即生效，改动写入审计日志；关闭只隐藏入口，数据全部保留，重新开启即恢复。',
    notSuper: '只有超级管理员可以管理功能模块。', loadFail: '加载失败，请刷新页面重试。',
    secModules: '模块', secAi: 'AI 功能', aiGovLink: 'AI 治理（接入状态、用量、调用记录）',
    on: '已开启', off: '已关闭', forced: '已由服务器环境变量强制关闭（LMS_MODULES_OFF），如需开启请联系 IT 并重启服务。',
    defaultOff: '默认关闭', defaultOn: '默认开启',
    desc: {
      learning: '课程、发展项目、考试、题库、培训报表，以及员工端「培训」入口。',
      performance: '评估周期、自评与上级评级、绩效评估页，含绩效申诉与 HRBP 分工。关闭后「绩效记录」仍在员工档案中保留。',
      talent: '人才盘点九宫格、晋升评审候选、继任计划、人才筛选、AI 人才画像。',
      culture: '行为实践模块 Action 3+3 挑战：学员端、例会、认可卡与计分。',
      ai: 'AI 辅助：学习助手、AI 出题、简答题 AI 初评、AI 人才画像。数据会发送给公司指定的 AI 服务，须 IT 完成接入后开启。',
    },
    aiDesc: {
      assistant: '员工在课程页向 AI 提问；回答只作学习参考。',
      questionGen: 'HR 在题库用 AI 起草题目，逐题审阅后采纳。',
      translate: 'HR 编辑课程、小节、题目、考试时一键中英互译，译文填进表单，检查后保存。',
      grading: '交卷后 AI 按评分标准给简答题初评；分数决定是否通过时须 HR 复核。',
      portrait: '根据员工的结构化发展记录起草人才画像，须 HR 确认后生效。默认关闭。',
      talentFilter: 'HR 在人才筛选中用一句话描述要找的人，AI 将其转换为筛选条件，核对后再查询。只发送这句话（人名先脱敏），不发送任何员工数据。默认开启。',
    },
    aiModuleOff: 'AI 模块关闭时，下列开关保存后在模块开启时生效。',
    aiNotConfigured: (r) => `AI 服务尚未接入（${r}）：即使开启，各功能也会显示「未接入」，简答题由 HR 人工评分。接入方法见 HANDOVER-IT §10。`,
    aiDemo: '当前为演示模式（config.json 中 ai.demo: true）：不调用任何 AI 服务，演示内容不计入成绩。',
    confirmOffT: (n) => `关闭「${n}」？`,
    confirmOff: '关闭后该模块的全部入口立即隐藏，相关接口返回「不存在」；数据全部保留，重新开启即恢复。本次修改会写入审计日志。',
    confirmAiOn: '开启后，所开启的 AI 功能会把去标识化的数据发送给公司指定的 AI 服务。请确认 IT 已完成接入（HANDOVER-IT §10）。',
    confirmOnT: (n) => `开启「${n}」？`,
    // 第二批 2.8（政策审查 5）：关闭绩效模块前，列出申诉期限未届满或有申诉在处理中的周期
    perfOpenWarn: '以下评估周期的申诉期限尚未届满或有申诉在处理中。关闭后员工将无法查看或提出申诉，HRBP 也无法处理：',
    perfOpenRow: (name, dl, n) => `「${name}」${dl ? ` · 申诉截止 ${dl}` : ''}${n ? ` · 处理中 ${n} 条` : ''}`,
    ok: '确认', cancel: '取消', saved: '已保存，立即生效', saveFail: '保存失败',
    secrets: '密钥类配置（AI 服务的地址与密钥、行为实践的评分密钥等）不在本页编辑，由 IT 在服务器上配置。',
  },
  en: {
    title: 'Modules', lead: 'Turn sellable modules and each AI feature on or off. Changes apply at once and are written to the audit log; turning a module off only hides its entry points — all data is kept and comes back when it is turned on again.',
    notSuper: 'Only a super admin can manage modules.', loadFail: 'Couldn’t load. Refresh the page to try again.',
    secModules: 'Modules', secAi: 'AI features', aiGovLink: 'AI governance (status, usage, call log)',
    on: 'On', off: 'Off', forced: 'Forced off by the server environment variable LMS_MODULES_OFF. Ask IT to change it and restart the service.',
    defaultOff: 'Off by default', defaultOn: 'On by default',
    desc: {
      learning: 'Courses, development programs, exams, question bank, training reports, and the employee “Learning” menu.',
      performance: 'Review cycles, self-reviews and manager ratings, the Performance Reviews page; includes performance appeals and HRBP coverage. Performance Records stay in employee profiles.',
      talent: 'Talent review 9-box, promotion panel candidates, succession plans, talent filters, AI talent portraits.',
      culture: 'The Behavior Practice module Action 3+3 Challenge: learner app, team meetings, recognition cards and scoring.',
      ai: 'AI Assist: study assistant, AI question drafting, AI pre-scoring of short answers, AI talent portraits. Data is sent to the company-designated AI service — turn on only after IT has connected it.',
    },
    aiDesc: {
      assistant: 'Employees ask AI about the course they are on; answers are for learning support only.',
      questionGen: 'HR drafts questions with AI in the question bank and adopts them one by one.',
      translate: 'HR translates courses, sections, questions and exams between Chinese and English in one click; the translation is filled into the form to check before saving.',
      grading: 'After submission AI pre-scores short answers against the rubric; HR reviews when the score decides pass or fail.',
      portrait: 'Drafts a talent portrait from structured development records; takes effect only after HR confirms. Off by default.',
      talentFilter: 'In talent filters, HR describes the people they need in one sentence and AI turns it into filter conditions to check before running. Only that sentence is sent (names masked first), never employee data. On by default.',
    },
    aiModuleOff: 'The AI module is off: these switches are saved and apply once it is turned on.',
    aiNotConfigured: (r) => `The AI service is not connected yet (${r}). Even when on, the features show “not connected” and short answers go to HR scoring. See HANDOVER-IT §10.`,
    aiDemo: 'Demo mode is on (ai.demo: true in config.json): no AI service is called and demo content never counts toward results.',
    confirmOffT: (n) => `Turn off “${n}”?`,
    confirmOff: 'All of its entry points disappear at once and its APIs answer “not found”; all data is kept and comes back when you turn it on again. This change is written to the audit log.',
    confirmAiOn: 'Once on, the AI features you enable send de-identified data to the company-designated AI service. Confirm that IT has connected it (HANDOVER-IT §10).',
    confirmOnT: (n) => `Turn on “${n}”?`,
    perfOpenWarn: 'The following cycles have an open appeal window or appeals in progress. If you turn this module off, employees cannot view or file appeals and HRBPs cannot handle them:',
    perfOpenRow: (name, dl, n) => `${name}${dl ? ` · appeal deadline ${dl}` : ''}${n ? ` · ${n} in progress` : ''}`,
    ok: 'Confirm', cancel: 'Cancel', saved: 'Saved — in effect now', saveFail: 'Save failed',
    secrets: 'Secrets (the AI service address and key, the Behavior Practice rater key, …) are not edited here; IT configures them on the server.',
  },
};

export default function Modules() {
  const navigate = useNavigate();
  const { lang, loc } = useI18n();
  const s = T[lang];
  const { user, refresh } = useAuth();
  const allowed = isSuperAdmin(user);
  const q = useAsync(() => (allowed ? api.get('/api/admin/modules-config') : Promise.resolve(null)), [allowed]);
  const [busy, setBusy] = useState(null);

  if (!allowed) return <div className="wrap"><h1 className="tset-title">{s.title}</h1><Banner type="warning" fullMode={false} closeIcon={null} description={s.notSuper} /></div>;
  if (q.loading) return <div className="wrap"><Spin /></div>;
  if (q.error || !q.data) return <div className="wrap"><Banner type="danger" fullMode={false} closeIcon={null} description={s.loadFail} /></div>;
  const data = q.data;
  const aiMod = data.modules.find((m) => m.id === 'ai');

  const save = async (patch, key) => {
    setBusy(key);
    try {
      await api.put('/api/admin/modules-config', patch);
      Toast.success(s.saved);
      q.reload();
      if (typeof refresh === 'function') refresh();
    } catch (e) {
      Toast.error((e && e.message) || s.saveFail);
    } finally { setBusy(null); }
  };
  const ask = (title, content, onOk) => Modal.confirm({ title, content, okText: s.ok, cancelText: s.cancel, onOk });
  // 关闭绩效模块前查一次申诉统计（超级管理员可读），有未届满的申诉期限或处理中的申诉就在确认框里列出；查不到（老服务）照旧只给通用说明
  const perfOpenCycles = () => api.get('/api/admin/review-appeals/stats')
    .then((r) => ((r && Array.isArray(r.cycles)) ? r.cycles : []).filter((c) => c && (c.windowOpen || Number(c.open) > 0)))
    .catch(() => []);
  const toggleModule = (m, next) => {
    // CX-068：模块名是 { zh, en } 对象 —— 先按对象取当前语言；loc() 只认 name / name_zh 两个字段，遇到对象会原样返回，标题显示成 [object Object]
    const name = (m.name && typeof m.name === 'object' ? (m.name[lang] || m.name.en) : loc(m, 'name')) || m.id;
    const run = () => save({ modules: { [m.id]: next } }, m.id);
    if (!next && m.id === 'performance') {
      perfOpenCycles().then((list) => ask(s.confirmOffT(name), list.length ? (
        <div>
          <p style={{ margin: '0 0 8px' }}>{s.confirmOff}</p>
          <p style={{ margin: '0 0 6px', color: 'var(--danger)' }}>{s.perfOpenWarn}</p>
          <ul style={{ margin: 0, paddingLeft: 18 }}>{list.map((c) => <li key={c.cycleId}>{s.perfOpenRow(c.name || c.cycleId, c.windowOpen ? c.deadline : '', Number(c.open) || 0)}</li>)}</ul>
        </div>
      ) : s.confirmOff, run));
    } else if (!next) ask(s.confirmOffT(name), s.confirmOff, run);
    else if (m.id === 'ai') ask(s.confirmOnT(name), s.confirmAiOn, run);
    else run();
  };
  const toggleFeature = (f, next) => {
    const name = (f.name && (f.name[lang] || f.name.en)) || f.id;
    const run = () => save({ aiFeatures: { [f.id]: next } }, 'ai:' + f.id);
    if (next) ask(s.confirmOnT(name), s.confirmAiOn, run); else run();
  };
  const nameOf = (m) => (m.name && (m.name[lang] || m.name.en)) || m.id;

  return (
    <div className="wrap mods-wrap">
      <div className="tset-head">
        <div><h1 className="tset-title">{s.title}</h1><div className="tset-lead">{s.lead}</div></div>
      </div>

      {/* Layout v2：两个分节改成左页签右面板（SettingsWorkspace，v2.css .v2-settings-workspace） */}
      <SettingsWorkspace>
      <div className="ppl-card" data-section={s.secModules}>
        <div className="ppl-sec-h"><div><h2>{s.secModules}</h2></div></div>
        <div className="mods-list">
          {data.modules.map((m) => (
            <div className="mods-row" key={m.id}>
              <div className="mods-main">
                <div className="mods-name">
                  <b>{nameOf(m)}</b>
                  <Tag size="small" color={m.on ? 'green' : 'grey'} type="light" shape="circle">{m.on ? s.on : s.off}</Tag>
                  <Text type="tertiary" size="small">{m.defaultOn ? s.defaultOn : s.defaultOff}</Text>
                </div>
                <div className="mods-desc">{s.desc[m.id] || ''}</div>
                {m.forcedOff && <div className="mods-note">{s.forced}</div>}
              </div>
              <Switch checked={m.on} disabled={m.forcedOff || busy === m.id} loading={busy === m.id}
                onChange={(v) => toggleModule(m, v)} aria-label={nameOf(m)} />
            </div>
          ))}
        </div>
      </div>

      <div className="ppl-card" data-section={s.secAi}>
        <div className="ppl-sec-h"><div><h2>{s.secAi}</h2></div><button type="button" className="dash-cardlink" onClick={() => navigate('/admin/audit?section=ai')}>{s.aiGovLink} →</button></div>
        {aiMod && !aiMod.on && <Banner type="info" fullMode={false} closeIcon={null} description={s.aiModuleOff} style={{ marginBottom: 10 }} />}
        {aiMod && aiMod.on && data.ai.demo && <Banner type="warning" fullMode={false} closeIcon={null} description={s.aiDemo} style={{ marginBottom: 10 }} />}
        {aiMod && aiMod.on && !data.ai.demo && !data.ai.providerConfigured && <Banner type="warning" fullMode={false} closeIcon={null} description={s.aiNotConfigured(data.ai.providerReason || 'no_provider')} style={{ marginBottom: 10 }} />}
        <div className="mods-list">
          {data.ai.features.map((f) => (
            <div className="mods-row" key={f.id}>
              <div className="mods-main">
                <div className="mods-name">
                  <b>{(f.name && (f.name[lang] || f.name.en)) || f.id}</b>
                  <Tag size="small" color={f.enabled ? 'green' : 'grey'} type="light" shape="circle">{f.enabled ? s.on : s.off}</Tag>
                  <Text type="tertiary" size="small">{f.defaultOn ? s.defaultOn : s.defaultOff}</Text>
                </div>
                <div className="mods-desc">{s.aiDesc[f.id] || ''}</div>
              </div>
              <Switch checked={f.enabled} disabled={busy === 'ai:' + f.id} loading={busy === 'ai:' + f.id}
                onChange={(v) => toggleFeature(f, v)} aria-label={(f.name && (f.name[lang] || f.name.en)) || f.id} />
            </div>
          ))}
        </div>
        <div className="tset-renamehint">{s.secrets}</div>
      </div>
      </SettingsWorkspace>
    </div>
  );
}
