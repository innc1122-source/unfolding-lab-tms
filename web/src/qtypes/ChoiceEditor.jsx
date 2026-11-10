// Choice 题型的编辑器（简化 10/11 从 Choice.jsx 拆出，后台题库 / 组卷用；员工端不引）
// 第四批 6.1（2026-10-08，G3）：选择类题型 —— 单选 mcq、多选 multi、判断 tf。
//   学员端标记与样式沿用原答题页 / 成绩页（exam-opt、res-arow），老题型的显示与原来一致。
import { useId } from 'react';
import { Button, Radio, Checkbox, RadioGroup } from '@douyinfe/semi-ui';
import { setAt, moveItem, LIMITS, stateOf } from './model.js';
import { kt, locText, OPT_KEY, listSep, FieldError, ResRow, ExplRow } from './common.jsx';
import { BiTextRow, MoveButtons, RemoveButton, EditorShell } from './commonEdit.jsx';

/* ---------------- 编辑器 ---------------- */

function OptionsEditor({ draft, onChange, lang, errors }) {
  const s = kt(lang);
  const single = draft.type === 'mcq';
  const opts = Array.isArray(draft.options) ? draft.options : [];
  const setOpts = (next) => onChange(setAt(draft, 'options', next));
  const pick = (i) => setOpts(opts.map((o, k) => (single ? { ...o, ok: k === i } : k === i ? { ...o, ok: !o.ok } : o)));
  const add = () => { if (opts.length < LIMITS.optionsMax) setOpts([...opts, { zh: '', en: '', ok: false }]); };
  const remove = (i) => {
    if (opts.length <= LIMITS.optionsMin) return;
    const next = opts.filter((_, k) => k !== i);
    // 单选删掉了正确项：第一项补为正确，免得一保存就报错
    if (single && opts[i].ok && next.length && !next.some((o) => o.ok)) next[0] = { ...next[0], ok: true };
    setOpts(next);
  };
  return (
    <div className="qb-optblock">
      <div className="qb-optlabel">
        <span>{s.options}</span>
        <span className="qk-muted">{s.markCorrect}</span>
      </div>
      {opts.map((o, i) => (
        <div className={'qb-optrow qk-optrow' + (o.ok ? ' on' : '')} key={i}>
          <span className="qb-optpick">
            {single
              ? <Radio checked={!!o.ok} onChange={() => pick(i)} aria-label={`${s.markCorrect} ${OPT_KEY(i)}`} />
              : <Checkbox checked={!!o.ok} onChange={() => pick(i)} aria-label={`${s.markCorrect} ${OPT_KEY(i)}`} />}
          </span>
          <span className="qb-optkey">{OPT_KEY(i)}</span>
          <div className="qk-optinputs">
            <BiTextRow value={o} onChange={(v) => setOpts(opts.map((x, k) => (k === i ? { ...x, zh: v.zh, en: v.en } : x)))} lang={lang} compact />
          </div>
          <span className="qk-rowact">
            <MoveButtons index={i} count={opts.length} onMove={(a, b) => setOpts(moveItem(opts, a, b))} lang={lang} label={OPT_KEY(i)} />
            <RemoveButton onClick={() => remove(i)} disabled={opts.length <= LIMITS.optionsMin} lang={lang} label={`${s.removeOpt} ${OPT_KEY(i)}`} />
          </span>
        </div>
      ))}
      <div className="qb-optfoot">
        <Button theme="borderless" type="primary" size="small" disabled={opts.length >= LIMITS.optionsMax} onClick={add}>+ {s.addOption}</Button>
        <FieldError errors={errors} field="options" lang={lang} />
      </div>
    </div>
  );
}

export function ChoiceEditor(props) {
  return (
    <EditorShell {...props}>
      <OptionsEditor {...props} />
    </EditorShell>
  );
}

export function TfEditor(props) {
  const { draft, onChange, lang, errors } = props;
  const s = kt(lang);
  return (
    <EditorShell {...props}>
      <div className="qb-tfblock">
        <div className="qb-fieldlabel">{s.tfAnswer}</div>
        <RadioGroup type="button" value={draft.answer !== false} onChange={(e) => onChange(setAt(draft, 'answer', e.target.value))} aria-label={s.tfAnswer}>
          <Radio value={true}>{s.tfTrue}</Radio>
          <Radio value={false}>{s.tfFalse}</Radio>
        </RadioGroup>
        <FieldError errors={errors} field="answer" lang={lang} />
      </div>
    </EditorShell>
  );
}

/* ---------------- 学员作答 ---------------- */
