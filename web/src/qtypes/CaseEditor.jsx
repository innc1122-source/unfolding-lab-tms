// Case 题型的编辑器（简化 10/11 从 Case.jsx 拆出，后台题库 / 组卷用；员工端不引）
// 第四批 6.1（2026-10-08，G3）：情境案例题组 case —— 一段案例材料 + 2–8 道客观小题。
//   编辑仍在一个整页里完成（小题可折叠，不再开新页）；答题页按小题逐题展示（答题卡 3.1–3.4），手机上案例材料可收起；
//   成绩页案例材料默认收起，逐小题回顾。
import { useState } from 'react';
import { Button, Modal } from '@douyinfe/semi-ui';
import { setAt, moveItem, changeType, hasTypeContent, emptySub, caseTotal, earnedOf, maxOf, stateOf, LIMITS } from './model.js';
import { typeLabel } from './spec.js';
import { kt, locText, stemOf, FieldError, ResRow, scopedErrors } from './common.jsx';
import { BiTextRow, MoveButtons, RemoveButton } from './commonEdit.jsx';
import { ChoiceRunner, TfRunner, ChoiceReview, TfReview, ChoicePreview, TfPreview } from './Choice.jsx';
import { ChoiceEditor, TfEditor } from './ChoiceEditor.jsx';
import { FillRunner, ClozeRunner, FillReview, ClozeReview, FillPreview, ClozePreview } from './Fill.jsx';
import { FillEditor, ClozeEditor } from './FillEditor.jsx';
import { OrderingRunner, OrderingReview, OrderingPreview } from './Ordering.jsx';
import { OrderingEditor } from './OrderingEditor.jsx';
import { MatchingRunner, MatchingReview, MatchingPreview } from './Matching.jsx';
import { MatchingEditor } from './MatchingEditor.jsx';
import { ClassifyRunner, ClassifyReview, ClassifyPreview } from './Classify.jsx';
import { ClassifyEditor } from './ClassifyEditor.jsx';
import { subDef as viewSubDef } from './Case.jsx';

// 小题编辑器（作答 / 回顾部件在 Case.jsx 的小题表里）
const SUB_EDITOR = { mcq: ChoiceEditor, multi: ChoiceEditor, tf: TfEditor, fill: FillEditor, cloze: ClozeEditor, ordering: OrderingEditor, matching: MatchingEditor, classify: ClassifyEditor };
const subDef = (type) => { const d = viewSubDef(type); return d ? { ...d, Editor: SUB_EDITOR[type] } : null; };

export function CaseEditor({ draft, onChange, lang, errors }) {
  const s = kt(lang);
  const subs = Array.isArray(draft.subs) ? draft.subs : [];
  const [closed, setClosed] = useState(() => new Set());
  const setSubs = (next) => onChange(setAt(draft, 'subs', next));
  const setSub = (i, sub) => setSubs(subs.map((x, k) => (k === i ? sub : x)));
  const retype = (i, t) => {
    const sub = subs[i];
    if (!sub || sub.type === t) return;
    const go = () => setSub(i, changeType(sub, t));
    if (hasTypeContent(sub)) Modal.confirm({ title: s.subType, content: s.retypeAsk, okText: s.retypeOk, cancelText: s.cancel, onOk: go });
    else go();
  };
  const toggle = (i) => setClosed((prev) => { const n = new Set(prev); if (n.has(i)) n.delete(i); else n.add(i); return n; });
  // 移动 / 删除后折叠状态按新位置重排
  const moveSub = (a, b) => {
    setSubs(moveItem(subs, a, b));
    setClosed((prev) => { const arr = subs.map((_, k) => prev.has(k)); const m = moveItem(arr, a, b); return new Set(m.map((v, k) => (v ? k : -1)).filter((k) => k >= 0)); });
  };
  const removeSub = (i) => {
    setSubs(subs.filter((_, k) => k !== i));
    setClosed((prev) => new Set([...prev].filter((k) => k !== i).map((k) => (k > i ? k - 1 : k))));
  };
  return (
    <div className="qk-editor qk-case">
      <BiTextRow value={draft.stem} onChange={(v) => onChange(setAt(draft, 'stem', v))}
        labelZh={s.caseTitleZh} labelEn={s.caseTitleEn} lang={lang} errors={errors} field="stem" />
      <BiTextRow value={draft.passage} onChange={(v) => onChange(setAt(draft, 'passage', v))} multiline rows={5} max={LIMITS.passageMax}
        labelZh={s.passageZh} labelEn={s.passageEn} phZh={s.passagePh} phEn={kt('en').passagePh} lang={lang} errors={errors} field="passage" />
      <div className="qk-block">
        <div className="qk-case-h">
          <span className="qk-label">{s.subsH}</span>
          <span className="qk-total tnum">{s.caseTotal(caseTotal(draft))}</span>
        </div>
        {subs.map((sub, i) => {
          const def = subDef(sub.type);
          const open = !closed.has(i);
          const pre = `subs.${i}.`;
          const bad = (errors || []).some((e) => e.field.startsWith(pre));
          return (
            <section className={'qk-sub' + (bad ? ' bad' : '')} key={i}>
              <div className="qk-sub-h">
                <button type="button" className="qk-sub-toggle" aria-expanded={open} onClick={() => toggle(i)}>
                  <span className="qk-caret" aria-hidden="true">{open ? '▾' : '▸'}</span>
                  <b>{s.subN(i + 1)}</b>
                  <span className="qk-muted">{typeLabel(sub.type, lang)}</span>
                  {!open && <span className="qk-sub-peek">{stemOf({ ...sub, question: sub.stem && sub.stem.en, question_zh: sub.stem && sub.stem.zh }, lang)}</span>}
                </button>
                <span className="qk-rowact">
                  <MoveButtons index={i} count={subs.length} onMove={moveSub} lang={lang} label={s.subN(i + 1)} />
                  <RemoveButton onClick={() => removeSub(i)} disabled={subs.length <= LIMITS.subsMin} lang={lang} label={`${s.remove} ${s.subN(i + 1)}`} />
                </span>
              </div>
              {open && (def
                ? <def.Editor draft={sub} onChange={(ns) => setSub(i, ns)} lang={lang} errors={scopedErrors(errors, pre)} inCase onTypeChange={(t) => retype(i, t)} />
                : <FieldError errors={scopedErrors(errors, pre)} field="type" lang={lang} />)}
            </section>
          );
        })}
        <div className="qb-optfoot">
          <Button theme="borderless" type="primary" size="small" disabled={subs.length >= LIMITS.subsMax} onClick={() => setSubs([...subs, emptySub('mcq')])}>+ {s.addSub}</Button>
          <FieldError errors={errors} field="subs" lang={lang} />
        </div>
      </div>
    </div>
  );
}

/* ---------------- 学员作答 ---------------- */
