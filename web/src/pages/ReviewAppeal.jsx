// 绩效申诉 · 员工端（第二批 2.8，2026-10-08；设计 appeal-design §8.1–8.3，负责人 10/8 定：系统内申诉取代 Lark）。
//   AppealLine   「我的绩效」卡片上的申诉行（Review.jsx HistoryPanel 引用）：可申诉 + 截止日 / 已提交 / 处理中 / 维持 / 调整 / 已撤回 / 已过期限；
//                不开放申诉（服务端 appeal: null）时什么都不显示。
//   AppealPage   申诉整页（/review?view=history&item=<reviewItemId>）：书面说明 + 佐证材料（PDF / PNG / JPG，最多 5 个、每个 ≤10 MB）、
//                确认弹窗、撤回；已提交后只读，有结论后显示结论、HRBP 答复与最终评级。数据 GET / POST /api/me/reviews/:itemId/appeal。
//   ConsultView  申诉征询（/review?view=consult[&item=<consultId>]）：HRBP 征询直属上级 / 部门负责人的意见；列表 + 整页详情，意见只能提交一次。
// 员工只看结论、HRBP 答复与当前最终评级：页面不读、也不显示调整前的评级、内部说明、处理人或答复时限（服务端也不下发，见设计 §4.7）。
// 佐证材料在页内查看（PdfViewer / <img>），不在新标签页直接打开：附件接口可能拦截直接打开（feasibility 评审 #9）。
// 员工端页面：不 import Semi；确认用 .exam-overlay > .exam-dialog；样式 .rv-ap-* / .rv-cs-* 在 app.css 追加段。
import Overlay from '../components/Overlay.jsx';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, useAsync } from '../api.js';
import { errText } from '../apierr.js';
import ModuleTrail from '../components/ModuleTrail.jsx';
import PdfViewer from '../components/PdfViewer.jsx';
import { useLeaveGuard, confirmLeave } from '../components/useLeaveGuard.js';
import { localDay } from '../deptcal.js';
import { APPEAL_CATEGORIES, categoryLabel } from '../appealcats.js';   // 绩效看板第二期：申诉原因分类（迁移 97）
import {
  limitsOf, appealCardState, appealDecided, reasonLen, reasonOk, activeFiles, canAddFile, slotsLeft,
  fileCheck, fmtSize, consultPill, opinionOk, OPINION_LIMITS,
} from '../reviewappeal.js';

const T = {
  zh: {
    trailRoot: '绩效评估', trailHistory: '我的绩效', trailConsult: '申诉征询',
    back: '返回我的绩效', backConsult: '返回申诉征询',
    loading: '加载中…', loadErr: '加载失败，请刷新页面重试。', notFound: '未找到该申诉。',
    apTitleShort: '最终评级申诉', finalRating: '最终评级',
    // 卡片上的申诉行
    cardOpen: '可提出申诉', apDeadline: (d) => `如对最终评级有异议，可提出申诉，截止日为 ${d}（含当日）`,
    fileBtn: '提出申诉', viewAppeal: '查看申诉', viewOutcome: '查看结论',
    stSubmitted: '已提交申诉', stInReview: '申诉处理中', stMaintained: '维持原评级', stAdjusted: '评级已调整', stWithdrawn: '已撤回申诉',
    stExpired: '已过申诉期限，视为认可评级',
    // 申诉表单
    policy: '根据公司绩效管理制度，对最终评级有异议的员工，可在结果正式告知之日起 5 个工作日内提出申诉；逾期未提出视为认可评级，逾期提交的申诉不予处理。',
    windowLine: (comm, dl) => `结果告知日：${comm} · 申诉截止：${dl}（马尼拉时间当日 23:59）`,
    reasonLab: '书面说明',
    reasonHint: '请具体说明你对最终评级的哪些方面有异议，并列出支持你观点的事实，例如目标完成情况、主要工作成果、关键事件及发生时间。',
    counter: (n, min) => `已输入 ${n} 字，至少 ${min} 字`, counterMax: (n, max) => `已输入 ${n} 字，最多 ${max} 字`,
    filesLab: '佐证材料（选填）', filesHint: '支持 PDF、PNG、JPG，单个文件不超过 10 MB，最多 5 个。',
    addFile: '添加文件', remove: '移除', uploading: '上传中…', filesUsed: (n, max) => `已添加 ${n} / ${max} 个`,
    recipients: (names) => `提交给：${names}（HRBP）`, recipientsHr: '提交给：人力资源部', nameSep: '、',
    submit: '提交申诉', cancel: '取消', submitting: '提交中…',
    confirmTitle: '确认提交申诉',
    confirmBody: '每个评估周期只能提出一次申诉。负责处理的 HR（HRBP 或其他 HR）开始处理前你可以撤回；撤回后视为认可评级，本周期不能再次申诉。',
    confirmBtn: '确认提交',
    unsaved: '申诉尚未提交，离开后已填写的内容和已添加的文件不会保存。确定离开吗？',
    // 已提交 / 处理中
    langKey: 'zh', catLab: '申诉原因', catHint: '选择最主要的一项；HR 处理时可能会改正分类。', yourCat: '申诉原因',
    submittedOn: (d) => `已于 ${d} 提交`, yourReason: '你的书面说明', yourFiles: '你提交的佐证材料', noFiles: '未提交佐证材料。',
    view: '查看', hide: '收起',
    withdrawHint: '负责处理的 HR（HRBP 或其他 HR）开始处理前你可以撤回申诉。撤回后视为认可评级，本周期不能再次申诉。',
    withdrawBtn: '撤回申诉', withdrawTitle: '确认撤回申诉', withdrawBody: '撤回后视为认可本周期最终评级，且不能再次申诉。',
    withdrawConfirm: '确认撤回', withdrawing: '撤回中…',
    inReview: (d) => `HR 已于 ${d} 开始处理，处理期间不能撤回。结论将通过通知告知你。`,
    // 有结论
    outcome: '申诉结论', decidedOn: (d) => `${d} 作出结论`, reply: 'HR 答复', closedNote: '本周期的申诉已关闭，不能再次申诉。',
    showReason: '查看你提交的书面说明与佐证材料',
    withdrawnNote: (d) => `你已于 ${d} 撤回申诉，视为认可评级。本周期不能再次申诉。`,
    // 不开放申诉（服务端 state = none 时按 reasonCode 说明原因）
    noneDefault: '此评估周期不开放系统内申诉。',
    none: {
      not_communicated: '本周期结果尚未正式告知，申诉期限尚未开始。',
      results_hidden: '本周期评估结果目前不对员工显示，暂不能提出申诉。',
      not_in_service: '已离职员工不能提出申诉。',
      no_record: '本周期没有你的最终评级记录，不能提出申诉。',
      pre_feature: '本周期结果告知早于系统内申诉上线，申诉期限已届满。',
      before_go_live: '本周期结果告知早于系统内申诉上线，申诉期限已届满。',
    },
    // 错误（按服务端 code；文案与设计 §4.8 一致，「申诉说明」按政策用语改为「书面说明」）
    err: {
      not_found: '未找到该申诉。', appeal_not_found: '未找到该申诉。',
      appeal_unavailable: '此评估周期不开放申诉。', appeal_window_closed: '已过申诉期限，视为认可评级。',
      appeal_exists: '本周期已提出过申诉，不能再次申诉。', not_in_service: '已离职员工不能提出申诉。',
      appeal_reason: '书面说明需 50–4000 字。', appeal_attachment: '佐证材料无效或已失效，请重新上传。',
      appeal_file_type: '只支持 PDF、PNG、JPG 文件。', appeal_file_too_large: '单个文件不能超过 10 MB。',
      appeal_upload_rate: '上传次数过多，请明天再试。', appeal_in_review: 'HR 已开始处理，不能撤回申诉。',
      appeal_state: '申诉状态已变化，请刷新后重试。',
      consult_answered: '你已提交过意见，不能修改。', consult_closed: '该申诉已有结论，征询已关闭。', opinion_length: '意见需 10–4000 字。',
      files_full: '已达到文件数量上限。', upload_failed: '上传失败，请重试。',
    },
    // 申诉征询
    csLead: 'HRBP 复核员工对最终评级的申诉时，会征询直属上级或部门负责人（HoD）的意见。你的意见仅供 HRBP 参考，员工看不到。',
    csEmpty: '目前没有需要你提供意见的申诉。',
    relManager: '直属上级', relHod: '部门负责人（HoD）', askedOn: (d) => `征询日期 ${d}`,
    csOpen: '待填写', csAnswered: '已提交意见', csClosed: '已关闭',
    csTitle: (name, cycle) => `${name} · ${cycle}`, csAnnual: '年度',
    csDetailLead: 'HRBP 正在复核员工对最终评级的申诉，并征询你的意见。你的意见仅供 HRBP 参考，员工看不到；评级只能由 HRBP 调整。',
    csYourRole: (r) => `你的身份：${r}`, csSubmittedAt: (d) => `员工于 ${d} 提交申诉`,
    csQuestion: 'HRBP 的问题', csReason: '员工书面说明', csRecord: '评估记录',
    csSelf: '员工自评', csMgrRating: '上级评级', csMgrText: '上级评语', csHighlights: '关键亮点', csHodText: '部门校准说明', csFinal: '最终评级',
    csPrevGoal: (n) => `上一周期目标 ${n}`, csOutcome: (n) => `目标 ${n} 关键成果`, csChallenges: '遇到的挑战', csFeedback: '对团队/公司的建议',
    csGoalsNext: '下一周期目标', csNoSelf: '未提交自评。', csNone: '—',
    csAnnualNote: '年度周期没有员工自评与上级评级，评级由部门负责人（HoD）提议、HR 确认。',
    csOpinion: '你的意见', csOpinionHint: '请就书面说明所涉及的事实和评定依据给出意见。',
    csCounter: (n, min) => `已输入 ${n} 字，至少 ${min} 字`, csCounterMax: (n, max) => `已输入 ${n} 字，最多 ${max} 字`,
    csSubmit: '提交意见', csConfirmTitle: '确认提交意见', csConfirmBody: '提交后不能修改。', csConfirmBtn: '确认提交',
    csAnsweredOn: (d) => `你已于 ${d} 提交意见`, csClosedNote: '该申诉已处理完毕，征询已关闭。',
    csUnsaved: '意见尚未提交，离开后已填写的内容不会保存。确定离开吗？', csSaved: '意见已提交。',
  },
  en: {
    trailRoot: 'Performance Reviews', trailHistory: 'My performance', trailConsult: 'Appeal consultations',
    back: 'Back to My performance', backConsult: 'Back to Appeal consultations',
    loading: 'Loading…', loadErr: 'Couldn’t load. Refresh the page to try again.', notFound: 'Appeal not found.',
    apTitleShort: 'Final rating appeal', finalRating: 'Final rating',
    cardOpen: 'Appeal available', apDeadline: (d) => `If you disagree with your final rating, you may file an appeal by the end of ${d}`,
    fileBtn: 'File an appeal', viewAppeal: 'View appeal', viewOutcome: 'View outcome',
    stSubmitted: 'Appeal submitted', stInReview: 'Under review', stMaintained: 'Rating maintained', stAdjusted: 'Rating adjusted', stWithdrawn: 'Appeal withdrawn',
    stExpired: 'Past the appeal deadline; the rating is deemed acknowledged',
    policy: 'Under the company’s performance management policy, an employee who disputes the final rating may file a formal appeal within five working days of the date the result is officially communicated. If no appeal is filed in time, the rating is deemed acknowledged, and late appeals are not considered.',
    windowLine: (comm, dl) => `Result communicated: ${comm} · Appeal deadline: ${dl}, 11:59 pm Manila time`,
    reasonLab: 'Written explanation',
    reasonHint: 'State which aspects of the final rating you disagree with and the facts that support your view, such as goal attainment, key results, and relevant events with dates.',
    counter: (n, min) => `${n} characters (minimum ${min})`, counterMax: (n, max) => `${n} characters (maximum ${max})`,
    filesLab: 'Supporting documents (optional)', filesHint: 'PDF, PNG or JPG; up to 10 MB each, at most 5 files.',
    addFile: 'Add file', remove: 'Remove', uploading: 'Uploading…', filesUsed: (n, max) => `${n} of ${max} added`,
    recipients: (names) => `Will be sent to: ${names} (HRBP)`, recipientsHr: 'Will be sent to: Human Resources', nameSep: ', ',
    submit: 'Submit appeal', cancel: 'Cancel', submitting: 'Submitting…',
    confirmTitle: 'Submit this appeal?',
    confirmBody: 'You can file one appeal per review cycle. You may withdraw it until HR (your HRBP or the HR handling it) starts the review; once withdrawn, the rating is deemed acknowledged and you cannot appeal this cycle again.',
    confirmBtn: 'Submit',
    unsaved: 'Your appeal has not been submitted. If you leave, the text and files you added will not be saved. Leave this page?',
    langKey: 'en', catLab: 'Reason for the appeal', catHint: 'Choose the main one. HR may correct the category when reviewing.', yourCat: 'Reason',
    submittedOn: (d) => `Submitted on ${d}`, yourReason: 'Your written explanation', yourFiles: 'Your supporting documents', noFiles: 'No supporting documents were submitted.',
    view: 'View', hide: 'Hide',
    withdrawHint: 'You can withdraw the appeal until HR (your HRBP or the HR handling it) starts the review. Once withdrawn, the rating is deemed acknowledged and you cannot appeal this cycle again.',
    withdrawBtn: 'Withdraw appeal', withdrawTitle: 'Withdraw this appeal?', withdrawBody: 'Once withdrawn, the final rating for this cycle is deemed acknowledged and you cannot appeal again.',
    withdrawConfirm: 'Withdraw', withdrawing: 'Withdrawing…',
    inReview: (d) => `HR started the review on ${d}. The appeal can no longer be withdrawn; you will be notified of the outcome.`,
    outcome: 'Outcome', decidedOn: (d) => `Decided on ${d}`, reply: 'HR reply', closedNote: 'The appeal for this cycle is closed and cannot be filed again.',
    showReason: 'Show your written explanation and supporting documents',
    withdrawnNote: (d) => `You withdrew this appeal on ${d}; the rating is deemed acknowledged. You cannot appeal this cycle again.`,
    noneDefault: 'In-system appeal is not available for this review cycle.',
    none: {
      not_communicated: 'Results for this cycle have not been officially communicated; the appeal period has not started.',
      results_hidden: 'Results for this cycle are not currently shown to employees, so an appeal cannot be filed.',
      not_in_service: 'Employees who have left cannot file an appeal.',
      no_record: 'There is no final rating on record for you in this cycle, so an appeal cannot be filed.',
      pre_feature: 'Results for this cycle were communicated before in-system appeals were introduced; the appeal period has ended.',
      before_go_live: 'Results for this cycle were communicated before in-system appeals were introduced; the appeal period has ended.',
    },
    err: {
      not_found: 'Appeal not found.', appeal_not_found: 'Appeal not found.',
      appeal_unavailable: 'Appeals are not available for this review cycle.', appeal_window_closed: 'The appeal deadline has passed; the rating is deemed acknowledged.',
      appeal_exists: 'An appeal has already been filed for this cycle.', not_in_service: 'Employees who have left cannot file an appeal.',
      appeal_reason: 'The written explanation must be 50–4,000 characters.', appeal_attachment: 'One or more supporting documents are invalid. Upload them again.',
      appeal_file_type: 'Only PDF, PNG and JPG files are accepted.', appeal_file_too_large: 'Each file must be 10 MB or smaller.',
      appeal_upload_rate: 'Too many uploads. Try again tomorrow.', appeal_in_review: 'HR has started the review; the appeal can no longer be withdrawn.',
      appeal_state: 'The appeal status has changed. Refresh and try again.',
      consult_answered: 'You have already submitted your opinion; it cannot be changed.', consult_closed: 'This appeal has been decided; the consultation is closed.', opinion_length: 'The opinion must be 10–4,000 characters.',
      files_full: 'You have reached the maximum number of files.', upload_failed: 'The upload failed. Try again.',
    },
    csLead: 'When an HRBP reviews an employee’s appeal against their final rating, they may ask the direct manager or the head of department (HoD) for an opinion. Your opinion is for the HRBP only and is not shown to the employee.',
    csEmpty: 'There are no appeals waiting for your opinion.',
    relManager: 'Direct manager', relHod: 'Head of department (HoD)', askedOn: (d) => `Requested on ${d}`,
    csOpen: 'Awaiting your opinion', csAnswered: 'Opinion submitted', csClosed: 'Closed',
    csTitle: (name, cycle) => `${name} · ${cycle}`, csAnnual: 'Annual',
    csDetailLead: 'An HRBP is reviewing an employee’s appeal against their final rating and has asked for your view. Your opinion is for the HRBP only and is not shown to the employee; only the HRBP can change the rating.',
    csYourRole: (r) => `You are consulted as: ${r}`, csSubmittedAt: (d) => `Appeal submitted on ${d}`,
    csQuestion: 'Question from the HRBP', csReason: 'Employee’s written explanation', csRecord: 'Review record',
    csSelf: 'Self-review', csMgrRating: 'Manager rating', csMgrText: 'Manager comment', csHighlights: 'Highlights', csHodText: 'Calibration note', csFinal: 'Final rating',
    csPrevGoal: (n) => `Previous cycle goal ${n}`, csOutcome: (n) => `Goal ${n} key outcomes`, csChallenges: 'Challenges encountered', csFeedback: 'Suggestions for the team/company',
    csGoalsNext: 'Goals for the next cycle', csNoSelf: 'No self-review was submitted.', csNone: '—',
    csAnnualNote: 'Annual cycles have no self-review or manager rating; the head of department (HoD) proposes the rating and HR confirms it.',
    csOpinion: 'Your opinion', csOpinionHint: 'Comment on the facts raised in the appeal and the basis of the rating.',
    csCounter: (n, min) => `${n} characters (minimum ${min})`, csCounterMax: (n, max) => `${n} characters (maximum ${max})`,
    csSubmit: 'Submit opinion', csConfirmTitle: 'Submit your opinion?', csConfirmBody: 'Your opinion cannot be changed after submission.', csConfirmBtn: 'Submit',
    csAnsweredOn: (d) => `You submitted your opinion on ${d}`, csClosedNote: 'This appeal has been decided and the consultation is closed.',
    csUnsaved: 'Your opinion has not been submitted. If you leave, what you have entered will not be saved. Leave this page?', csSaved: 'Opinion submitted.',
  },
};

const dictOf = (lang) => T[lang === 'zh' ? 'zh' : 'en'];
const day = (v) => localDay(v);
// 服务端 code → 本页文案（errText 回落到服务端 error）
const errMap = (s) => Object.fromEntries(Object.keys(s.err).map((k) => [k, () => s.err[k]]));
const codeOf = (err) => (err && err.data && err.data.code) || null;
// 评级显示名：配置里的中文名（有才用）
export function ratingLabeller(options, optionsZh, lang) {
  return (v) => {
    if (v === null || v === undefined || v === '') return '';
    const i = (options || []).indexOf(v);
    const zh = i >= 0 ? (optionsZh || [])[i] : null;
    return lang === 'zh' && zh ? zh : String(v);
  };
}

// 确认弹窗：外壳用公共的 Overlay（Esc 与点遮罩关闭，提交中不关）
function Confirm({ title, body, okText, cancelText, busy, error, onCancel, onOk }) {
  return (
    <Overlay kind="exam" boxClassName="rv-ap-dialog" label={title} busy={busy} onClose={onCancel}>
        <h3>{title}</h3>
        <p>{body}</p>
        {error && <p className="rv-msg err" role="alert">{error}</p>}
        <div className="exam-dialog-act">
          <button type="button" className="btn ghost" onClick={onCancel} disabled={busy}>{cancelText}</button>
          <button type="button" className="btn" onClick={onOk} disabled={busy} autoFocus>{okText}</button>
        </div>
    </Overlay>
  );
}

// ---------------------------------------------------------------------------
// 「我的绩效」卡片上的申诉行
// ---------------------------------------------------------------------------
export function AppealLine({ appeal, lang, onOpen }) {
  const s = dictOf(lang);
  const c = appealCardState(appeal);
  if (!c) return null;
  if (c.action === 'file') {
    return (
      <div className="rv-ap-line">
        <span className="rv-ap-dl">{s.apDeadline(appeal.deadline)}</span>
        <button type="button" className="btn sm rv-ap-btn" onClick={onOpen}>{s.fileBtn}</button>
      </div>
    );
  }
  if (c.tone === null) return <div className="rv-ap-line"><span className="rv-ap-dl muted">{s[c.labelKey]}</span></div>;
  return (
    <div className="rv-ap-line">
      <span className={'pill' + (c.tone ? ' ' + c.tone : '')}>{s[c.labelKey]}</span>
      {c.action && <button type="button" className="rv-ap-link" onClick={onOpen}>{c.action === 'outcome' ? s.viewOutcome : s.viewAppeal}</button>}
    </div>
  );
}

// 佐证材料：页内查看（PDF 用 PdfViewer，图片用 <img>），一次展开一个
function Attachments({ s, files }) {
  const [open, setOpen] = useState(null);
  if (!files || !files.length) return <div className="rv-note">{s.noFiles}</div>;
  return (
    <ul className="rv-ap-files">
      {files.map((a) => (
        <li key={a.id} className="rv-ap-file">
          <div className="rv-ap-file-row">
            <span className="rv-ap-file-name">{a.name}</span>
            <span className="rv-ap-file-size tnum">{fmtSize(a.size)}</span>
            <button type="button" className="rv-nudge" aria-expanded={open === a.id} onClick={() => setOpen(open === a.id ? null : a.id)}>
              {open === a.id ? s.hide : s.view}
            </button>
          </div>
          {open === a.id && (
            <div className="rv-ap-preview">
              {a.kind === 'pdf' ? <PdfViewer url={a.url} /> : <img className="rv-ap-img" src={a.url} alt={a.name} />}
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}

// ---------------------------------------------------------------------------
// 申诉整页
// ---------------------------------------------------------------------------
export default function AppealPage({ itemId, lang, ratingOptions, ratingOptionsZh, onBack }) {
  const s = dictOf(lang);
  const q = useAsync(() => api.get(`/api/me/reviews/${encodeURIComponent(itemId)}/appeal`), [itemId]);
  // 页面级提示（提交被拒后表单收起、重新加载时显示原因）
  const [notice, setNotice] = useState('');
  const label = ratingLabeller(ratingOptions, ratingOptionsZh, lang);
  const data = q.data && q.data.item && q.data.item.id === itemId ? q.data : null;
  const reload = useCallback((msg) => { setNotice(msg || ''); q.reload(); }, [q]);
  const item = data ? data.item : null;
  // 测试反馈（10/8）：完整周期名放进标题会折成两行 → 标题固定为「最终评级申诉」，周期名放副标题
  const title = item ? s.apTitleShort : s.trailHistory;
  const rating = item ? label(item.rating) : '';
  return (
    <div className="rv-ap-page">
      <ModuleTrail items={[{ label: s.trailRoot, to: '/review' }, { label: s.trailHistory, onClick: onBack }, { label: item ? item.cycle : '…' }]} />
      <button type="button" className="btn ghost sm rv-ap-back" onClick={onBack}><span aria-hidden="true">‹</span>{s.back}</button>
      {!data && q.error && <div className="card rv-empty">{q.error.status === 404 ? s.notFound : s.loadErr}</div>}
      {!data && !q.error && <div className="card rv-note">{s.loading}</div>}
      {data && (
        <>
          <div className="ml-head rv-ap-head">
            <h1 className="ml-title">{title}</h1>
            {item && <div className="ml-sub rv-ap-cycle">{item.cycle}</div>}
            {rating && <span className="pill pri rv-ap-final">{s.finalRating} · {rating}</span>}
          </div>
          {notice && <div className="card rv-ap-notice" role="alert">{notice}</div>}
          <AppealBody s={s} data={data} itemId={itemId} label={label} onBack={onBack} onReload={reload} />
        </>
      )}
    </div>
  );
}

function AppealBody({ s, data, itemId, label, onBack, onReload }) {
  const st = data.state;
  const ap = data.appeal;
  const w = data.window;
  if (st === 'open') return <AppealForm key={itemId} s={s} data={data} itemId={itemId} onBack={onBack} onReload={onReload} />;
  if (st === 'expired') {
    return (
      <div className="card rv-card rv-ap-state">
        <p className="rv-ap-strong">{s.stExpired}</p>
        {w && <p className="rv-hint">{s.windowLine(w.communicatedOn, w.deadline)}</p>}
      </div>
    );
  }
  if (!ap || st === 'none') {
    const txt = (data.reasonCode && s.none[data.reasonCode]) || s.noneDefault;
    return <div className="card rv-card rv-ap-state"><p>{txt}</p></div>;
  }
  if (st === 'withdrawn') {
    return <div className="card rv-card rv-ap-state"><p>{s.withdrawnNote(day(ap.withdrawnAt))}</p></div>;
  }
  if (appealDecided(st)) {
    const c = appealCardState({ state: st });
    return (
      <>
        <div className="card rv-card rv-ap-outcome">
          <div className="rv-head">
            <b className="rv-cycle">{s.outcome}</b>
            <span className={'pill' + (c && c.tone ? ' ' + c.tone : '')}>{c ? s[c.labelKey] : ''}</span>
            {ap.decidedAt && <span className="rv-hint rv-ap-date">{s.decidedOn(day(ap.decidedAt))}</span>}
          </div>
          {ap.reply && <><div className="rv-lab">{s.reply}</div><div className="rv-ap-text">{ap.reply}</div></>}
          {data.item && data.item.rating && (
            <><div className="rv-lab">{s.finalRating}</div><div className="rv-ap-rating">{label(data.item.rating)}</div></>
          )}
          <p className="rv-note rv-ap-closed">{s.closedNote}</p>
        </div>
        <details className="card rv-card rv-ap-more">
          <summary>{s.showReason}</summary>
          <FiledContent s={s} ap={ap} />
        </details>
      </>
    );
  }
  // submitted / in_review
  return <FiledView s={s} ap={ap} st={st} itemId={itemId} onReload={onReload} />;
}

function FiledContent({ s, ap }) {
  return (
    <>
      {ap.category && <><div className="rv-lab">{s.yourCat}</div><div className="rv-ap-text">{categoryLabel(ap.category, s.langKey)}</div></>}
      <div className="rv-lab">{s.yourReason}</div>
      <div className="rv-ap-text">{ap.reason}</div>
      <div className="rv-lab">{s.yourFiles}</div>
      <Attachments s={s} files={ap.attachments} />
    </>
  );
}

function FiledView({ s, ap, st, itemId, onReload }) {
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const withdraw = async () => {
    setBusy(true); setErr('');
    try {
      await api.post(`/api/me/reviews/${encodeURIComponent(itemId)}/appeal/withdraw`, {});
      // 成功后保持 busy：重新加载完成前不能再点（随后本块换成新状态）
      setAsking(false);
      onReload();
    } catch (e) {
      const code = codeOf(e);
      setBusy(false);
      // 状态已变（HRBP 已开始处理等）：关掉弹窗、重新加载，并在页上说明原因
      if (code === 'appeal_in_review' || code === 'appeal_state') { setAsking(false); onReload(errText(e, errMap(s))); return; }
      setErr(errText(e, errMap(s)));
    }
  };
  return (
    <div className="card rv-card rv-ap-filed">
      <div className="rv-head">
        <span className="pill warn">{st === 'in_review' ? s.stInReview : s.stSubmitted}</span>
        {ap.submittedAt && <span className="rv-hint rv-ap-date">{s.submittedOn(day(ap.submittedAt))}</span>}
      </div>
      {st === 'in_review' && <p className="rv-ap-strong">{s.inReview(day(ap.startedAt))}</p>}
      <FiledContent s={s} ap={ap} />
      {st === 'submitted' && (
        <div className="rv-ap-withdraw">
          <p className="rv-hint">{s.withdrawHint}</p>
          <button type="button" className="btn ghost sm" onClick={() => { setErr(''); setAsking(true); }}>{s.withdrawBtn}</button>
        </div>
      )}
      {asking && (
        <Confirm title={s.withdrawTitle} body={s.withdrawBody} okText={busy ? s.withdrawing : s.withdrawConfirm} cancelText={s.cancel}
          busy={busy} error={err} onCancel={() => setAsking(false)} onOk={withdraw} />
      )}
    </div>
  );
}

let fileSeq = 0;
function AppealForm({ s, data, itemId, onBack, onReload }) {
  const limits = limitsOf(data.limits);
  const [reason, setReason] = useState('');
  const [cat, setCat] = useState('');   // 申诉原因分类（必选）
  const [files, setFiles] = useState([]);   // { key, name, size, uploading, id?, kind?, url?, error?, errMsg? }
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [sent, setSent] = useState(false);
  const inputRef = useRef(null);
  const filesRef = useRef(files);
  filesRef.current = files;
  // 上传逐个排队：服务端对同一员工同时进行的上传返回 429（安全评审 #6）
  const queue = useRef(Promise.resolve());
  const dirty = !sent && (reason.trim() !== '' || cat !== '' || activeFiles(files).length > 0);
  useLeaveGuard(dirty, s.unsaved);

  const n = reasonLen(reason);
  const uploading = files.some((f) => f.uploading);
  const ready = reasonOk(reason, limits) && cat !== '' && !uploading && !busy;
  const w = data.window;
  const rc = data.recipients;
  const recipientLine = rc && rc.kind === 'hrbp' && Array.isArray(rc.names) && rc.names.length ? s.recipients(rc.names.join(s.nameSep))
    : rc && (rc.kind === 'hr' || rc.kind === 'hrbp') ? s.recipientsHr : '';

  const patchFile = (key, p) => setFiles((fs) => fs.map((x) => (x.key === key ? { ...x, ...p } : x)));
  const upload = (file, key) => {
    queue.current = queue.current.then(async () => {
      try {
        const path = `/api/me/reviews/appeal-files?item=${encodeURIComponent(itemId)}&name=${encodeURIComponent(file.name || '')}`;
        const r = await api.upload(path, file, { 'content-type': file.type || 'application/octet-stream' });
        patchFile(key, { uploading: false, id: r.id, name: r.name || file.name, kind: r.kind, size: r.size != null ? r.size : file.size, url: r.url });
      } catch (e) {
        const code = codeOf(e);
        patchFile(key, { uploading: false, error: code || 'upload_failed', errMsg: code && s.err[code] ? s.err[code] : (e && e.status ? errText(e, errMap(s)) : s.err.upload_failed) });
      }
    });
  };
  const pick = (e) => {
    const list = Array.from((e.target && e.target.files) || []);
    if (e.target) e.target.value = '';
    let room = slotsLeft(filesRef.current, limits);
    const add = [];
    for (const f of list) {
      const key = ++fileSeq;
      const code = fileCheck(f, limits);
      if (code) { add.push({ key, name: f.name, size: f.size, error: code, errMsg: s.err[code] }); continue; }
      if (room <= 0) { add.push({ key, name: f.name, size: f.size, error: 'files_full', errMsg: s.err.files_full }); continue; }
      room -= 1;
      add.push({ key, name: f.name, size: f.size, uploading: true });
      upload(f, key);
    }
    if (add.length) setFiles((fs) => [...fs, ...add]);
  };
  const remove = (key) => setFiles((fs) => fs.filter((x) => x.key !== key));

  const submit = async () => {
    setBusy(true); setMsg('');
    try {
      const attachmentIds = activeFiles(filesRef.current).filter((f) => f.id).map((f) => f.id);
      await api.post(`/api/me/reviews/${encodeURIComponent(itemId)}/appeal`, { reason: reason.trim(), category: cat, attachmentIds });
      setSent(true); setAsking(false);
      onReload();
    } catch (e) {
      const code = codeOf(e);
      const text = errText(e, errMap(s));
      setBusy(false); setAsking(false);
      // 不能再提交（期限已过、已有申诉、不开放、已离职）：收起表单、重新加载，并说明原因
      if (['appeal_window_closed', 'appeal_exists', 'appeal_unavailable', 'not_in_service', 'not_found'].includes(code)) {
        setSent(true); onReload(text); return;
      }
      setMsg(text);
    }
  };

  const used = activeFiles(files).length;
  return (
    <div className="rv-ap-form">
      <div className="card rv-card rv-note rv-ap-policy">{s.policy}</div>
      {w && <p className="rv-ap-window tnum">{s.windowLine(w.communicatedOn, w.deadline)}</p>}
      <div className="card rv-card">
        <fieldset className="rv-ap-cats" disabled={busy}>
          <legend className="rv-lab rv-ap-lab">{s.catLab}<span className="req">*</span></legend>
          <p className="rv-hint rv-ap-hint">{s.catHint}</p>
          {APPEAL_CATEGORIES.map((c) => (
            <label key={c.key} className={'rv-ap-cat' + (cat === c.key ? ' on' : '')}>
              <input type="radio" name="rv-ap-cat" value={c.key} checked={cat === c.key} onChange={() => setCat(c.key)} />
              <span>{c[s.langKey]}</span>
            </label>
          ))}
        </fieldset>
        <label className="rv-lab rv-ap-lab" htmlFor="rv-ap-reason">{s.reasonLab}<span className="req">*</span></label>
        <p className="rv-hint rv-ap-hint">{s.reasonHint}</p>
        <textarea id="rv-ap-reason" className="rv-ta rv-ap-ta" rows={8} value={reason} disabled={busy}
          onChange={(e) => setReason(e.target.value)} aria-describedby="rv-ap-count" />
        <div id="rv-ap-count" className={'rv-ap-count tnum' + (n > limits.reasonMax ? ' err' : n >= limits.reasonMin ? ' ok' : '')} aria-live="polite">
          {n > limits.reasonMax ? s.counterMax(n, limits.reasonMax) : s.counter(n, limits.reasonMin)}
        </div>

        <div className="rv-lab rv-ap-lab">{s.filesLab}</div>
        <p className="rv-hint rv-ap-hint">{s.filesHint}</p>
        {files.length > 0 && (
          <ul className="rv-ap-files">
            {files.map((f) => (
              <li key={f.key} className={'rv-ap-file' + (f.error ? ' err' : '')}>
                <div className="rv-ap-file-row">
                  <span className="rv-ap-file-name">{f.name}</span>
                  <span className="rv-ap-file-size tnum">{f.uploading ? s.uploading : fmtSize(f.size)}</span>
                  <button type="button" className="rv-nudge" disabled={f.uploading || busy} onClick={() => remove(f.key)}>{s.remove}</button>
                </div>
                {f.error && <div className="rv-msg err">{f.errMsg || s.err.upload_failed}</div>}
              </li>
            ))}
          </ul>
        )}
        <div className="rv-ap-add">
          <input ref={inputRef} type="file" hidden multiple accept="application/pdf,image/png,image/jpeg" onChange={pick} />
          <button type="button" className="btn ghost sm" disabled={busy || !canAddFile(files, limits)} onClick={() => inputRef.current && inputRef.current.click()}>{s.addFile}</button>
          <span className="rv-hint tnum">{s.filesUsed(used, limits.filesMax)}</span>
        </div>
        {recipientLine && <p className="rv-ap-to">{recipientLine}</p>}
        {msg && <p className="rv-msg err" role="alert">{msg}</p>}
      </div>
      <div className="rv-ap-foot">
        <button type="button" className="btn ghost" disabled={busy} onClick={onBack}>{s.cancel}</button>
        <button type="button" className="btn" disabled={!ready} onClick={() => setAsking(true)}>{busy ? s.submitting : s.submit}</button>
      </div>
      {asking && (
        <Confirm title={s.confirmTitle} body={s.confirmBody} okText={busy ? s.submitting : s.confirmBtn} cancelText={s.cancel}
          busy={busy} onCancel={() => setAsking(false)} onOk={submit} />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 申诉征询（直属上级 / 部门负责人）
// ---------------------------------------------------------------------------
export function ConsultView({ lang, params, patch, ratingOptions, ratingOptionsZh, onChanged }) {
  const s = dictOf(lang);
  const nav = useNavigate();
  const fromList = useRef(false);
  const back = useCallback(() => {
    if (!confirmLeave()) return;
    if (fromList.current) { fromList.current = false; nav(-1); return; }
    patch({ item: null }, { push: false });
  }, [nav, patch]);
  const open = useCallback((id) => { fromList.current = true; patch({ item: id }); }, [patch]);
  if (params.item) {
    return <ConsultDetail key={params.item} s={s} lang={lang} consultId={params.item} onBack={back} onChanged={onChanged}
      label={ratingLabeller(ratingOptions, ratingOptionsZh, lang)} />;
  }
  return <ConsultList s={s} onOpen={open} />;
}

const relText = (s, r) => (r === 'hod' ? s.relHod : s.relManager);

function ConsultList({ s, onOpen }) {
  const q = useAsync(() => api.get('/api/me/reviews/appeal-consults'), []);
  const items = q.data && Array.isArray(q.data.items) ? q.data.items : null;
  return (
    <div className="rv-cs-page">
      <p className="rv-note rv-cs-lead">{s.csLead}</p>
      {!items && q.error && <div className="card">{s.loadErr}</div>}
      {!items && !q.error && <div className="card rv-note">{s.loading}</div>}
      {items && items.length === 0 && <div className="card rv-empty">{s.csEmpty}</div>}
      {items && items.length > 0 && (
        <div className="rv-cs-list">
          {items.map((c) => {
            const p = consultPill(c.state);
            return (
              <button key={c.id} type="button" className={'card rv-cs-card' + (c.state === 'open' ? ' open' : '')} onClick={() => onOpen(c.id)}>
                <span className="rv-cs-title">{s.csTitle(c.name, c.cycle)}</span>
                <span className="rv-cs-meta">
                  <span className="pill pri">{relText(s, c.relation)}</span>
                  {c.kind === 'annual' && <span className="pill muted">{s.csAnnual}</span>}
                  {p && <span className={'pill ' + p.tone}>{s[p.labelKey]}</span>}
                  <span className="rv-hint tnum">{s.askedOn(day(c.askedAt))}</span>
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function ConsultDetail({ s, consultId, onBack, onChanged, label }) {
  const q = useAsync(() => api.get(`/api/me/reviews/appeal-consults/${encodeURIComponent(consultId)}`), [consultId]);
  const data = q.data && q.data.consult && q.data.consult.id === consultId ? q.data : null;
  const [notice, setNotice] = useState('');
  const reload = useCallback((msg) => { setNotice(msg || ''); q.reload(); if (onChanged) onChanged(); }, [q, onChanged]);
  const c = data ? data.consult : null;
  const emp = data ? data.employee || {} : {};
  const cycle = data ? data.cycle || {} : {};
  const closed = !!data && (c.state === 'closed' || data.closedNote === true);
  const p = c ? consultPill(closed ? 'closed' : c.state) : null;
  return (
    <div className="rv-cs-page rv-cs-detail">
      <ModuleTrail items={[{ label: s.trailRoot, to: '/review' }, { label: s.trailConsult, onClick: onBack }, { label: emp.name || '…' }]} />
      <button type="button" className="btn ghost sm rv-ap-back" onClick={onBack}><span aria-hidden="true">‹</span>{s.backConsult}</button>
      {!data && q.error && <div className="card rv-empty">{q.error.status === 404 ? s.notFound : s.loadErr}</div>}
      {!data && !q.error && <div className="card rv-note">{s.loading}</div>}
      {data && (
        <>
          <div className="ml-head rv-ap-head">
            <h1 className="ml-title">{s.csTitle(emp.name || '', cycle.name || '')}</h1>
            {p && <span className={'pill ' + p.tone}>{s[p.labelKey]}</span>}
          </div>
          <div className="rv-cs-who">
            {/* 9.1（第三批）：员工端不显示工号 —— 只给职位与部门 */}
            {[emp.position, emp.department].filter(Boolean).map((x, i) => <span key={i}>{x}</span>)}
          </div>
          <p className="rv-hint">{s.csYourRole(relText(s, c.relation))} · {s.askedOn(day(c.askedAt))}</p>
          {notice && <div className="card rv-ap-notice" role="alert">{notice}</div>}
          {closed ? (
            <div className="card rv-card rv-ap-state"><p>{s.csClosedNote}</p></div>
          ) : (
            <>
              <div className="card rv-card rv-note rv-ap-policy">{s.csDetailLead}</div>
              {c.question && (
                <div className="card rv-card">
                  <div className="rv-lab">{s.csQuestion}</div>
                  <div className="rv-ap-text">{c.question}</div>
                </div>
              )}
              {data.appeal && (
                <div className="card rv-card">
                  <div className="rv-lab">{s.csReason}</div>
                  {data.appeal.submittedAt && <p className="rv-hint">{s.csSubmittedAt(day(data.appeal.submittedAt))}</p>}
                  <div className="rv-ap-text">{data.appeal.reason}</div>
                </div>
              )}
              <ConsultRecord s={s} record={data.record} annual={cycle.kind === 'annual'} relation={c.relation} label={label} />
              {c.answeredAt ? (
                <div className="card rv-card">
                  <div className="rv-head"><b className="rv-cycle">{s.csOpinion}</b><span className="pill ok">{s.csAnswered}</span></div>
                  <p className="rv-hint">{s.csAnsweredOn(day(c.answeredAt))}</p>
                  <div className="rv-ap-text">{c.opinion}</div>
                </div>
              ) : (
                <OpinionForm key={c.id} s={s} consultId={c.id} onBack={onBack} onReload={reload} />
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}

// 评估记录：只渲染服务端下发的字段（年度周期没有自评与上级评级；部门校准说明只发给部门负责人）
function ConsultRecord({ s, record, annual, relation, label }) {
  const r = record || {};
  const self = r.selfReview;
  const val = (v) => (v === null || v === undefined || v === '' ? null : v);
  const block = (lab, v) => (val(v) ? <><div className="rv-lab">{lab}</div><div className="rv-ap-text">{v}</div></> : null);
  const prev = self && Array.isArray(self.prevGoals) ? self.prevGoals : [];
  const outs = self && Array.isArray(self.selfOutcomes) ? self.selfOutcomes : [];
  const next = self && Array.isArray(self.goalsNext) ? self.goalsNext.filter((g) => String(g || '').trim()) : [];
  const slots = Math.max(prev.length, outs.length);
  return (
    <div className="card rv-card rv-cs-record">
      <div className="rv-head"><b className="rv-cycle">{s.csRecord}</b></div>
      {annual && <p className="rv-note">{s.csAnnualNote}</p>}
      {!annual && (
        <>
          <div className="rv-part">{s.csSelf}</div>
          {!self ? <p className="rv-note">{s.csNoSelf}</p> : (
            <div className="rv-pack">
              {Array.from({ length: slots }).map((_, i) => (
                <div key={i} className="rv-pack-row">
                  {prev[i] && <div><b>{s.csPrevGoal(i + 1)}</b> <span>{prev[i]}</span></div>}
                  <div><b>{s.csOutcome(i + 1)}</b> <span>{val(outs[i]) || s.csNone}</span></div>
                </div>
              ))}
              {val(self.selfChallenges) && <div className="rv-pack-row"><b>{s.csChallenges}</b> <span>{self.selfChallenges}</span></div>}
              {val(self.selfFeedback) && <div className="rv-pack-row"><b>{s.csFeedback}</b> <span>{self.selfFeedback}</span></div>}
              {next.length > 0 && <div className="rv-pack-row"><b>{s.csGoalsNext}</b> <span>{next.map((g, i) => `${i + 1}. ${g}`).join('\n')}</span></div>}
            </div>
          )}
          {val(r.managerRating) && <><div className="rv-lab">{s.csMgrRating}</div><div className="rv-ap-rating sm">{label(r.managerRating)}</div></>}
          {block(s.csMgrText, r.managerText)}
          {block(s.csHighlights, r.highlights)}
        </>
      )}
      {relation === 'hod' && block(s.csHodText, r.hodText)}
      {val(r.finalRating) && <><div className="rv-lab">{s.csFinal}</div><div className="rv-ap-rating">{label(r.finalRating)}</div></>}
    </div>
  );
}

function OpinionForm({ s, consultId, onBack, onReload }) {
  const [text, setText] = useState('');
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [sent, setSent] = useState(false);
  useLeaveGuard(!sent && text.trim() !== '', s.csUnsaved);
  const n = reasonLen(text);
  const ok = opinionOk(text) && !busy;
  const submit = async () => {
    setBusy(true); setMsg('');
    try {
      await api.post(`/api/me/reviews/appeal-consults/${encodeURIComponent(consultId)}/opinion`, { opinion: text.trim() });
      setSent(true); setAsking(false);
      onReload(s.csSaved);
    } catch (e) {
      const code = codeOf(e);
      const t = errText(e, errMap(s));
      setBusy(false); setAsking(false);
      if (code === 'consult_answered' || code === 'consult_closed' || code === 'not_found') { setSent(true); onReload(t); return; }
      setMsg(t);
    }
  };
  return (
    <div className="rv-ap-form">
      <div className="card rv-card">
        <label className="rv-lab rv-ap-lab" htmlFor="rv-cs-opinion">{s.csOpinion}<span className="req">*</span></label>
        <p className="rv-hint rv-ap-hint">{s.csOpinionHint}</p>
        <textarea id="rv-cs-opinion" className="rv-ta rv-ap-ta" rows={8} value={text} disabled={busy} onChange={(e) => setText(e.target.value)} aria-describedby="rv-cs-count" />
        <div id="rv-cs-count" className={'rv-ap-count tnum' + (n > OPINION_LIMITS.max ? ' err' : n >= OPINION_LIMITS.min ? ' ok' : '')} aria-live="polite">
          {n > OPINION_LIMITS.max ? s.csCounterMax(n, OPINION_LIMITS.max) : s.csCounter(n, OPINION_LIMITS.min)}
        </div>
        {msg && <p className="rv-msg err" role="alert">{msg}</p>}
      </div>
      <div className="rv-ap-foot">
        <button type="button" className="btn ghost" disabled={busy} onClick={onBack}>{s.cancel}</button>
        <button type="button" className="btn" disabled={!ok} onClick={() => setAsking(true)}>{busy ? s.submitting : s.csSubmit}</button>
      </div>
      {asking && (
        <Confirm title={s.csConfirmTitle} body={s.csConfirmBody} okText={busy ? s.submitting : s.csConfirmBtn} cancelText={s.cancel}
          busy={busy} onCancel={() => setAsking(false)} onOk={submit} />
      )}
    </div>
  );
}
