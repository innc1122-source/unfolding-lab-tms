// 第四批 6.1（2026-10-08，G3）：简答题 open。成绩页的分数、AI 评语与 HR 评语沿用原写法。
import { setAt } from './model.js';
import { kt, ktFor, ResRow, ExplRow } from './common.jsx';
export function OpenRunner({ value, onChange, lang, readOnly }) {
  const s = kt(lang);
  return (
    <div className="exam-options">
      <textarea className="exam-textarea" rows={6} placeholder={s.openPlaceholder} disabled={readOnly}
        value={typeof value === 'string' ? value : ''} onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}

export function OpenReview({ d, lang, audience }) {
  const s = ktFor(lang, audience);
  const st = d.score == null ? 'pending' : (Number(d.maxPoints) > 0 && Number(d.score) >= Number(d.maxPoints) ? 'ok' : 'bad');
  const yours = d.answer && String(d.answer).trim() !== '' ? d.answer : s.notAnswered;
  return (
    <>
      <ResRow tone={st} label={s.yourAns}>{yours}</ResRow>
      {d.score != null && (
        // CX-004（2026-10-09 验收）：考试里该题分值（points）与评分刻度（maxPoints，通常 10）不同时，只显示折算后的得分并注明评分刻度
        <ResRow label={s.yourScore}><span className="tnum">{d.points != null && Number(d.points) !== Number(d.maxPoints)
          ? s.scoreConv(Math.round(((Number(d.score) || 0) / (Number(d.maxPoints) || 1)) * Number(d.points) * 10) / 10, Number(d.points), Number(d.score) || 0, Number(d.maxPoints) || 0)
          : s.scoreOf(Number(d.score) || 0, Number(d.maxPoints) || 0)}</span></ResRow>
      )}
      {d.score == null && d.demoEstimate != null && (
        <ResRow label={s.yourScore}><span className="tnum">{s.demoEstimate(d.demoEstimate, Number(d.maxPoints) || 0)}</span></ResRow>
      )}
      {d.feedback && (
        <ResRow label={d.review === 'ai_provisional' || d.review === 'confirmed' ? s.aiFeedback : s.feedback}>
          {d.feedback}{d.ai && d.ai.model && <span className="res-aimodel">{s.aiModel(d.ai.model)}</span>}
        </ResRow>
      )}
      <ExplRow d={d} lang={lang} />
    </>
  );
}

export function OpenPreview({ q, lang }) {
  const s = kt(lang);
  const rubric = lang === 'zh' ? (q.rubric_zh || q.rubric) : (q.rubric || q.rubric_zh);
  return (
    <div className="qk-pv-line">
      <b>{s.rubricShort}</b>{rubric || '—'}
      {q.maxPoints != null && <span className="qk-muted tnum"> · {s.maxPts(q.maxPoints)}</span>}
    </div>
  );
}
