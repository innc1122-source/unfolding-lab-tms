// Ordering 题型的编辑器（简化 10/11 从 Ordering.jsx 拆出，后台题库 / 组卷用；员工端不引）
// 第四批 6.1（2026-10-08，G3）：排序题 ordering。
//   作答不依赖拖拽：每行有位置号与 ↑ ↓；点选一项、再点目标位置即可移过去（触屏、键盘、读屏都能用）；桌面上原生拖拽是附加的。
//   没动过顺序（也没点「确认顺序」）= 未作答，打乱后的初始顺序不会被当成答案白拿部分分。
import { useRef, useState } from 'react';
import { Button } from '@douyinfe/semi-ui';
import { setAt, moveItem, identity, orderingPairs, LIMITS, stateOf } from './model.js';
import { kt, locText, FieldError, ResRow, ExplRow } from './common.jsx';
import { BiTextRow, MoveButtons, RemoveButton, EditorShell } from './commonEdit.jsx';

/* ---------------- 编辑器 ---------------- */

export function OrderingEditor(props) {
  const { draft, onChange, lang, errors } = props;
  const s = kt(lang);
  const items = Array.isArray(draft.items) ? draft.items : [];
  const set = (next) => onChange(setAt(draft, 'items', next));
  return (
    <EditorShell {...props}>
      <div className="qk-block">
        <div className="qk-label">{s.stepsH}</div>
        <div className="qk-hint">{s.orderingCap}</div>
        <ol className="qk-steps">
          {items.map((it, i) => (
            <li className="qk-steprow" key={i}>
              <span className="qk-stepno tnum" aria-hidden="true">{i + 1}</span>
              <div className="qk-stepbody">
                <BiTextRow value={it} onChange={(v) => set(items.map((x, k) => (k === i ? v : x)))} lang={lang} compact
                  errors={errors} field={`items.${i}`} phZh={s.stepN(i + 1)} phEn={kt('en').stepN(i + 1)} />
              </div>
              <span className="qk-rowact">
                <MoveButtons index={i} count={items.length} onMove={(a, b) => set(moveItem(items, a, b))} lang={lang} label={s.stepN(i + 1)} />
                <RemoveButton onClick={() => set(items.filter((_, k) => k !== i))} disabled={items.length <= LIMITS.orderingMin} lang={lang} label={`${s.remove} ${s.stepN(i + 1)}`} />
              </span>
            </li>
          ))}
        </ol>
        <div className="qb-optfoot">
          <Button theme="borderless" type="primary" size="small" disabled={items.length >= LIMITS.orderingMax} onClick={() => set([...items, { zh: '', en: '' }])}>+ {s.addStep}</Button>
          <FieldError errors={errors} field="items" lang={lang} />
        </div>
      </div>
    </EditorShell>
  );
}

/* ---------------- 学员作答 ---------------- */
