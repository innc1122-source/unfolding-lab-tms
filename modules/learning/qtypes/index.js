"use strict";
// 第四批 6.1 题型注册表（设计 §1.2 / §1.3）：server.js 与 store.js 通过这里使用各题型，不再按题型写 if/else。
// 每个题型文件导出同一组函数（fromRow / toRow / validate / snapshot / client / parseAnswer / grade / learnerDetail / totals），
// 本文件再提供整卷级的便捷函数。旧四种题型（mcq / multi / fill / open）逐字移植，行为与 2026-10-08 的代码相同，
// 由 test/qtypes-legacy-parity.test.js 对照冻结副本 test/fixtures/qtypes-legacy.js 证明。
const spec = require("./spec.js");
const U = require("./util.js");

const DEFS = {
  mcq: require("./mcq.js"), multi: require("./multi.js"), tf: require("./tf.js"), fill: require("./fill.js"),
  cloze: require("./cloze.js"), ordering: require("./ordering.js"), matching: require("./matching.js"),
  classify: require("./classify.js"), open: require("./open.js"), case: require("./case.js"),
};
const ENABLED_SET = new Set(spec.ENABLED);
const has = (o, k) => !!o && Object.prototype.hasOwnProperty.call(o, k);

// ---- 目录 ----
const get = (key) => (typeof key === "string" && has(DEFS, key) ? DEFS[key] : null);
const all = () => spec.TYPE_ORDER.map((k) => DEFS[k]);
const order = () => spec.TYPE_ORDER.slice();
const isEnabled = (key) => typeof key === "string" && ENABLED_SET.has(key) && !!get(key);
// 已开放的题型，按目录顺序（TYPE_ORDER）
const enabled = () => spec.TYPE_ORDER.filter((k) => ENABLED_SET.has(k));
const groupOf = (key) => (get(key) ? spec.TYPES[key].group : null);
const objectiveKeys = () => enabled().filter((k) => spec.TYPES[k].group === "objective");
// 自动评分（交卷即出分）的题型：简答以外都是
const isAuto = (key) => !!get(key) && spec.TYPES[key].group !== "open";
// 考试「题型默认分值」可设的键：已开放题型中除案例外的全部（案例分值 = 各小题之和）
const typePointsKeys = () => enabled().filter((k) => k !== "case");
const defaultPoints = (key) => (get(key) ? spec.TYPES[key].defaultPoints : null);

// ---- 题库 ----
// 题库行 → 题目对象。旧四种逐字照搬 store.js rowToQuestion；未知题型（更新版本写入的行）→ unsupported:true，
// 抽题、组卷与题库列表都应跳过它，旧服务端因此不会被新题型的行弄坏。
function rowToQuestion(r) {
  if (!r) return null;
  const q = {
    id: r.id, courseId: r.courseId, moduleId: r.moduleId, type: r.type,
    question: r.question, question_zh: r.question_zh,
  };
  const def = get(r.type);
  if (def) Object.assign(q, def.fromRow(r));
  else q.unsupported = true;
  // 单题分值（迁移 59）：null = 按考试的题型默认分值
  q.points = r.points == null ? null : Number(r.points);
  // AI 起草并被采纳的题目带来源信息（迁移 58）
  if (r.origin) { try { q.origin = JSON.parse(r.origin); } catch { /* 忽略损坏的来源信息 */ } }
  return q;
}
// 题目对象 → 与题型相关的列 { options, data, explanation, explanation_zh, rubric, rubric_zh, maxPoints }
// （id / courseId / moduleId / type / question / question_zh / origin / points 由 store 自己写）
function questionColumns(q) {
  const def = q ? get(q.type) : null;
  return def ? def.toRow(q) : U.legacyColumns(q || {});
}
// 题目请求体 → 题库条目。单题 POST / PUT（ctx.bulk 为假）与批量导入（ctx.bulk = true，ctx.courseId = 目标课程）共用。
// 返回 { item } 或 { error, error_zh, code }。旧四种题型的错误文字与条目逐字照旧：
//   单题：课程 / 题型 / 题干缺失 → "Invalid question"；简答 maxPoints 不夹取；
//   批量：题型无效或题干为空 → "invalid type or empty question"；题干与中文题干去首尾空白；简答 maxPoints 夹到 1–100；moduleId 为空。
// 未开放或未知的题型 → code "bad_type"。
function itemFromBody(q, ctx = {}) {
  const bulk = !!ctx.bulk;
  const typeOk = !!q && isEnabled(q.type);
  if (bulk) {
    if (!q || !typeOk || !String(q.question || "").trim())
      return { error: "invalid type or empty question", error_zh: "题型无效或题干为空", code: q && typeOk ? "empty_question" : "bad_type" };
  } else if (!q || !q.courseId || !typeOk || !q.question) {
    return { error: "Invalid question", error_zh: "题目无效：请检查所属课程、题型与题干。", code: q && q.courseId && q.question && !typeOk ? "bad_type" : "invalid_question" };
  }
  const v = get(q.type).validate(q, { bulk, inCase: false });
  if (v.error) return v;
  const item = bulk
    ? { courseId: ctx.courseId, moduleId: null, type: q.type, question: String(q.question).trim(), question_zh: q.question_zh ? String(q.question_zh).trim() : null }
    : { courseId: q.courseId, moduleId: q.moduleId || null, type: q.type, question: q.question, question_zh: q.question_zh || null };
  Object.assign(item, v.fields);
  // 每题分值：1–100 的整数，其余视为未设置（按考试的题型默认分值）；案例的分值是各小题之和，题目本身不设
  if (q.type !== "case") { const pts = U.pointsOf(q.points); if (pts != null) item.points = pts; }
  return { item };
}
// 题目是否能进卷：已知且已开放的题型、题型数据完整（坏 JSON 读出来的空题不进卷）
function isUsable(q) {
  if (!q || q.unsupported || !isEnabled(q.type)) return false;
  const def = get(q.type);
  if (def.isUsable) return !!def.isUsable(q);
  if (q.type === "mcq" || q.type === "multi") return Array.isArray(q.options) && q.options.length > 0;
  if (q.type === "fill") return Array.isArray(q.answers);
  return true;
}
// 卷面小题数：案例按小题计，其余 1
const itemCount = (q) => (q && q.type === "case" ? DEFS.case.itemCount(q) : 1);

// ---- 考试 ----
// 开考快照。ctx: { shuffle(arr)（服务端注入 crypto 版；测试注入带种子的版本）, shuffleOptions, multiPartial, partialCredit,
//   points（questionPoints(exam, q)，null = 旧口径）, pointsFor(sub)（案例小题的题型默认分值，可选）, typePoints（同上，二选一） }
function snapshot(q, ctx) {
  const def = q ? get(q.type) : null;
  return def ? def.snapshot(q, ctx) : null;
}
// 学员拿到的题目副本（逐题型白名单，不展开快照）
function clientQuestion(snap) {
  const def = get(snap.type);
  if (def) return def.client(snap);
  const c = { id: snap.id, type: snap.type, question: snap.question, question_zh: snap.question_zh };
  if (snap.points != null) c.points = snap.points;
  return c;
}
const clientQuestions = (snaps) => (snaps || []).map(clientQuestion);
// 单题评分：answers 是整份作答 { [qid]: 作答 }
function gradeOne(snap, answers) {
  const def = get(snap.type) || DEFS.open; // 旧交卷代码的 else 分支即简答
  const raw = answers && has(answers, snap.id) ? answers[snap.id] : undefined;
  return def.grade(snap, def.parseAnswer(raw, snap));
}
const gradeAll = (snaps, answers) => (snaps || []).map((s) => gradeOne(s, answers || {}));
// 员工看到的答卷明细（showAnswers = false 时去掉正确答案与讲解；简答一律经 clientOpenDetail）。未知题型按旧代码的通用分支。
function clientDetail(detail, showAnswers) {
  return (detail || []).map((d) => {
    const def = get(d.type);
    if (def) return def.learnerDetail(d, showAnswers);
    if (showAnswers !== false) return d;
    const base = { id: d.id, type: d.type, question: d.question, question_zh: d.question_zh, isRight: d.isRight, partial: d.partial || false };
    if (d.points != null) base.points = d.points;
    base.options = d.options; base.picked = d.picked;
    return base;
  });
}
// 卷面计分：先问题型的 totals()（新题型：分值 × 得分比例；案例：各小题之和），返回 null 的旧题型走原来的口径，逐字照旧。
function scoreTotals(detail) {
  let earned = 0, max = 0;
  for (const q of detail || []) {
    const def = get(q.type);
    const t = def ? def.totals(q) : null;
    if (t) { earned += t.earned; max += t.max; continue; }
    if (q.points != null) {
      const pts = Number(q.points) || 0;
      max += pts;
      if (q.type === "open") earned += q.maxPoints ? ((q.score == null ? 0 : q.score) / q.maxPoints) * pts : 0;
      else earned += q.isRight ? pts : q.partial ? pts / 2 : 0;
    } else if (q.type === "open") { max += q.maxPoints / 10; earned += ((q.score == null ? 0 : q.score) / q.maxPoints) * (q.maxPoints / 10); }
    else { max += 1; earned += q.isRight ? 1 : q.partial ? 0.5 : 0; }
  }
  return { earned, max, hasPoints: (detail || []).some((q) => q.points != null) };
}
function scoreDetail(detail) {
  const t = scoreTotals(detail);
  return t.max ? Math.round((t.earned / t.max) * 100) : 0;
}
// 及格判定的唯一口径（F57，负责人 10/9）：用未四舍五入的得分比例与及格线比较 —— 86.5% 对 87% 不通过，87.0% 对 87% 通过。
// 页面上的百分比仍是 scoreDetail 的整数。1e-9 只吸收浮点误差（如 27/31*100），不改变任何实际分数的结论。
// 只用于交卷 / 重新评分时写入 passed；读取旧答卷一律读已存的 passed，不在读取时重算。
function passedOf(earned, total, passingScore) {
  const e = Number(earned), t = Number(total), p = Number(passingScore);
  if (!(t > 0) || !Number.isFinite(e) || !Number.isFinite(p)) return false;
  return (e / t) * 100 + 1e-9 >= p;
}
function passedOfDetail(detail, passingScore) {
  const t = scoreTotals(detail);
  return passedOf(t.earned, t.max, passingScore);
}
// 「最好成绩」选两份答卷：百分比高者；百分比相同（整数）时已通过的优先（F57 后同为 87% 可能一份 86.5 未过、一份 87.0 已过）
function betterAttempt(a, b) {
  if (!a) return b || null;
  if (!b) return a;
  if (b.percent > a.percent) return b;
  if (b.percent === a.percent && b.passed && !a.passed) return b;
  return a;
}

module.exports = {
  spec, TYPE_ORDER: spec.TYPE_ORDER, TYPES: spec.TYPES, ENABLED: spec.ENABLED, LIMITS: spec.LIMITS,
  get, all, order, enabled, isEnabled, groupOf, objectiveKeys, isAuto, typePointsKeys, defaultPoints,
  rowToQuestion, questionColumns, itemFromBody, isUsable, itemCount,
  snapshot, clientQuestion, clientQuestions, gradeOne, gradeAll, clientDetail, scoreTotals, scoreDetail, passedOf, passedOfDetail, betterAttempt,
  creditOf: U.creditOf, normFill: U.normFill, shuffleNonIdentity: U.shuffleNonIdentity,
};
