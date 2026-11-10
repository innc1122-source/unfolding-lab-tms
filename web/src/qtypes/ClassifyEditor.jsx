// Classify 题型的编辑器（简化 10/11 从 Classify.jsx 拆出，后台题库 / 组卷用；员工端不引）
// 第四批 6.1（2026-10-08，G3）：分类题 classify。
//   作答：每个项目一行，用分段按钮（单选组，方向键可切换）选类别；类别多于 3 个时手机上换成下拉框。
import { useId } from 'react';
import { Button, Select } from '@douyinfe/semi-ui';
import { setAt, moveItem, LIMITS, stateOf } from './model.js';
import { kt, locText, FieldError, ResRow, ExplRow } from './common.jsx';
import { BiTextRow, MoveButtons, RemoveButton, EditorShell } from './commonEdit.jsx';
import { PickTable } from './Matching.jsx';

/* ---------------- 编辑器 ---------------- */

export function ClassifyEditor(props) {
  const { draft, onChange, lang, errors } = props;
  const s = kt(lang);
  const cats = Array.isArray(draft.categories) ? draft.categories : [];
  const items = Array.isArray(draft.items) ? draft.items : [];
  const catName = (c, i) => (lang === 'zh' ? (c.zh || c.en) : (c.en || c.zh)) || s.categoryN(i + 1);
  // 删类别：归在它下面的项目改成「未选」（-1，保存前要重选），后面的类别序号前移
  const removeCat = (i) => onChange({
    ...draft,
    categories: cats.filter((_, k) => k !== i),
    items: items.map((it) => ({ ...it, cat: it.cat === i ? -1 : it.cat > i ? it.cat - 1 : it.cat })),
  });
  const setItems = (next) => onChange(setAt(draft, 'items', next));
  return (
    <EditorShell {...props}>
      <div className="qk-block">
        <div className="qk-label">{s.categoriesH}</div>
        <div className="qk-chips">
          {cats.map((c, i) => (
            <div className="qk-chip" key={i}>
              <span className="qk-rowlab">{s.categoryN(i + 1)}</span>
              <div className="qk-grow"><BiTextRow value={c} onChange={(v) => onChange(setAt(draft, `categories.${i}`, v))} lang={lang} compact errors={errors} field={`categories.${i}`} /></div>
              <RemoveButton onClick={() => removeCat(i)} disabled={cats.length <= LIMITS.categoriesMin} lang={lang} label={`${s.remove} ${s.categoryN(i + 1)}`} />
            </div>
          ))}
        </div>
        <div className="qb-optfoot">
          <Button theme="borderless" type="primary" size="small" disabled={cats.length >= LIMITS.categoriesMax} onClick={() => onChange(setAt(draft, 'categories', [...cats, { zh: '', en: '' }]))}>+ {s.addCategory}</Button>
          <FieldError errors={errors} field="categories" lang={lang} />
        </div>
      </div>
      <div className="qk-block">
        <div className="qk-label">{s.itemsH}</div>
        {items.map((it, i) => (
          <div className="qk-clsrow" key={i}>
            <div className="qk-grow"><BiTextRow value={it} onChange={(v) => setItems(items.map((x, k) => (k === i ? { ...x, zh: v.zh, en: v.en } : x)))} lang={lang} compact errors={errors} field={`items.${i}`} phZh={s.itemN(i + 1)} /></div>
            <Select className="qk-clssel" value={Number.isInteger(it.cat) && it.cat >= 0 && it.cat < cats.length ? it.cat : undefined} placeholder={s.itemCat}
              onChange={(v) => setItems(items.map((x, k) => (k === i ? { ...x, cat: v } : x)))} aria-label={`${s.itemCat} · ${s.itemN(i + 1)}`}
              optionList={cats.map((c, k) => ({ value: k, label: catName(c, k) }))} />
            <span className="qk-rowact">
              <MoveButtons index={i} count={items.length} onMove={(a, b) => setItems(moveItem(items, a, b))} lang={lang} label={s.itemN(i + 1)} />
              <RemoveButton onClick={() => setItems(items.filter((_, k) => k !== i))} disabled={items.length <= LIMITS.classItemsMin} lang={lang} label={`${s.remove} ${s.itemN(i + 1)}`} />
            </span>
          </div>
        ))}
        <div className="qb-optfoot">
          <Button theme="borderless" type="primary" size="small" disabled={items.length >= LIMITS.classItemsMax} onClick={() => setItems([...items, { zh: '', en: '', cat: -1 }])}>+ {s.addItem}</Button>
          <FieldError errors={errors} field="items" lang={lang} />
        </div>
      </div>
    </EditorShell>
  );
}

/* ---------------- 学员作答 ---------------- */
