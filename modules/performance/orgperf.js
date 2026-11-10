// 组织绩效（负责人 2026-10-10）：一级部门负责人互评的维度、校验与汇总 —— 纯函数，server.js 调用，测试直接 require。
// 维度与行为参照取自负责人提供的「Q3 支持部门服务满意度互评问卷」：三个维度各打 0–10 分，0 = 不适用；
// 另一题为「过去一个季度中与该部门协同中最需解决的 1 个具体流程卡点或历史遗留问题」（文字）。评分人所在部门由系统识别，不用选。
"use strict";

const DIMS = Object.freeze([
  { key: "resp", zh: "响应与敏捷度", en: "Responsiveness & Agility", subZh: "速度与主动性", subEn: "Speed & proactiveness",
    bands: [
      ["基本无响应或明确拒绝承接", "Little to no response, or openly refuses to take it on"],
      ["需求挂起、长期无反馈", "Requests left pending, no feedback for long periods"],
      ["需反复催促才推进", "Moves forward only after repeated chasing"],
      ["按需响应、闭环及时", "Responds as needed and closes the loop on time"],
      ["主动预判风险、提前对齐", "Anticipates risks and aligns ahead of time"],
    ] },
  { key: "expert", zh: "专业与解题能力", en: "Expertise & Problem-Solving", subZh: "解决问题深度", subEn: "Depth of resolution",
    bands: [
      ["问题搁置，造成损失或矛盾升级", "Lets issues sit, causing losses or escalating conflict"],
      ["既不解决也不向上升级", "Neither resolves the issue nor escalates it upward"],
      ["只说「不行」，无替代方案", "Just says \"no\", with no alternative offered"],
      ["能解决但较为被动", "Solves the problem, but largely reactively"],
      ["提出替代 / 组合方案并推动落地", "Proposes alternative / combined plans and drives them to land"],
    ] },
  { key: "process", zh: "协作流程优化", en: "Process & Mechanism Enablement", subZh: "合作顺畅程度", subEn: "Smoothness of collaboration",
    bands: [
      ["流程缺失混乱，协同无法推进", "Missing or chaotic process; collaboration can't move"],
      ["流程已成业务推进瓶颈", "Process has become a bottleneck for the business"],
      ["合规但设置额外审批 / 卡点", "Compliant, but adds extra approvals / checkpoints"],
      ["流程顺畅、无额外阻碍", "Smooth process with no added friction"],
      ["主动简化流程、沉淀组织能力", "Proactively simplifies process and builds lasting capability"],
    ] },
]);
// 分档：1–2 CRITICAL、3–4 WEAK、5–6 PASSABLE、7–8 STRONG、9–10 EXCELLENT
const BANDS = Object.freeze([
  { from: 1, to: 2, en: "CRITICAL", zh: "严重不足" }, { from: 3, to: 4, en: "WEAK", zh: "较弱" }, { from: 5, to: 6, en: "PASSABLE", zh: "合格" },
  { from: 7, to: 8, en: "STRONG", zh: "良好" }, { from: 9, to: 10, en: "EXCELLENT", zh: "卓越" },
]);
const ISSUE = Object.freeze({ zh: "写下过去一个季度中与该部门协同中「最需解决的 1 个具体流程卡点或历史遗留问题」。", en: "Name the one specific process blocker or legacy issue in working with this department last quarter that most needs fixing." });
const ISSUE_MAX = 1000;
const MIN_RATERS_VISIBLE = 3;   // 被评部门负责人看本部门汇总的最少评分部门数（少于此只给 HR 看，以免推出是谁打的）
const QUARTER_RE = /^\d{4}-Q[1-4]$/;

const dimKeys = (dims) => (Array.isArray(dims) && dims.length ? dims : DIMS).map((d) => d.key);

// 校验一个被评部门的作答：{ scores: { 维度键: 0–10 整数 }, issue }；complete = 每个维度都给了分（0 = 不适用也算给了）；
// scored = 至少一个维度打了大于 0 的分（负责人 10/10：没打分 = 跳过，按不适用处理，不进平均、不算有效评分部门）
function checkAnswer(a, dims) {
  const keys = dimKeys(dims);
  const scores = {};
  const src = a && typeof a === "object" && a.scores && typeof a.scores === "object" ? a.scores : {};
  for (const k of keys) {
    if (src[k] === undefined || src[k] === null || src[k] === "") continue;
    // 代码审查 10/11：只收 number 或纯数字字符串（true、[7] 之类不再被当成 1、7）
    if (typeof src[k] !== "number" && !(typeof src[k] === "string" && /^\s*\d+\s*$/.test(src[k]))) return { ok: false, code: "bad_score", dim: k };
    const v = Number(src[k]);
    if (!Number.isInteger(v) || v < 0 || v > 10) return { ok: false, code: "bad_score", dim: k };
    scores[k] = v;
  }
  if (a && a.issue != null && typeof a.issue !== "string") return { ok: false, code: "bad_issue" };
  const issue = a && a.issue != null ? a.issue.trim() : "";
  if (Array.from(issue).length > ISSUE_MAX) return { ok: false, code: "issue_too_long", max: ISSUE_MAX };
  return { ok: true, scores, issue: issue || null, complete: keys.every((k) => scores[k] !== undefined), scored: keys.some((k) => scores[k] > 0) };
}

const avg1 = (arr) => (arr.length ? Math.round((arr.reduce((a, b) => a + b, 0) / arr.length) * 10) / 10 : null);

// 汇总：只算已提交评分部门的答卷；0 = 不适用，不进平均。返回每个被评部门一行：
//   { dept1Id, dept1, raters（给了至少一个非 0 分的评分部门数）, dims: { key: { avg, n } }, overall（各维度平均的平均）, issues: [文字] }
// issues 按文字排序（不保留提交顺序，免得与评分部门对上号）。不返回任何评分部门 / 评分人信息（匿名，负责人 10/10 定）。
function summarize(targets, answers, submittedDepts, dims) {
  const keys = dimKeys(dims);
  const ok = new Set(submittedDepts || []);
  return (targets || []).map((t) => {
    const mine = (answers || []).filter((a) => a.targetDept1Id === t.dept1Id && ok.has(a.raterDept1Id) && a.raterDept1Id !== t.dept1Id);
    const dimsOut = {};
    for (const k of keys) {
      const vals = mine.map((a) => Number(a.scores && a.scores[k])).filter((v) => Number.isFinite(v) && v > 0);
      dimsOut[k] = { avg: avg1(vals), n: vals.length };
    }
    const dimAvgs = keys.map((k) => dimsOut[k].avg).filter((v) => v != null);
    return {
      dept1Id: t.dept1Id, dept1: t.dept1 || null,
      raters: mine.filter((a) => keys.some((k) => Number(a.scores && a.scores[k]) > 0)).length,
      dims: dimsOut, overall: avg1(dimAvgs),
      // 跳过（没打分 / 全不适用）的部门即使留了文字也不算（负责人 10/10：跳过 = 不适用）
      issues: mine.filter((a) => keys.some((k) => Number(a.scores && a.scores[k]) > 0)).map((a) => a.issue).filter(Boolean).sort((a, b) => String(a).localeCompare(String(b))),
    };
  });
}

function bandOf(score) {
  const v = Number(score);
  if (!Number.isFinite(v) || v <= 0) return null;
  return BANDS.find((b) => v >= b.from && v < b.to + 1) || BANDS[BANDS.length - 1];
}

module.exports = { DIMS, BANDS, ISSUE, ISSUE_MAX, MIN_RATERS_VISIBLE, QUARTER_RE, dimKeys, checkAnswer, summarize, bandOf };
