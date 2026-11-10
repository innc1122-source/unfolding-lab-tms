// 第四批 6.1（2026-10-08，G3）：分类题 classify。
//   作答：每个项目一行，用分段按钮（单选组，方向键可切换）选类别；类别多于 3 个时手机上换成下拉框。
import { useId } from 'react';

import { setAt, moveItem, LIMITS, stateOf } from './model.js';
import { kt, ktFor, locText, FieldError, ResRow, ExplRow } from './common.jsx';
import { PickTable } from './Matching.jsx';

/* ---------------- 编辑器 ---------------- */
export function ClassifyRunner({ q, value, onChange, lang, readOnly }) {
  const s = kt(lang);
  const base = useId();
  const cats = Array.isArray(q.categories) ? q.categories : [];
  const items = Array.isArray(q.items) ? q.items : [];
  const cur = Array.isArray(value) && value.length === items.length ? value : items.map(() => null);
  const set = (i, v) => onChange(cur.map((x, k) => (k === i ? v : x)));
  const many = cats.length > 3;
  return (
    <div className="exam-options qt-cls">
      {items.map((it, i) => {
        const t = locText(it, 'text', lang);
        const v = cur[i];
        return (
          <fieldset key={i} className={'qt-cls-row' + (Number.isInteger(v) ? ' on' : '')} disabled={readOnly}>
            <legend className="qt-cls-item">{t}</legend>
            <div className={'qt-seg' + (many ? ' many' : '')} role="radiogroup" aria-label={s.classifyFor(t)}>
              {cats.map((c, k) => (
                <label key={k} className={'qt-seg-opt' + (v === k ? ' on' : '')}>
                  <input type="radio" name={`${base}-${i}`} checked={v === k} onChange={() => set(i, k)} />
                  <span>{locText(c, 'text', lang)}</span>
                </label>
              ))}
            </div>
            {many && (
              <select className="qt-select qt-cls-sel" value={Number.isInteger(v) ? String(v) : ''} aria-label={s.classifyFor(t)}
                onChange={(e) => set(i, e.target.value === '' ? null : Number(e.target.value))}>
                <option value="">{s.choose}</option>
                {cats.map((c, k) => <option key={k} value={String(k)}>{locText(c, 'text', lang)}</option>)}
              </select>
            )}
          </fieldset>
        );
      })}
    </div>
  );
}

/* ---------------- 成绩回顾 ---------------- */

export function ClassifyReview({ d, lang, showAnswers, audience }) {
  const s = ktFor(lang, audience);
  const st = stateOf(d);
  const show = audience === 'hr' || showAnswers !== false;
  const cats = Array.isArray(d.categories) ? d.categories : [];
  const items = Array.isArray(d.items) ? d.items : [];
  const resp = Array.isArray(d.response) ? d.response : [];
  const key = show && Array.isArray(d.key) ? d.key : null;
  const ct = (k) => (Number.isInteger(k) && cats[k] ? locText(cats[k], 'text', lang) : '');
  const rows = items.map((it, i) => ({
    item: locText(it, 'text', lang),
    yours: ct(resp[i]),
    ok: key ? resp[i] === key[i] : null,
    correct: key ? ct(key[i]) : '',
  }));
  return (
    <>
      <ResRow tone={st === 'ok' ? 'ok' : 'bad'} label={s.yourAns}>
        <PickTable rows={rows} lang={lang} showKey={!!key && st !== 'ok'} audience={audience} />
      </ResRow>
      <ExplRow d={d} lang={lang} />
    </>
  );
}

/* ---------------- 题库预览 ---------------- */

export function ClassifyPreview({ q, lang }) {
  const cats = Array.isArray(q.categories) ? q.categories : [];
  const items = Array.isArray(q.items) ? q.items : [];
  return (
    <ul className="qk-pv-list">
      {cats.map((c, k) => (
        <li key={k}>
          <b>{locText(c, 'text', lang)}</b>
          {items.filter((it) => it.cat === k).map((it) => locText(it, 'text', lang)).join(lang === 'zh' ? '、' : ', ')}
        </li>
      ))}
    </ul>
  );
}
