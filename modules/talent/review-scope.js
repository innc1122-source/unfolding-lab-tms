"use strict";
// 人才盘点 · 页面人群范围（F60，2026-10-09；F61 同日删除「管理职责」）
// 人才盘点页顶部筛选（部门、职级段、岗位序列、直属上级、司龄、员工状态、潜力评定）定义整页的人群范围：九宫格与未定位名单、
// 晋升评审候选、继任计划、人才筛选结果、导出与批量操作都按它收窄。判定只在这里一处（原九宫格在前端 TalentReview.jsx 的
// trRowMatch 逐行判断，现移到服务端，前端只消费 GET /api/admin/talent-review 每行的 inScope），server.js 的各个端点共用。
// 绩效来源（src）只决定九宫格横轴取哪一期评级，不改变人群，所以不在这里。
// 数据范围（RBAC）先行：各端点先按 scopePredicate 取基础人群，本文件的谓词只在其上再收窄。
// 纯函数，不读库；日期判定复用 filter-engine.js 的 fullMonths / monthsBefore（与人才筛选的司龄、潜力评定同一口径）。
//
// 取值（地址栏键名 = 接口参数名）：
//   dept     部门 id（含下级）/ "name:<名>" 伪 id / "__none"；由调用方的 deptParse 解析，解析不了（不存在、范围外）= 不匹配任何人
//   band     "g:<职等>" / "nogrid"（有职级但不在职级体系内）/ "none"（未设职级）/ "r:<职级>"
//   track    "M" 管理通道 / "P" 专业通道（不分大小写；不在职级体系内的人不属于任何通道）
//   mgr      直属上级的用户 id / "__none"（没有直属上级）
//   tenure   lt1 / 1to3 / 3to5 / 5p / none（入职日期未填）；满 N 周年才算 N 年
//   estatus  probation / regular / exited / none（未填）
//   pot      fresh（12 个月内评定）/ stale（满 12 个月或日期不详）/ none（未评定）
// 不认识的取值不报错，按「不匹配任何人」处理（页面会先清掉不适用的取值）。范围只会收窄，不会越过数据范围。
const FE = require("./filter-engine.js");

const SCOPE_KEYS = Object.freeze(["dept", "band", "track", "mgr", "tenure", "estatus", "pot"]);
const POT_STALE_MONTHS = 12;
const MGR_NONE = "__none";
const MAX_LEN = 200;
const str = (v) => (v === null || v === undefined ? "" : String(v));
const blank = (v) => !str(v).trim();
const up = (v) => str(v).trim().toUpperCase();

// 读取范围参数：get(key) → 原始值（GET 的 query.get、POST 的 body.scope[key]）；数组取第一个。只留非空的键。
function readScope(get) {
  const out = {};
  if (typeof get !== "function") return out;
  for (const k of SCOPE_KEYS) {
    let v = get(k);
    if (Array.isArray(v)) v = v[0];
    if (v === null || v === undefined || typeof v === "object") continue;
    const s = str(v).trim().slice(0, MAX_LEN);
    if (s) out[k] = s;
  }
  return out;
}
const scopeFromObject = (o) => readScope((k) => (o && typeof o === "object" && !Array.isArray(o) ? o[k] : undefined));
const isActive = (f) => !!f && SCOPE_KEYS.some((k) => !blank(f[k]));

// 司龄分段：满 N 周年才算 N 年；入职日期在未来按「不满 1 年」；没有或认不出入职日期 = none
function tenureBucket(hireDate, today) {
  const m = FE.fullMonths(hireDate, today);
  if (m === null) return "none";
  const y = Math.floor(m / 12);
  if (y < 1) return "lt1";
  if (y < 3) return "1to3";
  if (y < 5) return "3to5";
  return "5p";
}
// 潜力评定状态：none 未评定；fresh 评定日 > 今天往前 months 个月；stale 已满或日期不详（迁移 67 之前评定的没有日期）
function potState(potential, atDay, today, months) {
  if (!potential) return "none";
  if (!atDay) return "stale";
  return str(atDay).slice(0, 10) > FE.monthsBefore(today, months === undefined ? POT_STALE_MONTHS : months) ? "fresh" : "stale";
}
// 职级段（与后台看板的 lv 口径一致；不认识的写法不匹配任何人）
function bandMatch(row, band) {
  const v = str(band);
  if (v === "none") return blank(row.jobLevel);
  if (v === "nogrid") return !blank(row.jobLevel) && blank(row.jobGrade);
  if (v.startsWith("g:")) return !blank(row.jobGrade) && str(row.jobGrade).trim() === v.slice(2).trim();
  if (v.startsWith("r:")) return !blank(row.jobLevel) && up(row.jobLevel) === up(v.slice(2));
  return false;
}

// 一行是否在范围内。row = { department, jobLevel, jobGrade, jobTrack, managerId, hireDate, empStatus, potential, potentialAt(本地日) }；
// ctx = { deptOk(部门原文) → bool, today, months? }。f 里没有的键不参与判定。
function rowMatch(row, f, ctx) {
  if (!f) return true;
  if (f.dept && !ctx.deptOk(row.department)) return false;
  if (f.band && !bandMatch(row, f.band)) return false;
  if (f.track && up(row.jobTrack) !== up(f.track)) return false;
  if (f.mgr && (f.mgr === MGR_NONE ? !!row.managerId : str(row.managerId) !== f.mgr)) return false;
  if (f.tenure && tenureBucket(row.hireDate, ctx.today) !== f.tenure) return false;
  if (f.estatus && (row.empStatus || "none") !== f.estatus) return false;
  if (f.pot && potState(row.potential, row.potentialAt, ctx.today, ctx.months) !== f.pot) return false;
  return true;
}

// 编译成「用户 → bool」的谓词；没有任何范围键 → null（不收窄）。
// env = { deptParse(id) → (部门名) => bool | null（null = 值不可用，不匹配任何人）, gradeOf(jobLevel) → { grade, track } | null,
//         today: "YYYY-MM-DD", dayOf(iso) → 本地日 }
function compileScope(f, env) {
  if (!isActive(f)) return null;
  const e = env || {};
  let deptOk = () => true;
  if (f.dept) {
    const m = typeof e.deptParse === "function" ? e.deptParse(f.dept) : null;
    deptOk = typeof m === "function" ? m : () => false;
  }
  const ctx = { deptOk, today: e.today, months: POT_STALE_MONTHS };
  const dayOf = typeof e.dayOf === "function" ? e.dayOf : (x) => str(x).slice(0, 10);
  const memo = new Map();
  return (u) => {
    if (!u) return false;
    if (memo.has(u.id)) return memo.get(u.id);
    const gr = u.jobLevel && typeof e.gradeOf === "function" ? e.gradeOf(u.jobLevel) : null;
    const row = {
      department: u.department || null, jobLevel: u.jobLevel || null,
      jobGrade: gr && gr.grade !== null && gr.grade !== undefined ? gr.grade : null, jobTrack: gr ? gr.track || null : null,
      managerId: u.managerId || null, hireDate: u.hireDate || null, empStatus: u.empStatus || null,
      potential: u.potential || null, potentialAt: u.potentialAt ? dayOf(u.potentialAt) : null,
    };
    const ok = rowMatch(row, f, ctx);
    memo.set(u.id, ok);
    return ok;
  };
}

module.exports = { SCOPE_KEYS, POT_STALE_MONTHS, MGR_NONE, readScope, scopeFromObject, isActive, tenureBucket, potState, bandMatch, rowMatch, compileScope, monthsBefore: FE.monthsBefore };
