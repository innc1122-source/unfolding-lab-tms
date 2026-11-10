// Open 题型的编辑器（简化 10/11 从 Open.jsx 拆出，后台题库 / 组卷用；员工端不引）
// 第四批 6.1（2026-10-08，G3）：简答题 open。成绩页的分数、AI 评语与 HR 评语沿用原写法。
import { setAt } from './model.js';
import { kt, ResRow, ExplRow } from './common.jsx';
import { BiTextRow, EditorShell } from './commonEdit.jsx';

export function OpenEditor(props) {
  const { draft, onChange, lang, errors } = props;
  const s = kt(lang);
  return (
    <EditorShell {...props} noExplanation>
      <BiTextRow value={draft.rubric} onChange={(v) => onChange(setAt(draft, 'rubric', v))} multiline rows={2}
        labelZh={s.rubricZh} labelEn={s.rubricEn} phZh={s.rubricZhPh} phEn={s.rubricEnPh} errors={errors} field="rubric" lang={lang} />
    </EditorShell>
  );
}
