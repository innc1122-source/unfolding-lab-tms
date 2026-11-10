// 第四批 6.1（2026-10-08，G3）：选择类题型 —— 单选 mcq、多选 multi、判断 tf。
//   学员端标记与样式沿用原答题页 / 成绩页（exam-opt、res-arow），老题型的显示与原来一致。
import { useId } from 'react';

import { setAt, moveItem, LIMITS, stateOf } from './model.js';
import { kt, ktFor, locText, OPT_KEY, listSep, FieldError, ResRow, ExplRow } from './common.jsx';

/* ---------------- 编辑器 ---------------- */
export function ChoiceRunner({ q, value, onChange, lang, readOnly }) {
  const name = useId();
  const opts = Array.isArray(q.options) ? q.options : [];
  if (q.type === 'multi') {
    const cur = Array.isArray(value) ? value : [];
    const toggle = (i) => onChange(cur.includes(i) ? cur.filter((x) => x !== i) : [...cur, i].sort((x, y) => x - y));
    return (
      <div className="exam-options">
        {opts.map((o, i) => {
          const on = cur.includes(i);
          return (
            <label key={i} className={'exam-opt' + (on ? ' on' : '')}>
              <input type="checkbox" checked={on} disabled={readOnly} onChange={() => toggle(i)} />
              <span className="exam-mark check" aria-hidden="true" />
              <span className="exam-key">{OPT_KEY(i)}</span>
              <span className="exam-lbl">{locText(o, 'text', lang)}</span>
            </label>
          );
        })}
      </div>
    );
  }
  return (
    <div className="exam-options">
      {opts.map((o, i) => {
        const on = value === i;
        return (
          <label key={i} className={'exam-opt' + (on ? ' on' : '')}>
            <input type="radio" name={name} checked={on} disabled={readOnly} onChange={() => onChange(i)} />
            <span className="exam-mark radio" aria-hidden="true" />
            <span className="exam-key">{OPT_KEY(i)}</span>
            <span className="exam-lbl">{locText(o, 'text', lang)}</span>
          </label>
        );
      })}
    </div>
  );
}

// 判断题：两个固定选项，正确在前、错误在后，从不打乱
export function TfRunner({ value, onChange, lang, readOnly }) {
  const s = kt(lang);
  const name = useId();
  return (
    <div className="exam-options">
      {[[true, s.tfTrue], [false, s.tfFalse]].map(([v, label], i) => {
        const on = value === v;
        return (
          <label key={String(v)} className={'exam-opt' + (on ? ' on' : '')}>
            <input type="radio" name={name} checked={on} disabled={readOnly} onChange={() => onChange(v)} />
            <span className="exam-mark radio" aria-hidden="true" />
            <span className="exam-key">{OPT_KEY(i)}</span>
            <span className="exam-lbl">{label}</span>
          </label>
        );
      })}
    </div>
  );
}

/* ---------------- 成绩回顾 ---------------- */

const toneOf = (st) => (st === 'ok' ? 'ok' : st === 'pending' ? 'pending' : 'bad');
const optText = (options, i, lang) => {
  if (!Array.isArray(options) || i == null || !options[i]) return '';
  return locText(options[i], 'text', lang);
};

export function ChoiceReview({ d, lang, showAnswers, audience }) {
  const s = ktFor(lang, audience);
  const st = stateOf(d);
  const show = audience === 'hr' || showAnswers !== false;
  let yours, answer = null;
  if (d.type === 'multi') {
    const picked = Array.isArray(d.picked) ? d.picked : [];
    yours = picked.length ? picked.map((i) => optText(d.options, i, lang)).filter(Boolean).join(listSep(lang)) : s.notAnswered;
    if (show && Array.isArray(d.correct)) answer = d.correct.map((i) => optText(d.options, i, lang)).filter(Boolean).join(listSep(lang)) || null;
  } else {
    yours = d.picked == null ? s.notAnswered : (optText(d.options, d.picked, lang) || s.notAnswered);
    if (show && d.correct !== undefined) answer = optText(d.options, d.correct, lang) || null;
  }
  return (
    <>
      <ResRow tone={toneOf(st)} label={s.yourAns}>{yours}</ResRow>
      {st !== 'ok' && answer && <ResRow tone="ok" label={s.correctAns}>{answer}</ResRow>}
      <ExplRow d={d} lang={lang} />
    </>
  );
}

export function TfReview({ d, lang, showAnswers, audience }) {
  const s = ktFor(lang, audience);
  const st = stateOf(d);
  const show = audience === 'hr' || showAnswers !== false;
  const word = (v) => (v === true ? s.tfTrue : v === false ? s.tfFalse : s.notAnswered);
  const correct = typeof d.answer === 'boolean' ? d.answer : typeof d.key === 'boolean' ? d.key : undefined;
  return (
    <>
      <ResRow tone={toneOf(st)} label={s.yourAns}>{word(d.response)}</ResRow>
      {st !== 'ok' && show && correct !== undefined && <ResRow tone="ok" label={s.correctAns}>{word(correct)}</ResRow>}
      <ExplRow d={d} lang={lang} />
    </>
  );
}

/* ---------------- 题库预览（组卷 / 题库展开 / AI 草稿） ---------------- */

export function ChoicePreview({ q, lang }) {
  const opts = Array.isArray(q.options) ? q.options : [];
  return (
    <ol className="qk-pv-opts">
      {opts.map((o, i) => (
        <li key={i} className={o.ok ? 'ok' : ''}>
          <span className="qk-pv-key">{OPT_KEY(i)}</span>
          <span className="qk-pv-txt">{locText(o, 'text', lang)}</span>
          {o.ok && <span className="qk-pv-tick" aria-label={kt(lang).markCorrect}>✓</span>}
        </li>
      ))}
    </ol>
  );
}

export function TfPreview({ q, lang }) {
  const s = kt(lang);
  return <div className="qk-pv-line"><b>{s.answerKey}</b>{q.answer === false ? s.tfFalse : s.tfTrue}</div>;
}
