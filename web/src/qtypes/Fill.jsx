// 第四批 6.1（2026-10-08，G3）：填空类题型 —— 填空 fill、多空填空 cloze。
//   多空填空的题干里用 {{1}}…{{n}} 标出空格；答题页把标记换成行内输入框，成绩页按空着色。
import { useRef } from 'react';

import { setAt, clozeParts, clozeMarkers, insertMarker, LIMITS, stateOf } from './model.js';
import { kt, ktFor, locText, FieldError, ResRow, ExplRow } from './common.jsx';
const toneOf = (st) => (st === 'ok' ? 'ok' : st === 'pending' ? 'pending' : 'bad');

/* ---------------- 编辑器 ---------------- */

export function FillRunner({ value, onChange, lang, readOnly }) {
  const s = kt(lang);
  return (
    <div className="exam-options">
      <input type="text" className="exam-textarea" placeholder={s.fillPlaceholder} disabled={readOnly}
        value={typeof value === 'string' ? value : ''} onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}

// 多空填空：题干原位换成输入框（6ch–24ch，随文字换行）
export function ClozeRunner({ q, value, onChange, lang, readOnly }) {
  const s = kt(lang);
  const n = Number(q.blanks) || 0;
  const cur = Array.isArray(value) && value.length === n ? value : Array.from({ length: n }, () => '');
  const set = (i, v) => onChange(cur.map((x, k) => (k === i ? v : x)));
  const parts = clozeParts(locText(q, 'question', lang));
  return (
    <p className="exam-qtext qt-cloze">
      {parts.map((p, k) => {
        if (p.t === 'text') return <span key={k}>{p.s}</span>;
        const i = p.n - 1;
        if (i < 0 || i >= n) return <span key={k}>{`{{${p.n}}}`}</span>;
        const v = cur[i] || '';
        return (
          <input key={k} type="text" className="qt-blank" aria-label={s.blankAria(p.n)} disabled={readOnly} value={v} maxLength={LIMITS.clozeAnswerLen}
            style={{ width: `${Math.min(24, Math.max(6, v.length + 2))}ch` }} onChange={(e) => set(i, e.target.value)} />
        );
      })}
    </p>
  );
}

/* ---------------- 成绩回顾 ---------------- */

export function FillReview({ d, lang, showAnswers, audience }) {
  const s = ktFor(lang, audience);
  const st = stateOf(d);
  const show = audience === 'hr' || showAnswers !== false;
  const yours = d.answer && String(d.answer).trim() !== '' ? d.answer : s.notAnswered;
  const acc = show && Array.isArray(d.accepted) ? d.accepted.join(' / ') : '';
  return (
    <>
      <ResRow tone={toneOf(st)} label={s.yourAns}>{yours}</ResRow>
      {st !== 'ok' && acc && <ResRow tone="ok" label={s.accepted}>{acc}</ResRow>}
      <ExplRow d={d} lang={lang} />
    </>
  );
}

export function ClozeReview({ d, lang, showAnswers, audience }) {
  const s = ktFor(lang, audience);
  const st = stateOf(d);
  const show = audience === 'hr' || showAnswers !== false;
  const resp = Array.isArray(d.response) ? d.response : [];
  const right = Array.isArray(d.blankRight) ? d.blankRight : [];
  const blanks = show && Array.isArray(d.blanks) ? d.blanks : null;
  const parts = clozeParts(locText(d, 'question', lang));
  return (
    <>
      <ResRow tone={toneOf(st)} label={s.yourAns}>
        <span className="qt-cloze-rv">
          {parts.map((p, k) => {
            if (p.t === 'text') return <span key={k}>{p.s}</span>;
            const i = p.n - 1;
            const v = String(resp[i] == null ? '' : resp[i]).trim();
            const ok = !!right[i];
            return (
              <span key={k} className={'qt-blank-rv ' + (ok ? 'ok' : 'bad')}>
                <span className="qk-sr">{s.blankAria(p.n)}{' '}</span>{v || s.notAnswered}
                <span className="qk-sr">{' '}{ok ? s.blankOk : s.blankBad}</span>
              </span>
            );
          })}
        </span>
      </ResRow>
      {st !== 'ok' && blanks && (
        <ResRow tone="ok" label={s.accepted}>
          <span className="qt-cloze-acc">
            {blanks.map((b, i) => (
              <span key={i}><b>{s.blankN(i + 1)}</b>{(Array.isArray(b && b.answers) ? b.answers : []).join(' / ')}</span>
            ))}
          </span>
        </ResRow>
      )}
      <ExplRow d={d} lang={lang} />
    </>
  );
}

/* ---------------- 题库预览 ---------------- */

export function FillPreview({ q, lang }) {
  const s = kt(lang);
  const list = (Array.isArray(q.answers) ? q.answers : []).filter((a) => String(a).trim());
  return <div className="qk-pv-line">{s.acceptedList(list.join(' / '))}</div>;
}

export function ClozePreview({ q, lang }) {
  const s = kt(lang);
  const blanks = Array.isArray(q.blanks) ? q.blanks : [];
  return (
    <ol className="qk-pv-list">
      {blanks.map((b, i) => (
        <li key={i}><b>{s.blankN(i + 1)}</b>{(Array.isArray(b && b.answers) ? b.answers : []).join(' / ')}</li>
      ))}
    </ol>
  );
}
