// core 订阅的领域事件处理函数（kernel/registry.js 在 load() 时读取，早于打开数据库：顶层不做 I/O）。
// 键与 modules/core/manifest.js 的 subscribes 逐一对应；处理函数同步执行，在引起事件的事务提交之后运行。
// ctx.services 是 core 专用的每轮服务（server.js eventServices(true)）：hodOf / deptLevelsOf，外加 addTalentRecordOnce。
"use strict";
const crypto = require("crypto");

// 行为实践项目的正式人才记录（modules/culture/CONTRACT.md 6.1）。类型由 store.js 数据迁移 51 种入。
const CULTURE_RECORD_TYPE = "culture-program";
// 事件 data 里抄进记录 detail 的字段（与数据迁移 51 种入的 record_fields 对应；programId 另存，便于追溯）。
const TEXT_KEYS = ["programName", "startDate", "endDate", "track", "participantStatus", "dept1Id", "dept1"];
const NUMBER_KEYS = ["weeksRequired", "weeksMet", "totalPoints", "tasksSubmitted", "tasksWitnessed", "cardsGiven", "cardsReceived"];
// 两个选择字段存 record_fields.options 里的值（store.js 数据迁移 54）：事件 data 用内部键（CONTRACT.md 6.1），而 options 同时是
// 存储值与英文显示名 —— 原样存内部键，英文界面就显示「Track employee」。事件里出现这里没有的值时原样保存。
// 与迁移 55 之后的 options 逐项一致（迁移 54 定形、55 改为 Team Member / Full participation；test/culture-record-options.test.js 核对）。
const OPTION_VALUES = Object.freeze({
  track: Object.freeze({ leader: "Leader", employee: "Follower" }),   // 2026-09-30 负责人标准英文：Team Member → Follower（数据迁移 60）
  participantStatus: Object.freeze({ active: "Full participation", left: "Left early" }),
});
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function isDate(s) {
  const m = typeof s === "string" ? DATE_RE.exec(s) : null;
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
}
// 记录 id 由 programId + userId 确定性生成：同一对无论事件送达几次，都落在同一个主键上（INSERT OR IGNORE）。
function cultureRecordId(programId, userId) {
  return "tr-cp-" + crypto.createHash("sha256").update(`${programId}\n${userId}`, "utf8").digest("hex").slice(0, 24);
}

module.exports = {
  // 计分冻结时，culture 为每名参与者（active 或 left）发一条；每个项目只发一次（以 frozenAt 判定）。
  // 逐条 O(1)：一次主键插入。同一 programId + userId 只写一次；之后的保持度测评等变化不改写已写入的记录。
  // 日期取 data.endDate（第 W 周宽限结束日），不取 occurredAt（真实时钟，与业务日期无关）。
  // data 不合规（缺 userId / programId、endDate 不是真实日期）时抛错：总线按失败记入发件箱 lastError，不写半条记录。
  "culture.program.completed": (event, ctx) => {
    const userId = event.subject && event.subject.userId;
    const d = event.data || {};
    const programId = typeof d.programId === "string" || typeof d.programId === "number" ? String(d.programId).trim() : "";
    if (!userId) throw new Error("culture.program.completed: subject.userId is missing");
    if (!programId) throw new Error("culture.program.completed: data.programId is missing");
    if (!isDate(d.endDate)) throw new Error("culture.program.completed: data.endDate must be a YYYY-MM-DD date");
    const detail = { programId };
    for (const k of TEXT_KEYS) {
      if (typeof d[k] !== "string" || !d[k].trim()) continue;
      const v = d[k].trim();
      const map = OPTION_VALUES[k];
      detail[k] = (map && Object.hasOwn(map, v) ? map[v] : v).slice(0, 200);
    }
    for (const k of NUMBER_KEYS) if (typeof d[k] === "number" && Number.isFinite(d[k])) detail[k] = d[k];
    ctx.services.addTalentRecordOnce({
      id: cultureRecordId(programId, userId),
      userId,
      type: CULTURE_RECORD_TYPE,
      date: d.endDate,
      title: typeof d.programName === "string" ? d.programName.trim().slice(0, 200) : "",
      detail,
      createdBy: event.actorId || "system",
    });
  },
};
