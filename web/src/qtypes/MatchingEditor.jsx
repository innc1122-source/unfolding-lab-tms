// Matching 题型的编辑器（简化 10/11 从 Matching.jsx 拆出，后台题库 / 组卷用；员工端不引）
// 第四批 6.1（2026-10-08，G3）：匹配题 matching。
//   作答：每个左项一行，用下拉框选右栏的项（A、B、C… 加文字）；别处已选的标「已选」但仍可选。不用拖拽，触屏与键盘都能答。
import { Button } from '@douyinfe/semi-ui';
import { setAt, moveItem, LIMITS, stateOf } from './model.js';
import { kt, locText, OPT_KEY, FieldError, ResRow, ExplRow } from './common.jsx';
import { BiTextRow, MoveButtons, RemoveButton, EditorShell } from './commonEdit.jsx';

/* ---------------- 编辑器 ---------------- */

export function MatchingEditor(props) {
  const { draft, onChange, lang, errors } = props;
  const s = kt(lang);
  const pairs = Array.isArray(draft.pairs) ? draft.pairs : [];
  const ds = Array.isArray(draft.distractors) ? draft.distractors : [];
  const setPairs = (next) => onChange(setAt(draft, 'pairs', next));
  const setDs = (next) => onChange(setAt(draft, 'distractors', next));
  return (
    <EditorShell {...props}>
      <div className="qk-block">
        <div className="qk-label">{s.pairsH}</div>
        {pairs.map((p, i) => (
          <div className="qk-pair" key={i}>
            <div className="qk-pair-h">
              <span className="qk-rowlab">{s.pairN(i + 1)}</span>
              <span className="qk-rowact">
                <MoveButtons index={i} count={pairs.length} onMove={(a, b) => setPairs(moveItem(pairs, a, b))} lang={lang} label={s.pairN(i + 1)} />
                <RemoveButton onClick={() => setPairs(pairs.filter((_, k) => k !== i))} disabled={pairs.length <= LIMITS.pairsMin} lang={lang} label={`${s.remove} ${s.pairN(i + 1)}`} />
              </span>
            </div>
            <div className="qk-pair-grid">
              <BiTextRow label={s.leftH} value={p.left} onChange={(v) => setPairs(pairs.map((x, k) => (k === i ? { ...x, left: v } : x)))} lang={lang} compact errors={errors} field={`pairs.${i}.left`} />
              <BiTextRow label={s.rightH} value={p.right} onChange={(v) => setPairs(pairs.map((x, k) => (k === i ? { ...x, right: v } : x)))} lang={lang} compact errors={errors} field={`pairs.${i}.right`} />
            </div>
          </div>
        ))}
        <div className="qb-optfoot">
          <Button theme="borderless" type="primary" size="small" disabled={pairs.length >= LIMITS.pairsMax} onClick={() => setPairs([...pairs, { left: { zh: '', en: '' }, right: { zh: '', en: '' } }])}>+ {s.addPair}</Button>
          <FieldError errors={errors} field="pairs" lang={lang} />
        </div>
      </div>
      <div className="qk-block">
        <div className="qk-label">{s.distractorsH}</div>
        <div className="qk-hint">{s.distractorsHint}</div>
        {ds.map((d, i) => (
          <div className="qk-row" key={i}>
            <div className="qk-grow"><BiTextRow value={d} onChange={(v) => setDs(ds.map((x, k) => (k === i ? v : x)))} lang={lang} compact errors={errors} field={`distractors.${i}`} /></div>
            <RemoveButton onClick={() => setDs(ds.filter((_, k) => k !== i))} lang={lang} label={`${s.remove} ${s.distractorTag} ${i + 1}`} />
          </div>
        ))}
        <div className="qb-optfoot">
          <Button theme="borderless" type="primary" size="small" disabled={ds.length >= LIMITS.distractorsMax} onClick={() => setDs([...ds, { zh: '', en: '' }])}>+ {s.addDistractor}</Button>
          <FieldError errors={errors} field="distractors" lang={lang} />
        </div>
      </div>
    </EditorShell>
  );
}

/* ---------------- 学员作答 ---------------- */
