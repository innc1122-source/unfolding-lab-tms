// 第二批波次 3 W3-S（2026-10-08）的页面收尾，源码断言 + 纯函数实跑，不起服务器、不碰数据库：
//   · 1 对 1 面谈日期：员工一侧（Review.jsx）与上级一侧（ReviewTeam.jsx）都按服务端 cycleStartedAt 设下限，手动输入越界时
//     按钮置灰、范围提示标红（不等 400 date_invalid）；提示文案中英成对。
//   · 上级评级表单的评语可见提示读服务端 commentVisibleToEmployee（/api/me/reviews 与 team/:id 都下发）。
//   · 后台评估页（ReviewCycles.jsx）：已关闭周期的各档人数按档案评级 —— 标题与说明行写明「以档案为准」；
//     没有一级部门的组显示「未归入一级部门」，不再是「—」（部门列表、提醒名单、退回弹窗、看板矩阵）。
// 服务端口径（部门行、分布、已归档人数、team[] 与旧 /hod 形状删除、commentVisibleToEmployee）见 perf-record-amend、
// review-team-roster、review-hod-calibration、review-w2-fixes、review-v2。
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const SRC = path.join(__dirname, "..", "web", "src");
const read = (...p) => fs.readFileSync(path.join(SRC, ...p), "utf8").replace(/\r\n/g, "\n");
const REVIEW = read("pages", "Review.jsx");
const TEAM = read("pages", "ReviewTeam.jsx");
const RVC = read("pages", "admin", "ReviewCycles.jsx");

// 取 `const T = { zh: {...}, en: {...} }` 里某个键在两种语言下的源码片段
function keyBoth(src, key) {
  const hits = [...src.matchAll(new RegExp(`\\b${key}: ([^\\n]+)`, "g"))].map((m) => m[1]);
  assert.equal(hits.length, 2, `${key}: one zh and one en entry, got ${hits.length}`);
  return hits;
}

test("1-on-1 date: both sides gate the Log button on the cycle start day and show the range hint", () => {
  for (const [name, src] of [["Review.jsx", REVIEW], ["ReviewTeam.jsx", TEAM]]) {
    assert.match(src, /const outOfRange = !!date && \(date > today \|\| \(!!minDate && date < minDate\)\);/, name);
    assert.match(src, /disabled=\{(busy|off) \|\| !date \|\| outOfRange\}/, name + ": the Log button is disabled out of range");
    assert.match(src, /className=\{outOfRange \? 'rv-msg err' : 'rv-hint'\}>\{s\.oneDateRange\(minDate\)\}/, name + ": the hint turns red out of range");
    assert.match(src, /cycleStartedAt/, name + ": the lower bound comes from the server's cycleStartedAt");
    const [zh, en] = keyBoth(src, "oneDateRange");
    assert.match(zh, /周期发起日/);
    assert.match(en, /cycle start/);
  }
  // 文案函数实跑：日期原样带出
  const f = vm.runInNewContext("(" + keyBoth(TEAM, "oneDateRange")[1].replace(/,\s*oneLog:.*$/, "") + ")");
  assert.equal(f("2026-10-01"), "Pick a date from 2026-10-01 (cycle start) to today");
});

test("the manager form reads commentVisibleToEmployee from the list and from team/:id", () => {
  assert.match(TEAM, /typeof data\.commentVisibleToEmployee === 'boolean' \? data\.commentVisibleToEmployee : undefined/);
  assert.match(TEAM, /commentVisible=\{typeof data\.commentVisibleToEmployee === 'boolean' \? data\.commentVisibleToEmployee : commentVisible\}/);
});

test("ReviewCycles: closed cycles say the counts follow the rating on file", () => {
  const [zhNote, enNote] = keyBoth(RVC, "fileNote");
  assert.match(zhNote, /以员工档案里的绩效记录为准/);
  assert.match(enNote, /performance record on file/);
  assert.match(RVC, /\{!open && <div className="tset-foot">\{s\.fileNote\}<\/div>\}/, "a note under the header of a closed cycle");
  assert.match(RVC, /title: open \? s\.dDist : s\.dDistFile, dataIndex: 'counts'/, "department list column title");
  assert.match(RVC, /\{open \? s\.dist : s\.distFile\}/, "legacy table distribution label");
  keyBoth(RVC, "dDistFile");
  keyBoth(RVC, "distFile");
});

test("ReviewCycles: the wave-2 inline styles are replaced by W3-C's utility classes (scratchpad w3-css-contract)", () => {
  assert.doesNotMatch(RVC, /marginLeft: 6/, "Tag / small-text gap → .u-tag-gap");
  assert.doesNotMatch(RVC, /textTransform/, "header text → .u-th-plain");
  assert.doesNotMatch(RVC, /const st = over/, "over-quota numbers → .u-num-over");
  assert.equal((RVC.match(/className="u-tag-gap"/g) || []).length, 7);
  assert.equal((RVC.match(/className="u-th-plain"/g) || []).length, 2);
  assert.match(RVC, /<Tag color="green" type="light" shape="circle" className="u-tag-wrap" title=\{text\}><span>\{text\}<\/span><\/Tag>/, "O1 confirmed tag wraps");
  assert.match(RVC, /className=\{'u-num-link tnum' \+ ov\}/);
  assert.match(RVC, /<span className=\{'tnum' \+ ov\}>/);
});

test("ReviewCycles: the department list only has the (right-fixed) actions column for people who can confirm / return", () => {
  // 已关闭周期与只读角色那一列是空的，固定在右侧会盖住「状态」列（W3-S 浏览器核对 1440 宽）
  assert.match(RVC, /scroll=\{\{ x: bulkOn \? 1290 \+ BULK_SEL_EXTRA : 1070 \}\} className="rvc-depts"/);
  assert.match(RVC, /\.\.\.\(bulkOn \? \[\{ title: s\.dOps, dataIndex: 'ops', width: 220, fixed: 'right'/);
  assert.match(RVC, /const bulkOn = open && canEdit;/);
});

test("ReviewCycles: the group without a level-1 department has a name everywhere", () => {
  const [zh, en] = keyBoth(RVC, "noDept1");
  assert.match(zh, /未归入一级部门/);
  assert.match(en, /No level-1 department/);
  assert.match(RVC, /\{v \|\| s\.noDept1\}<\/Link>/, "department list");
  assert.match(RVC, /const label = \(r\) => r\.dept1 \|\| s\.noDept1;/, "remind list");
  assert.match(RVC, /\$\{ret\.dept1 \|\| s\.noDept1\}/, "return dialog title");
  assert.match(RVC, /rvcMatrixRows\(fItems, fq, d, closed, s\.noDept1\)/, "board matrix");
  // 纯函数实跑：没有一级部门的组（dept1 = null）用传入的名字；不传时保留「—」。
  // 取法同 review-board-ui：「周期列表筛选」到「评级的显示名」之间是模块级纯函数；dc 只给用到的几个
  const a = RVC.indexOf("const RVC_KINDS = "), b = RVC.indexOf("// 评级的显示名", a);
  assert.ok(a > 0 && b > a && RVC.slice(a, b).includes("function rvcMatrixRows("));
  const dc = { isCounted: () => true, bucketOf: (r) => r || null, effectiveOf: (i) => i.finalRating || i.managerRating || null, QUOTA_CAPPED: ["A+", "A", "B+"] };
  const ctx = vm.createContext({ dc, console });
  vm.runInContext(RVC.slice(a, b), ctx);
  const d = { depts: [{ dept1Id: "__none", dept1: null, allowed: null }] };
  const rows = JSON.parse(JSON.stringify(vm.runInContext("rvcMatrixRows", ctx)([{ id: "1", dept1Id: "__none", managerRating: "B" }], {}, d, false, "未归入一级部门")));
  assert.equal(rows[0].label, "未归入一级部门");
  assert.equal(JSON.parse(JSON.stringify(vm.runInContext("rvcMatrixRows", ctx)([], {}, d, false)))[0].label, "—");
});
