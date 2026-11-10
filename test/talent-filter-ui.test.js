// 第五批 8.1 人才筛选前端（B5-D，2026-10-08）：web/src/pages/admin/talentFilter.js 纯函数直接跑（条件摘要中英文、编辑器状态的增删改、
// 不同 valueKind / 运算符选到的值控件、列与结果单元、晋升评审候选行操作、批量结果归一、草稿读写）；页面接线做少量源码断言。
// 不起浏览器、不打包。
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");

const ROOT = path.join(__dirname, "..");
const lib = () => import(pathToFileURL(path.join(ROOT, "web", "src", "pages", "admin", "talentFilter.js")).href);
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), "utf8").replace(/\r\n/g, "\n");

const op = (o, en, zh) => ({ op: o, label: en, label_zh: zh });
const CATALOG = {
  fields: [
    { id: "dept", group: "Organization", group_zh: "组织", label: "Department", label_zh: "部门", valueKind: "dept", ops: [op("in", "in", "属于"), op("notIn", "not in", "不属于")] },
    { id: "jobLevel", group: "Job level", group_zh: "职级", label: "Job level", label_zh: "职级", valueKind: "level", ops: [op("in", "is", "为"), op("notIn", "is not", "不为"), op("between", "between", "介于")],
      options: [{ value: "PD1", label: "PD1", label_zh: "PD1" }, { value: "PD2", label: "PD2", label_zh: "PD2" }, { value: "PD3", label: "PD3", label_zh: "PD3" }] },
    { id: "nextLevelExists", group: "Job level", group_zh: "职级", label: "Has next level", label_zh: "有下一职级", valueKind: "bool", ops: [op("isTrue", "yes", "是"), op("isFalse", "no", "否")] },
    { id: "tenureMonths", group: "Tenure", group_zh: "司龄", label: "Tenure", label_zh: "司龄", valueKind: "months", ops: [op("gte", "at least", "不少于"), op("lte", "at most", "不超过"), op("between", "between", "介于")] },
    { id: "perfRecent", group: "Performance", group_zh: "绩效", label: "Recent ratings", label_zh: "近期绩效", valueKind: "rating", module: "performance",
      ops: [op("atLeast", "at least", "不低于"), op("atMost", "at most", "不高于"), op("in", "is", "为"), op("noRecord", "no record", "没有记录")],
      options: [{ value: "A+", label: "A+", label_zh: "A+" }, { value: "A", label: "A", label_zh: "A" }, { value: "B", label: "B", label_zh: "B" }] },
    { id: "potential", group: "Potential", group_zh: "潜力", label: "Potential", label_zh: "潜力", valueKind: "enum", ops: [op("in", "is", "为")],
      options: [{ value: "High", label: "High", label_zh: "高" }, { value: "Low", label: "Low", label_zh: "低" }] },
    { id: "trainingCompletion", group: "Training", group_zh: "培训", label: "Training completion", label_zh: "培训完成率", valueKind: "percent", ops: [op("gte", "at least", "不低于"), op("lte", "at most", "不高于")], available: false, reason: "module_off" },
    { id: "violation", group: "Discipline", group_zh: "违纪", label: "Disciplinary records", label_zh: "违纪记录", valueKind: "count", ops: [op("none", "none", "没有"), op("countAtLeast", "at least", "至少")] },
    { id: "position", group: "Organization", group_zh: "组织", label: "Position", label_zh: "岗位", valueKind: "text", ops: [op("contains", "contains", "包含"), op("in", "is", "为")] },
    { id: "custom:start", group: "Custom fields", group_zh: "自定义字段", label: "Start", label_zh: "开始日期", valueKind: "date", ops: [op("onOrAfter", "on or after", "不早于"), op("between", "between", "介于"), op("withinMonths", "within", "近")] },
    { id: "record", group: "Records", group_zh: "档案记录", label: "Record", label_zh: "档案记录", valueKind: "record", ops: [op("exists", "has", "有"), op("notExists", "has no", "没有"), op("countAtLeast", "at least", "至少")],
      recordTypes: [{ key: "award", label: "Award", label_zh: "荣誉", fields: [] }] },
  ],
  columns: [{ id: "name", label: "Name", label_zh: "姓名" }, { id: "latestRating", label: "Latest rating", label_zh: "最近评级" }, { id: "empStatus", label: "Status", label_zh: "员工状态", options: [{ value: "regular", label: "Regular", label_zh: "正式" }] }],
};

test("值控件：按 valueKind 与运算符选控件（部门 / 多选 / 单选 / 区间 / 数字 / 日期 / 文本 / 无值）", async () => {
  const { valueControl, defaultValue, isValueFilled } = await lib();
  const f = (id) => CATALOG.fields.find((x) => x.id === id);
  assert.deepEqual(valueControl(f("dept"), "in"), { kind: "dept", multiple: true });
  assert.equal(valueControl({ valueKind: "dept" }, "equals").multiple, false, "自定义部门字段 equals 为单选");
  assert.equal(valueControl(f("jobLevel"), "in").kind, "multi");
  assert.equal(valueControl(f("jobLevel"), "between").kind, "levelRange");
  assert.equal(valueControl(f("perfRecent"), "atLeast").kind, "single");
  assert.equal(valueControl(f("perfRecent"), "noRecord").kind, "none");
  assert.equal(valueControl(f("nextLevelExists"), "isTrue").kind, "none");
  const ten = valueControl(f("tenureMonths"), "gte");
  assert.deepEqual([ten.kind, ten.min, ten.max], ["number", 0, 600]);
  assert.equal(valueControl(f("tenureMonths"), "between").kind, "numberRange");
  assert.deepEqual([valueControl(f("trainingCompletion"), "gte").min, valueControl(f("trainingCompletion"), "gte").max], [0, 100], "百分比 0–100");
  assert.equal(valueControl(f("violation"), "countAtLeast").min, 1);
  assert.equal(valueControl(f("violation"), "none").kind, "none");
  assert.equal(valueControl(f("position"), "contains").kind, "text");
  assert.deepEqual(valueControl(f("position"), "in"), { kind: "multi", allowCreate: true }, "文本字段多选可自填");
  assert.equal(valueControl(f("custom:start"), "onOrAfter").kind, "date");
  assert.equal(valueControl(f("custom:start"), "between").kind, "dateRange");
  assert.equal(valueControl(f("custom:start"), "withinMonths").kind, "number");
  assert.equal(valueControl(null, "").kind, "none");
  // 缺省值与是否填完
  assert.deepEqual(defaultValue({ kind: "multi" }), []);
  assert.deepEqual(defaultValue({ kind: "levelRange" }), { from: null, to: null });
  assert.equal(defaultValue({ kind: "none" }), undefined);
  assert.equal(isValueFilled({ kind: "multi" }, []), false);
  assert.equal(isValueFilled({ kind: "multi" }, ["A"]), true);
  assert.equal(isValueFilled({ kind: "number" }, 0), true, "0 是合法数字");
  assert.equal(isValueFilled({ kind: "number" }, null), false);
  assert.equal(isValueFilled({ kind: "numberRange" }, { from: 12, to: "" }), false);
  assert.equal(isValueFilled({ kind: "levelRange" }, { from: "PD1", to: "PD3" }), true);
  assert.equal(isValueFilled({ kind: "none" }, undefined), true);
});

test("编辑器状态：加条件 / 加条件组 / 换字段重置值与参数 / 换运算符只在控件变化时重置 / 删除组内最后一条连组删除 / 上限", async () => {
  const L = await lib();
  let d = L.emptyFilter();
  assert.deepEqual(d, { v: 1, logic: "and", items: [], includeExited: false });
  d = L.addCondition(d);
  assert.deepEqual(d.items[0], { id: "c1", field: "", op: "" });
  d = L.setLeafField(d, [0], "perfRecent", CATALOG);
  assert.deepEqual(d.items[0], { id: "c1", field: "perfRecent", op: "atLeast", value: "", params: { n: 1, mode: "all", k: 1, periodKind: "any", missing: "fail", withinMonths: 0 } });
  d = L.setLeafValue(d, [0], "A");
  d = L.setLeafParams(d, [0], { n: 2 });
  assert.equal(d.items[0].params.n, 2);
  assert.equal(d.items[0].params.mode, "all", "参数合并不丢其它项");
  d = L.setLeafOp(d, [0], "atMost", CATALOG);
  assert.equal(d.items[0].value, "A", "single → single 保留值");
  d = L.setLeafOp(d, [0], "in", CATALOG);
  assert.deepEqual(d.items[0].value, [], "single → multi 重置");
  d = L.setLeafOp(d, [0], "noRecord", CATALOG);
  assert.ok(!("value" in d.items[0]), "无值运算符去掉 value");
  // 条件组：缺省逻辑与根相反
  d = L.addGroup(d);
  assert.equal(d.items[1].logic, "or");
  assert.equal(d.items[1].items[0].id, "c2");
  d = L.addCondition(d, 1);
  assert.deepEqual(d.items[1].items.map((l) => l.id), ["c2", "c3"]);
  d = L.setLogic(d, [1], "and");
  assert.equal(d.items[1].logic, "and");
  d = L.setLogic(d, [], "or");
  assert.equal(d.logic, "or");
  assert.deepEqual(L.findLeafPath(d, "c3"), [1, 1]);
  assert.equal(L.getAt(d, [1, 1]).id, "c3");
  d = L.removeAt(d, [1, 0]);
  d = L.removeAt(d, [1, 0]);
  assert.equal(d.items.length, 1, "组内最后一条删除后整组删除");
  assert.equal(L.nextLeafId(d), "c2", "空出来的编号复用");
  // 不改入参
  const before = JSON.stringify(d);
  L.addCondition(d); L.setLeafField(d, [0], "dept", CATALOG); L.removeAt(d, [0]);
  assert.equal(JSON.stringify(d), before);
  // 上限：根 20 项、总数 30 条
  let big = L.emptyFilter();
  for (let i = 0; i < 25; i += 1) big = L.addCondition(big);
  assert.equal(big.items.length, L.MAX_ROOT_ITEMS);
  big = L.normalizeDef({ logic: "and", items: Array.from({ length: 3 }, () => ({ logic: "or", items: Array.from({ length: 10 }, () => ({ field: "dept", op: "in", value: [] })) })) });
  assert.equal(L.countLeaves(big), 30);
  assert.equal(L.addCondition(big), big, "满 30 条不再加");
  assert.equal(L.addGroup(big), big);
});

test("normalizeDef 补齐形状与叶子 id（重复或不合法的 id 重新编号），applyChoice 写入 AI 候选", async () => {
  const L = await lib();
  const d = L.normalizeDef({ logic: "x", items: [{ id: "c1", field: "dept", op: "in", value: [] }, { id: "c1", field: "potential", op: "in", value: ["High"] }, { logic: "and", items: [{ id: "bad id", field: "tenureMonths", op: "gte", value: 12 }] }, null] });
  assert.equal(d.logic, "and");
  const ids = [d.items[0].id, d.items[1].id, d.items[2].items[0].id];
  assert.equal(new Set(ids).size, 3);
  for (const id of ids) assert.match(id, /^c[0-9a-z]{1,8}$/);
  assert.equal(d.items.length, 3, "null 项去掉");
  assert.deepEqual(L.normalizeDef(null), { v: 1, logic: "and", items: [], includeExited: false });
  const after = L.applyChoice(d, "c1", "d-9");
  assert.deepEqual(after.items[0].value, ["d-9"]);
  assert.deepEqual(L.applyChoice(after, "c1", "d-9").items[0].value, ["d-9"], "重复选择不重复写入");
  assert.equal(L.applyChoice(d, "nope", "x"), d);
});

test("运行前清理：没填完的条件不参与查询并报出位置；空组去掉；目录里没有的字段交给服务端", async () => {
  const L = await lib();
  const def = { v: 1, logic: "and", includeExited: true, items: [
    { id: "c1", field: "dept", op: "in", value: [] },
    { id: "c2", field: "tenureMonths", op: "gte", value: 24 },
    { logic: "or", items: [{ id: "c3", field: "", op: "" }] },
    { logic: "or", items: [{ id: "c4", field: "potential", op: "in", value: ["High"] }, { id: "c5", field: "jobLevel", op: "between", value: { from: "PD1", to: null } }] },
    { id: "c6", field: "custom:gone", op: "equals", value: "x" },
    { id: "c7", field: "record", op: "exists", params: { type: "" } },
  ] };
  const { definition, incomplete } = L.cleanForRun(def, CATALOG);
  assert.deepEqual(incomplete, [[0], [2, 0], [3, 1], [5]]);
  assert.deepEqual(definition.items.map((x) => x.id || x.items.map((l) => l.id).join("+")), ["c2", "c4", "c6"]);
  assert.equal(definition.includeExited, true);
  assert.deepEqual(L.errorsByPath([{ path: "items[3].items[1].value", code: "bad_value" }, { path: "/items/0/op", code: "bad_op" }, { path: "", code: "too_large" }, { path: "items.0", code: "bad_op" }]),
    new Map([["3.1", ["bad_value"]], ["0", ["bad_op"]], ["", ["too_large"]]]));
  assert.equal(L.pathLabel([3, 1]), "4.2");
  assert.deepEqual(L.leafNotices(def, [{ id: "c4", reason: "module_off" }, { id: "c2", code: "value_unavailable", count: 2 }]),
    [{ code: "module_off", label: "4.1", count: null }, { code: "value_unavailable", label: "2", count: 2 }]);
});

test("条件摘要：中英文，部门含下级、职级区间、近 N 期绩效、司龄、违纪时间窗与严重度、条件组括号、含已离职、未设条件", async () => {
  const L = await lib();
  const def = { v: 1, logic: "and", items: [
    { id: "c1", field: "dept", op: "in", value: ["d1"] },
    { id: "c2", field: "jobLevel", op: "between", value: { from: "PD1", to: "PD3" } },
    { id: "c3", field: "perfRecent", op: "atLeast", value: "A", params: { n: 2, mode: "all", periodKind: "any", missing: "fail" } },
    { id: "c4", field: "tenureMonths", op: "gte", value: 24 },
    { id: "c5", field: "violation", op: "none", params: { months: 12, severity: ["Major"] } },
    { logic: "or", items: [{ id: "c6", field: "potential", op: "in", value: ["High"] }, { id: "c7", field: "nextLevelExists", op: "isTrue" }] },
  ] };
  const ctx = { deptLabel: (id) => (id === "d1" ? "Finance" : id) };
  assert.equal(L.summarize(def, CATALOG, "zh", ctx),
    "满足全部：部门 Finance（含下级） · 职级 PD1–PD3 · 近 2 期绩效均不低于 A · 司龄不少于 24 个月 · 近 12 个月无重大违纪记录 · （潜力：高 或 有下一职级）");
  assert.equal(L.summarize(def, CATALOG, "en", ctx),
    "Match all: Department Finance (incl. sub-departments) · Job level PD1–PD3 · Last 2 ratings all A or above · Tenure at least 24 months · No major disciplinary record in the last 12 months · (Potential: High or Has a next job level)");
  assert.equal(L.summarize({ v: 1, logic: "or", items: [{ id: "c1", field: "perfRecent", op: "atLeast", value: "A+", params: { n: 1 } }], includeExited: true }, CATALOG, "zh"),
    "满足任一：最近一期绩效不低于 A+ · 含已离职员工");
  assert.equal(L.summarize({ v: 1, logic: "and", items: [{ id: "c1", field: "perfRecent", op: "atLeast", value: "A", params: { n: 3, mode: "atLeastK", k: 2, periodKind: "quarter" } }] }, CATALOG, "en"),
    "Match all: At least 2 of the last 3 ratings A or above (quarterly)");
  assert.equal(L.summarize(L.emptyFilter(), CATALOG, "zh"), "未设条件：列出数据范围内的全部在职员工");
  assert.equal(L.summarize(L.emptyFilter(), CATALOG, "en"), "No conditions: everyone active in your data scope");
  // 没填完的条件标出来；name: 伪 id 没有名称时取原文
  assert.equal(L.summarize({ v: 1, logic: "and", items: [{ id: "c1", field: "tenureMonths", op: "gte", value: null }] }, CATALOG, "zh"), "满足全部：司龄不少于  个月（待填写）");
  assert.equal(L.summarize({ v: 1, logic: "and", items: [{ id: "c1", field: "dept", op: "notIn", value: ["name:ops"] }] }, CATALOG, "en"), "Match all: Department not name:ops (incl. sub-departments)");
  // 多值超过 3 个写「等 N 项」；记录类型取目录名称
  assert.equal(L.summarize({ v: 1, logic: "and", items: [{ id: "c1", field: "position", op: "in", value: ["a", "b", "c", "d"] }] }, CATALOG, "zh"), "满足全部：岗位：a、b、c 等 4 项");
  assert.equal(L.summarize({ v: 1, logic: "and", items: [{ id: "c1", field: "record", op: "exists", params: { type: "award", months: 24 } }] }, CATALOG, "zh"), "满足全部：近 24 个月有「荣誉」记录");
  assert.equal(L.itemSummary({ id: "c1", field: "violation", op: "none", params: { months: 6, severity: [] } }, CATALOG, "zh"), "近 6 个月无违纪记录");
  assert.equal(L.itemSummary({ logic: "or", items: [{ id: "c1", field: "nextLevelExists", op: "isFalse" }] }, CATALOG, "en"), "At the top level (no next job level)");
});

test("字段分组与可用性、结果列（显示、增删、上移下移、姓名列锁定）、命中标记、晋升评审候选行操作、批量结果、文件名", async () => {
  const L = await lib();
  const g = L.groupedFields(CATALOG, "zh");
  assert.equal(g[0].label, "组织");
  assert.deepEqual(g[0].fields.map((x) => x.value), ["dept", "position"], "同组字段归到一起");
  assert.equal(g.find((x) => x.label === "培训").fields[0].disabled, true, "模块关闭的字段不可选");
  // 列
  assert.deepEqual(L.DEFAULT_COLUMNS, ["name", "employeeId", "department", "jobLevel", "latestRating", "potential", "tenure"]);
  assert.deepEqual(L.toggleColumn(["name", "jobLevel"], "name"), ["name", "jobLevel"], "姓名列不能去掉");
  assert.deepEqual(L.toggleColumn(["name", "jobLevel"], "jobLevel"), ["name"]);
  assert.deepEqual(L.toggleColumn(["name"], "potential"), ["name", "potential"]);
  assert.deepEqual(L.moveColumn(["name", "a", "b"], "b", -1), ["name", "b", "a"]);
  assert.deepEqual(L.moveColumn(["name", "a"], "name", -1), ["name", "a"]);
  assert.equal(L.displayCell("potential", "High", CATALOG, "zh"), "高", "选项值按当前语言显示");
  assert.equal(L.displayCell("potential", "High", CATALOG, "en"), "High");
  assert.equal(L.displayCell("empStatus", "regular", CATALOG, "zh"), "正式", "列目录自带选项");
  assert.equal(L.displayCell("recentRatings", ["A", "B"], CATALOG, "zh"), "A · B");
  assert.equal(L.displayCell("x", { value: "v", label: "En", label_zh: "中" }, CATALOG, "zh"), "中");
  assert.equal(L.displayCell("trainingMandatory", { done: 3, total: 5 }, CATALOG, "zh"), "3/5");
  assert.equal(L.displayCell("x", null, CATALOG, "zh"), "—");
  assert.equal(L.displayCell("x", true, CATALOG, "en"), "yes");
  assert.equal(L.cellOf({ cells: { name: "Ann" }, name: "x" }, "name"), "Ann");
  assert.equal(L.cellOf({ name: "Ann" }, "name"), "Ann");
  // 命中
  const def = { items: [{ id: "c1" }, { logic: "or", items: [{ id: "c2" }, { id: "c3" }] }, { id: "c4" }] };
  assert.deepEqual(L.topHits(def, { explain: { c1: true, c2: false, c3: true } }), [true, true, null]);
  assert.deepEqual(L.topHits(def, { hits: { c1: { ok: false }, c2: false, c3: false, c4: null } }), [false, false, null]);
  // 晋升评审候选行操作
  assert.equal(L.promoRowAction({ eligible: true }), "exclude");
  assert.equal(L.promoRowAction({ eligible: true, member: "include" }), "uninclude");
  assert.equal(L.promoRowAction({ eligible: false, member: "exclude" }), "restore");
  assert.equal(L.promoRowAction({ eligible: false }), null);
  assert.deepEqual(L.includePreview([{ eligible: true, nextLevel: "PD2" }, { member: "include" }, { eligible: false, nextLevel: null }, { eligible: false, nextLevel: "PD3" }]), { already: 2, noNext: 1 });
  assert.equal(L.positionKey("  Head   of Ops "), "head of ops");
  // 批量结果
  assert.deepEqual(L.bulkOutcome({ created: ["T-1", "T-2"], skipped: [{ employeeId: "T-3", userId: "u3", code: "already_listed" }] }),
    { done: 2, skipped: [{ id: "u3", employeeId: "T-3", code: "already_listed" }] });
  assert.deepEqual(L.bulkOutcome({ results: [{ id: "a", ok: true }, { id: "b", ok: false, code: "inactive" }] }), { done: 1, skipped: [{ id: "b", employeeId: null, code: "inactive" }] });
  assert.deepEqual(L.bulkOutcome(null), { done: 0, skipped: [] });
  assert.equal(L.exportFileName("High potential / Finance", new Date(2026, 9, 8)), "talent-filter-High-potential-Finance-20261008.csv");
  assert.equal(L.exportFileName("", new Date(2026, 0, 2)), "talent-filter-adhoc-20260102.csv");
  assert.deepEqual(L.recordTypeFilter("award").items[0], { id: "c1", field: "record", op: "exists", params: { type: "award", months: 0, fields: {} } });
});

test("临时筛选草稿：localStorage 读写都包 try/catch，坏数据与异常不抛出", async () => {
  const L = await lib();
  const mem = new Map();
  const store = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, v), removeItem: (k) => mem.delete(k) };
  assert.equal(L.readDraft(store), null);
  assert.equal(L.writeDraft(store, { definition: { v: 1, logic: "or", items: [{ field: "dept", op: "in", value: ["d1"] }] }, columns: ["name", "potential"] }), true);
  const d = L.readDraft(store);
  assert.equal(d.definition.logic, "or");
  assert.equal(d.definition.items[0].id, "c1", "读回时补 id");
  assert.deepEqual(d.columns, ["name", "potential"]);
  mem.set(L.DRAFT_KEY, "{not json");
  assert.equal(L.readDraft(store), null);
  const boom = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); }, removeItem() { throw new Error("blocked"); } };
  assert.equal(L.readDraft(boom), null);
  assert.equal(L.writeDraft(boom, { definition: {} }), false);
  assert.equal(L.writeDraft(store, null), true);
  assert.equal(L.readDraft(store), null);
});

test("页面接线：路由、三个页签、继任卡「批量导入」与就绪度下拉加宽、晋升条件卡改为说明、AI 功能登记、审计标签", () => {
  const app = read("web", "src", "App.jsx");
  assert.match(app, /const TalentFilter = lazy\(\(\) => import\('\.\/pages\/admin\/TalentFilter\.jsx'\)\);/);
  assert.match(app, /const SuccessionImport = lazy\(\(\) => import\('\.\/pages\/admin\/SuccessionImport\.jsx'\)\);/);
  assert.match(app, /\{on\('talent'\) && <Route path="talent-review\/filter\/:id" element=\{<TalentFilter \/>\} \/>\}/);
  assert.match(app, /\{on\('talent'\) && <Route path="talent-review\/succession-import" element=\{<SuccessionImport \/>\} \/>\}/);
  const tr = read("web", "src", "pages", "admin", "TalentReview.jsx");
  assert.match(tr, /<FilterListCard data-section=\{s\.filtersTitle\}/);
  assert.ok(!/function SearchCard|api\.post\('\/api\/admin\/talent-search'/.test(tr), "原人才检索卡已删除，前端不再调用 talent-search");
  assert.match(tr, /navigate\('\/admin\/talent-review\/succession-import'\)/);
  assert.match(tr, /<Select value=\{ready\} onChange=\{setReady\} style=\{\{ minWidth: 200 \}\} dropdownMatchSelectWidth=\{false\}/, "录入行就绪度 ≥ 200px");
  assert.match(tr, /style=\{\{ minWidth: 168 \}\} dropdownMatchSelectWidth=\{false\}/, "行内就绪度 ≥ 168px");
  assert.match(tr, /<SettingsWorkspace initial=\{initialTab\}>/);
  assert.match(tr, /exclude' && !reason\.trim\(\)/, "排除必须写理由");
  const ts = read("web", "src", "pages", "admin", "TalentSettings.jsx");
  assert.ok(!ts.includes("api.put('/api/admin/promotion-config'"), "设置页不再直接改晋升条件");
  assert.match(ts, /navigate\('\/admin\/talent-review'\)/);
  const tf = read("web", "src", "pages", "admin", "TalentFilter.jsx");
  assert.match(tf, /useLeaveGuard\(canWrite && dirty, s\.leaveAsk\)/);
  assert.match(tf, /const AI_SHOWN = \['on', 'demo', 'not_configured', 'budget_exhausted'\];/, "off_* 时不显示 AI 输入框");
  assert.match(tf, /if \(!runKey \|\| aiPending \|\| runKey === lastKey\.current\) return undefined;/, "AI 生成的条件不自动查询");
  assert.match(tf, /setTimeout\(\(\) => doRun\(JSON\.parse\(runKey\)\), 400\)/, "防抖 400 ms");
  assert.match(tf, /const canExport = canReadDomain\(user, 'people'\);/, "导出与人才记录 CSV 同一判定");
  assert.match(read("web", "src", "pages", "admin", "AiGovernance.jsx"), /'translate', 'talentFilter', 'test'\]/);
  assert.match(read("web", "src", "pages", "admin", "Modules.jsx"), /talentFilter: 'HR 在人才筛选中/);
  const audit = read("web", "src", "pages", "admin", "Audit.jsx");
  for (const a of ["talent.filter.create", "talent.filter.update", "talent.filter.delete", "talent.filter.members", "export.talent-filter", "succession.bulk-add", "succession.import"])
    assert.ok(audit.includes(`'${a}': { zh: '`), "审计标签 " + a);
});
