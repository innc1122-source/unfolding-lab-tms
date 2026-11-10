// 第四批 6.1（2026-10-08，G3）：匹配题 matching。
//   作答：每个左项一行，用下拉框选右栏的项（A、B、C… 加文字）；别处已选的标「已选」但仍可选。不用拖拽，触屏与键盘都能答。

import { setAt, moveItem, LIMITS, stateOf } from './model.js';
import { kt, ktFor, locText, OPT_KEY, FieldError, ResRow, ExplRow } from './common.jsx';

/* ---------------- 编辑器 ---------------- */
export function MatchingRunner({ q, value, onChange, lang, readOnly }) {
  const s = kt(lang);
  const lefts = Array.isArray(q.lefts) ? q.lefts : [];
  const rights = Array.isArray(q.rights) ? q.rights : [];
  const cur = Array.isArray(value) && value.length === lefts.length ? value : lefts.map(() => null);
  const set = (i, v) => onChange(cur.map((x, k) => (k === i ? v : x)));
  return (
    <div className="exam-options qt-match">
      <div className="qt-match-rights">
        <div className="qt-sub-h">{s.rightsH}</div>
        <ul>
          {rights.map((r, j) => (
            <li key={j}><span className="exam-key">{OPT_KEY(j)}</span><span>{locText(r, 'text', lang)}</span></li>
          ))}
        </ul>
      </div>
      {lefts.map((l, i) => {
        const lt = locText(l, 'text', lang);
        const v = cur[i];
        return (
          <div key={i} className={'qt-match-row' + (Number.isInteger(v) ? ' on' : '')}>
            <span className="qt-match-left">{lt}</span>
            <select className="qt-select" value={Number.isInteger(v) ? String(v) : ''} disabled={readOnly} aria-label={s.matchFor(lt)}
              onChange={(e) => set(i, e.target.value === '' ? null : Number(e.target.value))}>
              <option value="">{s.choose}</option>
              {rights.map((r, j) => {
                const elsewhere = cur.some((x, k) => k !== i && x === j);
                return <option key={j} value={String(j)}>{`${OPT_KEY(j)}. ${locText(r, 'text', lang)}${elsewhere ? ` · ${s.inUse}` : ''}`}</option>;
              })}
            </select>
          </div>
        );
      })}
    </div>
  );
}

/* ---------------- 成绩回顾 ---------------- */

// 匹配题与分类题共用的回顾表：项目 → 你的选择 ✓/✗ → 正确选择（只在显示答案时）
export function PickTable({ rows, lang, showKey, audience }) {
  const s = ktFor(lang, audience);   // CX-149（R183）：后台答卷表头写「本人选择」
  return (
    <div className="qt-rv-tablewrap">
      <table className="qt-rv-table">
        <thead>
          <tr><th scope="col">{s.item}</th><th scope="col">{s.yourChoice}</th>{showKey && <th scope="col">{s.correctChoice}</th>}</tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className={r.ok == null ? '' : r.ok ? 'ok' : 'bad'}>
              <td>{r.item}</td>
              <td>
                {r.ok != null && <span className="qt-rv-mark" aria-hidden="true">{r.ok ? '✓' : '✗'}</span>}
                {r.ok != null && <span className="qk-sr">{r.ok ? s.correct : s.incorrect}</span>}
                {r.yours || s.notAnswered}
              </td>
              {showKey && <td>{r.correct}</td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function MatchingReview({ d, lang, showAnswers, audience }) {
  const s = ktFor(lang, audience);
  const st = stateOf(d);
  const show = audience === 'hr' || showAnswers !== false;
  const lefts = Array.isArray(d.lefts) ? d.lefts : [];
  const rights = Array.isArray(d.rights) ? d.rights : [];
  const resp = Array.isArray(d.response) ? d.response : [];
  const key = show && Array.isArray(d.key) ? d.key : null;
  const rt = (j) => (Number.isInteger(j) && rights[j] ? `${OPT_KEY(j)}. ${locText(rights[j], 'text', lang)}` : '');
  // 没有 key（答案不公开）时不逐行标对错（那等于泄露答案），只看整题的对错状态
  const rows = lefts.map((l, i) => ({
    item: locText(l, 'text', lang),
    yours: rt(resp[i]),
    ok: key ? resp[i] === key[i] : null,
    correct: key ? rt(key[i]) : '',
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

export function MatchingPreview({ q, lang }) {
  const s = kt(lang);
  const pairs = Array.isArray(q.pairs) ? q.pairs : [];
  const ds = Array.isArray(q.distractors) ? q.distractors : [];
  return (
    <ul className="qk-pv-list">
      {pairs.map((p, i) => (
        <li key={i}>{locText(p.left, 'text', lang)}<span className="qk-pv-arrow" aria-hidden="true"> → </span><span className="qk-sr"> : </span>{locText(p.right, 'text', lang)}</li>
      ))}
      {ds.map((d, i) => <li key={'d' + i} className="qk-muted"><span className="qk-pv-tag">{s.distractorTag}</span>{locText(d, 'text', lang)}</li>)}
    </ul>
  );
}
