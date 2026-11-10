// F44（2026-10-09）学完一门课之后的去向：web/src/afterCourse.js 纯函数（vm 直接跑）+ Course.jsx 源码约定。
//   · 学习包里还有没学完的课：先当前课之后的，再之前的（不再只看之后的）；
//   · 全部学完才去考试，且考试须已解锁或它要求的课程全部学完；否则回学习路径页；
//   · 完成横幅「前往考试」用同一规则：多门课的学习包里其他课没学完时不出现。
// 负责人实测场景：新员工入职培训，第 1 门学完、第 2 门进行中、第 3 门未开始 → 原来落到「尚未解锁」的考前说明页。
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const WEB = path.join(__dirname, "..", "web", "src");
const read = (...p) => fs.readFileSync(path.join(WEB, ...p), "utf8").replace(/\r\n/g, "\n");
const J = (v) => JSON.parse(JSON.stringify(v));

function loadEsm(src, names) {
  assert.doesNotMatch(src, /^import /m, "import-free so it runs in vm");
  const code = src.replace(/^export /gm, "") + `\n;({ ${names.join(", ")} })`;
  return vm.runInNewContext(code, { Math, Number, String, Array, Object, JSON });
}
const A = loadEsm(read("afterCourse.js"), ["nextAfterCourse", "examReachable", "examRequiredCourses"]);

// 入职培训学习包：3 门课 + 覆盖整个学习包的结业考试（courseIds 为空），快照里考试未解锁
const onboarding = (p1, p2, p3, exam = {}) => ({
  courses: [{ id: "c1", progress: p1 }, { id: "c2", progress: p2 }, { id: "c3", progress: p3 }],
  exams: [{ id: "x1", courseIds: [], unlocked: false, ...exam }],
});

test("F44 负责人场景：第 1 门学完、第 2 门进行中、第 3 门未开始 → 去第 2 门，不去考试", () => {
  assert.deepEqual(J(A.nextAfterCourse(onboarding(40, 30, 0), "c1", true)), { kind: "course", id: "c2" });
});

test("当前课之后都学完了、之前还有没学完的 → 回到之前那门（不再落到考试）", () => {
  assert.deepEqual(J(A.nextAfterCourse(onboarding(30, 100, 0), "c3", true)), { kind: "course", id: "c1" });
  assert.deepEqual(J(A.nextAfterCourse(onboarding(100, 50, 100), "c3", true)), { kind: "course", id: "c2" });
});

test("全部学完（当前课按刚学完计）→ 去考试；快照里考试 unlocked 是旧的也照样可去", () => {
  assert.deepEqual(J(A.nextAfterCourse(onboarding(100, 100, 80), "c3", true)), { kind: "exam", id: "x1" });
});

test("考试要求的课程没学完 / 无法确认 → 回学习路径页，不去锁住的考试", () => {
  // 考试只要求 c9（快照里找不到）：无法确认 → program
  const p = { courses: [{ id: "c1", progress: 100 }, { id: "c2", progress: 100 }], exams: [{ id: "x1", courseIds: ["c9"], unlocked: false }] };
  assert.deepEqual(J(A.nextAfterCourse(p, "c2", true)), { kind: "program" });
  // 当前课没学完（线下课未签到等）→ program
  assert.deepEqual(J(A.nextAfterCourse(onboarding(100, 100, 50), "c3", false)), { kind: "program" });
  // 没有考试的多门课学习包全部学完 → program
  assert.deepEqual(J(A.nextAfterCourse({ courses: [{ id: "c1", progress: 100 }, { id: "c2", progress: 0 }], exams: [] }, "c2", true)), { kind: "program" });
  // 没有快照 → program
  assert.deepEqual(J(A.nextAfterCourse(null, "c1", true)), { kind: "program" });
});

test("单课包装：有考试且可去 → 考试；没有考试 → 回课程列表", () => {
  assert.deepEqual(J(A.nextAfterCourse({ courses: [{ id: "c1", progress: 60 }], exams: [{ id: "x1", courseIds: ["c1"] }] }, "c1", true)), { kind: "exam", id: "x1" });
  assert.deepEqual(J(A.nextAfterCourse({ courses: [{ id: "c1", progress: 60 }], exams: [] }, "c1", true)), { kind: "list" });
});

test("完成横幅「前往考试」：多门课学习包里其他课没学完时不出现", () => {
  const p = onboarding(100, 30, 0);
  assert.equal(A.examReachable(p.exams[0], p.courses, "c1", true), false, "整包考试：c2、c3 没学完");
  // 考试只关联当前这门课：本课学完即可去（原有行为保留）
  assert.equal(A.examReachable({ id: "x2", courseIds: ["c1"] }, p.courses, "c1", true), true);
  assert.equal(A.examReachable({ id: "x2", courseIds: ["c1"] }, p.courses, "c1", false), false);
  // 关联多门课：其他课没学完 → 不可去
  assert.equal(A.examReachable({ id: "x3", courseIds: ["c1", "c2"] }, p.courses, "c1", true), false);
  // 服务端已解锁 → 可去
  assert.equal(A.examReachable({ id: "x4", courseIds: [], unlocked: true }, p.courses, "c1", true), true);
});

test("Course.jsx 用 afterCourse.js 的规则，不再有「兜底到第一个考试」", () => {
  const src = read("pages", "Course.jsx");
  assert.match(src, /import \{ examReachable, nextAfterCourse \} from '\.\.\/afterCourse\.js';/);
  assert.match(src, /const examOpen = \(e\) => examReachable\(e, prog && prog\.courses, id, courseDone\);/);
  assert.match(src, /const next = nextAfterCourse\(prog, id, courseDone\);/);
  assert.doesNotMatch(src, /\(prog\.exams \|\| \[\]\)\[0\]/, "不得兜底到第一个考试");
  assert.doesNotMatch(src, /prog\.courses\.slice\(idx \+ 1\)\.find/, "不得只在当前课之后找");
});
