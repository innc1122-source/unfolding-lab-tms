"use strict";
// 第四批 6.1 题型注册表：旧四种题型（mcq / multi / fill / open）的「冻结副本」（设计 §1.11）。
// 2026-10-08 15:00 在 G1 动 server.js / store.js 之前，从当日代码逐字剪下（server.js 14:42、store.js 14:31 版本），
// 只做最小包装：把 crypto 版 shuffle 改成参数注入、把 store / exam 依赖改成参数，让它们成为纯函数。
// 用途：test/qtypes-legacy-parity.test.js 用生成的大量用例比对「冻结副本」与 modules/learning/qtypes/ 注册表，
// 证明旧四种题型的行为逐字节不变。不要修改本文件（除非确认今天的代码本身就是这样）。
//
// 出处对照（server.js 行号为当日版本）：
//   questionItemFromBody  L5629   单题 POST / PUT 校验
//   bulkItemFromBody      L15063–15076  /api/admin/questions/bulk 逐行校验分支（包装成返回值，不写库）
//   questionPoints        L5622（含 examTypePoints L5621）
//   snapshotQuestion      L8968–8991  /api/exam/start 单题快照 + 分值 / 多选部分给分快照
//   clientQuestions       L2471
//   gradeQuestion         L9076–9113  /api/exam/:id/submit 单题评分 + 分值复制
//   clientDetail          L2485
//   clientOpenDetail      L5805
//   scoreTotals           L5603   scoreDetail L5615
//   rowToQuestion         store.js L1965
//   questionColumns       store.js L2037 insertQuestionRow / L3107 updateQuestion 的列映射

// ---- server.js L5621–5627 ----
function examTypePoints(exam) { const tp = exam && exam.typePoints; return tp && typeof tp === "object" ? tp : null; }
function questionPoints(exam, q) {
  if (q && q.points != null) return Number(q.points);
  const tp = examTypePoints(exam);
  if (tp && tp[q.type] != null) return Number(tp[q.type]);
  return null;
}

// ---- server.js L5629 ----
// 题目请求体 → 题库条目。新建（POST）与原地修改（PUT）共用同一套校验；返回 { item } 或 { error }。
function questionItemFromBody(q) {
  if (!q || !q.courseId || !["mcq", "multi", "fill", "open"].includes(q.type) || !q.question) return { error: "Invalid question" };
  if (q.type === "mcq" && (!Array.isArray(q.options) || q.options.length < 2 || q.options.filter((o) => o.ok).length !== 1))
    return { error: "Single-choice needs at least 2 options with exactly one correct answer" };
  if (q.type === "multi" && (!Array.isArray(q.options) || q.options.length < 2 || q.options.filter((o) => o.ok).length < 1))
    return { error: "Multiple-answer needs at least 2 options with one or more correct answers" };
  if (q.type === "fill" && (!Array.isArray(q.answers) || !q.answers.filter((a) => String(a).trim()).length))
    return { error: "Fill-in-the-blank needs at least one accepted answer" };
  const item = { courseId: q.courseId, moduleId: q.moduleId || null, type: q.type, question: q.question, question_zh: q.question_zh || null };
  if (q.type === "mcq" || q.type === "multi") {
    item.options = q.options.map((o) => ({ text: o.text, text_zh: o.text_zh || null, ok: !!o.ok }));
    item.explanation = q.explanation || ""; item.explanation_zh = q.explanation_zh || null;
  } else if (q.type === "fill") {
    item.answers = q.answers.map((a) => String(a).trim()).filter(Boolean);
    item.explanation = q.explanation || ""; item.explanation_zh = q.explanation_zh || null;
  } else { item.rubric = q.rubric || ""; item.rubric_zh = q.rubric_zh || null; item.maxPoints = q.maxPoints || 10; }
  // 每题分值：1–100 的整数，其余视为未设置（按考试的题型默认分值）
  { const pts = Math.round(Number(q.points)); if (q.points != null && q.points !== "" && Number.isFinite(pts) && pts >= 1 && pts <= 100) item.points = pts; }
  return { item };
}

// ---- server.js L15063–15076（循环体，包装成返回 { ok:false, question, reason } 或 { ok:true, item }） ----
function bulkItemFromBody(q, courseId) {
  const results = [];
  const stem = String((q && q.question) || "").trim().slice(0, 40);
  const bad = (reason) => results.push({ ok: false, question: stem, reason });
  do {
    if (!q || !["mcq", "multi", "fill", "open"].includes(q.type) || !String(q.question || "").trim()) { bad("invalid type or empty question"); continue; }
    if (q.type === "mcq" && (!Array.isArray(q.options) || q.options.length < 2 || q.options.filter((o) => o.ok).length !== 1)) { bad("single-choice needs ≥2 options and exactly one correct"); continue; }
    if (q.type === "multi" && (!Array.isArray(q.options) || q.options.length < 2 || q.options.filter((o) => o.ok).length < 1)) { bad("multiple-answer needs ≥2 options and ≥1 correct"); continue; }
    if (q.type === "fill" && (!Array.isArray(q.answers) || !q.answers.filter((a) => String(a).trim()).length)) { bad("fill-in needs at least one accepted answer"); continue; }
    const item = { courseId, moduleId: null, type: q.type, question: String(q.question).trim(), question_zh: q.question_zh ? String(q.question_zh).trim() : null };
    if (q.type === "mcq" || q.type === "multi") {
      item.options = q.options.map((o) => ({ text: String(o.text || ""), text_zh: o.text_zh ? String(o.text_zh) : null, ok: !!o.ok }));
      item.explanation = q.explanation || ""; item.explanation_zh = q.explanation_zh || null;
    } else if (q.type === "fill") {
      item.answers = q.answers.map((a) => String(a).trim()).filter(Boolean);
      item.explanation = q.explanation || ""; item.explanation_zh = q.explanation_zh || null;
    } else { item.rubric = q.rubric || ""; item.rubric_zh = q.rubric_zh || null; item.maxPoints = Math.min(100, Math.max(1, Number(q.maxPoints) || 10)); }
    { const pts = Math.round(Number(q.points)); if (q.points != null && q.points !== "" && Number.isFinite(pts) && pts >= 1 && pts <= 100) item.points = pts; }
    results.push({ ok: true, item });
  } while (false);
  return results[0];
}

// ---- server.js L8968–8991（单题；objPool / openPool 的 find 换成直接用源题 q） ----
function snapshotQuestion(q, exam, shuffle) {
  if (["mcq", "multi", "fill"].includes(q.type)) {
    const snap = q.type === "fill"
      ? { id: q.id, type: "fill", question: q.question, question_zh: q.question_zh || null, answers: q.answers, explanation: q.explanation, explanation_zh: q.explanation_zh || null }
      : {
          id: q.id, type: q.type, question: q.question, question_zh: q.question_zh || null,
          explanation: q.explanation, explanation_zh: q.explanation_zh || null,
          options: shuffle(q.options.map((o) => ({ text: o.text, text_zh: o.text_zh || null, ok: !!o.ok }))),
        };
    const src = q; const pts = src ? questionPoints(exam, src) : null;
    if (pts != null) snap.points = pts;
    if (snap.type === "multi") snap.partialCredit = exam.multiPartial !== false;
    return snap;
  }
  if (q.type === "open") {
    const snap = {
      id: q.id, type: "open", question: q.question, question_zh: q.question_zh || null,
      rubric: q.rubric, maxPoints: q.maxPoints,
    };
    const src = q; const pts = src ? questionPoints(exam, src) : null; if (pts != null) snap.points = pts;
    return snap;
  }
  return null; // 其他题型今天不会进卷（objPool / openPool 都不收）
}

// ---- server.js L2471 ----
// Client-safe copy of an attempt's questions: no accepted answers, no rubrics,
// no correct-option flags.
function clientQuestions(questions) {
  return questions.map((q) => {
    let c;
    if (q.type === "open") c = { id: q.id, type: "open", question: q.question, question_zh: q.question_zh, maxPoints: q.maxPoints };
    else if (q.type === "fill") c = { id: q.id, type: "fill", question: q.question, question_zh: q.question_zh };
    else c = { id: q.id, type: q.type, question: q.question, question_zh: q.question_zh, options: q.options.map((o) => ({ text: o.text, text_zh: o.text_zh })) };
    if (q.points != null) c.points = q.points; // 每题分值，答题页题头显示
    return c;
  });
}

// ---- server.js L9076–9113（单题；answers 是整份作答对象） ----
function gradeQuestion(q, answers) {
  const detail = [];
  const normFill = (s) => String(s || "").toLowerCase().replace(/\s+/g, " ").trim();
  if (q.type === "mcq") {
    const picked = answers[q.id];
    const correctIdx = q.options.findIndex((o) => o.ok);
    const isRight = picked === correctIdx;
    detail.push({
      id: q.id, type: "mcq", question: q.question, question_zh: q.question_zh || null,
      options: q.options.map((o) => ({ text: o.text, text_zh: o.text_zh || null })),
      picked: typeof picked === "number" ? picked : null,
      correct: correctIdx, isRight, explanation: q.explanation, explanation_zh: q.explanation_zh || null,
    });
  } else if (q.type === "multi") {
    // Multiple-answer: all correct = full credit, correct subset = half, any wrong pick = zero.
    const picked = Array.isArray(answers[q.id]) ? answers[q.id].filter((n) => typeof n === "number") : [];
    const correct = q.options.map((o, i) => (o.ok ? i : -1)).filter((i) => i >= 0);
    const anyWrong = picked.some((i) => !correct.includes(i));
    const allCorrect = !anyWrong && picked.length > 0 && correct.every((i) => picked.includes(i));
    // 「多选题部分正确给一半分」按开考时快照的考试设置（partialCredit），默认开 = 原规则
    const credit = allCorrect ? 1 : (q.partialCredit !== false && !anyWrong && picked.length > 0) ? 0.5 : 0;
    detail.push({
      id: q.id, type: "multi", question: q.question, question_zh: q.question_zh || null,
      options: q.options.map((o) => ({ text: o.text, text_zh: o.text_zh || null })),
      picked, correct, isRight: allCorrect, partial: credit === 0.5,
      explanation: q.explanation, explanation_zh: q.explanation_zh || null,
    });
  } else if (q.type === "fill") {
    const raw = String(answers[q.id] || "");
    const isRight = normFill(raw) !== "" && q.answers.some((a) => normFill(a) === normFill(raw));
    detail.push({
      id: q.id, type: "fill", question: q.question, question_zh: q.question_zh || null,
      answer: raw, accepted: q.answers, isRight,
      explanation: q.explanation, explanation_zh: q.explanation_zh || null,
    });
  } else {
    // 简答题：先不给分（score 为空）；评分队列或 HR 复核后才有分数
    detail.push({ id: q.id, type: "open", question: q.question, question_zh: q.question_zh || null, answer: String(answers[q.id] || ""), score: null, maxPoints: q.maxPoints, feedback: null, review: "pending" });
  }
  // 每题分值：明细带上开考时快照的分值，scoreTotals 按它计分；旧答卷没有这个字段 → 旧口径
  for (const d of detail) { const src = q; if (src && src.points != null) d.points = src.points; }
  return detail[0];
}

// ---- server.js L2485 ----
function clientDetail(detail, showAnswers) {
  return (detail || []).map((d) => {
    if (d.type === "open") return clientOpenDetail(d);
    if (showAnswers !== false) return d;
    const base = { id: d.id, type: d.type, question: d.question, question_zh: d.question_zh, isRight: d.isRight, partial: d.partial || false };
    if (d.points != null) base.points = d.points;
    if (d.type === "fill") base.answer = d.answer;
    else { base.options = d.options; base.picked = d.picked; }
    return base;
  });
}

// ---- server.js L5805 ----
function clientOpenDetail(d) {
  const out = { id: d.id, type: "open", question: d.question, question_zh: d.question_zh || null, answer: d.answer, maxPoints: d.maxPoints, score: d.score == null ? null : d.score };
  if (d.points != null) out.points = d.points;
  const review = d.review || (d.score == null ? "pending" : "legacy");
  out.review = review;
  if (review === "ai_provisional" || review === "confirmed") {
    out.feedback = d.feedback || (d.ai && d.ai.feedback) || null;
    if (d.ai) out.ai = { model: d.ai.modelReturned || d.ai.model || null, generatedAt: d.ai.generatedAt || null };
  } else if (review === "legacy" || review === "overridden" || review === "manual") {
    out.feedback = d.feedback || null;
  }
  if (d.demoEstimate != null) out.demoEstimate = d.demoEstimate;
  if (d.overridden) out.overridden = true;
  return out;
}

// ---- server.js L5603 / L5615 ----
function scoreTotals(detail) {
  let earned = 0, max = 0;
  for (const q of detail || []) {
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

// ---- store.js L1965 ----
function rowToQuestion(r) {
  if (!r) return null;
  const q = {
    id: r.id, courseId: r.courseId, moduleId: r.moduleId, type: r.type,
    question: r.question, question_zh: r.question_zh,
  };
  if (r.type === "mcq" || r.type === "multi") {
    q.options = r.options ? JSON.parse(r.options) : [];
    q.explanation = r.explanation;
    q.explanation_zh = r.explanation_zh;
  } else if (r.type === "fill") {
    // Accepted answers are stored in the options column as a JSON array.
    q.answers = r.options ? JSON.parse(r.options) : [];
    q.explanation = r.explanation;
    q.explanation_zh = r.explanation_zh;
  } else {
    q.rubric = r.rubric;
    q.rubric_zh = r.rubric_zh;
    q.maxPoints = r.maxPoints;
  }
  // 单题分值（迁移 59）：null = 按考试的题型默认分值
  q.points = r.points == null ? null : Number(r.points);
  // AI 起草并被采纳的题目带来源信息（迁移 58）：{ kind:"ai", providerId, protocol, model, modelReturned, promptVersion, generatedAt, callId, adoptedBy, adoptedAt }
  if (r.origin) { try { q.origin = JSON.parse(r.origin); } catch { /* 忽略损坏的来源信息 */ } }
  return q;
}

// ---- store.js L2037 insertQuestionRow / L3107 updateQuestion：与题型相关的列（id/courseId/moduleId/type/question/origin/points 之外） ----
function questionColumns(q) {
  return {
    options: q.options ? JSON.stringify(q.options) : q.answers ? JSON.stringify(q.answers) : null,
    explanation: q.explanation || null, explanation_zh: q.explanation_zh || null,
    rubric: q.rubric || null, rubric_zh: q.rubric_zh || null,
    maxPoints: q.maxPoints != null ? q.maxPoints : null,
  };
}

module.exports = {
  examTypePoints, questionPoints, questionItemFromBody, bulkItemFromBody, snapshotQuestion, clientQuestions,
  gradeQuestion, clientDetail, clientOpenDetail, scoreTotals, scoreDetail, rowToQuestion, questionColumns,
};
