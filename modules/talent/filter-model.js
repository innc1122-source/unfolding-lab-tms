"use strict";
// 人才筛选 · 条件模型（第 5 批 8.1，2026-10-08；设计 scratchpad/b5-design.md 第 2、3.4、4.2、5.1 节）
// 纯函数，零依赖，不读库。server.js（A 组）、store.js 迁移 81（A 组）、modules/ai/talent-filter.js（C 组）都 require 本文件；
// 前端（D 组）的条件摘要与编辑器在 web/src/pages/admin/talentFilter.js 另写一份，形状以本文件为准。
//
// ───────────────────────────── 导出 API ─────────────────────────────
// 常量
//   FILTER_VERSION = 1                     定义 JSON 的 v
//   LIMITS          { rootItems:20, groupItems:12, leaves:30, values:200, string:100, bytes:16384,
//                     privatePerUser:50, sharedTotal:200, nameLength:60, noteLength:300, memberBatch:200 }
//   TAGS            ["rating","tenure","trainings","violations","nextLevel","ratingWindow","levelTenure"]（只出现在内置晋升筛选上）
//                   F62（2026-10-09）：ratingWindow = 过去 N 个月绩效无低于某级（perfRecent + withinMonths）；levelTenure = 现职级任职时长
//   ERROR_CODES / WARNING_CODES            第 2.4 节的校验码
//   OPS             { [op]: { label, label_zh } }        运算符的中英文名
//   NO_VALUE_OPS    Set：不带 value 的运算符（isTrue、none、exists …）
//   FIELD_DEFS      静态字段定义（不含 custom:<key>），见第 2.2 节
//   COLUMN_DEFS     结果列目录 [{ id, label, label_zh, modules }]；DEFAULT_COLUMNS、PROMO_COLUMNS
//   PROMO_DEFAULTS  晋升评审候选内置条件的默认值（F62，负责人 2026-10-09 定的公司晋升门槛）：
//                     { minRating:"B+", minRatingPeriods:2（近 2 期任一期）, windowMinRating:"B", windowMonths:12（过去 12 个月无 C / D）,
//                       minLevelTenureMonths:12（现职级任职满 12 个月）, minTenureMonths:0（司龄门槛停用）, requireTrainings:false（去掉必修课程）,
//                       noMajorViolationMonths:12, violationMajorOnly:false（近 12 个月无违纪，所有严重度）}
//   LEGACY_PROMO_DEFAULTS  F62 之前的五项默认值（迁移 92 用来判断内置筛选是否从未被改过）
//   isLegacyPromotionDefault(def, ratingOptions) / isPromotionDefault(def, ratingOptions) / isInterimPromotionDefault(def, ratingOptions)
//                   定义是否与旧默认 / 新默认 / F62 首版默认（missing ignore，迁移 92 写入）逐条相同（忽略叶子 id；参数按缺省值补齐后比较）
//   samePromotionDefinition(def, ref) 上面三者共用的比较
//   PROMO_NAME      { name:"Promotion Panel Candidates", name_zh:"晋升评审候选" }
//   PROMO_SORT      { col:"jobLevel", dir:"desc" }
//
// 字段目录
//   buildCatalog(ctx) → catalog（可直接 JSON 下发给 GET /api/admin/talent-filters/catalog）
//     ctx = {
//       modules:            modulesOn() 的结果 { performance, learning, talent, culture, … }（值为真 = 开启）
//       ranks:              jobGrades() → [{ rank, grade, level, track }]
//       jobLevelsInUse?:    [string] 范围内人群实际在用、但不在职级体系里的 jobLevel（旧数据），列为可选值
//       recordTypes:        [{ key, label, label_zh, moduleOff, fields:[{ key, label, label_zh, input, options, options_zh, filterable }] }]
//                           必须含 performance（取 rating 字段）、award（awardName）、violation（severity）
//       customFields:       record_fields 中 typeKey = "user" 的字段 [{ key, label, label_zh, input, options, options_zh }]
//       deptOptions:        deptFilterFor(user).options(人群).options → [{ id, name, path, parentId, level }]（已按范围裁剪）
//       programs:           [{ id, title, title_zh }]（课程对象，不受数据范围限制）
//       talentTags:         [string] 范围内人群的人才标签
//       awardNames:         [string] 范围内人群的奖项（规范值）
//       successionPositions:[string] 范围内的继任岗位
//     }
//     catalog = { v:1, fields:[Field], columns:[Column], defaultColumns, ranks, ratingOptions, ratingOptions_zh }
//     Field = { id, group, group_label, group_label_zh, label, label_zh, ops:[{op,label,label_zh}], valueKind,
//               options?:[{value,label,label_zh}], params?:{…参数说明}, range?:[min,max], int?, module, modules,
//               available, reason?("module_off"), input?（custom 字段的输入类型）, recordTypes?（record 字段） }
//   indexCatalog(catalog) → { fields:Map(id→Field), columns:Map, recordTypes:Map(key→type), ratingOptions, ratingIndex:Map }（按 catalog 对象缓存）
//   valueShapeOf(field, op) → "none"|"list"|"one"|"number"|"numRange"|"rankRange"|"dateRange"|"date"|"text"
//
// 校验与归一
//   validateFilter(raw, catalog, opts?) → { ok, errors:[{path,code}], warnings:[{path,id,code}], filter|null, normalized }
//     opts.lenient = true：运行库里已保存的筛选时用 —— 已删除的自定义字段降为警告 field_removed、所属模块关闭的
//     记录类型降为警告 module_off（叶子在引擎里判为忽略）；默认（编辑、保存、AI 转换）两者都是错误。
//     已停用的内置字段（RETIRED_FIELDS，F61 的 isManager）两种模式都降为警告 field_retired、叶子原样保留，引擎判为忽略。
//   RETIRED_FIELDS / retiredLeafToTrack(leaf, ranks?)：已停用字段与其到职级通道叶子的对应（迁移 91 用）
//     filter = 校验通过时的归一化定义；normalized = 尽力归一的结果（有错误时也给，去掉了出错的叶子）。
//   normalizeFilter(raw, catalog, opts?) → 归一化定义（重复执行结果不变：叶子补 id、值转规范值、参数补默认值）
//   normalizeColumns(cols, catalog) → 去重、去未知/不可用列后的列数组（空 → DEFAULT_COLUMNS）
//   summarize(filter, catalog, lang) → 一句话条件摘要（导出首行、审计、列表页；lang = "zh" | "en"）
//   walkLeaves(filter, fn(leaf, groupIndex|null))   遍历叶子
//   pairOptions(field) → [{value,label,label_zh}]；canonOpt(options, v) → 规范值|null（中英文名、不分大小写都认）
//   positionKey(name) → 岗位名比较键（去空白与连字符、不分大小写、全角转半角）
//
// 数据范围
//   redactForViewer(def, allowDeptId, opts?) → { definition, redactedValues }
//     受限管理员查看共享筛选前调用：dept 叶子里 allowDeptId(id) 为假的部门 id、以及所有 "name:<名>" 伪 id 一律去掉
//     （"__none" 保留）；opts.allowUserId(id) 给了时同样裁剪 manager 叶子的上级 id。redactedValues = 去掉的值个数。
//
// 晋升评审候选（第 5 节）
//   promotionConfigToFilter(cfg, ratingOptions) → definition（迁移 81 用；cfg 先与 PROMO_DEFAULTS 合并）
//   promotionFilterRow(cfg, ratingOptions) → { builtinKey:"promotion", name, name_zh, visibility:"shared",
//                                              definition, columns, sort, dropped:["rating"]? }（迁移 81 直接写这一行）
//   promotionConfigOf(def) → { minRating, minRatingPeriods, windowMinRating, windowMonths, minLevelTenureMonths,
//                              minTenureMonths, requireTrainings, noMajorViolationMonths, violationMajorOnly }
//   applyPromotionConfig(def, patch) → 新定义：只增删改带标签的叶子，HR 自己加的叶子原样保留；
//                              patch 里明确给出的 minRatingPeriods / windowMonths 会覆盖叶子上的 n / withinMonths，没给的保留 HR 的调整
//
// 权限（第 4.2 节；filter 行 = { builtinKey, visibility, ownerId }，viewer = { id, isSuper, canWrite }）
//   canSeeFilter(f, viewer)     内置、共享：都能看；私有：只有创建人（超级管理员也看不到别人的私有筛选）
//   canEditFilter(f, viewer)    需 canWrite；内置：可改；私有：创建人；共享：创建人或超级管理员
//   canDeleteFilter(f, viewer)  内置不能删；其余同 canEditFilter
//   nameConflict(filters, cand, viewer) → null | "name" | "name_zh"（同一可见范围内名称重复，不分大小写，中英文名分别判断）

const FILTER_VERSION = 1;
const LIMITS = Object.freeze({
  rootItems: 20, groupItems: 12, leaves: 30, values: 200, string: 100, bytes: 16384,
  privatePerUser: 50, sharedTotal: 200, nameLength: 60, noteLength: 300, memberBatch: 200,
});
const TAGS = Object.freeze(["rating", "tenure", "trainings", "violations", "nextLevel", "ratingWindow", "levelTenure"]);
const ERROR_CODES = Object.freeze([
  "not_object", "bad_version", "bad_logic", "too_deep", "too_many_items", "too_many_leaves", "too_large",
  "unknown_field", "bad_op", "bad_value", "value_not_in_options", "value_out_of_range", "too_many_values",
  "string_too_long", "bad_params", "record_type_unknown", "record_type_unavailable", "custom_field_unknown",
]);
const WARNING_CODES = Object.freeze(["module_off", "field_removed", "value_unavailable", "field_retired"]);
// 已停用的内置字段（F61，负责人 2026-10-09「track 就是 role type」）：「管理者 / 个人贡献者」（isManager）并入职级通道（jobTrack）。
// 字段不再出现在目录里；已保存的筛选由数据迁移 91 改写为 jobTrack（toTrack 给出对应的通道值）。改写不了的叶子原样保留：
// 校验时一律降为警告 field_retired（宽松、严格模式都不报 400），引擎判为忽略，界面提示「该条件已停用，请改用岗位序列」。
const RETIRED_FIELDS = Object.freeze({
  isManager: Object.freeze({ label: "People manager / individual contributor", label_zh: "管理者 / 个人贡献者", toTrack: Object.freeze({ isTrue: "M", isFalse: "P" }) }),
});
// 已停用字段的叶子 → 职级通道叶子；对应不了（运算符不认识，或职级体系里没有该通道）→ null。ranks 省略 = 不核对职级体系。
function retiredLeafToTrack(leaf, ranks) {
  const r = leaf && RETIRED_FIELDS[leaf.field];
  if (!r || !r.toTrack || typeof leaf.op !== "string" || !Object.prototype.hasOwnProperty.call(r.toTrack, leaf.op)) return null;
  const track = r.toTrack[leaf.op];
  if (Array.isArray(ranks) && !ranks.some((x) => x && String(x.track || "").toUpperCase() === track)) return null;
  const out = { id: leaf.id, field: "jobTrack", op: "in", value: [track] };
  if (leaf.tag !== undefined) out.tag = leaf.tag;
  return out;
}
const ID_RE = /^c[0-9a-z]{1,8}$/;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

const L = (zh, en) => ({ label: en, label_zh: zh });
const OPS = Object.freeze({
  in: L("属于", "is any of"), notIn: L("不属于", "is none of"), between: L("介于", "between"),
  isTrue: L("是", "yes"), isFalse: L("否", "no"), contains: L("包含", "contains"), equals: L("等于", "equals"),
  gte: L("不少于", "at least"), lte: L("不超过", "at most"),
  atLeast: L("不低于", "at or above"), atMost: L("不高于", "at or below"), noRecord: L("无评级记录", "no rating on file"),
  allOf: L("全部完成", "all of"), anyOf: L("任一", "any of"), noneOf: L("均不", "none of"),
  countAtLeast: L("次数不少于", "at least (times)"), none: L("无", "none"),
  exists: L("有", "has"), notExists: L("没有", "has none"),
  listed: L("已列入", "is listed"), notListed: L("未列入", "is not listed"),
  isEmpty: L("为空", "is empty"), notEmpty: L("不为空", "is not empty"),
  onOrAfter: L("不早于", "on or after"), onOrBefore: L("不晚于", "on or before"), withinMonths: L("近 N 个月内", "within the last N months"),
});
const NO_VALUE_OPS = new Set(["isTrue", "isFalse", "noRecord", "none", "exists", "notExists", "listed", "notListed", "isEmpty", "notEmpty"]);
const LIST_OPS = new Set(["in", "notIn", "allOf", "anyOf", "noneOf"]);

const GROUPS = Object.freeze({
  org: L("组织", "Organization"), level: L("职级", "Job level"), tenure: L("司龄", "Tenure"),
  performance: L("绩效", "Performance"), potential: L("潜力", "Potential"), training: L("培训", "Training"),
  award: L("荣誉", "Awards"), violation: L("违纪", "Violations"), record: L("档案记录", "Profile records"),
  succession: L("继任", "Succession"), custom: L("自定义字段", "Custom fields"),
});

const opt = (value, zh, en) => ({ value, label: en, label_zh: zh });
const EMP_STATUS_OPTIONS = [opt("probation", "试用期", "Probation"), opt("regular", "正式", "Regular"), opt("exited", "已离职", "Exited"), opt("__none", "未设置", "Not set")];
const POTENTIAL_OPTIONS = [opt("High", "高", "High"), opt("Medium", "中", "Medium"), opt("Low", "低", "Low"), opt("__none", "未评定", "Not assessed")];
const TRACK_OPTIONS = [opt("M", "管理通道", "Management track"), opt("P", "专业通道", "Professional track")];
const BUCKET_ZH = ["低", "中", "高"], BUCKET_EN = ["Low", "Medium", "High"];
const NINEBOX_OPTIONS = (() => {
  const out = [];
  for (const p of [2, 1, 0]) for (const f of [2, 1, 0]) out.push(opt(`${p}-${f}`, `潜力${BUCKET_ZH[p]} · 绩效${BUCKET_ZH[f]}`, `${BUCKET_EN[p]} potential · ${BUCKET_EN[f]} performance`));
  out.push(opt("__unplaced", "未进入九宫格", "Not placed"));
  return out;
})();
const PERIOD_KINDS = ["any", "quarter", "half", "annual"];

// 参数说明（同时下发给前端编辑器）：type = int | enum | bool | list | string | object
const PARAMS = Object.freeze({
  perfRecent: {
    n: { type: "int", min: 1, max: 8, default: 1 },
    mode: { type: "enum", values: ["all", "any", "atLeastK"], default: "all" },
    k: { type: "int", min: 1, max: 8, default: null, when: { mode: "atLeastK" } },
    periodKind: { type: "enum", values: PERIOD_KINDS, default: "any" },
    missing: { type: "enum", values: ["fail", "ignore"], default: "fail" },
    // F62：按月份的时间窗（0 = 不用）。> 0 时看窗内的全部绩效记录（不再取近 n 期），mode 仍按 all / any / atLeastK；
    // 窗内没有记录：missing = fail → 不满足，ignore → 满足（「过去 12 个月没有 C / D」对没有评级的人成立）。
    withinMonths: { type: "int", min: 0, max: 120, default: 0 },
  },
  potential: { freshOnly: { type: "bool", default: false } },
  trainingCompletion: { scope: { type: "enum", values: ["mandatory", "all"], default: "mandatory" } },
  award: { months: { type: "int", min: 0, max: 120, default: 0 }, names: { type: "list", max: 50, default: [] } },
  violation: { months: { type: "int", min: 0, max: 120, default: 0 }, severity: { type: "list", max: 10, default: [] } },
  record: { type: { type: "string", required: true }, months: { type: "int", min: 0, max: 120, default: 0 }, fields: { type: "object", default: {} } },
  succession: { position: { type: "string", max: 80, default: "" } },
});

// 静态字段。valueKind：none | options | rating | dept | user | program | tag | jobLevel | text | number | count
//   ref 类（dept / user / program）的值在引擎里按「当前管理员能用的值」裁剪，裁剪后为空 = 不匹配任何人（值不可用）。
const F = (id, group, zh, en, ops, valueKind, modules, extra) => Object.freeze({ id, group, ...L(zh, en), ops, valueKind, modules, ...(extra || {}) });
const FIELD_DEFS = Object.freeze([
  F("dept", "org", "部门（含下级）", "Department (incl. sub-departments)", ["in", "notIn"], "dept", ["core"]),   // CX-192：与部门筛选控件同一用词
  F("position", "org", "职位", "Position", ["contains", "in"], "text", ["core"]),
  F("manager", "org", "直属上级", "Line manager", ["in"], "user", ["core"]),
  F("empStatus", "org", "员工状态", "Employment status", ["in"], "options", ["core"]),
  F("jobLevel", "level", "职级", "Job level", ["in", "notIn", "between"], "jobLevel", ["core"]),
  F("jobGrade", "level", "职等", "Job grade", ["in", "notIn"], "options", ["core"]),
  F("jobTrack", "level", "岗位序列", "Track", ["in"], "options", ["core"]),
  F("nextLevelExists", "level", "有下一职级", "Has a next job level", ["isTrue", "isFalse"], "none", ["core"]),
  F("tenureMonths", "tenure", "司龄（月）", "Tenure (months)", ["gte", "lte", "between"], "number", ["core"], { range: [0, 600], int: true }),
  // F62：从最近一条职级有变化的晋升 / 调动记录的日期起算（没有这类记录从入职日算），日历满月数
  F("levelTenureMonths", "tenure", "现职级任职时长（月）", "Months in current job level", ["gte", "lte", "between"], "number", ["core"], { range: [0, 600], int: true }),
  F("perfRecent", "performance", "近期绩效评级", "Recent performance rating", ["atLeast", "atMost", "in", "noRecord"], "rating", ["performance"]),
  F("potential", "potential", "潜力", "Potential", ["in"], "options", ["talent"]),
  F("nineBox", "potential", "九宫格位置", "9-box placement", ["in"], "options", ["talent", "performance"]),
  F("talentTag", "potential", "人才标签", "Talent tags", ["anyOf", "allOf", "noneOf"], "tag", ["core"]),
  F("trainingMandatoryDone", "training", "必修课程全部完成", "All required courses completed", ["isTrue", "isFalse"], "none", ["learning"]),
  F("trainingCompletion", "training", "课程完成率（%）", "Course completion rate (%)", ["gte", "lte"], "number", ["learning"], { range: [0, 100] }),
  F("trainingProgram", "training", "已完成课程", "Completed courses", ["allOf", "anyOf", "noneOf"], "program", ["learning"]),
  F("award", "award", "获奖记录", "Award records", ["countAtLeast", "none"], "count", ["core"], { range: [1, 999], int: true }),
  F("violation", "violation", "违纪记录", "Violation records", ["none", "countAtLeast"], "count", ["core"], { range: [1, 999], int: true }),
  F("record", "record", "档案记录", "Profile records", ["exists", "notExists", "countAtLeast"], "count", ["core"], { range: [1, 999], int: true }),
  F("succession", "succession", "继任计划", "Succession plan", ["listed", "notListed"], "none", ["talent"]),
]);
const CUSTOM_OPS = Object.freeze({
  select: ["in", "notIn"], suggest: ["in", "notIn"], text: ["contains", "equals", "isEmpty", "notEmpty"],
  textarea: ["contains", "equals", "isEmpty", "notEmpty"], number: ["gte", "lte", "between", "isEmpty"],
  date: ["onOrAfter", "onOrBefore", "between", "withinMonths"], checkbox: ["isTrue", "isFalse"], level: ["in"], department: ["equals"],
});

const C = (id, zh, en, modules) => Object.freeze({ id, ...L(zh, en), modules: modules || ["core"] });
const COLUMN_DEFS = Object.freeze([
  C("name", "姓名", "Name"), C("employeeId", "工号", "Employee ID"), C("department", "部门", "Department"),
  C("position", "职位", "Position"), C("jobLevel", "职级", "Job level"), C("nextLevel", "下一职级", "Next level"),
  C("jobGrade", "职等", "Job grade"), C("jobTrack", "岗位序列", "Track"), C("hireDate", "入职日期", "Hire date"),
  C("tenure", "司龄", "Tenure"), C("levelTenure", "现职级任职时长", "Time in current level"), C("manager", "直属上级", "Line manager"), C("empStatus", "员工状态", "Employment status"),
  C("latestRating", "最近评级", "Latest rating", ["performance"]), C("recentRatings", "近期评级", "Recent ratings", ["performance"]),
  C("potential", "潜力", "Potential", ["talent"]), C("nineBox", "九宫格", "9-box", ["talent", "performance"]),
  C("trainingMandatory", "必修课程完成", "Required courses done", ["learning"]), C("trainingCompletion", "课程完成率", "Course completion rate", ["learning"]),
  C("awardCount", "获奖次数", "Awards"), C("violationCount", "违纪次数", "Violations"),
  C("successionPositions", "继任岗位", "Succession positions", ["talent"]), C("member", "人工调整", "Manual adjustment", ["talent"]),
  C("talentTags", "人才标签", "Talent tags"),
]);
const DEFAULT_COLUMNS = Object.freeze(["name", "employeeId", "department", "jobLevel", "latestRating", "potential", "tenure"]);
// F62：必修课程列换成现职级任职时长（司龄列保留给 HR 参考）
const PROMO_COLUMNS = Object.freeze(["name", "employeeId", "department", "jobLevel", "nextLevel", "latestRating", "levelTenure", "tenure", "violationCount", "potential"]);
const LEGACY_PROMO_COLUMNS = Object.freeze(["name", "employeeId", "department", "jobLevel", "nextLevel", "latestRating", "tenure", "trainingMandatory", "violationCount", "potential"]);
const PROMO_NAME = Object.freeze({ name: "Promotion Panel Candidates", name_zh: "晋升评审候选" });
const PROMO_SORT = Object.freeze({ col: "jobLevel", dir: "desc" });
// F62（负责人 2026-10-09 定的公司晋升门槛）：① 有下一职级；② 过去 12 个月绩效无 C / D；③ 近 2 期任一期 ≥ B+；
// ④ 现职级任职满 12 个月；⑤ 近 12 个月无违纪记录（所有严重度）。司龄与必修课程两条默认停用（值 0 / false），HR 仍可在条件里加回。
const PROMO_DEFAULTS = Object.freeze({
  // No `ladder` here: the next level comes from the job-grade catalogue (jobGrades → next rank in the same track).
  minRating: "B+",             // any of the last `minRatingPeriods` ratings must be at least this ('' = skip)
  minRatingPeriods: 2,         // how many recent ratings the minRating rule looks at (1 = latest only)
  windowMinRating: "B",        // every rating in the last `windowMonths` months must be at least this ('' = skip)
  windowMonths: 12,            // look-back window of the windowMinRating rule (0 = skip)
  minLevelTenureMonths: 12,    // full calendar months in the current job level (0 = skip)
  minTenureMonths: 0,          // full calendar months since hireDate (0 = skip)
  requireTrainings: false,     // every assigned REQUIRED course completed (electives and self-enrolled excluded)
  noMajorViolationMonths: 12,  // no violation in the last N months (0 = skip)
  violationMajorOnly: false,   // true = only MAJOR violations block
});
// F62 之前的默认（迁移 81 写入的内置筛选；迁移 92 据此判断「从未改过」）
const LEGACY_PROMO_DEFAULTS = Object.freeze({
  minRating: "B+", minRatingPeriods: 1, windowMinRating: "", windowMonths: 0, minLevelTenureMonths: 0,
  minTenureMonths: 12, requireTrainings: true, noMajorViolationMonths: 12, violationMajorOnly: false,
});

// ---------------------------------------------------------------- helpers
const isObj = (x) => !!x && typeof x === "object" && !Array.isArray(x);
const str = (v) => (v === null || v === undefined ? "" : String(v));
const norm = (v) => str(v).trim().toLowerCase();
function utf8Len(s) {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1; else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff) { n += 4; i++; } else n += 3;
  }
  return n;
}
function validDay(s) {
  if (!DAY_RE.test(str(s))) return false;
  const d = new Date(s + "T00:00:00Z");
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}
// options / options_zh 两个平行数组 → [{value,label,label_zh}]（options_zh 缺或短时按值补齐，与 server.js optionsZhOf 同口径）
function pairOptions(f) {
  const opts = (f && Array.isArray(f.options)) ? f.options : [];
  const zh = (f && Array.isArray(f.options_zh)) ? f.options_zh : [];
  return opts.map((o, i) => ({ value: String(o), label: String(o), label_zh: zh[i] ? String(zh[i]) : String(o) }));
}
// 输入值 → 规范值：先精确匹配值，再精确匹配中英文名，最后不分大小写；都不匹配 → null
function canonOpt(options, v) {
  const s = str(v).trim();
  if (!s) return null;
  for (const o of options) if (o.value === s) return o.value;
  for (const o of options) if (o.label_zh === s || o.label === s) return o.value;
  const n = s.toLowerCase();
  for (const o of options) if (o.value.toLowerCase() === n || norm(o.label) === n || norm(o.label_zh) === n) return o.value;
  return null;
}
// 岗位名比较键：去掉空白与各种连字符、不分大小写、全角转半角（继任岗位去重、导入归并、succession 条件共用）
function positionKey(s) {
  return str(s).normalize("NFKC").toLowerCase().replace(/[\s\-‐-―−]+/g, "");
}
function typeOf(recordTypes, key) { return (recordTypes || []).find((t) => t && t.key === key) || null; }
function fieldOf(type, key) { return type && Array.isArray(type.fields) ? type.fields.find((f) => f && f.key === key) || null : null; }

// ---------------------------------------------------------------- catalog
function buildCatalog(ctx) {
  ctx = ctx || {};
  const mods = ctx.modules || {};
  const on = (m) => m === "core" || !!mods[m];
  const ranks = (Array.isArray(ctx.ranks) ? ctx.ranks : []).filter((r) => r && str(r.rank).trim())
    .map((r) => ({ rank: str(r.rank).trim(), grade: r.grade == null ? null : String(r.grade), level: Number(r.level) || 0, track: r.track == null ? null : String(r.track) }));
  const recordTypes = Array.isArray(ctx.recordTypes) ? ctx.recordTypes : [];
  const ratingField = fieldOf(typeOf(recordTypes, "performance"), "rating");
  const ratingOpts = pairOptions(ratingField);
  const awardField = fieldOf(typeOf(recordTypes, "award"), "awardName");
  const sevField = fieldOf(typeOf(recordTypes, "violation"), "severity");
  const sevOpts = pairOptions(sevField);
  // 职级：职级体系按通道、等级从高到低；体系之外但在用的值附在后面
  const known = new Set(ranks.map((r) => r.rank));
  const levelOpts = ranks.slice().sort((a, b) => str(a.track).localeCompare(str(b.track)) || (b.level - a.level) || a.rank.localeCompare(b.rank))
    .map((r) => ({ value: r.rank, label: r.rank, label_zh: r.rank, track: r.track, level: r.level, grade: r.grade }));
  for (const v of [...new Set((ctx.jobLevelsInUse || []).map((x) => str(x).trim()).filter((x) => x && !known.has(x)))].sort())
    levelOpts.push({ value: v, label: v, label_zh: v, track: null, level: null, grade: null, outside: true });
  const grades = [...new Set(ranks.map((r) => r.grade).filter((g) => g !== null && g !== ""))].sort();
  const gradeOpts = grades.map((g) => opt(g, g, g)).concat([opt("__nogrid", "不在职级体系内", "Not in the job-grade catalog"), opt("__none", "未设置职级", "No job level")]);
  const awardOpts = (() => {
    const base = pairOptions(awardField);
    const seen = new Set(base.map((o) => o.value));
    for (const n of ctx.awardNames || []) { const s = str(n).trim(); if (s && !seen.has(s) && !canonOpt(base, s)) { seen.add(s); base.push(opt(s, s, s)); } }
    return base;
  })();
  const fields = [];
  for (const d of FIELD_DEFS) {
    const f = {
      id: d.id, group: d.group, group_label: GROUPS[d.group].label, group_label_zh: GROUPS[d.group].label_zh,
      label: d.label, label_zh: d.label_zh,
      ops: d.ops.map((op) => ({ op, ...OPS[op] })),
      valueKind: d.valueKind, module: d.modules[0], modules: d.modules.slice(),
      available: d.modules.every(on),
    };
    if (!f.available) f.reason = "module_off";
    if (d.range) f.range = d.range.slice();
    if (d.int) f.int = true;
    if (PARAMS[d.id]) f.params = PARAMS[d.id];
    switch (d.id) {
      case "dept": f.options = (ctx.deptOptions || []).map((o) => ({ value: o.id, label: o.path || o.name, label_zh: o.path || o.name, parentId: o.parentId || null, level: o.level == null ? null : o.level })); f.options.push(opt("__none", "无部门", "No department")); break;
      case "empStatus": f.options = EMP_STATUS_OPTIONS; break;
      case "jobLevel": f.options = levelOpts; break;
      case "jobGrade": f.options = gradeOpts; break;
      case "jobTrack": f.options = TRACK_OPTIONS; break;
      case "perfRecent": f.options = ratingOpts; break;
      case "potential": f.options = POTENTIAL_OPTIONS; break;
      case "nineBox": f.options = NINEBOX_OPTIONS; break;
      case "talentTag": f.options = [...new Set((ctx.talentTags || []).map((t) => str(t).trim()).filter(Boolean))].sort().map((t) => opt(t, t, t)); break;
      case "trainingProgram": f.options = (ctx.programs || []).map((p) => ({ value: str(p.id), label: str(p.title || p.id), label_zh: str(p.title_zh || p.title || p.id) })); break;
      case "award": f.awardOptions = awardOpts; break;
      case "violation": f.severityOptions = sevOpts; break;
      case "succession": f.positionOptions = [...new Set((ctx.successionPositions || []).map((p) => str(p).trim()).filter(Boolean))].sort(); break;
      case "record": f.recordTypes = recordTypes.map((t) => ({
        key: t.key, label: str(t.label || t.key), label_zh: str(t.label_zh || t.label || t.key), moduleOff: !!t.moduleOff,
        fields: (t.fields || []).filter((x) => x && x.input !== "checkbox").map((x) => ({ key: x.key, label: str(x.label || x.key), label_zh: str(x.label_zh || x.label || x.key), input: x.input || "text", filterable: !!x.filterable, options: pairOptions(x) })),
      })); break;
      default: break;
    }
    fields.push(f);
  }
  for (const cf of ctx.customFields || []) {
    if (!cf || !cf.key) continue;
    const input = CUSTOM_OPS[cf.input] ? cf.input : "text";
    const f = {
      id: "custom:" + cf.key, group: "custom", group_label: GROUPS.custom.label, group_label_zh: GROUPS.custom.label_zh,
      label: str(cf.label || cf.key), label_zh: str(cf.label_zh || cf.label || cf.key),
      ops: CUSTOM_OPS[input].map((op) => ({ op, ...OPS[op] })),
      valueKind: input === "number" ? "number" : input === "date" ? "date" : (input === "select" || input === "suggest") ? "options" : input === "level" ? "jobLevel" : input === "checkbox" ? "none" : "text",
      input, module: "core", modules: ["core"], available: true,
    };
    if (input === "select" || input === "suggest") f.options = pairOptions(cf);
    if (input === "level") f.options = levelOpts;
    if (input === "number") f.range = [-1e12, 1e12];
    fields.push(f);
  }
  const columns = COLUMN_DEFS.map((c) => ({ id: c.id, label: c.label, label_zh: c.label_zh, modules: c.modules.slice(), available: c.modules.every(on) }));
  for (const cf of ctx.customFields || []) if (cf && cf.key) columns.push({ id: "custom:" + cf.key, label: str(cf.label || cf.key), label_zh: str(cf.label_zh || cf.label || cf.key), modules: ["core"], available: true, input: cf.input || "text", options: pairOptions(cf) });
  return {
    v: FILTER_VERSION, fields, columns, defaultColumns: DEFAULT_COLUMNS.slice(), ranks,
    ratingOptions: ratingOpts.map((o) => o.value), ratingOptions_zh: ratingOpts.map((o) => o.label_zh),
  };
}

const IX_CACHE = new WeakMap();
function indexCatalog(catalog) {
  if (!catalog || typeof catalog !== "object") catalog = { fields: [], columns: [], ranks: [], ratingOptions: [] };
  let ix = IX_CACHE.get(catalog);
  if (ix) return ix;
  const fields = new Map((catalog.fields || []).map((f) => [f.id, f]));
  const rec = fields.get("record");
  ix = {
    fields,
    columns: new Map((catalog.columns || []).map((c) => [c.id, c])),
    recordTypes: new Map(((rec && rec.recordTypes) || []).map((t) => [t.key, t])),
    ratingOptions: catalog.ratingOptions || [],
    ratingIndex: new Map((catalog.ratingOptions || []).map((v, i) => [v, i])),
  };
  IX_CACHE.set(catalog, ix);
  return ix;
}

function valueShapeOf(field, op) {
  if (NO_VALUE_OPS.has(op)) return "none";
  if (LIST_OPS.has(op)) return "list";
  if (op === "between") return field && field.valueKind === "jobLevel" ? "rankRange" : field && field.valueKind === "date" ? "dateRange" : "numRange";
  if (op === "atLeast" || op === "atMost") return "one";
  if (op === "gte" || op === "lte" || op === "countAtLeast" || op === "withinMonths") return "number";
  if (op === "onOrAfter" || op === "onOrBefore") return "date";
  return "text"; // contains / equals
}
const REF_KINDS = new Set(["dept", "user", "program"]);

// ---------------------------------------------------------------- validate / normalize
function validateFilter(raw, catalog, opts) {
  opts = opts || {};
  const errors = [], warnings = [];
  const ix = indexCatalog(catalog);
  const err = (path, code) => errors.push({ path, code });
  const fail = (code) => ({ ok: false, errors: [{ path: "", code }], warnings: [], filter: null, normalized: null });
  if (!isObj(raw)) return fail("not_object");
  let size;
  try { size = utf8Len(JSON.stringify(raw)); } catch { return fail("not_object"); }
  if (size > LIMITS.bytes) return fail("too_large");
  for (const k of Object.keys(raw)) if (!["v", "logic", "items", "includeExited"].includes(k)) err(k, "not_object");
  if (raw.v !== FILTER_VERSION) err("v", "bad_version");
  if (raw.logic !== "and" && raw.logic !== "or") err("logic", "bad_logic");
  if (raw.includeExited !== undefined && typeof raw.includeExited !== "boolean") err("includeExited", "bad_value");
  if (!Array.isArray(raw.items)) { err("items", "not_object"); return { ok: false, errors, warnings, filter: null, normalized: null }; }
  if (raw.items.length > LIMITS.rootItems) err("items", "too_many_items");
  let leaves = 0;
  const items = [];
  const st = { ix, opts, err, warn: (path, id, code) => warnings.push({ path, id: id || null, code }) };
  raw.items.forEach((it, i) => {
    const p = `items.${i}`;
    if (isObj(it) && it.items !== undefined) {
      for (const k of Object.keys(it)) if (!["logic", "items"].includes(k)) err(`${p}.${k}`, "not_object");
      if (it.logic !== "and" && it.logic !== "or") err(`${p}.logic`, "bad_logic");
      if (!Array.isArray(it.items)) { err(`${p}.items`, "not_object"); return; }
      if (!it.items.length) { err(`${p}.items`, "bad_value"); return; }
      if (it.items.length > LIMITS.groupItems) err(`${p}.items`, "too_many_items");
      const kids = [];
      it.items.forEach((leaf, j) => {
        const q = `${p}.items.${j}`;
        if (isObj(leaf) && leaf.items !== undefined) { err(q, "too_deep"); return; }
        leaves++;
        const n = checkLeaf(leaf, q, st);
        if (n) kids.push(n);
      });
      if (kids.length) items.push({ logic: it.logic === "or" ? "or" : "and", items: kids });
    } else {
      leaves++;
      const n = checkLeaf(it, p, st);
      if (n) items.push(n);
    }
  });
  if (leaves > LIMITS.leaves) err("items", "too_many_leaves");
  const normalized = { v: FILTER_VERSION, logic: raw.logic === "or" ? "or" : "and", items, includeExited: raw.includeExited === true };
  assignIds(normalized);
  return { ok: errors.length === 0, errors, warnings, filter: errors.length ? null : normalized, normalized };
}

function normalizeFilter(raw, catalog, opts) {
  const r = validateFilter(raw, catalog, opts);
  return r.normalized;
}

function assignIds(def) {
  const used = new Set();
  const all = [];
  walkLeaves(def, (leaf) => all.push(leaf));
  for (const leaf of all) {
    if (typeof leaf.id === "string" && ID_RE.test(leaf.id) && !used.has(leaf.id)) used.add(leaf.id);
    else leaf.id = null;
  }
  let n = 1;
  for (const leaf of all) {
    if (leaf.id) continue;
    while (used.has("c" + n.toString(36))) n++;
    leaf.id = "c" + n.toString(36);
    used.add(leaf.id);
  }
  // 统一键序（重复归一结果逐字相同）
  const order = (l) => {
    const o = { id: l.id, field: l.field, op: l.op };
    if (l.value !== undefined) o.value = l.value;
    if (l.params !== undefined) o.params = l.params;
    if (l.tag !== undefined) o.tag = l.tag;
    return o;
  };
  def.items = def.items.map((it) => (it.items ? { logic: it.logic, items: it.items.map(order) } : order(it)));
}

function walkLeaves(def, fn) {
  if (!def || !Array.isArray(def.items)) return;
  def.items.forEach((it, i) => {
    if (it && Array.isArray(it.items)) it.items.forEach((leaf) => fn(leaf, i));
    else if (it) fn(it, null);
  });
}

function checkLeaf(raw, path, st) {
  const { ix, opts, err, warn } = st;
  if (!isObj(raw)) { err(path, "not_object"); return null; }
  let bad = false;
  const e = (p, code) => { err(p, code); bad = true; };
  for (const k of Object.keys(raw)) if (!["id", "field", "op", "value", "params", "tag"].includes(k)) e(`${path}.${k}`, "bad_params");
  if (raw.id !== undefined && raw.id !== null && (typeof raw.id !== "string" || !ID_RE.test(raw.id))) e(`${path}.id`, "bad_value");
  if (raw.tag !== undefined && !TAGS.includes(raw.tag)) e(`${path}.tag`, "bad_value");
  const fieldId = raw.field;
  if (typeof fieldId !== "string" || !fieldId || fieldId.length > 64) { err(`${path}.field`, "unknown_field"); return null; }
  const def = ix.fields.get(fieldId);
  if (!def && Object.prototype.hasOwnProperty.call(RETIRED_FIELDS, fieldId)) {
    // 已停用字段（F61）：不报错，原样保留（截短），警告 field_retired，引擎判为忽略
    warn(path, typeof raw.id === "string" ? raw.id : null, "field_retired");
    const keep = { id: typeof raw.id === "string" && ID_RE.test(raw.id) ? raw.id : null, field: fieldId, op: str(raw.op).slice(0, 32) };
    if (raw.value !== undefined) keep.value = raw.value;
    return keep;
  }
  if (!def) {
    if (fieldId.startsWith("custom:")) {
      if (opts.lenient) {
        // 已删除的自定义字段：保留原样（截短），引擎判为忽略
        warn(path, typeof raw.id === "string" ? raw.id : null, "field_removed");
        const keep = { id: typeof raw.id === "string" && ID_RE.test(raw.id) ? raw.id : null, field: fieldId, op: str(raw.op).slice(0, 32) };
        if (raw.value !== undefined) keep.value = raw.value;
        return keep;
      }
      err(`${path}.field`, "custom_field_unknown");
      return null;
    }
    err(`${path}.field`, "unknown_field");
    return null;
  }
  const op = raw.op;
  if (typeof op !== "string" || !def.ops.some((o) => o.op === op)) { err(`${path}.op`, "bad_op"); return null; }
  const out = { id: typeof raw.id === "string" && ID_RE.test(raw.id) ? raw.id : null, field: fieldId, op };
  // ---- value
  const shape = valueShapeOf(def, op);
  const vp = `${path}.value`;
  const v = raw.value;
  const options = fieldId === "perfRecent" ? (def.options || []) : def.options;
  const strictOptions = def.valueKind === "options" || def.valueKind === "rating" || (def.input === "select");
  const freeOptions = def.input === "suggest" || def.valueKind === "jobLevel";
  const checkString = (s, p) => {
    if (typeof s !== "string" && typeof s !== "number") { e(p, "bad_value"); return null; }
    const t = String(s).trim();
    if (!t) { e(p, "bad_value"); return null; }
    if (t.length > LIMITS.string) { e(p, "string_too_long"); return null; }
    return t;
  };
  const checkNumber = (n, p) => {
    const x = typeof n === "string" && n.trim() !== "" ? Number(n) : n;
    if (typeof x !== "number" || !Number.isFinite(x)) { e(p, "bad_value"); return null; }
    if (def.int && !Number.isInteger(x)) { e(p, "bad_value"); return null; }
    const range = op === "withinMonths" ? [1, 120] : def.range;
    if (range && (x < range[0] || x > range[1])) { e(p, "value_out_of_range"); return null; }
    return x;
  };
  switch (shape) {
    case "none": break; // 不带值的运算符：传进来的值丢弃
    case "list": {
      if (!Array.isArray(v)) { e(vp, "bad_value"); break; }
      if (v.length > LIMITS.values) { e(vp, "too_many_values"); break; }
      const vals = [];
      v.forEach((x, i) => {
        const s = checkString(x, `${vp}.${i}`);
        if (s === null) return;
        if (strictOptions && options && options.length) {
          const c = canonOpt(options, s);
          if (c === null) { e(`${vp}.${i}`, "value_not_in_options"); return; }
          vals.push(c);
        } else if (freeOptions && options && options.length) {
          const c = canonOpt(options, s);
          vals.push(c === null ? s : c);
        } else vals.push(s);
      });
      const uniq = [...new Set(vals)];
      if (!uniq.length && !REF_KINDS.has(def.valueKind) && !bad) e(vp, "bad_value");
      out.value = uniq;
      break;
    }
    case "one": {
      const s = checkString(Array.isArray(v) && v.length === 1 ? v[0] : v, vp);
      if (s === null) break;
      const c = canonOpt(options || [], s);
      if (c === null) { e(vp, "value_not_in_options"); break; }
      out.value = c;
      break;
    }
    case "number": {
      const n = checkNumber(v, vp);
      if (n !== null) out.value = n;
      break;
    }
    case "numRange": case "rankRange": case "dateRange": {
      if (!isObj(v)) { e(vp, "bad_value"); break; }
      if (shape === "numRange") {
        const a = checkNumber(v.from, `${vp}.from`), b = checkNumber(v.to, `${vp}.to`);
        if (a === null || b === null) break;
        if (a > b) { e(vp, "bad_value"); break; }
        out.value = { from: a, to: b };
      } else if (shape === "dateRange") {
        if (!validDay(v.from) || !validDay(v.to) || v.from > v.to) { e(vp, "bad_value"); break; }
        out.value = { from: v.from, to: v.to };
      } else {
        const a = checkString(v.from, `${vp}.from`), b = checkString(v.to, `${vp}.to`);
        if (a === null || b === null) break;
        out.value = { from: a, to: b };
      }
      break;
    }
    case "date": {
      if (!validDay(v)) { e(vp, "bad_value"); break; }
      out.value = v;
      break;
    }
    default: { // text
      const s = checkString(v, vp);
      if (s !== null) out.value = s;
    }
  }
  // ---- params
  const pp = `${path}.params`;
  const spec = PARAMS[fieldId];
  const P = raw.params;
  if (P !== undefined && P !== null && !isObj(P)) { e(pp, "bad_params"); return bad ? null : out; }
  if (!spec) {
    if (P && Object.keys(P).length) e(pp, "bad_params");
  } else {
    const src = P || {};
    for (const k of Object.keys(src)) if (!spec[k]) e(`${pp}.${k}`, "bad_params");
    const params = {};
    for (const [k, s] of Object.entries(spec)) {
      let x = src[k];
      if (s.when && Object.entries(s.when).some(([wk, wv]) => (src[wk] === undefined ? spec[wk].default : src[wk]) !== wv)) continue;
      if (x === undefined || x === null) {
        if (s.required) { e(`${pp}.${k}`, "bad_params"); continue; }
        if (s.when) { e(`${pp}.${k}`, "bad_params"); continue; }
        x = s.default;
        if (s.type === "string" && !x) continue; // 可选字符串为空时不写
        params[k] = Array.isArray(x) ? x.slice() : isObj(x) ? { ...x } : x;
        continue;
      }
      if (s.type === "int") {
        const n = typeof x === "string" && x.trim() !== "" ? Number(x) : x;
        if (!Number.isInteger(n) || n < s.min || n > s.max) { e(`${pp}.${k}`, "bad_params"); continue; }
        params[k] = n;
      } else if (s.type === "enum") {
        if (!s.values.includes(x)) { e(`${pp}.${k}`, "bad_params"); continue; }
        params[k] = x;
      } else if (s.type === "bool") {
        if (typeof x !== "boolean") { e(`${pp}.${k}`, "bad_params"); continue; }
        params[k] = x;
      } else if (s.type === "string") {
        if (typeof x !== "string") { e(`${pp}.${k}`, "bad_params"); continue; }
        const t = x.trim();
        if (t.length > (s.max || LIMITS.string)) { e(`${pp}.${k}`, "string_too_long"); continue; }
        if (t) params[k] = t;
      } else if (s.type === "list") {
        if (!Array.isArray(x) || x.length > s.max) { e(`${pp}.${k}`, Array.isArray(x) ? "too_many_values" : "bad_params"); continue; }
        const list = [];
        for (let i = 0; i < x.length; i++) {
          const t = typeof x[i] === "string" ? x[i].trim() : "";
          if (!t) { e(`${pp}.${k}.${i}`, "bad_params"); continue; }
          if (t.length > LIMITS.string) { e(`${pp}.${k}.${i}`, "string_too_long"); continue; }
          if (fieldId === "violation" && k === "severity" && def.severityOptions && def.severityOptions.length) {
            const c = canonOpt(def.severityOptions, t);
            if (c === null) { e(`${pp}.${k}.${i}`, "value_not_in_options"); continue; }
            list.push(c);
          } else if (fieldId === "award" && k === "names" && def.awardOptions) {
            const c = canonOpt(def.awardOptions, t);
            list.push(c === null ? t : c);
          } else list.push(t);
        }
        params[k] = [...new Set(list)];
      } else if (s.type === "object") {
        if (!isObj(x)) { e(`${pp}.${k}`, "bad_params"); continue; }
        params[k] = x; // record.fields 在下面按类型细查
      }
    }
    if (fieldId === "perfRecent" && params.mode === "atLeastK" && Number.isInteger(params.k) && Number.isInteger(params.n) && params.k > params.n) e(`${pp}.k`, "bad_params");
    if (fieldId === "record" && typeof params.type === "string") {
      const t = ix.recordTypes.get(params.type);
      if (!t) e(`${pp}.type`, "record_type_unknown");
      else {
        if (t.moduleOff) {
          if (opts.lenient) warn(path, out.id, "module_off");
          else e(`${pp}.type`, "record_type_unavailable");
        }
        const fv = {};
        for (const [fk, fval] of Object.entries(params.fields || {})) {
          const fdef = (t.fields || []).find((x) => x.key === fk);
          if (!fdef) { e(`${pp}.fields.${fk}`, "bad_params"); continue; }
          if (fval === null || fval === undefined || (typeof fval !== "string" && typeof fval !== "number" && typeof fval !== "boolean")) { e(`${pp}.fields.${fk}`, "bad_value"); continue; }
          const s = String(fval).trim();
          if (!s) { e(`${pp}.fields.${fk}`, "bad_value"); continue; }
          if (s.length > LIMITS.string) { e(`${pp}.fields.${fk}`, "string_too_long"); continue; }
          if (fdef.options && fdef.options.length) {
            const c = canonOpt(fdef.options, s);
            if (c === null && fdef.input === "select") { e(`${pp}.fields.${fk}`, "value_not_in_options"); continue; }
            fv[fk] = c === null ? s : c;
          } else fv[fk] = s;
        }
        params.fields = fv;
      }
    } else if (fieldId === "record" && params.type !== undefined) e(`${pp}.type`, "bad_params");
    out.params = params;
  }
  if (raw.tag !== undefined && TAGS.includes(raw.tag)) out.tag = raw.tag;
  return bad ? null : out;
}

function normalizeColumns(cols, catalog) {
  const ix = indexCatalog(catalog);
  const out = [];
  for (const c of Array.isArray(cols) ? cols : []) {
    const id = str(c);
    const d = ix.columns.get(id);
    if (!d || d.available === false || out.includes(id)) continue;
    out.push(id);
    if (out.length >= 30) break;
  }
  return out.length ? out : DEFAULT_COLUMNS.filter((id) => { const d = ix.columns.get(id); return !d || d.available !== false; });
}

// ---------------------------------------------------------------- summary
function optLabel(options, v, zh) {
  const o = (options || []).find((x) => x.value === v);
  if (!o) return String(v).startsWith("name:") ? String(v).slice(5) : String(v);
  return zh ? o.label_zh : o.label;
}
function leafText(leaf, ix, zh) {
  const def = ix.fields.get(leaf.field);
  if (!def && RETIRED_FIELDS[leaf.field]) return zh ? `（已停用的条件：${RETIRED_FIELDS[leaf.field].label_zh}）` : `(retired condition: ${RETIRED_FIELDS[leaf.field].label})`;
  if (!def) return zh ? `（已删除的字段 ${leaf.field.replace(/^custom:/, "")}）` : `(removed field ${leaf.field.replace(/^custom:/, "")})`;
  const name = zh ? def.label_zh : def.label;
  const opName = OPS[leaf.op] ? (zh ? OPS[leaf.op].label_zh : OPS[leaf.op].label) : leaf.op;
  const p = leaf.params || {};
  const list = (vals) => (vals || []).map((v) => optLabel(def.options, v, zh)).join(zh ? "、" : ", ");
  const sep = zh ? "" : " ";
  switch (leaf.field) {
    case "perfRecent": {
      const n = p.n || 1;
      const kind = p.periodKind && p.periodKind !== "any" ? (zh ? { quarter: "季度", half: "半年度", annual: "年度" }[p.periodKind] : { quarter: "quarterly", half: "half-year", annual: "annual" }[p.periodKind] + " ") : "";
      const win = Number(p.withinMonths) || 0;
      if (win > 0 && leaf.op !== "noRecord") {
        // F62 时间窗：窗内全部记录
        const how = p.mode === "any" ? (zh ? "任一期" : "any") : p.mode === "atLeastK" ? (zh ? `至少 ${p.k} 期` : `at least ${p.k}`) : (zh ? "各期均" : "all");
        if (leaf.op === "in") return zh ? `近 ${win} 个月内${kind}绩效${how}属于 ${list(leaf.value)}` : `${kind ? kind + " ratings" : "Ratings"} in the last ${win} months (${how}) are any of ${list(leaf.value)}`;
        const noneOk = p.missing === "ignore" ? (zh ? "（无评级视为满足）" : " (no rating counts as met)") : "";
        return (zh ? `近 ${win} 个月内${kind}绩效${how}${opName} ${optLabel(def.options, leaf.value, zh)}` : `${kind ? kind + " ratings" : "Ratings"} in the last ${win} months (${how}) ${opName} ${optLabel(def.options, leaf.value, zh)}`) + noneOk;
      }
      const scope = zh
        ? (n === 1 ? `最近一期${kind}绩效` : `近 ${n} 期${kind}绩效` + (p.mode === "any" ? "任一期" : p.mode === "atLeastK" ? `至少 ${p.k} 期` : "均"))
        : (n === 1 ? `Latest ${kind}rating` : `Last ${n} ${kind}ratings` + (p.mode === "any" ? " (any)" : p.mode === "atLeastK" ? ` (at least ${p.k})` : " (all)"));
      if (leaf.op === "noRecord") return zh ? `无${kind}绩效评级记录` : `No ${kind}rating on file`;
      if (leaf.op === "in") return `${scope}${sep}${zh ? "属于" : "is any of"} ${list(leaf.value)}`;
      return `${scope}${sep}${opName} ${optLabel(def.options, leaf.value, zh)}`;
    }
    case "tenureMonths":
      if (leaf.op === "between") return zh ? `司龄 ${leaf.value.from}–${leaf.value.to} 个月` : `Tenure ${leaf.value.from}–${leaf.value.to} months`;
      return zh ? `司龄${opName} ${leaf.value} 个月` : `Tenure ${opName} ${leaf.value} months`;
    case "levelTenureMonths":
      if (leaf.op === "between") return zh ? `现职级任职 ${leaf.value.from}–${leaf.value.to} 个月` : `Time in current level ${leaf.value.from}–${leaf.value.to} months`;
      return zh ? `现职级任职${opName} ${leaf.value} 个月` : `Time in current level ${opName} ${leaf.value} months`;
    case "jobLevel":
      if (leaf.op === "between") return `${name} ${leaf.value.from}–${leaf.value.to}`;
      return `${name}${sep}${opName} ${list(leaf.value)}`;
    case "trainingMandatoryDone":
      return leaf.op === "isTrue" ? name : (zh ? "必修课程未全部完成" : "Required courses not all completed");
    case "nextLevelExists":
      return leaf.op === "isTrue" ? name : (zh ? "没有下一职级" : "No next job level");
    case "trainingCompletion":
      return `${name}${p.scope === "all" ? (zh ? "（全部指派）" : " (all assigned)") : (zh ? "（仅必修）" : " (required only)")}${sep}${opName} ${leaf.value}%`;
    case "violation": case "award": {
      const win = p.months ? (zh ? `近 ${p.months} 个月` : ` in the last ${p.months} months`) : "";
      const sev = leaf.field === "violation" && p.severity && p.severity.length ? (zh ? `（${p.severity.map((s) => optLabel(def.severityOptions, s, true)).join("、")}）` : ` (${p.severity.join(", ")})`) : "";
      const names = leaf.field === "award" && p.names && p.names.length ? (zh ? `（${p.names.map((s) => optLabel(def.awardOptions, s, true)).join("、")}）` : ` (${p.names.join(", ")})`) : "";
      if (zh) return leaf.op === "none" ? `${win}无${name}${sev}${names}` : `${win}${name}${sev}${names}不少于 ${leaf.value} 次`;
      return leaf.op === "none" ? `No ${name.toLowerCase()}${sev}${names}${win}` : `${name}${sev}${names}${win}: at least ${leaf.value}`;
    }
    case "record": {
      const t = ix.recordTypes.get(p.type);
      const tn = t ? (zh ? t.label_zh : t.label) : p.type;
      const win = p.months ? (zh ? `近 ${p.months} 个月` : ` in the last ${p.months} months`) : "";
      const fl = Object.entries(p.fields || {}).map(([k, v]) => {
        const fd = t && (t.fields || []).find((x) => x.key === k);
        return `${fd ? (zh ? fd.label_zh : fd.label) : k}=${fd ? optLabel(fd.options, v, zh) : v}`;
      }).join(zh ? "，" : ", ");
      const what = `${tn}${fl ? (zh ? `（${fl}）` : ` (${fl})`) : ""}`;
      if (zh) return leaf.op === "exists" ? `${win}有${what}记录` : leaf.op === "notExists" ? `${win}没有${what}记录` : `${win}${what}记录不少于 ${leaf.value} 条`;
      return leaf.op === "exists" ? `Has ${what} records${win}` : leaf.op === "notExists" ? `No ${what} records${win}` : `${what} records${win}: at least ${leaf.value}`;
    }
    case "succession": {
      const pos = p.position ? (zh ? `「${p.position}」` : ` "${p.position}"`) : "";
      return zh ? `${opName}${pos}继任名单` : `${opName} on the${pos} succession plan`;
    }
    case "potential":
      return `${name}${sep}${opName} ${list(leaf.value)}${p.freshOnly ? (zh ? "（12 个月内评定）" : " (assessed within 12 months)") : ""}`;
    default:
      break;
  }
  const shape = valueShapeOf(def, leaf.op);
  if (shape === "none") return `${name}${sep}${opName}`;
  if (shape === "list") return `${name}${sep}${opName} ${list(leaf.value)}`;
  if (shape === "numRange" || shape === "dateRange" || shape === "rankRange") return `${name}${sep}${opName} ${leaf.value.from}–${leaf.value.to}`;
  if (shape === "one") return `${name}${sep}${opName} ${optLabel(def.options, leaf.value, zh)}`;
  return `${name}${sep}${opName} ${leaf.value}`;
}
function summarize(filter, catalog, lang) {
  const zh = lang !== "en";
  const ix = indexCatalog(catalog);
  const items = (filter && filter.items) || [];
  const exited = filter && filter.includeExited ? (zh ? "（含已离职）" : " (incl. exited)") : "";
  if (!items.length) return (zh ? "全部人员（未设条件）" : "Everyone (no conditions)") + exited;
  const head = (logic) => (logic === "or" ? (zh ? "满足任一：" : "Any of: ") : (zh ? "满足全部：" : "All of: "));
  const parts = items.map((it) => {
    if (it && Array.isArray(it.items)) return (zh ? "（" : "(") + head(it.logic) + it.items.map((l) => leafText(l, ix, zh)).join(zh ? "；" : "; ") + (zh ? "）" : ")");
    return leafText(it, ix, zh);
  });
  return head(filter.logic) + parts.join(" · ") + exited;
}

// ---------------------------------------------------------------- scope redaction
function redactForViewer(def, allowDeptId, opts) {
  const copy = JSON.parse(JSON.stringify(def || { v: 1, logic: "and", items: [] }));
  let redacted = 0;
  const allowUser = opts && typeof opts.allowUserId === "function" ? opts.allowUserId : null;
  walkLeaves(copy, (leaf) => {
    if (leaf.field === "dept" && Array.isArray(leaf.value)) {
      const keep = leaf.value.filter((id) => {
        const s = str(id);
        if (s === "__none") return true;
        if (s.startsWith("name:")) return false; // 伪 id 自带部门名，受限管理员一律看不到
        return typeof allowDeptId === "function" ? !!allowDeptId(s) : false;
      });
      redacted += leaf.value.length - keep.length;
      leaf.value = keep;
    } else if (leaf.field === "manager" && allowUser && Array.isArray(leaf.value)) {
      const keep = leaf.value.filter((id) => !!allowUser(str(id)));
      redacted += leaf.value.length - keep.length;
      leaf.value = keep;
    }
  });
  return { definition: copy, redactedValues: redacted };
}

// ---------------------------------------------------------------- promotion
const promoInt = (v, max) => Math.max(0, Math.min(max, Math.floor(Number(v) || 0)));
function mergedPromo(cfg) {
  const c = { ...PROMO_DEFAULTS, ...(isObj(cfg) ? cfg : {}) };
  return {
    minRating: str(c.minRating).trim(),
    minRatingPeriods: Math.max(1, Math.min(8, Math.floor(Number(c.minRatingPeriods) || 1))),
    windowMinRating: str(c.windowMinRating).trim(),
    windowMonths: promoInt(c.windowMonths, 120),
    minLevelTenureMonths: promoInt(c.minLevelTenureMonths, 240),
    minTenureMonths: promoInt(c.minTenureMonths, 240),
    requireTrainings: !!c.requireTrainings,
    noMajorViolationMonths: promoInt(c.noMajorViolationMonths, 120),
    violationMajorOnly: !!c.violationMajorOnly,
  };
}
// 叶子顺序 = 负责人的条件编号（F62）：① 有下一职级 ② 过去 N 个月无低于 X ③ 近 N 期任一期 ≥ Y ④ 现职级任职 ⑤ 司龄（停用）⑥ 必修（停用）⑦ 违纪
const PROMO_TAG_ORDER = Object.freeze(["nextLevel", "ratingWindow", "rating", "levelTenure", "tenure", "trainings", "violations"]);
const PROMO_LEAF = {
  nextLevel: () => ({ id: "cnl", field: "nextLevelExists", op: "isTrue", tag: "nextLevel" }),
  // 近 N 期：N = 1 时看最近一期（旧口径）；N > 1 时任一期满足即可，但必须有 N 期可比（负责人 10/9 定：只有 1 期评级的不通过，missing: fail）
  rating: (c) => ({ id: "crt", field: "perfRecent", op: "atLeast", value: c.minRating,
    params: c.minRatingPeriods > 1 ? { n: c.minRatingPeriods, mode: "any", periodKind: "any", missing: "fail", withinMonths: 0 } : { n: 1, mode: "all", periodKind: "any", missing: "fail", withinMonths: 0 }, tag: "rating" }),
  // 过去 N 个月的每一期都不低于 X；窗内没有评级 → 不通过（负责人 10/9 定：可能是新入职，没有评级不能视为达标，missing: fail）
  ratingWindow: (c) => ({ id: "crw", field: "perfRecent", op: "atLeast", value: c.windowMinRating, params: { n: 1, mode: "all", periodKind: "any", missing: "fail", withinMonths: c.windowMonths }, tag: "ratingWindow" }),
  levelTenure: (c) => ({ id: "clt", field: "levelTenureMonths", op: "gte", value: c.minLevelTenureMonths, tag: "levelTenure" }),
  tenure: (c) => ({ id: "cte", field: "tenureMonths", op: "gte", value: c.minTenureMonths, tag: "tenure" }),
  trainings: () => ({ id: "ctr", field: "trainingMandatoryDone", op: "isTrue", tag: "trainings" }),
  violations: (c) => ({ id: "cvi", field: "violation", op: "none", params: { months: c.noMajorViolationMonths, severity: c.violationMajorOnly ? ["Major"] : [] }, tag: "violations" }),
};
const ratingKnown = (v, ratingOptions) => !!v && (!Array.isArray(ratingOptions) || !ratingOptions.length || ratingOptions.includes(v));
const promoWants = (c, ratingOptions) => ({
  nextLevel: true,
  ratingWindow: c.windowMonths > 0 && ratingKnown(c.windowMinRating, ratingOptions),
  rating: ratingKnown(c.minRating, ratingOptions),
  levelTenure: c.minLevelTenureMonths > 0,
  tenure: c.minTenureMonths > 0,
  trainings: c.requireTrainings,
  violations: c.noMajorViolationMonths > 0,
});
function promotionConfigToFilter(cfg, ratingOptions) {
  const c = mergedPromo(cfg);
  const want = promoWants(c, ratingOptions);
  const items = [];
  for (const tag of PROMO_TAG_ORDER) if (want[tag]) items.push(PROMO_LEAF[tag](c));
  return { v: FILTER_VERSION, logic: "and", items, includeExited: false };
}
function promotionFilterRow(cfg, ratingOptions) {
  const c = mergedPromo(cfg);
  const definition = promotionConfigToFilter(c, ratingOptions);
  const row = { builtinKey: "promotion", ...PROMO_NAME, visibility: "shared", definition, columns: PROMO_COLUMNS.slice(), sort: { ...PROMO_SORT } };
  const want = promoWants(c, ratingOptions);
  const dropped = [];
  if (c.minRating && !want.rating) dropped.push("rating");
  if (c.windowMonths > 0 && c.windowMinRating && !want.ratingWindow) dropped.push("ratingWindow");
  if (dropped.length) row.dropped = dropped;
  return row;
}
function findTagged(def, tag) {
  let hit = null;
  walkLeaves(def, (leaf) => { if (!hit && leaf.tag === tag) hit = leaf; });
  return hit;
}
function promotionConfigOf(def) {
  const r = findTagged(def, "rating"), rw = findTagged(def, "ratingWindow"), lt = findTagged(def, "levelTenure"),
    t = findTagged(def, "tenure"), tr = findTagged(def, "trainings"), v = findTagged(def, "violations");
  const sev = v && v.params && Array.isArray(v.params.severity) ? v.params.severity : [];
  return {
    minRating: r && typeof r.value === "string" ? r.value : "",
    minRatingPeriods: r && r.params && Number.isInteger(Number(r.params.n)) && Number(r.params.n) > 0 ? Number(r.params.n) : 1,
    windowMinRating: rw && typeof rw.value === "string" ? rw.value : "",
    windowMonths: rw && rw.params ? Number(rw.params.withinMonths) || 0 : 0,
    minLevelTenureMonths: lt && Number.isFinite(Number(lt.value)) ? Number(lt.value) : 0,
    minTenureMonths: t && Number.isFinite(Number(t.value)) ? Number(t.value) : 0,
    requireTrainings: !!(tr && tr.op === "isTrue"),
    noMajorViolationMonths: v && v.params ? Number(v.params.months) || 0 : 0,
    violationMajorOnly: sev.length === 1 && norm(sev[0]) === "major",
  };
}
// 叶子的比较键（忽略 id；参数按 PARAMS 缺省值补齐，旧库里没有 withinMonths 的叶子与补了 0 的相同）
function promoLeafKey(leaf) {
  const spec = PARAMS[leaf.field] || {};
  const params = {};
  for (const k of Object.keys(spec)) {
    const v = leaf.params && leaf.params[k] !== undefined ? leaf.params[k] : spec[k].default;
    if (v === null || v === undefined || (spec[k].when && !(leaf.params && leaf.params[k] !== undefined))) continue;
    params[k] = v;
  }
  return JSON.stringify({ field: leaf.field, op: leaf.op, value: leaf.value === undefined ? null : leaf.value, params, tag: leaf.tag || null });
}
function samePromotionDefinition(def, ref) {
  if (!def || !Array.isArray(def.items) || !ref || !Array.isArray(ref.items)) return false;
  if (def.items.length !== ref.items.length || !!def.includeExited !== !!ref.includeExited) return false;
  if ((def.logic || "and") !== (ref.logic || "and")) return false;
  for (let i = 0; i < def.items.length; i++) {
    const a = def.items[i], b = ref.items[i];
    if (!a || Array.isArray(a.items) || !b || Array.isArray(b.items)) return false;
    if (promoLeafKey(a) !== promoLeafKey(b)) return false;
  }
  return true;
}
const isLegacyPromotionDefault = (def, ratingOptions) => samePromotionDefinition(def, promotionConfigToFilter(LEGACY_PROMO_DEFAULTS, ratingOptions));
// F62 首版（迁移 92 写入）的默认：两条绩效叶子 missing 为 ignore；负责人 10/9 改口径后由迁移 93 换成 missing fail
function promotionInterimDefault(ratingOptions) {
  const d = promotionConfigToFilter(PROMO_DEFAULTS, ratingOptions);
  for (const l of d.items) if ((l.tag === "rating" || l.tag === "ratingWindow") && l.params) l.params.missing = "ignore";
  return d;
}
const isInterimPromotionDefault = (def, ratingOptions) => samePromotionDefinition(def, promotionInterimDefault(ratingOptions));
const isPromotionDefault = (def, ratingOptions) => samePromotionDefinition(def, promotionConfigToFilter(PROMO_DEFAULTS, ratingOptions));
function applyPromotionConfig(def, patch) {
  const next = JSON.parse(JSON.stringify(def || { v: FILTER_VERSION, logic: "and", items: [], includeExited: false }));
  if (!Array.isArray(next.items)) next.items = [];
  const cur = promotionConfigOf(next);
  const p = isObj(patch) ? patch : {};
  const c = mergedPromo({ ...cur, ...p });
  const want = promoWants(c, null);
  // patch 里明确给的期数 / 时间窗覆盖叶子上 HR 调过的 n / withinMonths；没给的保留（见 merge）
  const explicit = { rating: p.minRatingPeriods !== undefined ? ["n", "mode", "missing"] : [], ratingWindow: p.windowMonths !== undefined ? ["withinMonths"] : [] };
  const set = (tag, leaf) => {
    // 已有带标签的叶子：原位更新（保留 id、HR 调过的参数如近 N 期）；没有：追加到根节点
    for (let i = 0; i < next.items.length; i++) {
      const it = next.items[i];
      if (it && Array.isArray(it.items)) {
        const j = it.items.findIndex((l) => l.tag === tag);
        if (j >= 0) { it.items[j] = merge(it.items[j], leaf); return; }
      } else if (it && it.tag === tag) { next.items[i] = merge(it, leaf); return; }
    }
    next.items.push(leaf);
  };
  const merge = (old, leaf) => {
    const out = { ...old, field: leaf.field, op: leaf.op, tag: leaf.tag };
    if (leaf.value !== undefined) out.value = leaf.value; else delete out.value;
    if (leaf.params) {
      if (leaf.field === "perfRecent") {
        out.params = { ...leaf.params, ...(old.field === "perfRecent" ? old.params : {}) };
        for (const k of explicit[leaf.tag] || []) out.params[k] = leaf.params[k];
      } else out.params = { ...(old.params || {}), ...leaf.params };
    }
    return out;
  };
  const remove = (tag) => {
    next.items = next.items.map((it) => (it && Array.isArray(it.items) ? { ...it, items: it.items.filter((l) => l.tag !== tag) } : it))
      .filter((it) => it && !(it.tag === tag) && !(Array.isArray(it.items) && it.items.length === 0));
  };
  // nextLevel 叶子不在配置里：这里不增不删（HR 在编辑器里删掉它是有意为之）
  for (const tag of PROMO_TAG_ORDER) {
    if (tag === "nextLevel") continue;
    if (want[tag]) set(tag, PROMO_LEAF[tag](c)); else remove(tag);
  }
  // 新追加的叶子若与已有 id 撞号，交给 assignIds 重排（先出现的保留原 id）
  const used = new Set();
  let dup = false;
  walkLeaves(next, (leaf) => { if (used.has(leaf.id)) { leaf.id = null; dup = true; } else used.add(leaf.id); });
  if (dup) assignIds(next);
  return next;
}

// ---------------------------------------------------------------- permissions
function canSeeFilter(f, viewer) {
  if (!f || !viewer) return false;
  if (f.builtinKey) return true;
  if (f.visibility === "shared") return true;
  return !!f.ownerId && f.ownerId === viewer.id;
}
function canEditFilter(f, viewer) {
  if (!canSeeFilter(f, viewer) || !viewer.canWrite) return false;
  if (f.builtinKey) return true;
  if (f.visibility === "shared") return f.ownerId === viewer.id || !!viewer.isSuper;
  return f.ownerId === viewer.id;
}
function canDeleteFilter(f, viewer) {
  return !!f && !f.builtinKey && canEditFilter(f, viewer);
}
function nameConflict(filters, cand, viewer) {
  const n = norm(cand && cand.name), z = norm(cand && cand.name_zh);
  for (const f of filters || []) {
    if (!f || (cand && cand.id && f.id === cand.id)) continue;
    // 同一可见范围：候选筛选对其可见的人能同时看到的那些筛选
    const visibleTogether = cand && cand.visibility === "shared"
      ? (f.builtinKey || f.visibility === "shared" || f.ownerId === (viewer && viewer.id))
      : canSeeFilter(f, viewer);
    if (!visibleTogether) continue;
    if (n && norm(f.name) === n) return "name";
    if (z && norm(f.name_zh) === z) return "name_zh";
  }
  return null;
}

module.exports = {
  FILTER_VERSION, LIMITS, TAGS, ERROR_CODES, WARNING_CODES, OPS, NO_VALUE_OPS, GROUPS, PARAMS,
  FIELD_DEFS, CUSTOM_OPS, COLUMN_DEFS, DEFAULT_COLUMNS, PROMO_COLUMNS, LEGACY_PROMO_COLUMNS, PROMO_DEFAULTS, LEGACY_PROMO_DEFAULTS, PROMO_NAME, PROMO_SORT,
  isLegacyPromotionDefault, isPromotionDefault, isInterimPromotionDefault, samePromotionDefinition,
  RETIRED_FIELDS, retiredLeafToTrack,
  EMP_STATUS_OPTIONS, POTENTIAL_OPTIONS, TRACK_OPTIONS, NINEBOX_OPTIONS,
  buildCatalog, indexCatalog, valueShapeOf, pairOptions, canonOpt, positionKey,
  validateFilter, normalizeFilter, normalizeColumns, walkLeaves, summarize,
  redactForViewer,
  promotionConfigToFilter, promotionFilterRow, promotionConfigOf, applyPromotionConfig,
  canSeeFilter, canEditFilter, canDeleteFilter, nameConflict,
};
