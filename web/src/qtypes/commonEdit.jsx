// 题型编辑器的公共部件（简化 10/11 从 common.jsx 拆出）：含 Semi 与 AI 翻译，只给后台题库 / 组卷用，员工端不引。
// 第四批 6.1（2026-10-08，G3）：题型套件的公共部件与文案。
//   · 文案 T（中英同键）供各题型的 Editor / Runner / Review / BankPreview 共用；kt(lang) 取一种语言。
//   · 编辑器部件（管理端，用 Semi）：BiTextRow（中文在上 / 英文在下的一对输入）、MoveButtons（↑↓）、FieldError、EditorShell
//     （题干 + 题型专属区 + 解析；案例小题多出题型、分值）、TypeTag、useDraftTranslate（AI 翻译按钮的 extra）。
//   · 学员端部件（纯 HTML，与现有 exam-* 样式同一套）：locText、ResRow（成绩页的一行）、OPT_KEY。
import { useRef } from 'react';
import { Input, TextArea, Button, Tag, InputNumber, Select } from '@douyinfe/semi-ui';
import { needsTranslation } from '../components/AiTranslate.jsx';
import { typeLabel, caseItemTypes } from './spec.js';
import { setAt, translatePairs, applyTranslations, errorsAt } from './model.js';
import { T, kt, locText, stemOf, OPT_KEY, listSep, errorMessage, FieldError, scopedErrors, ResRow, ExplRow } from './common.jsx';

// 题型标签颜色：自评分的客观题保持中性，行为不同的题型才用颜色（沿用 Handoff 12 的做法）
const TYPE_COLOR = { mcq: 'grey', multi: 'blue', tf: 'grey', fill: 'amber', cloze: 'amber', ordering: 'violet', matching: 'cyan', classify: 'teal', open: 'red', case: 'indigo' };
export function TypeTag({ type, lang, short, size }) {
  return <Tag color={TYPE_COLOR[type] || 'grey'} type="light" shape="circle" size={size || 'default'}>{typeLabel(type, lang, short)}</Tag>;
}

/* ---------------- 编辑器部件 ---------------- */

// 一对双语输入：中文在上、英文在下（桌面并排）
export function BiTextRow({ label, labelZh, labelEn, value, onChange, multiline, rows = 2, phZh, phEn, errors, field, lang, max, compact }) {
  const v = value || { zh: '', en: '' };
  const s = kt(lang);
  const Comp = multiline ? TextArea : Input;
  const extra = multiline ? { autosize: { minRows: rows, maxRows: Math.max(rows, 8) } } : {};
  const bad = errors && field ? errorsAt(errors, field).length > 0 : false;
  return (
    <div className={'qk-bi' + (compact ? ' compact' : '')}>
      {label && <div className="qk-label">{label}</div>}
      <div className="qk-bi-grid">
        <label className="qk-bi-cell">
          {labelZh && <span className="qk-sublabel">{labelZh}</span>}
          <Comp value={v.zh} onChange={(x) => onChange({ ...v, zh: x })} placeholder={phZh || s.zhPh} validateStatus={bad ? 'error' : 'default'} aria-label={labelZh || (label ? `${label} · ${s.zhPh}` : s.zhPh)} {...extra} />
          {max && multiline && <span className="qk-count tnum">{s.counter(String(v.zh || '').length, max)}</span>}
        </label>
        <label className="qk-bi-cell">
          {labelEn && <span className="qk-sublabel">{labelEn}</span>}
          <Comp value={v.en} onChange={(x) => onChange({ ...v, en: x })} placeholder={phEn || s.enPh} validateStatus={bad ? 'error' : 'default'} aria-label={labelEn || (label ? `${label} · ${s.enPh}` : s.enPh)} {...extra} />
          {max && multiline && <span className="qk-count tnum">{s.counter(String(v.en || '').length, max)}</span>}
        </label>
      </div>
      {field && <FieldError errors={errors} field={field} lang={lang} />}
    </div>
  );
}

// ↑ ↓ 两个按钮（手机上至少 40px）
export function MoveButtons({ index, count, onMove, lang, label }) {
  const s = kt(lang);
  const name = label ? ` · ${label}` : '';
  return (
    <span className="qk-move">
      <Button size="small" theme="borderless" type="tertiary" className="qk-movebtn" disabled={index <= 0} onClick={() => onMove(index, index - 1)} aria-label={s.moveUp + name}>↑</Button>
      <Button size="small" theme="borderless" type="tertiary" className="qk-movebtn" disabled={index >= count - 1} onClick={() => onMove(index, index + 1)} aria-label={s.moveDown + name}>↓</Button>
    </span>
  );
}
export function RemoveButton({ onClick, disabled, lang, label }) {
  const s = kt(lang);
  return <Button size="small" theme="borderless" type="tertiary" className="qk-movebtn qk-rm" disabled={disabled} onClick={onClick} aria-label={label || s.remove}>✕</Button>;
}

// 编辑器外壳：题干 + 题型专属区 + 解析。案例小题（inCase）多出题型选择与分值。
//   stemSlot：多空填空题自己渲染题干（带「插入空格」）
export function EditorShell({ draft, onChange, lang, errors, children, stemSlot, noExplanation, inCase, onTypeChange }) {
  const s = kt(lang);
  const set = (path, v) => onChange(setAt(draft, path, v));
  return (
    <div className="qk-editor">
      {inCase && (
        <div className="qk-subhead">
          <label className="qk-subfield">
            <span className="qk-sublabel">{s.subType}</span>
            <Select value={draft.type} onChange={(t) => onTypeChange && onTypeChange(t)} style={{ width: '100%' }}
              optionList={caseItemTypes().map((k) => ({ value: k, label: typeLabel(k, lang) }))} aria-label={s.subType} />
          </label>
          <label className="qk-subfield qk-subpts">
            <span className="qk-sublabel">{s.subPoints}</span>
            <InputNumber value={draft.points == null ? undefined : draft.points} min={1} max={100} step={1} precision={0} placeholder={s.subPointsPh}
              onChange={(v) => set('points', v === '' || v == null ? null : v)} style={{ width: '100%' }} aria-label={s.subPoints} />
            <FieldError errors={errors} field="points" lang={lang} />
          </label>
        </div>
      )}
      {stemSlot || (
        <BiTextRow value={draft.stem} onChange={(v) => set('stem', v)} multiline rows={2}
          labelZh={s.stemZh} labelEn={s.stemEn} phZh={s.stemZhPh} phEn={s.stemEnPh} errors={errors} field="stem" lang={lang} />
      )}
      {children}
      {!noExplanation && (
        <BiTextRow value={draft.explanation} onChange={(v) => set('explanation', v)} multiline rows={2}
          labelZh={s.explZh} labelEn={s.explEn} phZh={s.explPh} phEn={s.explEnPh} errors={errors} field="explanation" lang={lang} />
      )}
    </div>
  );
}

// AI 翻译按钮的 extra：把编辑稿里所有双语字段（选项、配对、类别、步骤、案例材料、小题……）一并送去翻译。
//   用法：<AiTranslateButton formApi={…} pairs={…} extra={useDraftTranslate(draft, setDraft)} />
export function useDraftTranslate(draft, onChange) {
  const ref = useRef({ draft, onChange });
  ref.current = { draft, onChange };
  return {
    get: (from, to, overwrite) => translatePairs(ref.current.draft)
      .map((p) => ({ key: 'x:' + p.key, text: p[from] || '', target: p[to] }))
      .filter((x) => x.text.trim() && (overwrite || needsTranslation(x.target, x.text, to)))
      .map(({ key, text }) => ({ key, text })),
    set: (map, to) => {
      const mine = new Map();
      for (const [k, v] of map) if (String(k).startsWith('x:')) mine.set(String(k).slice(2), v);
      if (mine.size) ref.current.onChange(applyTranslations(ref.current.draft, mine, to));
    },
  };
}

/* ---------------- 成绩页部件 ---------------- */
