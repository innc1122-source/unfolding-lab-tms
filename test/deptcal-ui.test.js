// 第二批 W1-B 共享前端件（2026-10-08）：deptcal.js / deptfilter.js / urlstate.js / reviewcodes.js 的纯函数用 vm 直接跑
// （去掉 import / export 再求值，不起浏览器、不打包）；DeptCalibration / DeptFilter / useLeaveGuard 做源码断言：
// 不引用 Semi（员工端包里没有 Semi）、hook 都在提前 return 之前（审查 P1-17）、离开守卫的全局登记与「每个挂载只垫一次」
// （P1-6）、地址栏参数「合并 + 层级键 push、筛选 replace」（P1-15）、草稿按「周期 + 一级部门」存 sessionStorage；
// app.css 末尾追加的 .dpf-* / .dcal-* 不写死颜色。
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
const SRC = path.join(ROOT, "web", "src");
const read = (...p) => fs.readFileSync(path.join(SRC, ...p), "utf8");
// 跨 realm 的对象不能直接 deepStrictEqual（原型不同）：先 JSON 往返
const J = (x) => JSON.parse(JSON.stringify(x));

function load(rel, stubs = {}) {
  let src = read(...rel.split("/"));
  const names = [...src.matchAll(/^export\s+(?:async\s+)?(?:function|const|let)\s+(\w+)/gm)].map((m) => m[1]);
  src = src
    .replace(/^import[\s\S]*?from\s+['"][^'"]+['"];?[ \t]*$/gm, "")
    .replace(/^export\s+default\s+\w+;?[ \t]*$/gm, "")
    .replace(/^export\s+default\s+/gm, "")
    .replace(/^export\s+/gm, "");
  const ctx = vm.createContext({ URLSearchParams, console, ...stubs });
  vm.runInContext(src + "\n;globalThis.__x = {" + names.join(",") + "};", ctx, { filename: rel });
  ctx.__x.__Set = vm.runInContext("Set", ctx);
  return ctx.__x;
}

const dc = load("deptcal.js");
const df = load("deptfilter.js", { useEffect() {}, useState() {}, api: {} });
const us = load("urlstate.js", { useCallback() {}, useMemo() {}, useSearchParams() {} });
const rc = load("reviewcodes.js");

const R = (id, extra = {}) => ({
  id, userId: "u" + id, name: "N" + id, employeeId: "E" + id, department: "D", deptPath: ["l1", "l2"], jobLevel: "P3", jobGrade: 3,
  managerId: "m1", manager: "Mgr One", managerStatus: "active", selfAt: "2026-10-01T01:00:00.000Z", oneOnOneAt: null, employeeOneOnOneAt: null,
  managerRating: null, highlights: "", finalRating: null, hodText: "", hodProxy: null, notCounted: null, overdue: [], locked: false, editable: true,
  ...extra,
});

// ---------- deptcal.js ----------
test("deptcal: 生效评级、C/D 合并档、面谈四态、代评类型兼容字符串 / 迁移 69 对象 / 空", () => {
  assert.equal(dc.bucketOf("C"), "C/D");
  assert.equal(dc.bucketOf("D"), "C/D");
  assert.equal(dc.bucketOf("A+"), "A+");
  assert.equal(dc.effectiveOf({ managerRating: "B", finalRating: "A" }), "A");
  assert.equal(dc.effectiveOf({ managerRating: "B" }), "B");
  assert.deepEqual(["both", "mgr", "emp", "none"].map((k) => dc.oneStateOf({ oneState: k })), ["both", "mgr", "emp", "none"]);
  assert.equal(dc.oneStateOf({ oneOnOneAt: "x", employeeOneOnOneAt: "y" }), "both");
  assert.equal(dc.oneStateOf({ employeeOneOnOneAt: "y" }), "emp");
  assert.equal(dc.proxyOf({ hodProxy: "manager_departed" }), "manager_departed");
  assert.equal(dc.proxyOf({ hodProxy: { by: "h", at: "t", reason: "r" }, managerStatus: "departed" }), "manager_departed");
  assert.equal(dc.proxyOf({ hodProxy: { by: "h", at: "t", reason: "r" }, managerStatus: "active" }), "manager_pending");
  assert.equal(dc.proxyOf({ hodProxy: { type: "manager_pending" }, managerStatus: "departed" }), "manager_pending");
  assert.equal(dc.proxyOf({ hodProxy: null }), null);
});

test("deptcal: 草稿合成、改动清单带 expect（审查 P1-4）、恢复时只留可改的行", () => {
  const rows = [R("a", { managerRating: "B" }), R("b"), R("c", { managerRating: "A", finalRating: "B", hodText: "x" })];
  const drafts = { a: { rating: "A", reason: "great" }, b: { rating: "B+", reason: "proxy why" }, c: { rating: "B", reason: "x" } };
  const applied = dc.applyDrafts(rows, drafts, { kind: "quarter" });
  assert.equal(applied[0].finalRating, "A");
  assert.equal(applied[0].adjusted, true);
  assert.equal(applied[0]._draft, true);
  assert.equal(applied[1].hodProxy, "manager_pending", "上级在职、未评 → 代评类型 manager_pending");
  assert.equal(applied[2], rows[2], "草稿与已保存值相同 → 原对象，不算改动");
  assert.deepEqual(J(dc.buildChanges(rows, drafts)), [
    { id: "a", rating: "A", reason: "great", expect: { managerRating: "B", finalRating: null } },
    { id: "b", rating: "B+", reason: "proxy why", expect: { managerRating: null, finalRating: null } },
  ]);
  const departed = dc.applyDrafts([R("d", { managerStatus: "departed" })], { d: { rating: "A", reason: "r" } }, {});
  assert.equal(departed[0].hodProxy, "manager_departed");
  assert.equal(dc.applyDrafts([R("e")], { e: { rating: "A", reason: "" } }, { kind: "annual" })[0].hodProxy, null, "年度周期不算代评");
  const clean = dc.sanitizeDrafts({ a: { rating: "A", reason: "r" }, gone: { rating: "A" }, l: { rating: "A" }, x: { rating: "A" }, z: { rating: null, reason: "" } },
    [R("a"), R("l", { locked: true }), R("x", { notCounted: "departed" }), R("z")]);
  assert.deepEqual(J(clean), { a: { rating: "A", reason: "r" } });
});

test("deptcal: 草稿记 base，expect 按 base 发；base 与现在的行对不上的草稿在恢复 / 刷新时丢掉，不悄悄换成新值（审查 P1-4 的绕过）", () => {
  // 打开时 b 上级未评 → HoD 起草代评 A（base 记下 managerRating null）
  const base = dc.draftBaseOf(R("b"));
  assert.deepEqual(J(base), { managerRating: null, finalRating: null });
  const drafts = { b: { rating: "A", reason: "上级逾期未评", base } };
  // 之后上级评了 B：按 base 发 expect，服务端会报 stale，而不是拿现在的 B 当 expect、把代评当成调整存下
  const now = [R("b", { managerRating: "B" })];
  assert.deepEqual(J(dc.buildChanges(now, drafts)), [{ id: "b", rating: "A", reason: "上级逾期未评", expect: { managerRating: null, finalRating: null } }]);
  assert.equal(dc.staleDraft(now[0], drafts.b), true);
  assert.equal(dc.staleDraft(R("b"), drafts.b), false);
  assert.equal(dc.staleDraft(R("b"), { rating: "A" }), false, "没有 base 的旧草稿不判");
  // 恢复 / 刷新：base 对不上 → 丢掉；对得上 → 保留且带着 base
  assert.deepEqual(J(dc.sanitizeDrafts(drafts, now)), {});
  assert.deepEqual(J(dc.sanitizeDrafts(drafts, [R("b")])), { b: { rating: "A", reason: "上级逾期未评", base: { managerRating: null, finalRating: null } } });
  // HoD 评级在别处被改了（finalRating 变了）同样算 stale
  assert.deepEqual(J(dc.sanitizeDrafts({ c: { rating: "B", reason: "x", base: { managerRating: "A", finalRating: null } } }, [R("c", { managerRating: "A", finalRating: "A+" })])), {});
});

test("deptcal: 理由与代评门槛（审查 P0-3）—— HoD 本人是直属上级走上级入口；上级在职且未过评级截止不能代评", () => {
  assert.equal(dc.reasonNeeded(R("a"), "A", "quarter"), "proxy");
  assert.equal(dc.reasonNeeded(R("a", { managerRating: "B" }), "A", "quarter"), "adjust");
  assert.equal(dc.reasonNeeded(R("a", { managerRating: "B" }), "B", "quarter"), null);
  assert.equal(dc.reasonNeeded(R("a"), "A", "annual"), null);
  assert.equal(dc.reasonNeeded(R("a"), null, "quarter"), null, "清空 HoD 评级不要理由");
  const ctx = { kind: "quarter", hodId: "hod1", today: "2026-10-08", dueRateAt: "2026-10-10" };
  assert.equal(dc.proxyGate(R("a", { managerId: "hod1" }), ctx), "use_manager_entry");
  assert.equal(dc.proxyGate(R("a"), ctx), "manager_not_overdue");
  assert.equal(dc.proxyGate(R("a"), { ...ctx, today: "2026-10-11" }), null, "过了评级截止日");
  assert.equal(dc.proxyGate(R("a", { managerStatus: "departed" }), ctx), null, "上级已离职");
  assert.equal(dc.proxyGate(R("a", { managerId: null, managerStatus: "none" }), ctx), null, "没有上级");
  assert.equal(dc.proxyGate(R("a", { managerRating: "B" }), ctx), null, "上级已评 = 调整，不是代评");
  assert.equal(dc.proxyGate(R("a", { finalRating: "A", hodProxy: "manager_pending" }), ctx), null, "已代评的行可改可清空");
  assert.equal(dc.proxyGate(R("a"), { ...ctx, kind: "annual" }), null);
  const rows = [R("a"), R("b", { managerRating: "B" }), R("c", { managerId: "hod1" }), R("d", { managerStatus: "departed" })];
  const errs = dc.validateChanges(rows, [
    { id: "a", rating: "A", reason: "" }, { id: "b", rating: "A", reason: " " }, { id: "c", rating: "A", reason: "r" }, { id: "d", rating: "A", reason: "" }, { id: "zz", rating: "A" },
  ], ctx);
  assert.deepEqual(J(errs), { a: "manager_not_overdue", b: "reason_required", c: "use_manager_entry", d: "proxy_reason_required", zz: "not_found" });
});

test("deptcal: 配额预览按草稿重算、离职者不计入、名额用服务端给的；范围不全（allowed 为 null）不算", () => {
  const rows = [
    R("1", { managerRating: "A" }), R("2", { managerRating: "A" }), R("3", { managerRating: "C" }), R("4", { managerRating: "D" }),
    R("5", { managerRating: "A", notCounted: "departed" }), R("6"),
  ];
  const allowed = { "A+": 0, A: 1, "B+": 1, B: 4, "C/D": 0 };
  const p = dc.quotaPreview(rows, allowed, {}, {});
  assert.deepEqual(J(p.counts), { A: 2, "C/D": 2 });
  assert.equal(p.headcount, 5);
  assert.deepEqual(J(p.over), [{ tier: "A", count: 2, allowed: 1 }], "C/D 不设上限，只有 A+ / A / B+ 判超额");
  const p2 = dc.quotaPreview(rows, allowed, { 2: { rating: "B", reason: "x" } }, {});
  assert.deepEqual(J(p2.over), [], "把一个 A 调成 B 后不再超额");
  assert.equal(dc.quotaPreview(rows, null, {}, {}), null);
  assert.deepEqual(J(dc.tiersOf(allowed, {})), ["A+", "A", "B+", "B", "C/D"]);
  assert.equal(dc.rowPending(R("x", { oneState: "both", managerRating: "A" }), new p.overTiers.constructor(["A"])), true, "落在超额档 = 待处理");
  assert.equal(dc.rowPending(R("x", { notCounted: "departed" }), null), false, "离职者不算待处理");
  // 年度周期没有面谈：评了级、不超额就不算待处理（与服务端 row.pending 一致，审查）
  assert.equal(dc.rowPending(R("x", { finalRating: "B" }), null, "annual"), false);
  assert.equal(dc.rowPending(R("x", { finalRating: "B" }), null, "quarter"), true, "季度：面谈未双方登记仍待处理");
  assert.equal(dc.rowPending(R("x"), null, "annual"), true, "年度：没评级仍待处理");
  assert.equal(dc.filterRows([R("y", { finalRating: "B" }), R("z")], { pending: "1" }, {}, { kind: "annual" }).map((r) => r.id).join(""), "z");
});

test("deptcal: 筛选 —— 部门按 id 不按位置（审查 P1-3）、上级、职级、面谈、上级评级、调整 / 代评、缺亮点、逾期、档位、待处理、点阻断项", () => {
  const rows = [
    R("a", { name: "Ann", deptPath: ["l2", "l3"], managerRating: "A", highlights: "", oneState: "both" }),
    R("b", { name: "Bob", deptPath: ["l1", "l2"], managerId: null, manager: null, managerStatus: "none", jobLevel: "", jobGrade: null, managerRating: "B", finalRating: "A", adjusted: true, oneState: "mgr" }),
    R("c", { name: "Cy", deptPath: ["l1"], finalRating: "C", hodProxy: "manager_departed", hodText: "", managerStatus: "departed", jobLevel: "X9", jobGrade: null, overdue: ["rate"] }),
    R("d", { name: "Dee", notCounted: "departed", managerRating: "D", highlights: "h" }),
  ];
  const f = (q, extra) => dc.filterRows(rows, q, {}, extra).map((r) => r.id).join("");
  assert.equal(f({ dept: "l2" }), "abd", "范围裁剪后 deptPath 从二级起，选二级照样命中");
  assert.equal(f({ dept: "l3" }), "a");
  assert.equal(f({ mgr: "__none" }), "b");
  assert.equal(f({ mgr: "m1" }), "acd");
  assert.equal(f({ lv: "g:3" }), "ad");
  assert.equal(f({ lv: "r:p3" }), "ad", "职级不分大小写");
  assert.equal(f({ lv: "none" }), "b");
  assert.equal(f({ lv: "nogrid" }), "c");
  assert.equal(f({ one: "mgr" }), "b");
  assert.equal(f({ one: "none" }), "cd");
  assert.equal(f({ mr: "none" }), "c");
  assert.equal(f({ mr: "A" }), "a");
  assert.equal(f({ adj: "adj" }), "b");
  assert.equal(f({ adj: "proxy" }), "c");
  assert.equal(f({ adj: "no" }), "ad");
  assert.equal(f({ hl: "1" }), "ac", "A 缺上级亮点；代评 C 缺理由（G1）；D 有亮点");
  assert.equal(f({ od: "1" }), "c");
  assert.equal(f({ od: "rate" }), "c");
  assert.equal(f({ tier: "C/D" }), "cd");
  assert.equal(f({ q: "bo" }), "b");
  assert.equal(f({ q: "eb" }), "b", "工号也能搜");
  assert.equal(f({ pending: "1" }), "bc", "a 已评且面谈双方登记；d 离职不算");
  assert.equal(f({ pending: "1" }, { overTiers: new dc.__Set(["A"]) }), "abc", "落在超额档也算待处理");
  assert.equal(f({}, { ids: new dc.__Set(["b", "d"]) }), "bd");
  // 正在改的行不被筛掉
  const applied = dc.applyDrafts(rows, { a: { rating: "B", reason: "r" } }, {});
  assert.equal(dc.filterRows(applied, { tier: "A" }, { a: { rating: "B", reason: "r" } }).map((r) => r.id).join(""), "ab");
});

test("deptcal: 排序、按上级分组（无上级一组排最后；已评 / 人数只数计入的人）、进度、上级与职级选项", () => {
  const rows = [
    R("1", { name: "Zed", managerId: "m2", manager: "Amy", managerRating: "B" }),
    R("2", { name: "Al", managerRating: "A+" }),
    R("3", { name: "Bo", managerId: null, manager: null, managerStatus: "none" }),
    R("4", { name: "Cy", notCounted: "departed", managerRating: "C", department: "AAA" }),
  ];
  assert.equal(dc.sortRows(rows, "rating").map((r) => r.id).join(""), "2143");
  assert.equal(dc.sortRows(rows, "name").map((r) => r.id).join(""), "2341");
  assert.equal(dc.sortRows(rows, "dept")[0].id, "4");
  const g = dc.groupByManager(rows);
  assert.deepEqual(J(g.map((x) => [x.key, x.manager, x.total, x.rated, x.rows.length])), [["m2", "Amy", 1, 1, 1], ["m1", "Mgr One", 1, 1, 2], ["__none", null, 1, 0, 1]]);
  assert.deepEqual(J(dc.progressOf(rows)), { total: 3, self: 3, one: 0, rated: 2 });
  assert.deepEqual(J(dc.managerOptions(rows)), [{ id: "m2", name: "Amy", status: "active" }, { id: "m1", name: "Mgr One", status: "active" }, { id: "__none", name: "", status: "none" }]);
  const lv = dc.levelOptions([R("a", { jobLevel: "P10", jobGrade: 10 }), R("b", { jobLevel: "p2", jobGrade: 2 }), R("c", { jobLevel: "", jobGrade: null }), R("d", { jobLevel: "Z1", jobGrade: null })]);
  assert.deepEqual(J(lv.map((o) => o.value)), ["g:2", "g:10", "r:p2", "r:P10", "r:Z1", "nogrid", "none"]);
  assert.equal(dc.matchLevel({ jobLevel: "P3" }, ""), true);
});

test("deptcal: 看板复用 —— stageOf 阶段、mgrDist 按上级看分布（排除代评与离职，阈值常量）", () => {
  const depts = [
    { dept1Id: "d1", hod: { id: "h" }, status: null },
    { dept1Id: "d2", hod: { id: "h2" }, status: { hodSubmittedAt: "t" } },
    { dept1Id: "d3", hod: { id: "h3" }, status: { hrConfirmedAt: "t", hodSubmittedAt: "t" } },
    { dept1Id: "none", hod: null, hodOwned: false, status: null },
  ];
  const it = (x) => ({ selfAt: "t", dept1Id: "d1", ...x });
  assert.equal(dc.stageOf(it({ selfAt: null }), depts), "self");
  assert.equal(dc.stageOf(it({}), depts), "one");
  assert.equal(dc.stageOf(it({ oneOnOneAt: "a", employeeOneOnOneAt: "b" }), depts), "rate");
  assert.equal(dc.stageOf(it({ managerRating: "B" }), depts), "hod", "面谈不是前提：评了就等部门提交");
  assert.equal(dc.stageOf(it({ dept1Id: "d2" }), depts), "hr");
  assert.equal(dc.stageOf(it({ dept1Id: "d3", finalRating: "A" }), depts), "confirmed");
  assert.equal(dc.stageOf(it({ dept1Id: "d3" }), depts), "norating");
  assert.equal(dc.stageOf(it({ dept1Id: "none", managerRating: "B" }), depts), "hr", "无 HoD 的组由 HR 直接确认");
  assert.equal(dc.stageOf(it({}), depts, "annual"), "hod");
  assert.equal(dc.stageOf(it({}), new Map(depts.map((d) => [d.dept1Id, d]))), "one");

  const opts = ["A+", "A", "B+", "B", "C", "D"];
  const items = [];
  for (let i = 0; i < 5; i++) items.push({ managerId: "loose", manager: "L", managerRating: "A" });
  for (let i = 0; i < 5; i++) items.push({ managerId: "tight", manager: "T", managerRating: "C" });
  for (let i = 0; i < 2; i++) items.push({ managerId: "few", manager: "F", managerRating: "B" });
  items.push({ managerId: "tight", manager: "T", managerRating: "A+", hodProxy: "manager_pending" });
  items.push({ managerId: "tight", manager: "T", managerRating: "A+", notCounted: "departed" });
  const m = dc.mgrDist(items, opts);
  assert.equal(m.overall.n, 12, "代评与离职不计");
  const byId = Object.fromEntries(m.rows.map((r) => [r.managerId, r]));
  assert.equal(byId.loose.tag, "loose");
  assert.equal(byId.tight.tag, "tight");
  assert.equal(byId.few.tag, "few");
  assert.equal(dc.MGR_DIST_MIN, 5);
  assert.equal(dc.MGR_DIST_DIFF, 0.5);
});

test("deptcal 波次 3：stageOf 年度周期没有自评这一步（未交自评也不落在 self）；无 HoD 的组记为 hr", () => {
  const depts = [
    { dept1Id: "d1", hod: { id: "h" }, hodOwned: true, status: null },
    { dept1Id: "d2", hod: null, hodOwned: false, status: null },
    { dept1Id: "d3", hod: { id: "h3" }, hodOwned: true, status: { hodSubmittedAt: "t" } },
    { dept1Id: "d4", hod: { id: "h4" }, hodOwned: true, status: { hodSubmittedAt: "t", hrConfirmedAt: "t" } },
    // 旧接口没有 hodOwned：有提交记录（hodId）就算归 HoD
    { dept1Id: "d5", hod: null, status: { hodId: "x" } },
  ];
  const it = (x) => ({ dept1Id: "d1", selfAt: null, managerRating: null, finalRating: null, ...x });
  assert.equal(dc.stageOf(it({}), depts, "annual"), "hod", "年度、未交自评 → 等 HoD，不是 self");
  assert.equal(dc.stageOf(it({ finalRating: "A" }), depts, "annual"), "hod");
  assert.equal(dc.stageOf(it({ dept1Id: "d2" }), depts, "annual"), "hr", "无 HoD 的组由 HR 直接确认");
  assert.equal(dc.stageOf(it({ dept1Id: "d3" }), depts, "annual"), "hr");
  assert.equal(dc.stageOf(it({ dept1Id: "d4", finalRating: "B" }), depts, "annual"), "confirmed");
  assert.equal(dc.stageOf(it({ dept1Id: "d4" }), depts, "annual"), "norating");
  assert.equal(dc.stageOf(it({ kind: "annual" }), depts), "hod", "不传 kind 时看条目自带的 kind");
  assert.equal(dc.stageOf(it({ dept1Id: "d5" }), depts, "annual"), "hod");
  // 季度不变：未交自评仍是 self
  assert.equal(dc.stageOf(it({}), depts, "quarter"), "self");
  assert.equal(dc.stageOf(it({}), depts), "self");
  // 与后台 ReviewCycles 的旧绕法（年度条目 selfAt 代入 'n/a'）结果相同
  assert.equal(dc.stageOf(it({ selfAt: "n/a", kind: "annual" }), depts, "annual"), dc.stageOf(it({}), depts, "annual"));
});

test("deptcal 波次 3：已关闭周期按档案评级计数（ratingOf：行上有 recordRating 字段时以它为准，null = 档案已删）", () => {
  assert.equal(dc.ratingOf({ finalRating: "A", managerRating: "B", recordRating: "B+" }), "B+");
  assert.equal(dc.ratingOf({ finalRating: "A", recordRating: null }), null, "档案记录已删 → 无评级");
  assert.equal(dc.ratingOf({ finalRating: null, managerRating: "B" }), "B", "没有 recordRating 字段（进行中周期、HoD 视图）→ 生效评级");
  assert.equal(dc.ratingOf(null), null);
  const rows = [
    R("1", { name: "A1", managerRating: "A", recordRating: "B", amendedFrom: "A", oneState: "both" }),
    R("2", { name: "A2", managerRating: "A", recordRating: "A", oneState: "both" }),
    R("3", { name: "A3", managerRating: "B", recordRating: null, oneState: "both" }),
    R("4", { name: "A4", managerRating: "C", recordRating: "C", notCounted: "departed" }),
  ];
  const p = dc.quotaPreview(rows, { "A+": 0, A: 1, "B+": 1, B: 4, "C/D": 0 }, {}, {});
  assert.deepEqual(J(p.counts), { B: 1, A: 1 }, "1 号关闭后从 A 改成 B：按档案计 B；3 号档案已删不计");
  assert.deepEqual(J(p.over), [], "按档案评级不再超额");
  assert.deepEqual(J(dc.progressOf(rows)), { total: 3, self: 3, one: 3, rated: 2 });
  assert.equal(dc.filterRows(rows, { tier: "B" }, {}).map((r) => r.id).join(""), "1");
  assert.equal(dc.filterRows(rows, { tier: "A" }, {}).map((r) => r.id).join(""), "2");
  assert.equal(dc.filterRows(rows, { mr: "A" }, {}).map((r) => r.id).join(""), "12", "上级评级筛选仍看上级当时给的评级");
  assert.equal(dc.filterRows(rows, { pending: "1" }, {}).map((r) => r.id).join(""), "3", "档案已删的人没有评级 → 待处理");
  assert.equal(dc.sortRows(rows, "rating").map((r) => r.id).join(""), "2143");
  assert.deepEqual(J(dc.groupByManager(rows).map((g) => [g.total, g.rated])), [[3, 2]]);
  // 看板的阶段：已确认的部门按档案评级判 confirmed / norating
  const depts = [{ dept1Id: "d", hod: { id: "h" }, hodOwned: true, status: { hrConfirmedAt: "t", hodSubmittedAt: "t" } }];
  assert.equal(dc.stageOf({ dept1Id: "d", selfAt: "t", managerRating: "B", recordRating: null }, depts), "norating");
  assert.equal(dc.stageOf({ dept1Id: "d", selfAt: "t", recordRating: "B" }, depts), "confirmed");
});

test("deptcal 波次 3：已确认的本地时间与确认人（O1）、无 HoD 的组判定", () => {
  const ts = new Date(2026, 9, 8, 7, 5).toISOString();
  assert.equal(dc.localStamp(ts), "2026-10-08 07:05", "本地时间，不是 UTC 截取");
  assert.equal(dc.localStamp("2026-10-08"), "2026-10-08");
  assert.equal(dc.localStamp(""), "");
  assert.equal(dc.localStamp(null), "");
  assert.equal(dc.confirmerOf({ hrName: "Ana" }), "Ana");
  assert.equal(dc.confirmerOf({ hrBy: { name: "Ben" } }), "Ben");
  assert.equal(dc.confirmerOf({ confirmedBy: { name: "Cy" } }), "Cy");
  assert.equal(dc.confirmerOf({ confirmedByName: "Di" }), "Di");
  assert.equal(dc.confirmerOf({ hrConfirmedAt: "t" }), "");
  assert.equal(dc.confirmerOf(null), "");
  assert.equal(dc.noHodOf({ hodOwned: false, hod: null }), true);
  assert.equal(dc.noHodOf({ hodOwned: true, hod: null }), false, "HoD 提交后被撤换：仍归 HoD");
  assert.equal(dc.noHodOf({ hod: { id: "h" } }), false);
  assert.equal(dc.noHodOf({ hod: null, status: { hodSubmittedAt: "t" } }), false);
  assert.equal(dc.noHodOf({ hod: null, status: null }), true);
  assert.equal(dc.noHodOf(null), false);
});

test("deptcal: 提醒结果按原因汇总；面谈日期按本地日显示（审查 P2）", () => {
  const s = dc.remindSummary({ ok: true, total: 4, done: 1, unchanged: 0, results: [
    { id: "a", ok: true }, { id: "b", ok: false, code: "no_manager" }, { id: "c", ok: false, code: "no_manager" }, { id: "d", ok: false, code: "cooldown" },
  ] });
  assert.deepEqual(J(s), { done: 1, unchanged: 0, reminded: 1, groups: [{ code: "no_manager", n: 2, ids: ["b", "c"] }, { code: "cooldown", n: 1, ids: ["d"] }] });
  // done 含「未改动」（加载后上级刚评了的人）：提醒到的人数 = done − unchanged（审查）
  assert.equal(dc.remindSummary({ done: 2, unchanged: 1, results: [{ id: "a", ok: true }, { id: "b", ok: true, unchanged: true }] }).reminded, 1);
  assert.equal(dc.localDay("2026-10-07"), "2026-10-07");
  const iso = "2026-10-07T23:30:00.000Z";
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, "0");
  assert.equal(dc.localDay(iso), `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`);
  assert.equal(dc.localDay(""), "");
});

// ---------- deptfilter.js ----------
const TREE = {
  options: [
    { id: "l2a", name: "AP", parentId: null, level: 2, path: "AP" },
    { id: "l3a", name: "Payables", parentId: "l2a", level: 3, path: "AP › Payables", count: 4 },
    { id: "l2b", name: "Treasury", parentId: null, level: 2, path: "Treasury", inactive: true },
    { id: "name:legacy", name: "Legacy", parentId: null, level: null, path: "Legacy" },
  ],
  idByName: { AP: "l2a", Payables: "l3a", "Deep Team": "l4", Treasury: "l2b", Legacy: "name:legacy" },
  chainById: { l2a: ["l2a"], l3a: ["l2a", "l3a"], l4: ["l2a", "l3a", "l4"], l2b: ["l2b"], "name:legacy": ["name:legacy"] },
};

test("deptfilter: deptMatcher 用服务端的 idByName / chainById（原文、去空白、不分大小写依次回退）；__none、多选、树未加载", () => {
  const m = df.deptMatcher(TREE, "l2a");
  assert.deepEqual(["AP", "Payables", "Deep Team", " deep team ", "Treasury", "Legacy", ""].map(m), [true, true, true, true, false, false, false]);
  const leg = df.deptMatcher(TREE, "name:legacy");
  assert.deepEqual(["Legacy", "LEGACY", "AP"].map(leg), [true, true, false]);
  const none = df.deptMatcher(TREE, "__none");
  assert.deepEqual(["", null, "AP"].map(none), [true, true, false]);
  const multi = df.deptMatcher(TREE, ["l2b", "__none"]);
  assert.deepEqual(["Treasury", "", "AP"].map(multi), [true, true, false]);
  assert.equal(df.deptMatcher(TREE, null)("anything"), true);
  assert.equal(df.deptMatcher(null, "l2a")("anything"), true, "树还没加载 / 不可用：不误删行");
  assert.equal(df.deptMatcher(TREE, "l2a")("Unknown Dept"), false);
  const pm = df.pathMatcher("l3a");
  assert.deepEqual([{ deptPath: ["l2a", "l3a"] }, { deptPath: ["l2a"] }, { deptPath: [] }].map(pm), [true, false, false]);
  assert.equal(df.pathMatcher("__none")({ deptPath: [] }), true);
});

test("deptfilter: 分列按裁剪后的 parentId 深度（根可以是二级部门，审查 P2）；伪选项排在根列末尾；搜索与祖先链", () => {
  const L = df.deptLayout(TREE.options);
  assert.deepEqual(J(L.roots.map((o) => o.id)), ["l2a", "l2b", "name:legacy"]);
  assert.equal(L.depthOf.get("l2a"), 0, "全树二级、裁剪后是根 → 第 1 列");
  assert.equal(L.depthOf.get("l3a"), 1);
  assert.equal(L.maxDepth, 1);
  assert.deepEqual(J((L.children.get("l2a") || []).map((o) => o.id)), ["l3a"]);
  assert.deepEqual(J(df.ancestorIds(L, "l3a")), ["l2a", "l3a"]);
  assert.deepEqual(J(df.searchDepts(TREE.options, "pay").map((o) => o.id)), ["l3a"]);
  assert.deepEqual(J(df.searchDepts(TREE.options, "ap").map((o) => o.id)), ["l2a", "l3a"], "名称开头排前，路径包含排后");
  assert.deepEqual(J(df.searchDepts(TREE.options, "  ")), []);
  // 脏数据：parentId 成环也不丢选项
  const loop = df.deptLayout([{ id: "x", name: "X", parentId: "y", level: 2 }, { id: "y", name: "Y", parentId: "x", level: 3 }]);
  assert.equal(loop.byId.size, 2);
  assert.ok(loop.depthOf.has("x") && loop.depthOf.has("y"));
});

// ---------- urlstate.js ----------
test("urlstate: 合并旧参数（不整串覆盖）、null 删除、clear、层级键变了才 push（审查 P1-15）、C/D 编码", () => {
  const prev = new URLSearchParams("view=hod&cycle=c1&unit=u1&q=ann&tier=A");
  const next = us.mergeParams(prev, { tier: "C/D", q: null }, []);
  assert.equal(next.toString(), "view=hod&cycle=c1&unit=u1&tier=C%2FD");
  assert.equal(us.shouldPush(prev, next), false, "只改筛选 → replace");
  const back = us.mergeParams(prev, { unit: null }, us.REVIEW_FILTER_KEYS);
  assert.equal(back.toString(), "view=hod&cycle=c1");
  assert.equal(us.shouldPush(prev, back), true, "离开部门明细 → push");
  const keep = us.mergeParams(prev, { q: "bob" }, ["q", "tier"]);
  assert.equal(keep.get("q"), "bob", "set 里明确给的键不被 clear 删掉");
  assert.equal(keep.get("tier"), null);
  assert.equal(us.mergeParams("a=1", { b: ["x", "y"], c: true }, []).toString(), "a=1&b=x&b=y&c=1");
  assert.deepEqual(J(us.paramsOf(new URLSearchParams("a=1&a=2&b=3"))), { a: "1", b: "3" });
  assert.deepEqual(J(us.PUSH_KEYS), ["view", "unit", "item", "cycle"]);
  assert.deepEqual(J(us.PAGE_KEYS), ["edit", "new", "learn", "attempt"]);
  assert.deepEqual(J(us.REVIEW_FILTER_KEYS), ["q", "dept", "mgr", "lv", "one", "mr", "adj", "hl", "od", "tier", "pending", "sort", "flat"]);
});

// ---------- reviewcodes.js ----------
test("reviewcodes: HoD 页的补充说法、阻断项 / 提示 / 错误码文案，BulkActions 用的 reviewWhy", () => {
  assert.match(rc.whyText("zh", "no_manager", "hod"), /可由 HoD 代评/);
  assert.equal(rc.whyText("zh", "no_manager"), "没有在职的直属上级");
  assert.equal(rc.whyText("en", "mystery", null, { error: "Server says" }), "Server says");
  assert.equal(rc.reviewWhy("participant_departed", "en"), "The employee has left; no reminder sent");
  assert.equal(rc.reviewWhy("zzz", "zh"), "zzz");
  // manager_pending 只在「面谈」这一步产生：上级还没登记 1 对 1 面谈（审查：原文写成「上级尚未评级」，把 HR 引到评级那一步）
  assert.equal(rc.reviewWhy("manager_pending", "zh"), "上级尚未登记 1 对 1 面谈，请先提醒上级");
  assert.equal(rc.reviewWhy("manager_pending", "en"), "The manager hasn’t logged the 1-on-1 yet. Remind the manager first");
  assert.match(rc.reviewWhy("hod_is_manager", "en"), /direct manager/);
  assert.ok(rc.errCodeText("zh", "duplicate") && rc.errCodeText("en", "duplicate"), "批量保存的 duplicate 码有文案");
  assert.equal(rc.issueText("zh", { code: "over_quota", over: [{ tier: "A", count: 3, allowed: 2 }, { tier: "A+", count: 1, allowed: 0 }] }), "A 3/2、A+ 1/0 超出名额");
  assert.equal(rc.issueText("en", { code: "rating_missing", ids: ["a", "b"] }), "2 people have no rating yet", "没有 n 时按 ids 计数");
  assert.equal(rc.issueText("zh", { code: "self_missing", n: 3 }), "3 人尚未提交自评（自评截止日未到）");
  assert.equal(rc.issueText("en", { code: "membership_changed", added: 1, removed: 2 }), "Members changed after the HoD submitted (1 added, 2 removed)");
  assert.equal(rc.noticeText("zh", { code: "participants_departed", ids: ["x"] }), "1 人已离职，不计入配额");
  assert.equal(rc.errCodeText("en", "bulk_invalid", 2), "2 rows didn’t pass the checks. Nothing was saved");
  assert.equal(rc.errCodeText("zh", "stale"), "保存前此人的评级已被改动，请核对后重新填写");
  assert.equal(rc.errCodeText("zh", "nope"), null);
  // 中英键一致（dict-pairs 也会扫到，这里再按函数入口核一遍）
  const zh = rc.reviewCodes("zh"), en = rc.reviewCodes("en");
  for (const k of ["why", "whyHod", "issue", "notice", "err"]) assert.deepEqual(Object.keys(zh[k]).sort(), Object.keys(en[k]).sort(), k);
});

// ---------- 源码断言 ----------
test("组件不引用 Semi（员工端包里没有 Semi）；deptcal.js / reviewcodes.js 没有任何 import", () => {
  for (const f of ["components/DeptCalibration.jsx", "components/DeptFilter.jsx", "components/useLeaveGuard.js", "deptfilter.js", "deptcal.js", "urlstate.js", "reviewcodes.js"]) {
    assert.doesNotMatch(read(...f.split("/")), /@douyinfe\/semi/, f);
  }
  assert.doesNotMatch(read("deptcal.js"), /^\s*import\s/m);
  assert.doesNotMatch(read("reviewcodes.js"), /^\s*import\s/m);
});

test("DeptCalibration：hook 全在提前 return 之前（审查 P1-17）；离开守卫无条件调用；草稿按「周期 + 一级部门」存 sessionStorage；改动带 expect", () => {
  const src = read("components", "DeptCalibration.jsx");
  const body = src.slice(src.indexOf("export default function DeptCalibration"));
  const early = body.indexOf("if (!view) return");
  assert.ok(early > 0, "has the loading return");
  const hooks = [...body.matchAll(/\b(useState|useEffect|useMemo|useCallback|useLeaveGuard|useRef)\(/g)].map((m) => m.index);
  assert.ok(hooks.length >= 10);
  assert.ok(hooks.every((i) => i < early), "every hook call sits before `if (!view) return`");
  assert.match(body, /\n  useLeaveGuard\(isHod && dirty, s\.unsavedLeave\);/, "unconditional, not inside an if");
  assert.match(body, /`dcal:\$\{cycle\.id\}:\$\{unit\}`/);
  assert.match(body, /sessionStorage\.setItem\(storeKey/);
  assert.match(read("deptcal.js"), /expect: \{ managerRating: normRating\(b\.managerRating\), finalRating: normRating\(b\.finalRating\) \}/, "expect 按草稿的 base");
  assert.match(body, /base: dc\.draftBaseOf\(row\)/, "第一次改这一行时记下 base");
  // 同一部门数据刷新后重新核对草稿；hod 只对可代评 / 已代评的行给「查看自评」，直接用行里的 selfReview
  assert.match(body, /dc\.sanitizeDrafts\(ds\.drafts, rows\)/);
  assert.match(body, /o\.proxyEligible \|\| dc\.proxyOf\(o\)/);
  assert.match(body, /selfPack\(o, \{ selfAt: o\.selfAt, \.\.\.o\.selfReview \}\)/);
  // hr：阻断项用 confirmIssues；只读提示只在归 HoD 的组出现；提醒不发给 HoD 本人的直属下级
  assert.match(body, /isHod \? dept\.issues : dept\.confirmIssues/);
  // CX-221：HoD 已提交才写「HR 只读，请退回」，未提交写「等待 HoD 提交」
  assert.match(body, /!isHod && dept\.hodOwned && <p className="rv-note">\{dept\.status && dept\.status\.hodSubmittedAt \? s\.hrReadonly : s\.hrWaitHod\}/);
  assert.match(body, /remindIds/);
  // hr 模式：只有 editable 的行才有「校准」，且宿主传了 onCalibrateRow（有写权限）
  assert.match(body, /!isHod && onCalibrateRow && r\.editable/);
});

test("useLeaveGuard：全局登记（confirmLeave 给 NotifBell / TopBar / 宿主切页签用）、拦 .um-item 与 .notif-item、每个挂载只垫一次", () => {
  const src = read("components", "useLeaveGuard.js");
  assert.match(src, /export function confirmLeave\(/);
  assert.match(src, /\.um-item/);
  assert.match(src, /\.notif-item/);
  assert.match(src, /if \(!paddedRef\.current\) \{\n\s+paddedRef\.current = true;/);
  assert.match(src, /dispatchEvent\(new PopStateEvent\('popstate'/, "取消后退时让路由按还原的地址重新渲染");
  assert.match(src, /window\.addEventListener\('beforeunload'/);
  // 审查：垫底标记也放进 usr，urlstate 改筛选（replace）时原样带上；取消后退后推回的那条是新的垫底
  assert.match(src, /usr: \{ \.\.\.\(base\.usr \|\| \{\}\), \[PAD_KEY\]: id \}/);
  assert.match(src, /padHref = landed;/);
  assert.match(read("urlstate.js"), /\{ replace: true, state \}/);
});

test("DeptFilter：onInvalid 只在 ready 时报、同一组无效值只报一次（审查 P1-8）；按裁剪后的深度分列", () => {
  const src = read("components", "DeptFilter.jsx");
  assert.match(src, /if \(!isReady \|\| !onInvalid\) return;/);
  assert.match(src, /reportedRef\.current === key/);
  assert.match(src, /deptLayout\(list\)/);
  assert.match(src, /matchMedia/);
});

test("DeptFilter 波次 3：放进 Semi Modal 的共用帮手（motion:false + 内容层 overflow:visible，可套宿主自己的 modalRender），仍不 import Semi", () => {
  const src = read("components", "DeptFilter.jsx");
  assert.match(src, /^import \{ cloneElement, isValidElement, [^}]*\} from 'react';$/m);
  const at = src.indexOf("export function dpfModalRender");
  const end = src.indexOf("\n}\n", src.indexOf("export function dpfModalProps")) + 3;
  assert.ok(at > 0 && end > at);
  const fns = src.slice(at, end).replace(/^export /gm, "");
  const isValidElement = (n) => !!n && typeof n === "object" && "props" in n;
  const cloneElement = (n, p) => ({ ...n, props: { ...n.props, ...p } });
  const x = vm.runInNewContext(fns + "\n;({ dpfModalRender, dpfModalProps })", { isValidElement, cloneElement });
  const node = { type: "div", props: { className: "semi-modal-content", style: { width: 520 } } };
  assert.deepEqual(J(x.dpfModalRender(node).props.style), { width: 520, overflow: "visible" }, "保留原样式，只加 overflow:visible");
  assert.equal(x.dpfModalRender("text"), "text", "不是元素时原样返回");
  const p = x.dpfModalProps();
  assert.equal(p.motion, false);
  assert.equal(J(p.modalRender(node).props.style).overflow, "visible");
  const host = (n) => ({ ...n, props: { ...n.props, "data-host": 1 } });
  const wrapped = x.dpfModalProps(host).modalRender(node);
  assert.equal(wrapped.props["data-host"], 1, "先走宿主的 modalRender");
  assert.equal(wrapped.props.style.overflow, "visible");
});

test("DeptCalibration 波次 3：hr 头部「已确认 · 本地时间 · 确认人」；无 HoD 的组不写「HoD 评级」、不给「HoD 代评」筛选；已关闭周期按档案评级并说明；L2 提示仍在", () => {
  const src = read("components", "DeptCalibration.jsx");
  const body = src.slice(src.indexOf("export default function DeptCalibration"));
  assert.match(src, /confirmedHr: \(d, who\) => `已确认 · \$\{d\}\$\{who \? ` · \$\{who\}` : ''\}`/);
  assert.match(src, /confirmedHr: \(d, who\) => `Confirmed · \$\{d\}\$\{who \? ` · \$\{who\}` : ''\}`/);
  assert.match(body, /s\.confirmedHr\(dc\.localStamp\(st\.hrConfirmedAt\), dc\.confirmerOf\(st\)\)/);
  assert.match(body, /const hrNoHod = !isHod && dc\.noHodOf\(dept\);/);
  assert.match(body, /const rateCol = annual \? s\.colAnnual : hrNoHod \? s\.colCalib : s\.colHod;/);
  assert.match(body, /<th>\{rateCol\}<\/th>/);
  assert.match(body, /<td data-label=\{rateCol\}>/);
  assert.doesNotMatch(body, /<th>\{annual \? s\.colAnnual : s\.colHod\}<\/th>/);
  assert.match(body, /\{!hrNoHod && <option value="proxy">\{s\.adjProxy\}<\/option>\}/);
  assert.match(body, /if \(hrNoHod && q\.adj === 'proxy'\) patch\.adj = null;/);
  assert.match(src, /colCalib: '校准评级'/);
  assert.match(src, /colCalib: 'Calibrated rating'/);
  // 已关闭周期：行上的档案评级参与计数；有这类行时说明口径
  assert.match(body, /const eff = dc\.ratingOf\(r\);/);
  assert.match(body, /cycle\.status === 'closed' && rows\.some\(\(r\) => r\.recordRating !== undefined\)/);
  assert.match(body, /\{onFile && <p className="rv-note">\{s\.closedOnFile\}<\/p>\}/);
  // 没有一级部门的组不再显示「—」
  assert.match(body, /\{dept\.dept1 \|\| s\.noDept1\}/);
  // L2：HoD 改了上级评级时提示核对评语（非阻断，不进保存校验）
  assert.match(body, /\{isHod && editable && r\._draft && need === 'adjust' && orig\.managerText !== '' && <div className="rv-hint dcal-gate dcal-cmt">\{s\.checkComment\}<\/div>\}/);
  assert.match(src, /checkComment: '请核对上级评语是否仍与调整后的评级一致'/);
});

test("app.css：末尾追加了 .dpf-* / .dcal-*，追加段不写死颜色，吸顶区按顶栏高度偏移", () => {
  const css = read("app.css");
  const at = css.indexOf("/* ===== 第二批 W1-B");
  assert.ok(at > 0);
  const block = css.slice(at);
  assert.match(block, /\.dpf-trigger\{/);
  assert.match(block, /\.dcal-sticky\{position:sticky;top:80px/);
  assert.match(block, /@media \(max-width:900px\)\{\.dcal-sticky\{top:72px\}\}/);
  assert.doesNotMatch(block.replace(/\/\*[\s\S]*?\*\//g, ""), /#[0-9a-fA-F]{3,8}\b/, "颜色一律用变量");
  assert.equal(css.includes("\r\n"), false, "app.css 仍是 LF");
});

// 波次 3 复核：部门树缓存按登录身份区分。服务端按各人数据范围裁剪部门树；同一标签页登出后换账号登录不刷新页面，
// 原来的模块级缓存（5 分钟）会把上一个账号的树给下一个账号用（范围外的部门露出来，或范围内的 ?dept= 被当成越权清掉）。
test("deptfilter: 部门树缓存按登录身份（id + 角色 + 后台角色）区分；换账号重取，在途的旧请求不写缓存；同一身份 5 分钟内不重取", async () => {
  const calls = [];
  const resolvers = [];
  const api = { get: (p) => { calls.push(p); const n = calls.length; return new Promise((r) => resolvers.push(() => r({ options: [{ id: "d" + n }], n }))); } };
  const m = load("deptfilter.js", { useEffect() {}, useState() {}, useAuth() { return null; }, api });
  const flush = () => { while (resolvers.length) resolvers.shift()(); };
  assert.equal(m.deptTreeWho({ id: "u1", role: "admin", adminRoleId: null }), "u1:admin:");
  assert.equal(m.deptTreeWho({ id: "u2", role: "admin", adminRoleId: "r-train" }), "u2:admin:r-train");
  assert.equal(m.deptTreeWho(null), "");
  const A = "u1:admin:", B = "u2:admin:r-train";
  let p = m.loadDeptTree(A); flush(); const a1 = await p;
  assert.equal(calls.length, 1);
  assert.equal(await m.loadDeptTree(A), a1, "same identity: served from the cache");
  assert.equal(calls.length, 1);
  p = m.loadDeptTree(B); flush(); const b1 = await p;
  assert.equal(calls.length, 2, "another account: fetched again");
  assert.notEqual(b1.n, a1.n);
  p = m.loadDeptTree(A); flush(); await p;
  assert.equal(calls.length, 3, "back to the first account: not the second account's tree");
  // 在途请求属于旧身份：新身份另取，旧请求回来后不写缓存
  const pa = m.loadDeptTree(B);
  const pb = m.loadDeptTree(A);
  assert.equal(calls.length, 5, "switching identity drops the other identity's cache");
  flush(); await pa; await pb;
  p = m.loadDeptTree(A); flush(); await p;
  assert.equal(calls.length, 5, "the later (A) result is the one cached");
  m.invalidateDeptTree();
  const pc = m.loadDeptTree(A); const pd = m.loadDeptTree(B);
  assert.equal(calls.length, 7);
  flush(); await pc; await pd;
  p = m.loadDeptTree(B); flush(); await p;
  assert.equal(calls.length, 7, "B's later request wins; A's earlier in-flight result did not overwrite it");
  p = m.loadDeptTree(A); flush(); await p;
  assert.equal(calls.length, 8, "A's in-flight result was dropped when B started");
});
