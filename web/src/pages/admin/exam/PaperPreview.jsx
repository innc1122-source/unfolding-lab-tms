// 预览试卷（第四批 6.2，整页 ?view=preview）：按试卷顺序、用学员端的作答部件（只读）逐题显示。
//   · 选项按题库录入顺序显示，并注明学员端的选项顺序（每次随机 / 固定）；
//   · 「显示答案与解析」在每题下展开正确答案（BankPreview）与解析；中文 / English 切换核对两种语言；
//   · 头部是试卷概况与考试规则（限时、及格线、作答次数）；打印时只留试卷本身（@media print）。
//   · 随机抽题考试：sample = true，显示一套按当前规则抽出的示例，并说明学员每次开考会重新抽题。
import { useMemo, useState } from 'react';
import { Button, Checkbox, RadioGroup, Radio, Banner, Empty } from '@douyinfe/semi-ui';
import { IconArrowLeft } from '@douyinfe/semi-icons';
import { qtype, TypeTag, locText } from '../../../qtypes/index.jsx';
import { paperSummary } from './paperSummary.js';

const T = {
  zh: {
    title: (n) => `预览试卷：${n}`, titleNew: '预览试卷：新考试',
    showAns: '显示答案与解析', langLabel: '题目语言', print: '打印',
    sample: '这是按当前规则随机抽出的一套示例，学员每次开考会重新抽题。', redraw: '换一套',
    optRandom: '学员端选项顺序：每次随机（此处按题库录入顺序显示）', optFixed: '学员端选项顺序：固定，按题库录入顺序',
    count: (n, c, i) => (c ? `共 ${n} 题（含 ${c} 组案例 · ${i} 小题）` : `共 ${n} 题`), total: (n) => `卷面总分 ${n} 分`,
    pass: (p, n) => (n == null ? `及格 ${p}%` : `及格 ${p}%（≥ ${n} 分）`),
    limit: (n) => `限时 ${n} 分钟`, noLimit: '不限时', attempts: (n) => `最多作答 ${n} 次`, attemptsUnl: '作答次数不限',
    qn: (n) => `第 ${n} 题`, pts: (n) => `${n} 分`, answer: '正确答案', expl: '解析',
    empty: '试卷上还没有题目。', outPool: '（不在关联课程题库中，保存时会移除）',
  },
  en: {
    title: (n) => `Preview paper: ${n}`, titleNew: 'Preview paper: new exam',
    showAns: 'Show answers and explanations', langLabel: 'Question language', print: 'Print',
    sample: 'This is one sample draw under the current rules; each attempt draws again.', redraw: 'Draw another',
    optRandom: 'Learner option order: shuffled for each attempt (shown here as entered in the bank)', optFixed: 'Learner option order: fixed, as entered in the bank',
    count: (n, c, i) => (c ? `${n} questions (incl. ${c} case group${c === 1 ? '' : 's'} · ${i} items)` : `${n} question${n === 1 ? '' : 's'}`), total: (n) => `Total ${n} pts`,
    pass: (p, n) => (n == null ? `Pass ${p}%` : `Pass ${p}% (≥ ${n} pts)`),
    limit: (n) => `${n} min limit`, noLimit: 'No time limit', attempts: (n) => `Up to ${n} attempts`, attemptsUnl: 'Unlimited attempts',
    qn: (n) => `Question ${n}`, pts: (n) => `${n} pt${n === 1 ? '' : 's'}`, answer: 'Answer', expl: 'Explanation',
    empty: 'The paper has no questions yet.', outPool: '(not in the linked courses’ bank; removed on save)',
  },
};

// 题库题目 → 学员端作答部件要的形状（与服务端 client() 同样的字段，按录入顺序，不带答案）
export function learnerShape(q, pts) {
  const base = { id: q.id, type: q.type, question: q.question, question_zh: q.question_zh };
  if (pts != null) base.points = pts;
  const tx = (o) => ({ text: o && o.text, text_zh: o && o.text_zh });
  const list = (x) => (Array.isArray(x) ? x : []);
  switch (q.type) {
    case 'mcq': case 'multi': return { ...base, options: list(q.options).map(tx) };
    case 'open': return { ...base, maxPoints: q.maxPoints };
    case 'cloze': return { ...base, blanks: list(q.blanks).length };
    case 'ordering': return { ...base, items: list(q.items).map(tx) };
    case 'matching':
      return { ...base, lefts: list(q.pairs).map((p) => tx(p && p.left)), rights: [...list(q.pairs).map((p) => tx(p && p.right)), ...list(q.distractors).map(tx)] };
    case 'classify': return { ...base, categories: list(q.categories).map(tx), items: list(q.items).map(tx) };
    case 'case':
      return {
        ...base, passage: q.passage, passage_zh: q.passage_zh,
        items: list(q.items).map((it, k) => ({ ...learnerShape({ ...it, id: `${q.id}:${(it && it.sid) || k}` }, it && it.points != null ? it.points : null), sid: (it && it.sid) || `s${k + 1}` })),
      };
    default: return base;
  }
}

const noop = () => {};

export default function PaperPreview({
  lang, examTitle, paper, bank, typePoints, passingScore, poolCourseIds, enabled,
  timeLimit, maxAttempts, shuffleOptions, sample, onRedraw, onBack, backLabel,
}) {
  const s = T[lang] || T.en;
  const [showAns, setShowAns] = useState(false);
  const [qLang, setQLang] = useState(lang === 'zh' ? 'zh' : 'en');
  const qs = T[qLang] || T.en;
  const byId = useMemo(() => new Map((bank || []).map((q) => [String(q.id), q])), [bank]);
  const sum = useMemo(() => paperSummary(paper || [], bank || [], { typePoints, passingScore, poolCourseIds, enabled }), [paper, bank, typePoints, passingScore, poolCourseIds, enabled]);
  const out = new Set(sum.outOfPool.map(String));
  const list = (paper || []).map((id) => byId.get(String(id))).filter(Boolean);

  return (
    <div className="excp-page">
      <div className="co-page-bar excp-bar">
        <Button theme="borderless" icon={<IconArrowLeft />} onClick={onBack}>{backLabel}</Button>
        <div className="co-page-titles">
          <h1 className="co-page-title">{examTitle ? s.title(examTitle) : s.titleNew}</h1>
        </div>
        <Button theme="light" onClick={() => { try { window.print(); } catch { /* no window */ } }}>{s.print}</Button>
      </div>
      <div className="card excp-tools">
        <Checkbox checked={showAns} onChange={(e) => setShowAns(!!(e && e.target && e.target.checked))}>{s.showAns}</Checkbox>
        <span className="excp-langpick">
          <span className="excp-langlab">{s.langLabel}</span>
          <RadioGroup type="button" value={qLang} onChange={(e) => setQLang(e.target.value)} aria-label={s.langLabel}>
            <Radio value="zh">中文</Radio>
            <Radio value="en">English</Radio>
          </RadioGroup>
        </span>
      </div>
      {sample && (
        <Banner
          type="info"
          closeIcon={null}
          className="excp-banner"
          description={<span>{s.sample} {onRedraw && <Button size="small" theme="borderless" onClick={onRedraw}>{s.redraw}</Button>}</span>}
        />
      )}
      <div className="card excp-head">
        <div className="excp-facts tnum">
          <span>{s.count(sum.count, sum.cases, sum.items)}</span>
          <span>{s.total(sum.total)}</span>
          {sum.passPct != null && <span>{s.pass(sum.passPct, sum.passPoints)}</span>}
          <span>{timeLimit ? s.limit(timeLimit) : s.noLimit}</span>
          <span>{maxAttempts ? s.attempts(maxAttempts) : s.attemptsUnl}</span>
        </div>
        <div className="excp-optnote">{shuffleOptions === false ? s.optFixed : s.optRandom}</div>
      </div>
      {!list.length ? (
        <div className="card excp-empty"><Empty description={s.empty} /></div>
      ) : (
        <ol className="excp-list">
          {list.map((q, i) => {
            const id = String(q.id);
            const def = qtype(q.type);
            const pts = sum.points[id];
            const lq = learnerShape(q, pts);
            const expl = locText(q, 'explanation', qLang);
            return (
              <li key={id} className={'card excp-q' + (out.has(id) ? ' out' : '')}>
                <div className="excp-qhead">
                  <span className="excp-qn tnum">{qs.qn(i + 1)}</span>
                  <TypeTag type={q.type} lang={qLang} size="small" />
                  {pts != null && <span className="excp-pts tnum">{qs.pts(pts)}</span>}
                  {out.has(id) && <span className="excp-out">{qs.outPool}</span>}
                </div>
                {!def.ownsStem && q.type !== 'case' && <div className="excp-stem">{locText(q, 'question', qLang)}</div>}
                <div className="excp-runner">
                  <def.Runner q={lq} value={undefined} onChange={noop} lang={qLang} readOnly caseNo={i + 1} />
                </div>
                {showAns && (
                  <div className="excp-ans">
                    <div className="excp-anslab">{qs.answer}</div>
                    <def.BankPreview q={q} lang={qLang} />
                    {expl && <div className="excp-expl"><b>{qs.expl}</b> {expl}</div>}
                  </div>
                )}
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
