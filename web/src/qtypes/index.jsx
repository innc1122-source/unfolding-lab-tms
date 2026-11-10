// 第四批 6.1（2026-10-08，G3）：题型注册表（前端）。每个题型四个部件：
//   Editor({ draft, onChange, lang, errors })            题库整页编辑器右栏（题干 + 题型专属区 + 解析）；draft 见 model.js
//   Runner({ q, value, onChange, lang, readOnly })       学员作答；readOnly = 组卷预览
//   Review({ d, lang, showAnswers, audience })           成绩回顾一题；audience 'learner' | 'hr'（HR 不论是否公开答案都看完整答案与解析）
//   BankPreview({ q, lang })                             组卷 / 题库展开 / AI 草稿：选项与正确答案（q 为题库题目或 toBody(draft) 的形状）
// 附加标记：ownsStem = 作答部件自己渲染题干（多空填空把空格放在题干里），答题页不再另印题干。
// 未知题型（更新的服务端发来的）一律回落到 UNKNOWN：答题页提示刷新，成绩页只显示作答为空。
// 简化 10/11：Runner / Review / BankPreview 在 views.jsx（员工端页面直接引那里，不带编辑器与 Semi），Editor 在各题型的 *Editor.jsx；
// 本文件把两部分合成完整注册表，给后台题库、组卷、成绩管理用，导出与原来相同。
import { VIEWS, UNKNOWN_VIEW } from './views.jsx';
import { ChoiceEditor, TfEditor } from './ChoiceEditor.jsx';
import { FillEditor, ClozeEditor } from './FillEditor.jsx';
import { OpenEditor } from './OpenEditor.jsx';
import { OrderingEditor } from './OrderingEditor.jsx';
import { MatchingEditor } from './MatchingEditor.jsx';
import { ClassifyEditor } from './ClassifyEditor.jsx';
import { CaseEditor } from './CaseEditor.jsx';
import { FieldError } from './common.jsx';

function UnknownEditor({ lang }) {
  return <FieldError errors={[{ field: 'type', code: 'bad_type' }]} field="type" lang={lang} />;
}

export const UNKNOWN = { ...UNKNOWN_VIEW, Editor: UnknownEditor };

const EDITORS = {
  mcq: ChoiceEditor, multi: ChoiceEditor, tf: TfEditor, fill: FillEditor, cloze: ClozeEditor,
  ordering: OrderingEditor, matching: MatchingEditor, classify: ClassifyEditor, open: OpenEditor, case: CaseEditor,
};
export const REGISTRY = Object.fromEntries(Object.entries(VIEWS).map(([k, v]) => [k, { ...v, Editor: EDITORS[k] }]));

// 取一个题型的部件；未知题型给 UNKNOWN
export const qtype = (key) => REGISTRY[key] || UNKNOWN;

export { CasePassage, SubStem, subDef } from './Case.jsx';
export { TypeTag, useDraftTranslate } from './commonEdit.jsx';
export { errorMessage, FieldError, stemOf, locText } from './common.jsx';
export { typeLabel, TYPE_ORDER, TYPES, ENABLED, AI_TYPE_MAP, enabledTypes, groupOf, typePointsKeys, caseItemTypes, isEnabledType } from './spec.js';
