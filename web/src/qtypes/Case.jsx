// 第四批 6.1（2026-10-08，G3）：情境案例题组 case —— 一段案例材料 + 2–8 道客观小题。
//   编辑仍在一个整页里完成（小题可折叠，不再开新页）；答题页按小题逐题展示（答题卡 3.1–3.4），手机上案例材料可收起；
//   成绩页案例材料默认收起，逐小题回顾。
import { useState } from 'react';

import { setAt, moveItem, changeType, hasTypeContent, emptySub, caseTotal, earnedOf, maxOf, stateOf, LIMITS } from './model.js';
import { typeLabel } from './spec.js';
import { kt, ktFor, locText, stemOf, FieldError, ResRow, scopedErrors } from './common.jsx';
import { ChoiceRunner, TfRunner, ChoiceReview, TfReview, ChoicePreview, TfPreview } from './Choice.jsx';
import { FillRunner, ClozeRunner, FillReview, ClozeReview, FillPreview, ClozePreview } from './Fill.jsx';
import { OrderingRunner, OrderingReview, OrderingPreview } from './Ordering.jsx';
import { MatchingRunner, MatchingReview, MatchingPreview } from './Matching.jsx';
import { ClassifyRunner, ClassifyReview, ClassifyPreview } from './Classify.jsx';
// 小题可用的题型（客观题；不能嵌套案例、不能是简答）
const SUB = {
  mcq: { Runner: ChoiceRunner, Review: ChoiceReview, BankPreview: ChoicePreview },
  multi: { Runner: ChoiceRunner, Review: ChoiceReview, BankPreview: ChoicePreview },
  tf: { Runner: TfRunner, Review: TfReview, BankPreview: TfPreview },
  fill: { Runner: FillRunner, Review: FillReview, BankPreview: FillPreview },
  cloze: { Runner: ClozeRunner, Review: ClozeReview, BankPreview: ClozePreview, ownsStem: true },
  ordering: { Runner: OrderingRunner, Review: OrderingReview, BankPreview: OrderingPreview },
  matching: { Runner: MatchingRunner, Review: MatchingReview, BankPreview: MatchingPreview },
  classify: { Runner: ClassifyRunner, Review: ClassifyReview, BankPreview: ClassifyPreview },
};
export const subDef = (type) => SUB[type] || null;

/* ---------------- 编辑器 ---------------- */

// 案例材料卡片：collapsible 时（手机上再次看到同一案例）可收起，按钮「查看案例 / 收起案例」
export function CasePassage({ q, lang, collapsible, defaultOpen = true }) {
  const s = kt(lang);
  const [open, setOpen] = useState(defaultOpen);
  const text = locText(q, 'passage', lang);
  const title = locText(q, 'question', lang);
  return (
    <section className={'qt-case-passage' + (open ? '' : ' closed')} aria-label={s.caseH}>
      <div className="qt-case-ph">
        <span className="qt-sub-h">{s.caseH}</span>
        {collapsible && (
          <button type="button" className="link-btn qt-case-toggle" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
            {open ? s.hideCase : s.viewCase}
          </button>
        )}
      </div>
      {open && (
        <>
          {title && title !== text && <div className="qt-case-title">{title}</div>}
          <div className="qt-case-text">{text}</div>
        </>
      )}
    </section>
  );
}

// 小题题干（多空填空的题干由它自己的作答部件带输入框渲染）
export function SubStem({ sub, lang, label }) {
  const s = kt(lang);
  const def = subDef(sub.type);
  if (def && def.ownsStem) return label ? <div className="qt-case-subno tnum">{label}</div> : null;
  return (
    <div className="qt-case-stem">
      {label && <span className="qt-case-subno tnum">{label}</span>}
      {locText(sub, 'question', lang)}
      {sub.type === 'multi' && <span className="exam-multi-hint">{s.multiHint}</span>}
    </div>
  );
}

// 整组作答（组卷预览用；答题页按小题逐题展示，见 ExamRunner）
export function CaseRunner({ q, value, onChange, lang, readOnly, caseNo }) {
  const s = kt(lang);
  const items = Array.isArray(q.items) ? q.items : [];
  const v = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return (
    <div className="qt-case">
      <CasePassage q={q} lang={lang} />
      {items.map((sub, k) => {
        const def = subDef(sub.type);
        return (
          <div className="qt-case-sub" key={sub.sid || k}>
            <SubStem sub={sub} lang={lang} label={caseNo ? `${caseNo}.${k + 1}` : `${k + 1}`} />
            {def
              ? <def.Runner q={sub} value={v[sub.sid]} onChange={(x) => onChange({ ...v, [sub.sid]: x })} lang={lang} readOnly={readOnly} />
              : <div className="qt-unknown">{s.refresh}</div>}
          </div>
        );
      })}
    </div>
  );
}

/* ---------------- 成绩回顾 ---------------- */

export function CaseReview({ d, lang, showAnswers, audience }) {
  const s = ktFor(lang, audience);
  const items = Array.isArray(d.items) ? d.items : [];
  const passage = locText(d, 'passage', lang);
  return (
    <>
      {passage && (
        <details className="qt-rv-passage">
          <summary>{s.caseH}</summary>
          <div className="qt-case-text">{passage}</div>
        </details>
      )}
      {items.map((sub, k) => {
        const def = subDef(sub.type);
        const st = stateOf(sub);
        return (
          <div className={'qt-rv-sub ' + (st === 'ok' ? 'ok' : 'bad')} key={sub.sid || k}>
            <div className="qt-rv-subh">
              <span className="res-qn tnum">{s.subQ(k + 1)}</span>
              <span className="pill muted">{typeLabel(sub.type, lang)}</span>
              <span className="pill muted tnum">{s.ptsOf(earnedOf(sub), maxOf(sub))}</span>
              {st === 'ok' ? <span className="pill ok">{s.correct}</span>
                : st === 'partial' ? <span className="pill warn">{s.partial}</span>
                  : <span className="pill res-failpill">{s.incorrect}</span>}
            </div>
            {sub.type !== 'cloze' && <div className="res-prompt">{locText(sub, 'question', lang)}</div>}
            {def ? <def.Review d={sub} lang={lang} showAnswers={showAnswers} audience={audience} /> : <ResRow label={s.yourAns}>{s.notAnswered}</ResRow>}
          </div>
        );
      })}
    </>
  );
}

/* ---------------- 题库预览 ---------------- */

export function CasePreview({ q, lang }) {
  const s = kt(lang);
  const items = Array.isArray(q.items) ? q.items : [];
  return (
    <div className="qk-pv-case">
      <div className="qk-pv-passage">{locText(q, 'passage', lang)}</div>
      <div className="qk-muted">{s.subCount(items.length)}</div>
      <ol className="qk-pv-subs">
        {items.map((sub, k) => {
          const def = subDef(sub.type);
          return (
            <li key={sub.sid || k}>
              <div className="qk-pv-substem"><span className="qk-muted">{typeLabel(sub.type, lang, true)}</span> {stemOf(sub, lang)}</div>
              {def && <def.BankPreview q={sub} lang={lang} />}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
