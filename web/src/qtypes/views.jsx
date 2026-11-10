// 题型注册表的学员端部分（简化 10/11 从 index.jsx 拆出）：每个题型的 Runner / Review / BankPreview，不含编辑器。
// 考试页、成绩页这些员工端页面引这里，员工端包就不会带上编辑器用的 Semi 组件；后台题库 / 组卷仍引 index.jsx（两部分合在一起）。
// 未知题型（更新的服务端发来的）一律回落到 UNKNOWN：答题页提示刷新，成绩页只显示作答为空。
import { ChoiceRunner, TfRunner, ChoiceReview, TfReview, ChoicePreview, TfPreview } from './Choice.jsx';
import { FillRunner, ClozeRunner, FillReview, ClozeReview, FillPreview, ClozePreview } from './Fill.jsx';
import { OpenRunner, OpenReview, OpenPreview } from './Open.jsx';
import { OrderingRunner, OrderingReview, OrderingPreview } from './Ordering.jsx';
import { MatchingRunner, MatchingReview, MatchingPreview } from './Matching.jsx';
import { ClassifyRunner, ClassifyReview, ClassifyPreview } from './Classify.jsx';
import { CaseRunner, CaseReview, CasePreview } from './Case.jsx';
import { kt, ResRow } from './common.jsx';

function UnknownRunner({ lang }) {
  return <div className="qt-unknown" role="note">{kt(lang).refresh}</div>;
}
function UnknownReview({ lang }) {
  return <ResRow label={kt(lang).yourAns}>{kt(lang).notAnswered}</ResRow>;
}
function UnknownPreview() { return null; }

export const UNKNOWN_VIEW = { Runner: UnknownRunner, Review: UnknownReview, BankPreview: UnknownPreview, unknown: true };

export const VIEWS = {
  mcq: { Runner: ChoiceRunner, Review: ChoiceReview, BankPreview: ChoicePreview },
  multi: { Runner: ChoiceRunner, Review: ChoiceReview, BankPreview: ChoicePreview },
  tf: { Runner: TfRunner, Review: TfReview, BankPreview: TfPreview },
  fill: { Runner: FillRunner, Review: FillReview, BankPreview: FillPreview },
  cloze: { Runner: ClozeRunner, Review: ClozeReview, BankPreview: ClozePreview, ownsStem: true },
  ordering: { Runner: OrderingRunner, Review: OrderingReview, BankPreview: OrderingPreview },
  matching: { Runner: MatchingRunner, Review: MatchingReview, BankPreview: MatchingPreview },
  classify: { Runner: ClassifyRunner, Review: ClassifyReview, BankPreview: ClassifyPreview },
  open: { Runner: OpenRunner, Review: OpenReview, BankPreview: OpenPreview },
  case: { Runner: CaseRunner, Review: CaseReview, BankPreview: CasePreview },
};

// 取一个题型的学员端部件；未知题型给 UNKNOWN_VIEW
export const qtype = (key) => VIEWS[key] || UNKNOWN_VIEW;

export { CasePassage, SubStem, subDef } from './Case.jsx';
export { errorMessage, FieldError, stemOf, locText } from './common.jsx';
export { typeLabel, TYPE_ORDER, TYPES, ENABLED, AI_TYPE_MAP, enabledTypes, groupOf, typePointsKeys, caseItemTypes, isEnabledType } from './spec.js';
