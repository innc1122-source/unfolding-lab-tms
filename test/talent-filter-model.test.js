// 第 5 批 8.1（2026-10-08）：人才筛选条件模型（modules/talent/filter-model.js）的纯函数。
//   字段目录（模块开关、可选值、自定义字段的运算符）；validateFilter 每个校验码一个反例、层级 / 数量 / 大小上限、
//   lenient 模式；normalizeFilter 重复执行结果不变；晋升旧规则 ⇄ 带标签叶子的往返；redactForViewer；筛选权限矩阵；名称重复。
"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const M = require("../modules/talent/filter-model.js");

const RECORD_TYPES = [
  { key: "performance", label: "Performance", label_zh: "绩效", fields: [
    { key: "period", input: "text" },
    { key: "rating", input: "select", options: ["A+", "A", "B+", "B", "C", "D"], options_zh: ["A+", "A", "B+", "B", "C", "D"] }] },
  { key: "award", label: "Award", label_zh: "荣誉", fields: [{ key: "awardName", input: "suggest", options: ["Top learner"], options_zh: ["优秀学员"] }] },
  { key: "violation", label: "Violation", label_zh: "违纪", fields: [{ key: "severity", input: "select", options: ["Minor", "Major"], options_zh: ["轻微", "重大"] }] },
  { key: "promotion", label: "Promotion", label_zh: "晋升", fields: [{ key: "result", label: "Result", label_zh: "结果", input: "select", options: ["Passed", "Failed"], options_zh: ["通过", "未通过"], filterable: true }] },
  { key: "culture-program", label: "Behavior practice", label_zh: "行为实践", moduleOff: true, fields: [] },
];
const CUSTOM = [
  { key: "lang", label: "Language", label_zh: "语言", input: "select", options: ["English", "Tagalog"], options_zh: ["英语", "他加禄语"] },
  { key: "cert", label: "Certificate", label_zh: "证书", input: "text" },
  { key: "score", label: "Score", label_zh: "分数", input: "number" },
  { key: "certDate", label: "Cert date", label_zh: "取证日期", input: "date" },
  { key: "remote", label: "Remote", label_zh: "远程", input: "checkbox" },
];
const RANKS = [{ rank: "PD1", grade: "D", level: 1, track: "P" }, { rank: "PD2", grade: "D", level: 2, track: "P" }, { rank: "MC1", grade: "C", level: 5, track: "M" }];
function catalog(mods) {
  return M.buildCatalog({
    modules: mods || { performance: true, learning: true, talent: true },
    ranks: RANKS, jobLevelsInUse: ["V4", "PD1"], recordTypes: RECORD_TYPES, customFields: CUSTOM,
    deptOptions: [{ id: "d-fin", name: "Finance", path: "Finance", parentId: null, level: 1 }, { id: "d-ap", name: "AP", path: "Finance › AP", parentId: "d-fin", level: 2 }],
    programs: [{ id: "p1", title: "Safety", title_zh: "安全" }], talentTags: ["Successor", "Mobile", "Successor"], awardNames: ["Hackathon"],
    successionPositions: ["Head of Finance"],
  });
}
const CAT = catalog();
const leafF = (leaf) => ({ v: 1, logic: "and", items: [leaf] });
const codes = (r) => r.errors.map((e) => e.code);

test("buildCatalog: fields, module switches, options in scope, custom field ops, columns", () => {
  const ids = CAT.fields.map((f) => f.id);
  for (const id of ["dept", "jobLevel", "jobGrade", "jobTrack", "nextLevelExists", "position", "manager", "empStatus", "tenureMonths",
    "perfRecent", "potential", "nineBox", "trainingMandatoryDone", "trainingCompletion", "trainingProgram", "award", "violation", "record", "talentTag", "succession"])
    assert.ok(ids.includes(id), id);
  assert.ok(ids.includes("custom:lang") && ids.includes("custom:remote"));
  assert.ok(!ids.includes("isManager"), "F61：「管理者 / 个人贡献者」已停用，不在字段目录里（并入 jobTrack）");
  const f = (id, c = CAT) => c.fields.find((x) => x.id === id);
  assert.deepEqual(f("custom:score").ops.map((o) => o.op), ["gte", "lte", "between", "isEmpty"]);
  assert.deepEqual(f("custom:certDate").ops.map((o) => o.op), ["onOrAfter", "onOrBefore", "between", "withinMonths"]);
  assert.deepEqual(f("custom:lang").options.map((o) => o.label_zh), ["英语", "他加禄语"]);
  assert.deepEqual(f("talentTag").options.map((o) => o.value), ["Mobile", "Successor"]);
  assert.deepEqual(f("dept").options.map((o) => o.value), ["d-fin", "d-ap", "__none"]);
  assert.equal(f("dept").options[1].label_zh, "Finance › AP");
  assert.deepEqual(f("jobLevel").options.map((o) => o.value), ["MC1", "PD2", "PD1", "V4"]);
  assert.deepEqual(f("jobGrade").options.map((o) => o.value), ["C", "D", "__nogrid", "__none"]);
  assert.deepEqual(f("award").awardOptions.map((o) => o.value), ["Top learner", "Hackathon"]);
  assert.deepEqual(CAT.ratingOptions, ["A+", "A", "B+", "B", "C", "D"]);
  assert.ok(f("perfRecent").available && f("trainingProgram").available);
  // performance / learning 关闭：对应字段与列标为不可用
  const off = catalog({ performance: false, learning: false, talent: true });
  assert.equal(f("perfRecent", off).available, false);
  assert.equal(f("perfRecent", off).reason, "module_off");
  assert.equal(f("nineBox", off).available, false);
  assert.equal(f("trainingMandatoryDone", off).available, false);
  assert.equal(f("dept", off).available, true);
  assert.equal(off.columns.find((c) => c.id === "latestRating").available, false);
  assert.ok(f("record").recordTypes.find((t) => t.key === "culture-program").moduleOff);
  assert.deepEqual(CAT.defaultColumns, ["name", "employeeId", "department", "jobLevel", "latestRating", "potential", "tenure"]);
  assert.ok(CAT.columns.find((c) => c.id === "custom:lang"));
  assert.doesNotThrow(() => JSON.stringify(CAT));
});

test("validateFilter: a valid filter passes and comes back normalized", () => {
  const r = M.validateFilter({ v: 1, logic: "and", items: [
    { field: "dept", op: "in", value: ["d-fin"] },
    { logic: "or", items: [{ field: "potential", op: "in", value: ["高"] }, { field: "tenureMonths", op: "gte", value: "24" }] },
  ] }, CAT);
  assert.ok(r.ok, JSON.stringify(r.errors));
  assert.deepEqual(r.filter.items[1].items[0].value, ["High"]);
  assert.equal(r.filter.items[1].items[1].value, 24);
  assert.deepEqual([r.filter.items[0].id, r.filter.items[1].items[0].id, r.filter.items[1].items[1].id], ["c1", "c2", "c3"]);
  assert.equal(r.filter.includeExited, false);
});

test("validateFilter: one counter-example per error code", () => {
  const cases = [
    [null, "not_object"],
    [{ v: 1, logic: "and", items: ["x"] }, "not_object"],
    [{ v: 1, logic: "and", items: [], extra: 1 }, "not_object"],
    [{ v: 2, logic: "and", items: [] }, "bad_version"],
    [{ v: 1, logic: "xor", items: [] }, "bad_logic"],
    [{ v: 1, logic: "and", items: [{ logic: "nand", items: [{ field: "nextLevelExists", op: "isTrue" }] }] }, "bad_logic"],
    [{ v: 1, logic: "and", items: [{ logic: "or", items: [{ logic: "and", items: [{ field: "nextLevelExists", op: "isTrue" }] }] }] }, "too_deep"],
    [{ v: 1, logic: "and", items: Array.from({ length: 21 }, () => ({ field: "nextLevelExists", op: "isTrue" })) }, "too_many_items"],
    [{ v: 1, logic: "and", items: [{ logic: "or", items: Array.from({ length: 13 }, () => ({ field: "nextLevelExists", op: "isTrue" })) }] }, "too_many_items"],
    [{ v: 1, logic: "and", items: Array.from({ length: 3 }, () => ({ logic: "or", items: Array.from({ length: 11 }, () => ({ field: "nextLevelExists", op: "isTrue" })) })) }, "too_many_leaves"],
    [leafF({ field: "position", op: "in", value: Array.from({ length: 200 }, (_, i) => "x".repeat(90) + i) }), "too_large"],
    [leafF({ field: "salary", op: "gte", value: 1 }), "unknown_field"],
    [leafF({ field: "tenureMonths", op: "in", value: [1] }), "bad_op"],
    [leafF({ field: "tenureMonths", op: "gte", value: "abc" }), "bad_value"],
    [leafF({ field: "tenureMonths", op: "gte", value: 1.5 }), "bad_value"],
    [leafF({ field: "tenureMonths", op: "between", value: { from: 24, to: 12 } }), "bad_value"],
    [leafF({ field: "potential", op: "in", value: [] }), "bad_value"],
    [leafF({ field: "custom:certDate", op: "onOrAfter", value: "2026-02-30" }), "bad_value"],
    [leafF({ field: "nextLevelExists", op: "isTrue", id: "Bad-Id" }), "bad_value"],
    [leafF({ field: "nextLevelExists", op: "isTrue", tag: "salary" }), "bad_value"],
    [leafF({ field: "perfRecent", op: "atLeast", value: "Z" }), "value_not_in_options"],
    [leafF({ field: "empStatus", op: "in", value: ["retired"] }), "value_not_in_options"],
    [leafF({ field: "violation", op: "none", params: { months: 12, severity: ["Critical"] } }), "value_not_in_options"],
    [leafF({ field: "record", op: "exists", params: { type: "promotion", fields: { result: "Maybe" } } }), "value_not_in_options"],
    [leafF({ field: "tenureMonths", op: "gte", value: 601 }), "value_out_of_range"],
    [leafF({ field: "trainingCompletion", op: "gte", value: 120 }), "value_out_of_range"],
    [leafF({ field: "violation", op: "countAtLeast", value: 0 }), "value_out_of_range"],
    [leafF({ field: "custom:certDate", op: "withinMonths", value: 121 }), "value_out_of_range"],
    [leafF({ field: "talentTag", op: "anyOf", value: Array.from({ length: 201 }, (_, i) => "t" + i) }), "too_many_values"],
    [leafF({ field: "position", op: "contains", value: "x".repeat(101) }), "string_too_long"],
    [leafF({ field: "succession", op: "listed", params: { position: "x".repeat(81) } }), "string_too_long"],
    [leafF({ field: "perfRecent", op: "atLeast", value: "A", params: { n: 9 } }), "bad_params"],
    [leafF({ field: "perfRecent", op: "atLeast", value: "A", params: { mode: "most" } }), "bad_params"],
    [leafF({ field: "perfRecent", op: "atLeast", value: "A", params: { mode: "atLeastK" } }), "bad_params"],
    [leafF({ field: "perfRecent", op: "atLeast", value: "A", params: { n: 2, mode: "atLeastK", k: 3 } }), "bad_params"],
    [leafF({ field: "perfRecent", op: "atLeast", value: "A", params: { salary: 1 } }), "bad_params"],
    [leafF({ field: "potential", op: "in", value: ["High"], params: { freshOnly: "yes" } }), "bad_params"],
    [leafF({ field: "nextLevelExists", op: "isTrue", params: { x: 1 } }), "bad_params"],
    [leafF({ field: "nextLevelExists", op: "isTrue", note: "x" }), "bad_params"],
    [leafF({ field: "record", op: "exists", params: {} }), "bad_params"],
    [leafF({ field: "record", op: "exists", params: { type: "promotion", fields: { nope: "x" } } }), "bad_params"],
    [leafF({ field: "record", op: "exists", params: { type: "nope" } }), "record_type_unknown"],
    [leafF({ field: "record", op: "exists", params: { type: "culture-program" } }), "record_type_unavailable"],
    [leafF({ field: "custom:gone", op: "contains", value: "x" }), "custom_field_unknown"],
  ];
  for (const [raw, code] of cases) {
    const r = M.validateFilter(raw, CAT);
    assert.equal(r.ok, false, `${code}: ${JSON.stringify(raw).slice(0, 120)}`);
    assert.ok(codes(r).includes(code), `${code} expected, got ${JSON.stringify(r.errors)} for ${JSON.stringify(raw).slice(0, 120)}`);
  }
  // 每个错误码都至少有一个反例
  const covered = new Set(cases.map((c) => c[1]));
  for (const c of M.ERROR_CODES) assert.ok(covered.has(c), "no counter-example for " + c);
  // 路径指到出错的位置
  const r = M.validateFilter({ v: 1, logic: "and", items: [{ field: "nextLevelExists", op: "isTrue" }, { logic: "or", items: [{ field: "tenureMonths", op: "gte", value: 999 }] }] }, CAT);
  assert.deepEqual(r.errors, [{ path: "items.1.items.0.value", code: "value_out_of_range" }]);
});

test("validateFilter: limits are inclusive (20 root items, 12 per group, 30 leaves, 200 values) and empty ref lists are allowed", () => {
  const leaf = { field: "nextLevelExists", op: "isTrue" };
  assert.ok(M.validateFilter({ v: 1, logic: "and", items: Array.from({ length: 20 }, () => ({ ...leaf })) }, CAT).ok);
  assert.ok(M.validateFilter({ v: 1, logic: "and", items: [{ logic: "or", items: Array.from({ length: 12 }, () => ({ ...leaf })) }] }, CAT).ok);
  assert.ok(M.validateFilter({ v: 1, logic: "and", items: [
    { logic: "or", items: Array.from({ length: 12 }, () => ({ ...leaf })) }, { logic: "or", items: Array.from({ length: 12 }, () => ({ ...leaf })) },
    ...Array.from({ length: 6 }, () => ({ ...leaf }))] }, CAT).ok);
  assert.ok(M.validateFilter(leafF({ field: "talentTag", op: "anyOf", value: Array.from({ length: 200 }, (_, i) => "t" + i) }), CAT).ok);
  // dept / manager / program 是引用类：裁剪后为空仍能保存（运行时判为值不可用）
  assert.ok(M.validateFilter(leafF({ field: "dept", op: "in", value: [] }), CAT).ok);
  assert.ok(M.validateFilter(leafF({ field: "manager", op: "in", value: [] }), CAT).ok);
  // 空根节点 = 全部人员
  assert.ok(M.validateFilter({ v: 1, logic: "and", items: [] }, CAT).ok);
  // 不带值的运算符：传进来的值丢弃
  const r = M.validateFilter(leafF({ field: "nextLevelExists", op: "isTrue", value: [] }), CAT);
  assert.ok(r.ok);
  assert.equal("value" in r.filter.items[0], false);
});

test("validateFilter lenient: removed custom field and switched-off record type become warnings, not errors", () => {
  const raw = { v: 1, logic: "and", items: [
    { id: "c7", field: "custom:gone", op: "contains", value: "x" },
    { field: "record", op: "exists", params: { type: "culture-program" } },
  ] };
  assert.equal(M.validateFilter(raw, CAT).ok, false);
  const r = M.validateFilter(raw, CAT, { lenient: true });
  assert.ok(r.ok, JSON.stringify(r.errors));
  assert.deepEqual(r.warnings.map((w) => w.code), ["field_removed", "module_off"]);
  assert.equal(r.filter.items[0].field, "custom:gone"); // 原样保留，保存时不丢
});

test("normalizeFilter: canonical values, default params, stable ids and key order; running it twice changes nothing", () => {
  const raw = { logic: "or", v: 1, items: [
    { op: "atLeast", field: "perfRecent", value: "b+", params: { n: "2", mode: "atLeastK", k: 1 } },
    { field: "violation", op: "none", params: { severity: ["重大", "Major"] } },
    { id: "c2", field: "custom:lang", op: "in", value: ["英语", "english"] },
    { logic: "and", items: [{ id: "c2", field: "jobLevel", op: "in", value: ["pd1", "V4"] }, { field: "record", op: "exists", params: { type: "promotion", fields: { result: "通过" } } }] },
    { field: "award", op: "countAtLeast", value: 1, params: { names: ["优秀学员"] } },
  ] };
  const n1 = M.normalizeFilter(raw, CAT);
  assert.deepEqual(n1.items[0], { id: "c1", field: "perfRecent", op: "atLeast", value: "B+", params: { n: 2, mode: "atLeastK", k: 1, periodKind: "any", missing: "fail", withinMonths: 0 } });
  assert.deepEqual(n1.items[1].params, { months: 0, severity: ["Major"] });
  assert.deepEqual(n1.items[2], { id: "c2", field: "custom:lang", op: "in", value: ["English"] });
  // 已有的合法 id 保留（c2）；缺的与重复的按出现顺序补上未用过的编号
  assert.deepEqual([n1.items[1].id, n1.items[3].items[0].id, n1.items[3].items[1].id, n1.items[4].id], ["c3", "c4", "c5", "c6"]);
  assert.deepEqual(n1.items[3].items[0].value, ["PD1", "V4"]);
  assert.deepEqual(n1.items[3].items[1].params, { type: "promotion", months: 0, fields: { result: "Passed" } });
  assert.deepEqual(n1.items[4].params, { months: 0, names: ["Top learner"] });
  const n2 = M.normalizeFilter(n1, CAT);
  assert.deepEqual(n2, n1);
  assert.equal(JSON.stringify(n2), JSON.stringify(n1));
  // 原始输入不被改动
  assert.equal(raw.items[0].value, "b+");
});

test("promotionConfigToFilter: defaults (F62 company threshold) and every switch", () => {
  const d = M.promotionConfigToFilter({}, CAT.ratingOptions);
  // F62（负责人 2026-10-09）：① 有下一职级 ② 过去 12 个月无 C / D ③ 近 2 期任一期 ≥ B+ ④ 现职级任职满 12 个月 ⑤ 近 12 个月无违纪
  assert.deepEqual(d, { v: 1, logic: "and", includeExited: false, items: [
    { id: "cnl", field: "nextLevelExists", op: "isTrue", tag: "nextLevel" },
    { id: "crw", field: "perfRecent", op: "atLeast", value: "B", params: { n: 1, mode: "all", periodKind: "any", missing: "fail", withinMonths: 12 }, tag: "ratingWindow" },
    { id: "crt", field: "perfRecent", op: "atLeast", value: "B+", params: { n: 2, mode: "any", periodKind: "any", missing: "fail", withinMonths: 0 }, tag: "rating" },
    { id: "clt", field: "levelTenureMonths", op: "gte", value: 12, tag: "levelTenure" },
    { id: "cvi", field: "violation", op: "none", params: { months: 12, severity: [] }, tag: "violations" },
  ] });
  // 旧默认（F62 之前）仍能生成，迁移 92 据此识别「从未改过」
  const legacy = M.promotionConfigToFilter(M.LEGACY_PROMO_DEFAULTS, CAT.ratingOptions);
  assert.deepEqual(legacy.items.map((l) => [l.tag, l.field, l.value]), [["nextLevel", "nextLevelExists", undefined], ["rating", "perfRecent", "B+"], ["tenure", "tenureMonths", 12], ["trainings", "trainingMandatoryDone", undefined], ["violations", "violation", undefined]]);
  assert.deepEqual(legacy.items[1].params, { n: 1, mode: "all", periodKind: "any", missing: "fail", withinMonths: 0 });
  assert.equal(M.isLegacyPromotionDefault(legacy, CAT.ratingOptions), true);
  assert.equal(M.isPromotionDefault(legacy, CAT.ratingOptions), false);
  assert.equal(M.isPromotionDefault(d, CAT.ratingOptions), true);
  // F62 首版默认（missing ignore）：不是新默认，但能被识别（迁移 93 用）
  const interim = JSON.parse(JSON.stringify(d));
  for (const l of interim.items) if (l.params && l.params.withinMonths !== undefined) l.params.missing = "ignore";
  assert.equal(M.isPromotionDefault(interim, CAT.ratingOptions), false);
  assert.equal(M.isInterimPromotionDefault(interim, CAT.ratingOptions), true);
  assert.equal(M.isInterimPromotionDefault(d, CAT.ratingOptions), false);
  assert.match(M.summarize(interim, CAT, "zh"), /无评级视为满足/);
  assert.equal(/无评级视为满足/.test(M.summarize(d, CAT, "zh")), false);
  // 旧库里的叶子没有 withinMonths、id 不同：仍判为旧默认；改了任一值就不是
  const stored = JSON.parse(JSON.stringify(legacy));
  stored.items.forEach((l, i) => { l.id = "x" + i; if (l.params) delete l.params.withinMonths; });
  assert.equal(M.isLegacyPromotionDefault(stored, CAT.ratingOptions), true);
  stored.items[2].value = 6;
  assert.equal(M.isLegacyPromotionDefault(stored, CAT.ratingOptions), false);
  assert.equal(M.isLegacyPromotionDefault({ ...legacy, items: legacy.items.slice(0, 4) }, CAT.ratingOptions), false, "a removed condition is a change");
  // 生成的定义本身就是归一化后的样子
  const v = M.validateFilter(d, CAT);
  assert.ok(v.ok, JSON.stringify(v.errors));
  assert.deepEqual(v.filter, d);
  const tags = (cfg) => M.promotionConfigToFilter(cfg, CAT.ratingOptions).items.map((l) => l.tag);
  assert.deepEqual(tags({ minRating: "" }), ["nextLevel", "ratingWindow", "levelTenure", "violations"]);
  assert.deepEqual(tags({ windowMonths: 0 }), ["nextLevel", "rating", "levelTenure", "violations"]);
  assert.deepEqual(tags({ windowMinRating: "" }), ["nextLevel", "rating", "levelTenure", "violations"]);
  assert.deepEqual(tags({ minLevelTenureMonths: 0 }), ["nextLevel", "ratingWindow", "rating", "violations"]);
  assert.deepEqual(tags({ minTenureMonths: 12, requireTrainings: true }), ["nextLevel", "ratingWindow", "rating", "levelTenure", "tenure", "trainings", "violations"]);
  assert.deepEqual(tags({ noMajorViolationMonths: 0 }), ["nextLevel", "ratingWindow", "rating", "levelTenure"]);
  assert.deepEqual(tags({ minRating: "", windowMonths: 0, minLevelTenureMonths: 0, noMajorViolationMonths: 0 }), ["nextLevel"]);
  assert.equal(M.promotionConfigToFilter({ minRatingPeriods: 1 }, CAT.ratingOptions).items.find((l) => l.tag === "rating").params.mode, "all", "1 period = latest only");
  const major = M.promotionConfigToFilter({ violationMajorOnly: true, noMajorViolationMonths: 24 }, CAT.ratingOptions).items.find((l) => l.tag === "violations");
  assert.deepEqual(major.params, { months: 24, severity: ["Major"] });
  assert.equal(M.promotionConfigToFilter({ minRating: "A", minTenureMonths: 36 }, CAT.ratingOptions).items.find((l) => l.tag === "rating").value, "A");
  // minRating 已不在评级选项中：去掉这条叶子（旧代码在这种情况下也等于不设门槛），迁移行带 dropped
  assert.equal(M.promotionConfigToFilter({ minRating: "S" }, null).items.some((l) => l.tag === "rating"), true); // 不传选项时不判断
  assert.equal(M.promotionConfigToFilter({ minRating: "S" }, CAT.ratingOptions).items.some((l) => l.tag === "rating"), false);
  const row = M.promotionFilterRow({ minRating: "S" }, CAT.ratingOptions);
  assert.deepEqual(row.dropped, ["rating"]);
  assert.deepEqual(M.promotionFilterRow({ windowMinRating: "S" }, CAT.ratingOptions).dropped, ["ratingWindow"]);
  assert.equal(row.builtinKey, "promotion");
  assert.equal(row.visibility, "shared");
  assert.equal(row.name_zh, "晋升评审候选");
  assert.deepEqual(row.columns, ["name", "employeeId", "department", "jobLevel", "nextLevel", "latestRating", "levelTenure", "tenure", "violationCount", "potential"]);
  assert.equal(M.promotionFilterRow({}, CAT.ratingOptions).dropped, undefined);
  assert.deepEqual(M.PROMO_DEFAULTS, { minRating: "B+", minRatingPeriods: 2, windowMinRating: "B", windowMonths: 12, minLevelTenureMonths: 12, minTenureMonths: 0, requireTrainings: false, noMajorViolationMonths: 12, violationMajorOnly: false });
  assert.deepEqual(M.LEGACY_PROMO_DEFAULTS, { minRating: "B+", minRatingPeriods: 1, windowMinRating: "", windowMonths: 0, minLevelTenureMonths: 0, minTenureMonths: 12, requireTrainings: true, noMajorViolationMonths: 12, violationMajorOnly: false });
});

test("promotionConfigOf ⇄ applyPromotionConfig round-trip and HR's own leaves are kept", () => {
  const cfgs = [
    { ...M.PROMO_DEFAULTS },
    { ...M.LEGACY_PROMO_DEFAULTS },
    { minRating: "A", minRatingPeriods: 3, windowMinRating: "C", windowMonths: 24, minLevelTenureMonths: 6, minTenureMonths: 24, requireTrainings: false, noMajorViolationMonths: 6, violationMajorOnly: true },
    { minRating: "", minRatingPeriods: 1, windowMinRating: "", windowMonths: 0, minLevelTenureMonths: 0, minTenureMonths: 0, requireTrainings: true, noMajorViolationMonths: 0, violationMajorOnly: false },
  ];
  for (const cfg of cfgs) assert.deepEqual(M.promotionConfigOf(M.promotionConfigToFilter(cfg, CAT.ratingOptions)), cfg);
  // HR 在内置筛选上加了自己的条件，并把评级改成「近 2 期均不低于」
  let def = M.promotionConfigToFilter({}, CAT.ratingOptions);
  def.items.find((l) => l.tag === "rating").params = { n: 2, mode: "all", periodKind: "any", missing: "fail", withinMonths: 0 };
  def.items.push({ id: "c1", field: "dept", op: "in", value: ["d-fin"] });
  def.items.push({ logic: "or", items: [{ id: "c2", field: "potential", op: "in", value: ["High"] }, { id: "c3", field: "nextLevelExists", op: "isTrue" }] });
  const before = JSON.parse(JSON.stringify(def));
  const next = M.applyPromotionConfig(def, { minRating: "A", minTenureMonths: 0, violationMajorOnly: true });
  assert.deepEqual(def, before, "input not mutated");
  assert.deepEqual(M.promotionConfigOf(next), { minRating: "A", minRatingPeriods: 2, windowMinRating: "B", windowMonths: 12, minLevelTenureMonths: 12, minTenureMonths: 0, requireTrainings: false, noMajorViolationMonths: 12, violationMajorOnly: true });
  const rating = next.items.find((l) => l.tag === "rating");
  assert.equal(rating.id, "crt");
  assert.equal(rating.value, "A");
  assert.equal(rating.params.n, 2, "HR's n=2 survives a minRating change");
  assert.equal(rating.params.mode, "all", "HR's mode survives too");
  // 明确给 minRatingPeriods / windowMonths 时才覆盖叶子上的 n / withinMonths
  const per = M.applyPromotionConfig(next, { minRatingPeriods: 3, windowMonths: 6 });
  assert.deepEqual(per.items.find((l) => l.tag === "rating").params, { n: 3, mode: "any", periodKind: "any", missing: "fail", withinMonths: 0 });
  assert.equal(per.items.find((l) => l.tag === "ratingWindow").params.withinMonths, 6);
  assert.equal(next.items.some((l) => l.tag === "tenure"), false);
  assert.ok(next.items.find((l) => l.id === "c1" && l.field === "dept"));
  assert.ok(next.items.find((it) => Array.isArray(it.items) && it.items.length === 2));
  assert.ok(M.validateFilter(next, CAT).ok);
  // 再把司龄加回来：追加到根节点，id 不与已有的撞号
  const back = M.applyPromotionConfig(next, { minTenureMonths: 18 });
  const ten = back.items.find((l) => l.tag === "tenure");
  assert.equal(ten.value, 18);
  const ids = [];
  M.walkLeaves(back, (l) => ids.push(l.id));
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(M.validateFilter(back, CAT).ok);
  // 空补丁不改任何东西
  assert.deepEqual(M.applyPromotionConfig(back, {}), back);
  // 带标签的叶子放在条件组里时原位更新
  const inGroup = { v: 1, logic: "and", includeExited: false, items: [{ logic: "or", items: [{ id: "c9", field: "tenureMonths", op: "gte", value: 6, tag: "tenure" }, { id: "c8", field: "nextLevelExists", op: "isTrue" }] }] };
  const g = M.applyPromotionConfig(inGroup, { minTenureMonths: 30, minRating: "", requireTrainings: false, noMajorViolationMonths: 0 });
  assert.equal(g.items.length, 1);
  assert.equal(g.items[0].items[0].value, 30);
  assert.equal(g.items[0].items[0].id, "c9");
});

test("redactForViewer: out-of-scope departments and every name: pseudo id are removed; __none kept; input untouched", () => {
  const def = { v: 1, logic: "and", includeExited: false, items: [
    { id: "c1", field: "dept", op: "in", value: ["d-fin", "d-ops", "name:legacy team", "__none"] },
    { logic: "or", items: [{ id: "c2", field: "dept", op: "notIn", value: ["d-hr"] }, { id: "c3", field: "manager", op: "in", value: ["u1", "u9"] }] },
  ] };
  const snapshot = JSON.stringify(def);
  const allow = (id) => id === "d-fin" || id === "name:legacy team";
  const r = M.redactForViewer(def, allow, { allowUserId: (id) => id === "u1" });
  assert.deepEqual(r.definition.items[0].value, ["d-fin", "__none"]);
  assert.deepEqual(r.definition.items[1].items[0].value, []);
  assert.deepEqual(r.definition.items[1].items[1].value, ["u1"]);
  assert.equal(r.redactedValues, 4);
  assert.equal(JSON.stringify(def), snapshot);
  assert.ok(!JSON.stringify(r.definition).includes("legacy"));
  // 裁剪后的定义仍能通过校验（受限管理员「另存为」保存的就是它）
  assert.ok(M.validateFilter(r.definition, CAT).ok);
  // 没有 allowUserId 时上级 id 不动
  assert.deepEqual(M.redactForViewer(def, allow).definition.items[1].items[1].value, ["u1", "u9"]);
});

test("canSeeFilter / canEditFilter / canDeleteFilter: private, shared, built-in × owner, other admin, super admin", () => {
  const owner = { id: "a1", canWrite: true }, other = { id: "a2", canWrite: true }, sup = { id: "a3", canWrite: true, isSuper: true }, reader = { id: "a4", canWrite: false };
  const priv = { id: "tf-1", visibility: "private", ownerId: "a1" };
  const shared = { id: "tf-2", visibility: "shared", ownerId: "a1" };
  const builtin = { id: "tf-3", visibility: "shared", ownerId: null, builtinKey: "promotion" };
  const t = (fn, f) => [owner, other, sup, reader].map((v) => fn(f, v));
  assert.deepEqual(t(M.canSeeFilter, priv), [true, false, false, false]);
  assert.deepEqual(t(M.canSeeFilter, shared), [true, true, true, true]);
  assert.deepEqual(t(M.canSeeFilter, builtin), [true, true, true, true]);
  assert.deepEqual(t(M.canEditFilter, priv), [true, false, false, false]);
  assert.deepEqual(t(M.canEditFilter, shared), [true, false, true, false]);
  assert.deepEqual(t(M.canEditFilter, builtin), [true, true, true, false]);
  assert.deepEqual(t(M.canDeleteFilter, priv), [true, false, false, false]);
  assert.deepEqual(t(M.canDeleteFilter, shared), [true, false, true, false]);
  assert.deepEqual(t(M.canDeleteFilter, builtin), [false, false, false, false]);
  assert.equal(M.canSeeFilter(null, owner), false);
});

test("nameConflict: case-insensitive, zh and en checked separately, only within what the viewer can see together", () => {
  const filters = [
    { id: "tf-1", name: "Finance HiPo", name_zh: "财务高潜", visibility: "private", ownerId: "a1" },
    { id: "tf-2", name: "Ops bench", name_zh: "运营梯队", visibility: "shared", ownerId: "a2" },
    { id: "tf-3", ...M.PROMO_NAME, builtinKey: "promotion", visibility: "shared", ownerId: null },
  ];
  const a1 = { id: "a1" }, a2 = { id: "a2" };
  assert.equal(M.nameConflict(filters, { name: "finance hipo", visibility: "private" }, a1), "name");
  assert.equal(M.nameConflict(filters, { name: "finance hipo", visibility: "private" }, a2), null); // 别人的私有筛选不冲突
  assert.equal(M.nameConflict(filters, { name: "x", name_zh: "运营梯队", visibility: "private" }, a1), "name_zh");
  assert.equal(M.nameConflict(filters, { name: "PROMOTION panel candidates", visibility: "shared" }, a2), "name");
  assert.equal(M.nameConflict(filters, { id: "tf-2", name: "Ops bench", visibility: "shared" }, a2), null); // 改自己不算重名
});

test("summarize: zh / en sentence for leaves, groups, empty filter and exited people", () => {
  const def = M.normalizeFilter({ v: 1, logic: "and", items: [
    { field: "dept", op: "in", value: ["d-ap", "name:legacy"] },
    { field: "jobLevel", op: "between", value: { from: "PD1", to: "PD2" } },
    { field: "perfRecent", op: "atLeast", value: "A", params: { n: 2 } },
    { logic: "or", items: [{ field: "potential", op: "in", value: ["High"] }, { field: "violation", op: "none", params: { months: 24, severity: ["Major"] } }] },
  ] }, CAT);
  assert.equal(M.summarize(def, CAT, "zh"), "满足全部：部门（含下级）属于 Finance › AP、legacy · 职级 PD1–PD2 · 近 2 期绩效均不低于 A · （满足任一：潜力属于 高；近 24 个月无违纪记录（重大））");
  assert.equal(M.summarize(def, CAT, "en"), "All of: Department (incl. sub-departments) is any of Finance › AP, legacy · Job level PD1–PD2 · Last 2 ratings (all) at or above A · (Any of: Potential is any of High; No violation records (Major) in the last 24 months)");
  assert.equal(M.summarize({ v: 1, logic: "and", items: [] }, CAT, "zh"), "全部人员（未设条件）");
  assert.equal(M.summarize({ v: 1, logic: "or", items: [], includeExited: true }, CAT, "en"), "Everyone (no conditions) (incl. exited)");
  assert.match(M.summarize(M.normalizeFilter(leafF({ field: "record", op: "exists", params: { type: "promotion", fields: { result: "Passed" } } }), CAT), CAT, "zh"), /有晋升（结果=通过）记录/);
});

test("normalizeColumns: dedupes, drops unknown / switched-off columns, falls back to the defaults", () => {
  assert.deepEqual(M.normalizeColumns(["name", "name", "salary", "custom:lang", "latestRating"], CAT), ["name", "custom:lang", "latestRating"]);
  assert.deepEqual(M.normalizeColumns([], CAT), [...M.DEFAULT_COLUMNS]);
  const off = catalog({ performance: false, learning: true, talent: true });
  assert.deepEqual(M.normalizeColumns(["name", "latestRating"], off), ["name"]);
  assert.ok(!M.normalizeColumns(null, off).includes("latestRating"));
});

test("positionKey: case, spaces, hyphens and full-width forms compare equal", () => {
  assert.equal(M.positionKey(" Head  of-Finance "), M.positionKey("head of finance"));
  assert.equal(M.positionKey("Team–Lead"), M.positionKey("TEAM LEAD"));
  assert.equal(M.positionKey("ＡＰ　Lead"), M.positionKey("ap lead"));
  assert.notEqual(M.positionKey("AP Lead"), M.positionKey("AR Lead"));
});

// F61（负责人 2026-10-09「一起删除，track 就是 role type」）：「管理者 / 个人贡献者」（isManager）停用，并入职级通道
test("F61 retired isManager: never a 400 — kept as a field_retired warning in strict and lenient mode; maps to jobTrack M / P", () => {
  const raw = { v: 1, logic: "and", items: [{ id: "c4", field: "isManager", op: "isTrue" }, { field: "jobTrack", op: "in", value: ["P"] }] };
  for (const opts of [undefined, { lenient: true }]) {
    const r = M.validateFilter(raw, CAT, opts);
    assert.equal(r.ok, true, JSON.stringify(r.errors));
    assert.deepEqual(r.warnings, [{ path: "items.0", id: "c4", code: "field_retired" }]);
    assert.deepEqual(r.filter.items[0], { id: "c4", field: "isManager", op: "isTrue" }, "the leaf stays as it was");
  }
  assert.ok(M.WARNING_CODES.includes("field_retired"));
  assert.ok(!M.FIELD_DEFS.some((d) => d.id === "isManager"));
  assert.match(M.summarize(M.normalizeFilter(raw, CAT), CAT, "zh"), /已停用的条件：管理者 \/ 个人贡献者/);
  // 改写：管理者 → 管理通道 M，个人贡献者 → 专业通道 P；职级体系里没有该通道或运算符不认识 → null（保留为停用条件）
  assert.deepEqual(M.retiredLeafToTrack({ id: "c1", field: "isManager", op: "isTrue" }, RANKS), { id: "c1", field: "jobTrack", op: "in", value: ["M"] });
  assert.deepEqual(M.retiredLeafToTrack({ id: "c2", field: "isManager", op: "isFalse" }, RANKS), { id: "c2", field: "jobTrack", op: "in", value: ["P"] });
  assert.equal(M.retiredLeafToTrack({ id: "c3", field: "isManager", op: "isTrue" }, RANKS.filter((r) => r.track === "P")), null);
  assert.equal(M.retiredLeafToTrack({ id: "c3", field: "isManager", op: "maybe" }, RANKS), null);
  assert.equal(M.retiredLeafToTrack({ id: "c3", field: "position", op: "isTrue" }, RANKS), null);
  // 改写结果过严格校验
  const mapped = { v: 1, logic: "and", items: [M.retiredLeafToTrack({ id: "c1", field: "isManager", op: "isTrue" }, RANKS)] };
  assert.equal(M.validateFilter(mapped, CAT).ok, true);
});
