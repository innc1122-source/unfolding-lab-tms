// 第四批 6.1（2026-10-08，G3）：排序题 ordering。
//   作答不依赖拖拽：每行有位置号与 ↑ ↓；点选一项、再点目标位置即可移过去（触屏、键盘、读屏都能用）；桌面上原生拖拽是附加的。
//   没动过顺序（也没点「确认顺序」）= 未作答，打乱后的初始顺序不会被当成答案白拿部分分。
import { useRef, useState } from 'react';

import { setAt, moveItem, identity, orderingPairs, LIMITS, stateOf } from './model.js';
import { kt, ktFor, locText, FieldError, ResRow, ExplRow } from './common.jsx';

/* ---------------- 编辑器 ---------------- */
export function OrderingRunner({ q, value, onChange, lang, readOnly }) {
  const s = kt(lang);
  const items = Array.isArray(q.items) ? q.items : [];
  const n = items.length;
  const touched = Array.isArray(value) && value.length === n;
  const order = touched ? value : identity(n);
  const [sel, setSel] = useState(null); // 选中的位置
  const [live, setLive] = useState('');
  const drag = useRef(null);
  const textOf = (idx) => locText(items[idx], 'text', lang);
  const move = (from, to) => {
    if (readOnly || from === to || from == null || to == null) return;
    const next = moveItem(order, from, to);
    onChange(next);
    setLive(s.movedTo(textOf(order[from]), to + 1));
    setSel(null);
  };
  const tap = (pos) => {
    if (readOnly) return;
    if (sel == null) { setSel(pos); setLive(s.orderSelected(textOf(order[pos]))); return; }
    if (sel === pos) { setSel(null); setLive(''); return; }
    move(sel, pos);
  };
  return (
    <div className="exam-options qt-order" onKeyDown={(e) => { if (e.key === 'Escape' && sel != null) { setSel(null); setLive(''); } }}>
      {!readOnly && <div className="qt-hint">{s.orderSelectHint}</div>}
      <ol className="qt-order-list">
        {order.map((idx, pos) => (
          <li
            key={idx}
            className={'qt-order-row' + (sel === pos ? ' sel' : '') + (sel != null && sel !== pos ? ' target' : '')}
            draggable={!readOnly}
            onDragStart={(e) => { drag.current = pos; try { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', String(pos)); } catch { /* 老浏览器 */ } }}
            onDragOver={(e) => { if (drag.current != null) e.preventDefault(); }}
            onDrop={(e) => { e.preventDefault(); const from = drag.current; drag.current = null; move(from, pos); }}
            onDragEnd={() => { drag.current = null; }}
          >
            <span className="qt-order-pos tnum" aria-hidden="true">{pos + 1}</span>
            <button type="button" className="qt-order-text" aria-pressed={sel === pos} disabled={readOnly}
              aria-label={s.posText(pos + 1, textOf(idx))} onClick={() => tap(pos)}>
              {textOf(idx)}
            </button>
            {!readOnly && (
              <span className="qt-order-act">
                <button type="button" className="qt-iconbtn" disabled={pos === 0} onClick={() => move(pos, pos - 1)} aria-label={s.moveUpT(textOf(idx))}>↑</button>
                <button type="button" className="qt-iconbtn" disabled={pos === n - 1} onClick={() => move(pos, pos + 1)} aria-label={s.moveDownT(textOf(idx))}>↓</button>
              </span>
            )}
          </li>
        ))}
      </ol>
      {!readOnly && !touched && (
        <div className="qt-order-confirm">
          <span>{s.orderHint}</span>
          <button type="button" className="btn ghost sm" onClick={() => { onChange(identity(n)); setLive(s.orderConfirmed); }}>{s.confirmOrder}</button>
        </div>
      )}
      {!readOnly && sel != null && (
        <button type="button" className="link-btn qt-cancel" onClick={() => { setSel(null); setLive(''); }}>{s.cancelSelect}</button>
      )}
      <div className="qk-sr" aria-live="polite">{live}</div>
    </div>
  );
}

/* ---------------- 成绩回顾 ---------------- */

export function OrderingReview({ d, lang, showAnswers, audience }) {
  const s = ktFor(lang, audience);
  const st = stateOf(d);
  const show = audience === 'hr' || showAnswers !== false;
  const items = Array.isArray(d.items) ? d.items : [];
  const resp = Array.isArray(d.response) ? d.response : null;
  const key = show && Array.isArray(d.key) ? d.key : null;
  const pairs = resp && key ? orderingPairs(resp, key) : [];
  const text = (i) => locText(items[i], 'text', lang);
  return (
    <>
      <ResRow tone={st === 'ok' ? 'ok' : 'bad'} label={s.yourOrder}>
        {resp ? (
          <ol className="qt-rv-order">
            {resp.map((i, k) => (
              <li key={k}>
                {text(i)}
                {k < pairs.length && pairs[k] && <span className="qt-rv-link" title={s.pairOk} aria-label={s.pairOk}>✓</span>}
              </li>
            ))}
          </ol>
        ) : s.notAnswered}
      </ResRow>
      {st !== 'ok' && key && (
        <ResRow tone="ok" label={s.correctOrder}>
          <ol className="qt-rv-order">{key.map((i, k) => <li key={k}>{text(i)}</li>)}</ol>
        </ResRow>
      )}
      <ExplRow d={d} lang={lang} />
    </>
  );
}

/* ---------------- 题库预览 ---------------- */

export function OrderingPreview({ q, lang }) {
  const items = Array.isArray(q.items) ? q.items : [];
  return <ol className="qk-pv-list qk-pv-num">{items.map((it, i) => <li key={i}>{locText(it, 'text', lang)}</li>)}</ol>;
}
