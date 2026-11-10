// 第三批 4.3 / 4.4 / 8.6 / 5.7（2026-10-08，G4）：前端共享的纯函数。
//   · web/src/categories.js：类别目录（含负责人 10/8 新增的「团建」，排在「其他」之前）、标签、排序、归一（英文标签与旧预设映射回中文键）。
//   · 与服务端 modules/learning/categories.js（G1）键、顺序、英文标签一致 —— 服务端文件还没落地时这一条跳过。
//   · 导入库 scripts/lib/course-db.js 的 CATEGORY_EN、校验脚本 verify-course-import.js 的 CATEGORIES 与目录一致。
//   · web/src/jobgrades.js（按职级选人）与 web/src/mediareasons.js（课件内视频行文）。
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
const WEB = path.join(ROOT, "web", "src");

// ESM 纯函数文件用 vm 跑：去掉 import / export，把导出名挂到 globalThis
function loadEsm(rel) {
  let src = fs.readFileSync(path.join(WEB, rel), "utf8");
  const names = [...src.matchAll(/^export\s+(?:async\s+)?(?:function|const|let)\s+(\w+)/gm)].map((m) => m[1]);
  src = src.replace(/^import[\s\S]*?from\s+['"][^'"]+['"];?[ \t]*$/gm, "").replace(/^export\s+/gm, "");
  const ctx = vm.createContext({ URL, Math, Number, String, Array, Object, Set, Map });
  vm.runInContext(src + "\n;globalThis.__x = {" + names.join(",") + "};", ctx);
  return ctx.__x;
}

const C = loadEsm("categories.js");
// vm 里的数组 / 对象换成本 realm 的普通值再比较（deepStrictEqual 会比原型）
const plain = (v) => JSON.parse(JSON.stringify(v));

test("catalogue: order, keys and labels (团建 / Team Building right before 其他; Wellbeing & Safety)", () => {
  assert.deepEqual([...C.CATEGORY_KEYS], ["合规", "健康与安全", "入职", "领导力", "管理", "专业技术", "产品与业务", "数字与数据", "通用", "团建", "其他"]);
  assert.equal(C.categoryLabel("团建", "en"), "Team Building");
  assert.equal(C.categoryLabel("团建", "zh"), "团建");
  assert.equal(C.categoryLabel("健康与安全", "en"), "Wellbeing & Safety");
  assert.equal(C.normalizeCategoryInput("Health & Safety"), "健康与安全");
  assert.equal(C.categoryLabel(null, "zh"), "未分类");
  assert.equal(C.categoryLabel("__none", "en"), "Uncategorized");
  assert.equal(C.categoryLabel("自定义类", "en"), "自定义类", "a custom value is shown as typed");
  assert.equal(C.UNCATEGORIZED, "__none");
});

test("sort: catalogue order, custom values after 其他 (alphabetical), uncategorized last", () => {
  assert.deepEqual([...C.sortCategoryKeys([null, "其他", "Zeta", "合规", "Alpha", "团建"])], ["合规", "团建", "其他", "Alpha", "Zeta", null]);
});

test("normalizeCategoryInput: en labels (any case) and old presets map back to the zh key; unknown values pass through; empty → null", () => {
  const n = C.normalizeCategoryInput;
  assert.equal(n("Compliance"), "合规");
  assert.equal(n("  team building "), "团建");
  assert.equal(n("Safety"), "健康与安全");
  assert.equal(n("Skills"), "专业技术");
  assert.equal(n("Onboarding"), "入职");
  assert.equal(n("General"), "通用");
  assert.equal(n("安全"), "健康与安全");
  assert.equal(n("技能"), "专业技术");
  assert.equal(n("Wellbeing / Safety"), "健康与安全");
  assert.equal(n("Product / Business"), "产品与业务");
  assert.equal(n("新类别"), "新类别");
  assert.equal(n("   "), null);
  assert.equal(n("__none"), null);
  assert.equal(n("x".repeat(80)).length, 60);
});

test("categoryOptions: the catalogue plus custom values in use, values are zh keys, labels localised", () => {
  const opts = C.categoryOptions("en", ["合规", "自定义", null, ""]);
  assert.equal(opts.length, 12);
  assert.deepEqual({ ...opts[0] }, { label: "Compliance", value: "合规" });
  assert.deepEqual({ ...opts[opts.length - 1] }, { label: "自定义", value: "自定义" });
  assert.equal(C.isCustomCategory("自定义"), true);
  assert.equal(C.isCustomCategory("团建"), false);
});


test("job grades: options grouped by track, range within a track by level, people without a grade are counted, not included", () => {
  const J = loadEsm("jobgrades.js");
  const ranks = [
    { rank: "PD1", grade: "D", level: 6, track: "P" }, { rank: "PD2", grade: "D", level: 5, track: "P" },
    { rank: "PD3", grade: "D", level: 4, track: "P" }, { rank: "PD4", grade: "D", level: 3, track: "P" },
    { rank: "MB1", grade: "B", level: 11, track: "M" },
  ];
  const opts = J.gradeOptions(ranks, ["PD1", "V4"]);
  assert.deepEqual(plain(opts.map((o) => o.value)), ["MB1", "PD1", "PD2", "PD3", "PD4", "V4"]);
  assert.deepEqual([...J.ranksInRange(ranks, "PD3", "PD1")].sort(), ["PD1", "PD2", "PD3"]);
  assert.deepEqual([...J.ranksInRange(ranks, "PD1", "PD1")], ["PD1"]);
  const people = [{ id: 1, jobLevel: "PD1" }, { id: 2, jobLevel: "PD4" }, { id: 3, jobLevel: null }, { id: 4, jobLevel: " PD2 " }];
  const r = J.splitByGrade(people, ["PD1", "PD2"]);
  assert.deepEqual(plain(r.match.map((p) => p.id)), [1, 4]);
  assert.deepEqual(plain(r.noGrade.map((p) => p.id)), [3]);
  const all = J.splitByGrade(people, []);
  assert.equal(all.match.length, 4);
  assert.equal(all.noGrade.length, 0);
});

test("media reasons: one sentence per reason, slide numbers, hidden slides, the exact-video line, en plurals", () => {
  const M = loadEsm("mediareasons.js");
  assert.equal(M.reasonText("error", "zh"), "视频文件已损坏或格式无法识别");
  assert.equal(M.reasonText("pptx_unreadable", "en"), M.reasonText("zip64_unsupported", "en"));
  assert.equal(M.reasonText("unsupported_format", "zh", { ext: ".wmv" }), "不支持的视频格式（.wmv）");
  assert.equal(M.reasonText("timeout", "en", { minutes: 1 }), "Conversion timed out (over 1 minute)");
  assert.equal(M.reasonText("brand_new_code", "zh"), "brand_new_code");
  assert.equal(M.slidesText([{ slideNo: 4, pageNo: 3 }, { slideNo: 9, pageNo: 8 }], "zh"), "第 4、9 页");
  assert.equal(M.slidesText([{ slideNo: 4, pageNo: 3 }], "en"), "slide 4");
  assert.equal(M.slidesText([{ slideNo: 4, pageNo: 3 }, { slideNo: 9, pageNo: 8 }], "en"), "slides 4, 9");
  assert.equal(M.slidesText([{ slideNo: 3, pageNo: null }], "zh"), "隐藏页");
  assert.equal(M.mediaLine({ name: "demo.wmv", slides: [{ slideNo: 4, pageNo: 4 }], status: "failed", reason: "error" }, "zh", { deck: "产品培训.pptx" }),
    "「产品培训.pptx」第 4 页「demo.wmv」：视频文件已损坏或格式无法识别");
  assert.equal(M.hostOf("https://www.youtube.com/watch?v=x"), "www.youtube.com");
  assert.deepEqual({ ...M.mediaSummaryOf([{ status: "ready" }, { status: "failed" }, { status: "failed" }]) }, { total: 3, ready: 1, pending: 0, transcoding: 0, failed: 2, external: 0, skipped: 0 });
  const zh = M.mediaText("zh"), en = M.mediaText("en");
  assert.deepEqual(Object.keys(zh.reason).sort(), Object.keys(en.reason).sort());
  assert.deepEqual(Object.keys(zh.vst).sort(), ["disabled", "missing", "no_encoder", "ok"]);
});
