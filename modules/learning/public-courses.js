"use strict";
// 公开课程与自主学习的纯规则（第四批 7 / 9.2，2026-10-08）。零依赖；server.js 只做取数与落库，判定都在这里，
// test/public-course-rules.test.js 覆盖。
//   公开课程 = 课程文档 public === true（包装程序 pw-<courseId> 镜像同一字段）。员工在「课程目录」点「开始学习」自主加入，
//   不需要审批；加入后是一行 source = 'self' 的指派（自主学习：没有截止日、不进必修完成率、不逾期、不提醒），学完计入学时。
//   旧版多课程课程包从不公开（目录只列 1:1 包装程序）。

// 9.2 负责人 2026-10-08 拍板 A：公开课程关闭（取消公开）后，目录立即不再显示；已开始学习的人保留到学完（含考试），
// 加入但未开始的人移出，已完成的记录与学时保留。B / C 只在改这个常量时生效（B = 立即停止，C = 关闭后 30 天内学完）。
const PUBLIC_CLOSE_POLICY = "A";
const POLICY_C_DAYS = 30;

// 课程是否在线下：缺省线上
const isOffline = (course) => !!course && (course.mode || "online") === "offline";
// "YYYY-MM-DDTHH:mm" → "YYYY-MM-DD"；无效 → null
function sessionDayOf(sessionAt) {
  const s = String(sessionAt || "").slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

// 课程目录收录判定。p = 程序（应为 1:1 包装程序），course = 它唯一的课程，today = 本地日 YYYY-MM-DD，
// hasCourse = 本人已有这门课（指派或自主）。规则：包装程序、课程存在、公开、已发布；线下课程在开课日（马尼拉本地日）
// 之前或当天、或未填开课时间时列出；本人已有这门课时始终列出（便于看到「已加入」「已完成」）。
function catalogEligible(p, course, { today, hasCourse = false, isWrapper = true } = {}) {
  if (!p || !course || !isWrapper) return false;
  if ((p.courseIds || []).length !== 1 || p.courseIds[0] !== course.id) return false;
  if (course.public !== true) return false;
  if ((course.status || "draft") !== "published") return false;
  if ((p.status || "published") !== "published") return false;
  if (hasCourse) return true;
  if (isOffline(course)) {
    const d = sessionDayOf(course.sessionAt);
    if (d && today && d < today) return false;
  }
  return true;
}
// 线下公开课程的开课日已过（不能再新加入）
function sessionPassed(course, today) {
  if (!isOffline(course)) return false;
  const d = sessionDayOf(course.sessionAt);
  return !!(d && today && d < today);
}

// 本人与这门课的关系：none | self | assigned
function myStatusOf(asg) {
  if (!asg) return "none";
  return asg.source === "self" ? "self" : "assigned";
}

// 「开始学习 / 加入课程」的判定：
//   { action: "reject", code: "not_public" | "session_passed" | "inactive" } | { action: "already", status } | { action: "enroll" }
// listed = 目录里是否收录（catalogEligible，hasCourse 传本人是否已有这门课）；asg = 本人的指派行（可无）。
function enrollDecision({ listed, asg, course, today, active = true }) {
  if (!listed) return { action: "reject", code: "not_public" };
  if (asg) return { action: "already", status: myStatusOf(asg) };
  if (!active) return { action: "reject", code: "inactive" };
  if (sessionPassed(course, today)) return { action: "reject", code: "session_passed" };
  return { action: "enroll" };
}
// 「退出学习」的判定：只有自主学习、且未完成的才能退出。
//   { ok: true } | { ok: false, code: "not_self" | "already_done" }
function leaveDecision({ asg, done }) {
  if (!asg || asg.source !== "self") return { ok: false, code: "not_self" };
  if (done) return { ok: false, code: "already_done" };
  return { ok: true };
}

// 指派来源的合并规则（与 store.setAssignment / selfEnroll 同一口径，给测试与文档用）：
//   incoming "assigned"（HR / 项目 / 审批 / 新员工默认）→ 总是 assigned（自主学习行被改为指派）；
//   incoming "self"（目录自主加入）→ 已有行不动（已有指派的仍是 assigned），没有行才是 self。
function mergeSource(existing, incoming) {
  if (incoming === "assigned") return "assigned";
  if (existing === "assigned" || existing === "self") return existing;
  return "self";
}

// 公开课程关闭（public true → false）时自主学习的人怎么处理。rows = 这门课全部 source='self' 的行：
//   [{ userId, started, done }]，started = 学习进度 > 0 或有答卷；done = 已完成。
// 返回 { remove: [userId], keep: [userId] }：
//   A（保留至学完，默认）：未开始且未完成 → 移出；其余保留（已开始的可以学完，已完成的记录与学时保留）。
//   B（立即停止）：同 A 的移出名单；保留的人在 selfAccessBlocked 里被挡住（进度保留，重新公开后可继续）。
//   C（限期学完）：同 A；关闭满 POLICY_C_DAYS 天后按 B 处理。
function planPublicClose(rows, policy = PUBLIC_CLOSE_POLICY) {
  void policy; // 三种方案的移出名单相同；差别只在之后的访问判定（selfAccessBlocked）
  const remove = [], keep = [];
  for (const r of rows || []) {
    if (!r || !r.userId) continue;
    if (!r.done && !r.started) remove.push(r.userId);
    else keep.push(r.userId);
  }
  return { remove, keep };
}
// 方案 B / C 的访问判定：自主学习、课程已不再公开、尚未完成 → 是否挡住（A 永不挡）。
// course 为课程文档（public / publicClosedAt）；nowMs = 当前时间毫秒。
function selfAccessBlocked({ asg, course, done, policy = PUBLIC_CLOSE_POLICY, nowMs = Date.now() }) {
  if (policy === "A") return false;
  if (!asg || asg.source !== "self" || done) return false;
  if (!course || course.public === true) return false;
  if (policy === "B") return true;
  if (policy === "C") {
    const t = Date.parse(course.publicClosedAt || "");
    if (!Number.isFinite(t)) return true;
    return nowMs - t > POLICY_C_DAYS * 86400000;
  }
  return false;
}
// 课程 PUT / 批量操作里 public 字段的合并：键缺省 = 保持原值（旧编辑器不发这个键）；变化时记 publicSince / publicClosedAt。
// 返回 { public, publicSince, publicClosedAt, changed: null | "open" | "close" }
function applyPublicFlag(prev, incoming, nowIso) {
  const was = !!(prev && prev.public === true);
  const out = { public: was, publicSince: (prev && prev.publicSince) || null, publicClosedAt: (prev && prev.publicClosedAt) || null, changed: null };
  if (incoming === undefined) return out;
  const next = incoming === true;
  out.public = next;
  if (next && !was) { out.publicSince = nowIso; out.changed = "open"; }
  else if (!next && was) { out.publicClosedAt = nowIso; out.changed = "close"; }
  return out;
}
// 简介裁到 240 字（目录列表用；详情给全文）
function clipSummary(s, n = 240) {
  const t = String(s || "").replace(/\s+/g, " ").trim();
  if (!t) return null;
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
}

module.exports = {
  PUBLIC_CLOSE_POLICY, POLICY_C_DAYS,
  sessionDayOf, catalogEligible, sessionPassed, myStatusOf, enrollDecision, leaveDecision,
  mergeSource, planPublicClose, selfAccessBlocked, applyPublicFlag, clipSummary,
};
