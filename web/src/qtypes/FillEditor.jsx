// Fill 题型的编辑器（简化 10/11 从 Fill.jsx 拆出，后台题库 / 组卷用；员工端不引）
// 第四批 6.1（2026-10-08，G3）：填空类题型 —— 填空 fill、多空填空 cloze。
//   多空填空的题干里用 {{1}}…{{n}} 标出空格；答题页把标记换成行内输入框，成绩页按空着色。
import { useRef } from 'react';
import { Button, Input, TagInput } from '@douyinfe/semi-ui';
import { setAt, clozeParts, clozeMarkers, insertMarker, LIMITS, stateOf } from './model.js';
import { kt, locText, FieldError, ResRow, ExplRow } from './common.jsx';
import { EditorShell, RemoveButton } from './commonEdit.jsx';

export function FillEditor(props) {
  const { draft, onChange, lang, errors } = props;
  const s = kt(lang);
  const answers = Array.isArray(draft.answers) && draft.answers.length ? draft.answers : [''];
  const set = (next) => onChange(setAt(draft, 'answers', next));
  return (
    <EditorShell {...props}>
      <div className="qk-block">
        <div className="qk-label">{s.fillAnswers}</div>
        <div className="qk-hint">{s.fillHint}</div>
        {answers.map((a, i) => (
          <div className="qk-row" key={i}>
            <Input value={a} onChange={(v) => set(answers.map((x, k) => (k === i ? v : x)))} placeholder={s.answerPh} aria-label={`${s.fillAnswers} ${i + 1}`} />
            <RemoveButton onClick={() => set(answers.filter((_, k) => k !== i))} disabled={answers.length <= 1} lang={lang} label={`${s.removeAnswer} ${i + 1}`} />
          </div>
        ))}
        <div className="qb-optfoot">
          <Button theme="borderless" type="primary" size="small" disabled={answers.length >= LIMITS.acceptedMax} onClick={() => set([...answers, ''])}>+ {s.addAnswer}</Button>
          <FieldError errors={errors} field="answers" lang={lang} />
        </div>
      </div>
    </EditorShell>
  );
}

// 标记核对：缺哪些、多出哪些（含重复）
function markerIssues(text, n) {
  const m = clozeMarkers(text);
  const missing = [], extra = [];
  for (let i = 1; i <= n; i++) if (!m.includes(i)) missing.push(`{{${i}}}`);
  const seen = new Set();
  for (const x of m) { if (x < 1 || x > n || seen.has(x)) extra.push(`{{${x}}}`); seen.add(x); }
  return { missing, extra };
}

function ClozeStem({ draft, onChange, lang, errors }) {
  const s = kt(lang);
  const caret = useRef({ zh: null, en: null });
  const boxes = useRef({ zh: null, en: null });   // CX-006：插入后把焦点与光标放回题干
  const lastLg = useRef('zh');
  const blanks = Array.isArray(draft.blanks) ? draft.blanks : [];
  const n = blanks.length;
  const track = (lg) => (e) => { caret.current[lg] = e.target.selectionStart; lastLg.current = lg; };
  const insert = () => {
    if (n >= LIMITS.blanksMax) return;
    const next = n + 1;
    const stem = { zh: String(draft.stem && draft.stem.zh || ''), en: String(draft.stem && draft.stem.en || '') };
    // 有内容的语言都插入；两种都空时插在中文里
    const langs = ['zh', 'en'].filter((lg) => stem[lg].trim());
    const after = {};
    for (const lg of langs.length ? langs : ['zh']) {
      const pos = caret.current[lg];
      const at = pos == null || pos < 0 || pos > stem[lg].length ? stem[lg].length : pos;
      const r = insertMarker(stem[lg], caret.current[lg], next);
      stem[lg] = r.text;
      after[lg] = at + `{{${next}}}`.length;
      caret.current[lg] = after[lg];
    }
    onChange({ ...draft, stem, blanks: [...blanks, { answers: [] }] });
    // CX-006（2026-10-09 验收）：点按钮后焦点在按钮上、光标归零 → 回到刚插入的那一栏，光标停在空格标记之后
    const focusLg = after[lastLg.current] != null ? lastLg.current : Object.keys(after)[0];
    setTimeout(() => { const el = boxes.current[focusLg]; if (el) { el.focus(); try { el.setSelectionRange(after[focusLg], after[focusLg]); } catch { /* 旧浏览器 */ } } }, 0);
  };
  const cell = (lg, label, ph) => {
    const text = String(draft.stem && draft.stem[lg] || '');
    const iss = text.trim() && n ? markerIssues(text, n) : { missing: [], extra: [] };
    return (
      <label className="qk-bi-cell">
        <span className="qk-sublabel">{label}</span>
        <textarea className="qk-textarea" rows={3} value={text} placeholder={ph} ref={(el) => { boxes.current[lg] = el; }}
          onChange={(e) => { caret.current[lg] = e.target.selectionStart; lastLg.current = lg; onChange(setAt(draft, `stem.${lg}`, e.target.value)); }}
          onSelect={track(lg)} onKeyUp={track(lg)} onClick={track(lg)} />
        {iss.missing.length > 0 && <span className="qk-warn">{s.clozeMissing(iss.missing.join(' '))}</span>}
        {iss.extra.length > 0 && <span className="qk-warn">{s.clozeExtra(iss.extra.join(' '))}</span>}
        <FieldError errors={errors} field={`stem.${lg}`} lang={lang} />
      </label>
    );
  };
  return (
    <div className="qk-bi">
      <div className="qk-bi-grid">
        {cell('zh', s.stemZh, s.stemZhPh)}
        {cell('en', s.stemEn, s.stemEnPh)}
      </div>
      <FieldError errors={errors} field="stem" lang={lang} />
      <div className="qk-cloze-bar">
        <Button size="small" onClick={insert} disabled={n >= LIMITS.blanksMax}>+ {s.insertBlank}</Button>
        <span className="qk-hint">{s.clozeHint}</span>
      </div>
    </div>
  );
}

export function ClozeEditor(props) {
  const { draft, onChange, lang, errors } = props;
  const s = kt(lang);
  const blanks = Array.isArray(draft.blanks) ? draft.blanks : [];
  // 只能删最后一空：同时去掉两种语言题干里的 {{n}}，其余标记不用重排
  const removeLast = () => {
    const n = blanks.length;
    if (!n) return;
    const strip = (t) => String(t || '').split(`{{${n}}}`).join('');
    onChange({ ...draft, stem: { zh: strip(draft.stem && draft.stem.zh), en: strip(draft.stem && draft.stem.en) }, blanks: blanks.slice(0, -1) });
  };
  return (
    <EditorShell {...props} stemSlot={<ClozeStem {...props} />}>
      <div className="qk-block">
        <div className="qk-label">{s.blanksH}</div>
        {blanks.map((b, i) => (
          <div className="qk-row" key={i}>
            <span className="qk-rowlab">{s.blankN(i + 1)}</span>
            <TagInput value={Array.isArray(b.answers) ? b.answers : []} separator={['/', '|', ';', '；']} addOnBlur allowDuplicates={false}
              placeholder={s.blankAnswersPh} onChange={(v) => onChange(setAt(draft, `blanks.${i}.answers`, v))} aria-label={s.blankN(i + 1)} style={{ flex: 1, minWidth: 0 }} />
            <RemoveButton onClick={removeLast} disabled={i !== blanks.length - 1} lang={lang} label={`${s.remove} ${s.blankN(i + 1)}`} />
            <FieldError errors={errors} field={`blanks.${i}`} lang={lang} />
          </div>
        ))}
        <FieldError errors={errors} field="blanks" lang={lang} />
      </div>
    </EditorShell>
  );
}

/* ---------------- 学员作答 ---------------- */
