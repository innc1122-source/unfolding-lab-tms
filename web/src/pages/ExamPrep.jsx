import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useI18n } from '../i18n.jsx';
import { useAuth } from '../auth.jsx';
import { useAsync, api, serverNow } from '../api.js';
import ModuleTrail from '../components/ModuleTrail.jsx';
import { useTrailSource, withFrom } from '../trailsource.js';

// 第三批 5.3 + 10.9（2026-10-08）：考前说明页重排为单列（ep2-*）——
//   概况（题目 / 考试时长 / 及格分 / 剩余次数 / 最好成绩）→ 考试规则（卷面总分与本场实际出现的题型、
//   重考等待期、交卷后可否查看答案）→ 考前须知（注意事项 + 简答题 AI 初评告知）→ 底部操作条
//   （返回课程详情为文字链接，「开始考试」为唯一主按钮）。新老考试显示同一组规则：老考试（没有每题分值设置）
//   也有「卷面总分」一行（服务端按旧口径算出 totalPoints）。
// 第四批 6.1 / 10.6（2026-10-08）：题型名覆盖全部 10 种题型（typeName 与 qtypes/spec.js 的短名一致，test/qtypes-spec-parity 守住）；
//   情境案例一行写成「情境案例 2 组（共 8 小题）· 8 分」；题目数按小题计（itemCount）；选项顺序固定时多一行「选项顺序 · 固定」；
//   排序 / 匹配 / 分类 / 多空填空按答对比例给分时在题型构成下加一句。
const T = {
  zh: {
    finalExam: '结业考试',
    subtitle: '开始前，请阅读并确认以下考试规则。',
    // 概况
    ep2Questions: '题目',
    qCountV: (n) => `${n} 题`,
    ep2Time: '考试时长',
    limitV: (n) => `${n} 分钟`,
    noLimit: '不限时',
    ep2Pass: '及格分',
    passV: (n) => `${n}%`,
    ep2Left: '剩余次数',
    leftV: (left, max) => `${left} / ${max} 次`,
    attempts: '可考次数',
    attemptsV: (n) => `${n} 次`,
    ep2Unlimited: '不限',
    best: '最好成绩',
    bestV: (n) => `${n}%`,
    // 规则
    ep2Rules: '考试规则',
    totalPts: '卷面总分',
    totalPtsV: (a, b) => (a === b ? `${a} 分` : `${a}–${b} 分`),
    // 10.9：只列本场实际出现的题型，写成「单选 20 题 × 1 分」
    typeName: { mcq: '单选', single: '单选', multi: '多选', tf: '判断', fill: '填空', cloze: '多空', ordering: '排序', matching: '匹配', classify: '分类', open: '简答', case: '案例' },
    // F56：同题型分值不同（br = 服务端 breakdown [{ points, count }]）→「判断 2 题，共 3 分（1 分 × 1、2 分 × 1）」
    typeLine: (name, count, pts, br) => (br && br.length
      ? `${name} ${count} 题，共 ${Math.round(br.reduce((n, b) => n + b.points * b.count, 0) * 10) / 10} 分（${br.map((b) => `${b.points} 分 × ${b.count}`).join('、')}）`
      : pts == null ? `${name} ${count} 题` : count != null ? `${name} ${count} 题 × ${pts} 分` : `${name}每题 ${pts} 分`),
    // 情境案例：count = 组数，items = 小题总数（随机抽题时可能不定），pts = 每组分值（各组不一致时为空，固定题目时另带 br 每组分值分布）
    caseLine: (count, items, pts, br) => `情境案例 ${count} 组${items != null ? `（共 ${items} 小题）` : ''}${br && br.length
      ? `${items != null ? '' : ' '}· 共 ${Math.round(br.reduce((n, b) => n + b.points * b.count, 0) * 10) / 10} 分（${br.map((b) => `${b.points} 分 × ${b.count}`).join('、')}）`
      : pts != null ? `${items != null ? '' : ' '}· ${count != null ? Math.round(count * pts * 10) / 10 : pts} 分` : ''}`,
    multiPartial: '多选题少选且无错选得一半分，有错选不得分',
    partialCredit: '排序 / 匹配 / 分类 / 多空填空按答对比例给分',
    caseGroups: (c) => `（含 ${c} 组案例）`,
    optionOrder: '选项顺序',
    optionFixed: '固定，按题库顺序',
    cooldown: '重考等待期',
    cooldownV: (n) => `每次考试后需等待 ${n} 小时`,
    none: '无',
    seeAns: '交卷后可查看答案',
    yes: '是',
    no: '否',
    // 须知
    ep2Notes: '考前须知',
    tip: '开始后计时立即开始，中途请勿刷新或关闭页面：离开后本次作答不保存，重新进入将重新开始考试。请确保网络稳定，并预留足够时间一次完成。',
    // 简答题 AI 初评的告知（AI 治理方案 2.6，告知版本 grading@1；只展示、不要求确认）
    aiHead: '简答题由 AI 初评',
    aiNotice: '本次考试的简答题在交卷后由 AI 按评分标准进行初评并给出评语，通常几分钟内出结果。你的作答内容（已去除姓名和工号）会发送给公司指定的 AI 服务处理。当简答题分数影响是否通过时，结果须经 HR 复核确认后生效。AI 初评的分数、评语和所用模型随答卷保存，你本人和负责培训的 HR 可以查看。你可以对成绩提出申诉。',
    // 开不了考的原因（与 /api/exam/start 拒绝的顺序一致）
    lockedHead: '尚未解锁',
    lockedNote: '完成全部学习内容后即可开始本考试。',
    usedUpHead: '考试次数已用完',
    usedUpNote: (n) => `你已用完 ${n} 次考试机会。如需重考，请联系 HR 重置。`,
    coolingHead: '重考等待期',
    coolingNote: (hint) => `两次考试之间需间隔一段时间。${hint}`,
    retakeInH: (h) => `约 ${h} 小时后可重考`,
    retakeInM: (m) => `约 ${m} 分钟后可重考`,
    retakeAt: (wait, at) => `${wait}（${at}）`,
    pendingHead: '上一次答卷结果待定',
    pendingGrading: '上一次答卷的简答题仍在评分中，结果确定后才能再次开始。',
    pendingReview: '上一次答卷的简答题待 HR 复核，复核完成后才能再次开始。',
    viewPending: '查看上一次答卷',
    // 操作条
    ep2Agree: '我已阅读考试规则与考前须知',
    ep2Hint: '勾选后即可开始',
    ep2Start: '开始考试',
    ep2Back: '返回课程详情',
    loading: '加载中…',
    error: '加载失败，请刷新页面重试。',
    notFound: '未找到该考试，或它未被指派给你。',
    openFromProgram: '请从对应课程页面进入本考试。',
    backToLearning: '返回我的课程',
  },
  en: {
    finalExam: 'Final exam',
    subtitle: 'Before you begin, please read and confirm the exam rules below.',
    ep2Questions: 'Questions',
    qCountV: (n) => `${n}`,
    ep2Time: 'Time limit',
    limitV: (n) => `${n} min`,
    noLimit: 'No limit',
    ep2Pass: 'Pass mark',
    passV: (n) => `${n}%`,
    ep2Left: 'Attempts left',
    leftV: (left, max) => `${left} of ${max}`,
    attempts: 'Attempts allowed',
    attemptsV: (n) => `${n}`,
    ep2Unlimited: 'Unlimited',
    best: 'Best score',
    bestV: (n) => `${n}%`,
    ep2Rules: 'Exam rules',
    totalPts: 'Total points',
    totalPtsV: (a, b) => (a === b ? `${a} pts` : `${a}–${b} pts`),
    typeName: { mcq: 'Single choice', single: 'Single choice', multi: 'Multiple answer', tf: 'True / false', fill: 'Fill in the blank', cloze: 'Multi-blank fill', ordering: 'Ordering', matching: 'Matching', classify: 'Classification', open: 'Short answer', case: 'Scenario case' },
    // F56: mixed points within a type (br = server breakdown [{ points, count }]) →
    // "True / false: 2 questions, 3 pts total (1 pt × 1, 2 pts × 1)"
    typeLine: (name, count, pts, br) => (br && br.length
      ? `${name}: ${count} question${count === 1 ? '' : 's'}, ${Math.round(br.reduce((n, b) => n + b.points * b.count, 0) * 10) / 10} pts total (${br.map((b) => `${b.points} pt${b.points === 1 ? '' : 's'} × ${b.count}`).join(', ')})`
      : pts == null ? `${name}: ${count} question${count === 1 ? '' : 's'}` : count != null
      ? `${name}: ${count} question${count === 1 ? '' : 's'} × ${pts} pt${pts === 1 ? '' : 's'}`
      : `${name}: ${pts} pt${pts === 1 ? '' : 's'} each`),
    caseLine: (count, items, pts, br) => {
      const mixed = !!(br && br.length);
      const total = mixed ? Math.round(br.reduce((n, b) => n + b.points * b.count, 0) * 10) / 10 : pts != null && count != null ? Math.round(count * pts * 10) / 10 : pts;
      const parts = mixed ? ` (${br.map((b) => `${b.points} pt${b.points === 1 ? '' : 's'} × ${b.count}`).join(', ')})` : '';
      return `Scenario cases: ${count} group${count === 1 ? '' : 's'}${items != null ? ` (${items} sub-question${items === 1 ? '' : 's'})` : ''}${total != null ? ` · ${total} point${total === 1 ? '' : 's'}${parts}` : ''}`;
    },
    multiPartial: 'Multiple-answer questions: half credit if you miss an option but select no wrong ones; no credit if any wrong option is selected',
    partialCredit: 'Ordering, matching, classification and multi-blank questions give proportional credit',
    caseGroups: (c) => ` (incl. ${c} case group${c === 1 ? '' : 's'})`,
    optionOrder: 'Option order',
    optionFixed: 'Fixed, as entered in the question bank',
    cooldown: 'Waiting period',
    cooldownV: (n) => `${n} hour${n === 1 ? '' : 's'} after each attempt`,
    none: 'None',
    seeAns: 'Answers shown after submission',
    yes: 'Yes',
    no: 'No',
    ep2Notes: 'Before you start',
    tip: 'The timer starts the moment you begin — do not refresh or close the page: if you leave, this attempt is not saved and coming back starts the exam over. Make sure your connection is stable and set aside enough time to finish in one sitting.',
    aiHead: 'Short answers are pre-scored by AI',
    aiNotice: 'Short answers in this exam are pre-scored by AI against the rubric after you submit, usually within a few minutes. Your answer text (with your name and employee ID removed) is sent to the company-designated AI service. Where the open-answer score decides whether you pass, the result takes effect only after HR review. The AI pre-score, feedback and model used are saved with your attempt and are visible to you and to the HR staff responsible for training. You may appeal your result.',
    lockedHead: 'Not unlocked yet',
    lockedNote: 'Complete all course content to start this exam.',
    usedUpHead: 'No attempts left',
    usedUpNote: (n) => `You have used all ${n} attempts. Contact HR to reset them if you need a retake.`,
    coolingHead: 'Waiting Period',
    coolingNote: (hint) => `A waiting period applies between attempts. ${hint}`,
    retakeInH: (h) => `Retake available in about ${h} hour${h === 1 ? '' : 's'}`,
    retakeInM: (m) => `Retake available in about ${m} minute${m === 1 ? '' : 's'}`,
    retakeAt: (wait, at) => `${wait} (${at})`,
    pendingHead: 'Previous attempt pending',
    pendingGrading: 'Your previous attempt is still being scored. You can start again once the result is confirmed.',
    pendingReview: 'Your previous attempt is awaiting HR review. You can start again once the review is done.',
    viewPending: 'View the previous attempt',
    ep2Agree: 'I have read the exam rules and notes',
    ep2Hint: 'Tick the box to start',
    ep2Start: 'Start exam',
    ep2Back: 'Back to course details',
    loading: 'Loading…',
    error: 'Couldn’t load. Refresh the page to try again.',
    notFound: 'This exam was not found, or it is not assigned to you.',
    openFromProgram: 'Open this exam from its course page.',
    backToLearning: 'Back to My Courses',
  },
};

// "MM-DD HH:MM", dropping the date when the moment is today — a bare HH:MM would
// read as today, and a 24h cooldown almost never ends on the same day.
const coolStamp = (d) => {
  const p = (n) => String(n).padStart(2, '0');
  const clock = `${p(d.getHours())}:${p(d.getMinutes())}`;
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  return sameDay ? clock : `${p(d.getMonth() + 1)}-${p(d.getDate())} ${clock}`;
};

// When the retake reopens. retryAt is authoritative; without it we recompute the
// server's own rule (last attempt + retakeCooldownHours) so an older payload
// still gates the button instead of silently letting it through.
const retryAtOf = (ex) => {
  if (ex.retryAt) {
    const d = new Date(ex.retryAt);
    if (!Number.isNaN(d.getTime())) return d;
  }
  if (ex.lastAttemptAt && ex.retakeCooldownHours) {
    const d = new Date(ex.lastAttemptAt);
    if (!Number.isNaN(d.getTime()))
      return new Date(d.getTime() + Number(ex.retakeCooldownHours) * 3600000);
  }
  return null;
};

// Why this exam cannot be started, in the same order /api/exam/start rejects:
// not unlocked -> pending result -> attempts exhausted -> cooldown. null means "go ahead".
// Without this the learner ticks the box, hits Start and eats a raw 400.
const examBlock = (s, ex) => {
  if (!ex.unlocked) return { head: s.lockedHead, note: s.lockedNote };
  if (ex.pending) return { head: s.pendingHead, note: ex.pending.gradingStatus === 'grading' ? s.pendingGrading : s.pendingReview, attemptId: ex.pending.attemptId };
  const max = Number(ex.maxAttempts) || 0;
  const used = Number(ex.attemptsUsed) || 0;
  if (max > 0 && used >= max) return { head: s.usedUpHead, note: s.usedUpNote(max) };
  const at = retryAtOf(ex);
  const mins = at ? Math.ceil((at.getTime() - serverNow()) / 60000) : 0;   // CX-156：按服务器时间
  if (mins > 0) {
    const wait = mins >= 60 ? s.retakeInH(Math.round(mins / 60)) : s.retakeInM(mins);
    return { head: s.coolingHead, note: s.coolingNote(s.retakeAt(wait, coolStamp(at))) };
  }
  return null;
};

// 卷面总分：服务端 totalPoints（数字或 {min,max}；老考试按旧口径算出）优先，其次 pointsRange；都没有时不显示
export const totalOf = (ex) => {
  const t = ex.totalPoints;
  if (typeof t === 'number' && Number.isFinite(t)) return { min: t, max: t };
  if (t && typeof t === 'object' && t.min != null) return { min: Number(t.min), max: Number(t.max != null ? t.max : t.min) };
  if (ex.pointsRange && ex.pointsRange.min != null) return { min: ex.pointsRange.min, max: ex.pointsRange.max };
  return null;
};

// 第四批：考前概况的题目数按小题计（itemCount，案例展开）；旧服务端没有 itemCount 时按 mcqCount + openCount。
export const questionCountOf = (ex) => {
  const n = Number(ex.itemCount);
  if (ex.itemCount != null && Number.isFinite(n)) return n;
  return (Number(ex.mcqCount) || 0) + (Number(ex.openCount) || 0);
};
// 本场是否有按比例给分的题型（排序 / 匹配 / 分类 / 多空填空）
export const PROPORTIONAL_TYPES = ['ordering', 'matching', 'classify', 'cloze'];

// F58（负责人 10/9 定）：HR 在考试设置里填写的考前须知（选填，纯文本）。按界面语言取，该语言为空时取另一种语言；
//   两种都空 = null（只显示系统须知）。只作为文本节点渲染（React 转义），换行靠 white-space: pre-line，不解析 HTML。
export const preNoticeOf = (ex, lang) => {
  const zh = ex && typeof ex.preNotice_zh === 'string' ? ex.preNotice_zh.trim() : '';
  const en = ex && typeof ex.preNotice === 'string' ? ex.preNotice.trim() : '';
  return (lang === 'zh' ? (zh || en) : (en || zh)) || null;
};

// 10.9：本场实际出现的题型（count > 0）；服务端 typeSummary 为准。旧服务端只有 typePoints 时
// 不再列四种题型的默认分值（那会把没出现的题型也列出来，F40），只在题目全是简答 / 全是选择类时写出能确定的那一种。
export const typeLinesOf = (ex) => {
  if (Array.isArray(ex.typeSummary)) {
    return ex.typeSummary
      .filter((x) => x && x.type && (x.count == null || Number(x.count) > 0) && !(x.count == null && x.points == null))
      .map((x) => {
        const line = { type: x.type, count: x.count == null ? null : Number(x.count), points: x.points == null ? null : Number(x.points) };
        // 第四批：案例一行另带小题总数（只有案例行有 items 字段）
        if (x.type === 'case') line.items = x.items == null ? null : Number(x.items);
        // F56：同题型分值不同 → 服务端带 breakdown [{ points, count }]（只在题数确定时用；旧服务端没有这个字段，照旧）
        if (x.points == null && x.count != null && Array.isArray(x.breakdown) && x.breakdown.length)
          line.breakdown = x.breakdown.map((b) => ({ points: Number(b.points), count: Number(b.count) }));
        return line;
      });
  }
  const tp = ex.typePoints;
  if (!tp) return [];
  const mcq = Number(ex.mcqCount) || 0;
  const open = Number(ex.openCount) || 0;
  const out = [];
  if (open > 0 && tp.open != null) out.push({ type: 'open', count: open, points: Number(tp.open) });
  return mcq > 0 ? [] : out;
};

export default function ExamPrep() {
  const { lang, loc } = useI18n();
  // 页头路径与页间跳转按来源（D-29）：从培养项目进入时带 ?from=project:<id>
  const { src: trailSrc, head: trailHead } = useTrailSource();
  const s = T[lang];
  const nav = useNavigate();
  const { programId, examId } = useParams();
  const [agreed, setAgreed] = useState(false);
  const { user } = useAuth();
  const aiGrading = !!(user && user.ai && user.ai.grading === 'on');

  const { loading, error, data } = useAsync(
    () => (programId ? api.get(`/api/programs/${programId}`) : Promise.resolve(null)),
    [programId]
  );

  // No program context (deep-link with only examId, or none) — send them to
  // their program page rather than a broken frame.
  if (!programId || !examId) {
    return (
      <div className="wrap">
        <ModuleTrail items={trailHead(lang, loc)} />
        <div style={{ padding: '72px 24px', textAlign: 'center', color: 'var(--ink-3)', fontSize: 14 }}>
          <p style={{ marginBottom: 16 }}>{s.openFromProgram}</p>
          <button className="btn ghost" onClick={() => nav('/learning')}>{s.backToLearning}</button>
        </div>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="wrap">
        <ModuleTrail items={trailHead(lang, loc)} />
        <div style={{ padding: '80px 24px', textAlign: 'center', color: 'var(--ink-3)', fontSize: 14 }}>
          {s.loading}
        </div>
      </div>
    );
  }
  if (error && !(error.status === 404)) {
    return (
      <div className="wrap">
        <ModuleTrail items={trailHead(lang, loc)} />
        <div style={{ padding: '80px 24px', textAlign: 'center', color: 'var(--ink-3)', fontSize: 14 }}>
          {s.error}
        </div>
      </div>
    );
  }

  const program = data;
  const exam = program && Array.isArray(program.exams)
    ? program.exams.find((e) => e.id === examId)
    : null;

  // Program missing (404) or exam id not present in the program.
  if (!program || !exam) {
    return (
      <div className="wrap">
        <ModuleTrail items={trailHead(lang, loc)} />
        <div style={{ padding: '72px 24px', textAlign: 'center', color: 'var(--ink-3)', fontSize: 14 }}>
          <p style={{ marginBottom: 16 }}>{s.notFound}</p>
          <button className="btn ghost" onClick={() => nav(withFrom(`/program/${programId}`, trailSrc))}>{s.ep2Back}</button>
        </div>
      </div>
    );
  }

  const block = examBlock(s, exam);
  const questions = questionCountOf(exam);
  const caseCount = Number(exam.caseCount) || 0;
  const examTitle = loc(exam, 'title') || s.finalExam;
  const goBack = () => nav(withFrom(`/program/${programId}`, trailSrc));

  // ---- 概况：题目 / 考试时长 / 及格分 / 剩余次数（+ 最好成绩） ----
  const max = Number(exam.maxAttempts) || 0;
  const used = Number(exam.attemptsUsed);
  const facts = [
    { k: 'q', label: s.ep2Questions, value: s.qCountV(questions) + (caseCount > 0 ? s.caseGroups(caseCount) : '') },
    { k: 'time', label: s.ep2Time, value: exam.timeLimitMinutes != null ? s.limitV(exam.timeLimitMinutes) : s.noLimit },
    { k: 'pass', label: s.ep2Pass, value: s.passV(exam.passingScore), strong: true },
    max > 0 && Number.isFinite(used)
      ? { k: 'left', label: s.ep2Left, value: s.leftV(Math.max(0, max - used), max) }
      : { k: 'left', label: max > 0 ? s.attempts : s.ep2Left, value: max > 0 ? s.attemptsV(max) : s.ep2Unlimited },
  ];
  if (exam.best != null) facts.push({ k: 'best', label: s.best, value: s.bestV(exam.best.percent), strong: true });

  // ---- 规则：卷面总分（题型构成）/ 重考等待期 / 交卷后可否查看答案 ----
  const total = totalOf(exam);
  const lines = typeLinesOf(exam);
  const hasMulti = lines.some((l) => l.type === 'multi');
  const hasProportional = lines.some((l) => PROPORTIONAL_TYPES.includes(l.type));
  const rules = [];
  if (total) {
    rules.push({
      k: 'pts',
      label: s.totalPts,
      value: s.totalPtsV(total.min, total.max),
      subs: [
        ...lines.map((l) => (l.type === 'case' ? s.caseLine(l.count, l.items, l.points, l.breakdown) : s.typeLine((s.typeName[l.type] || l.type), l.count, l.points, l.breakdown))),
        ...(hasMulti && exam.multiPartial ? [s.multiPartial] : []),
        ...(hasProportional && exam.partialCredit !== false ? [s.partialCredit] : []),
      ],
    });
  }
  // 10.6：选项顺序固定时才多一行（默认每次随机，不提）
  if (exam.shuffleOptions === false) rules.push({ k: 'order', label: s.optionOrder, value: s.optionFixed });
  rules.push({ k: 'cool', label: s.cooldown, value: exam.retakeCooldownHours ? s.cooldownV(Number(exam.retakeCooldownHours)) : s.none });
  rules.push({ k: 'ans', label: s.seeAns, value: exam.showAnswersAfterExam ? s.yes : s.no });

  const canStart = agreed && !block;
  const preNotice = preNoticeOf(exam, lang);   // F58

  return (
    <div className="wrap">
      <div className="ep2-col">
      <ModuleTrail items={[...trailHead(lang, loc), { label: loc(program, 'title'), to: withFrom(`/program/${programId}`, trailSrc) }, { label: examTitle }]} />

      <div className="ep-head">
        <span className="pill pri">
          <svg className="ic sm" viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" /><path d="M14 2v6h6" /><path d="M9 15l2 2 4-4" /></svg>
          {s.finalExam}
        </span>
        <h1 className="ep-title">{examTitle}</h1>
        <p className="ep-sub">{s.subtitle}</p>
      </div>

      <dl className="card ep2-facts">
        {facts.map((f) => (
          <div key={f.k} className="ep2-fact" data-k={f.k}>
            <dt>{f.label}</dt>
            <dd className={'tnum' + (f.strong ? ' strong' : '')}>{f.value}</dd>
          </div>
        ))}
      </dl>

      <section className="card ep2-rules">
        <h2>{s.ep2Rules}</h2>
        <dl>
          {rules.map((r) => (
            <div key={r.k} className="ep2-rule" data-k={r.k}>
              <dt>{r.label}</dt>
              <dd>
                <span className="tnum">{r.value}</span>
                {r.subs && r.subs.length > 0 && (
                  <ul className="ep2-types">{r.subs.map((t, i) => <li key={i}>{t}</li>)}</ul>
                )}
              </dd>
            </div>
          ))}
        </dl>
      </section>

      <section className="card ep2-notes">
        <h2>{s.ep2Notes}</h2>
        <ol>
          <li>{s.tip}</li>
          {aiGrading && (exam.openCount || 0) > 0 && <li className="ep-ai"><b>{s.aiHead}</b>{s.aiNotice}</li>}
          {/* F58：HR 填写的考前须知，排在系统固定须知（含 AI 初评告知）之后；纯文本，保留换行 */}
          {preNotice && <li className="ep-custom" style={{ whiteSpace: 'pre-line' }}>{preNotice}</li>}
        </ol>
      </section>

      <div className="ep2-start">
        {block ? (
          <div className="callout ep2-block">
            <b>{block.head}</b>{block.note}
            {block.attemptId && <> <button className="link-btn" onClick={() => nav(`/result/${block.attemptId}`)}>{s.viewPending}</button></>}
          </div>
        ) : (
          <label className="ep-agree ep2-agree">
            {/* 只有可以开考时才出现勾选框；被挡住时由上面的原因说明代替 */}
            <input
              type="checkbox"
              checked={agreed}
              onChange={(e) => setAgreed(e.target.checked)}
            />
            <span className="ep-box" aria-hidden="true">
              <svg className="ic sm" viewBox="0 0 24 24"><path d="M20 6L9 17l-5-5" /></svg>
            </span>
            <span className="ep-agree-txt">{s.ep2Agree}</span>
          </label>
        )}
        <div className="ep2-actions">
          <button type="button" className="link-btn ep2-back" onClick={goBack}>‹ {s.ep2Back}</button>
          <div className="ep2-go-wrap">
            <button
              className="btn lg ep2-go"
              disabled={!canStart}
              aria-disabled={!canStart}
              onClick={() => agreed && !block && nav(withFrom(`/exam/${examId}`, trailSrc))}
            >
              {s.ep2Start}
              <svg className="ic sm" viewBox="0 0 24 24"><path d="M5 12h14M13 6l6 6-6 6" /></svg>
            </button>
            {!block && !agreed && <span className="ep2-hint">{s.ep2Hint}</span>}
          </div>
        </div>
      </div>
      </div>
    </div>
  );
}
