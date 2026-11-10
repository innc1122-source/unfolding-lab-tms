// 第三批 G5 学员端页面（2026-10-08）：5.1–5.4、10.4、10.7、10.8、10.9 的静态与纯函数检查。
// learnstatus.js 是「课程」页与首页共用的状态推算；这里用 vm 直接跑它（去掉 export）。
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const WEB = path.join(__dirname, "..", "web", "src");
const read = (...p) => fs.readFileSync(path.join(WEB, ...p), "utf8");

function loadEsm(src, names) {
  const code = src.replace(/^export /gm, "") + `\n;({ ${names.join(", ")} })`;
  return vm.runInNewContext(code, { Date, Math, Number, String, Array, Object, Set, Map });
}
const LS = loadEsm(read("learnstatus.js"), ["retakeInfo", "learnStatusOf", "examAction", "learnRank", "sortForLearner", "pickTop", "retakeHref", "stampOf"]);

// 第四批 G6（2026-10-09）QA 缺陷回归用：app.css 在给定视口宽度下，某个选择器（整段选择器文本相同）某个属性最后一次声明的值。
// 只认 @media 里的 min/max-width（px）；print 与 @container 视为不生效；后写的覆盖先写的。
function cssLast(css, selector, prop, width) {
  const src = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const stack = [];
  let buf = "", val;
  const applies = () => stack.every((m) => {
    if (m.startsWith("@container") || /\bprint\b/.test(m)) return false;
    if (!m.startsWith("@media")) return true;
    for (const [, k, n] of m.matchAll(/(max|min)-width\s*:\s*(\d+)px/g)) if (k === "max" ? width > +n : width < +n) return false;
    return true;
  });
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === "{") {
      const sel = buf.trim();
      buf = "";
      if (sel.startsWith("@")) { stack.push(sel); continue; }
      const end = src.indexOf("}", i);
      const body = src.slice(i + 1, end);
      i = end;
      if (!applies() || !sel.split(",").map((x) => x.trim().replace(/\s+/g, " ")).includes(selector)) continue;
      for (const d of body.split(";")) { const at = d.indexOf(":"); if (at > 0 && d.slice(0, at).trim() === prop) val = d.slice(at + 1).trim(); }
    } else if (c === "}") { stack.pop(); buf = ""; }
    else if (c === ";" && buf.trim().startsWith("@")) buf = "";
    else buf += c;
  }
  return val;
}

const dayOffset = (n) => {
  const d = new Date(); d.setDate(d.getDate() + n);
  const p = (x) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};
const failed = (extra = {}) => ({ id: "p1", progress: 100, hasExam: true, done: false, best: { percent: 53, passed: false }, ...extra });

test("10.8 learnstatus: a failed course with attempts left is 待补考 (retake), not 进行中; used up is failed", () => {
  // Lark exam repro (DEMO-ADMIN): unlimited attempts, no waiting period
  assert.equal(LS.learnStatusOf(failed({ attemptsLeft: null, retakeAvailableAt: null })), "retake");
  const r0 = LS.retakeInfo(failed({ attemptsLeft: null, retakeAvailableAt: null }));
  assert.equal(r0.attemptsLeft, null, "null = unlimited");
  assert.equal(r0.waiting, false, "no waiting period = available now");
  assert.equal(LS.learnStatusOf(failed({ attemptsLeft: 2 })), "retake");
  assert.equal(LS.learnStatusOf(failed({ attemptsLeft: 0 })), "failed");
  assert.equal(LS.learnStatusOf(failed()), "retake", "old server without the new fields still offers the retake");
  assert.equal(LS.learnStatusOf(failed({ status: "retake_pending" })), "retake");
  assert.equal(LS.learnStatusOf({ ...failed(), learnStatus: "failed" }), "failed");
  // waiting period
  const later = new Date(Date.now() + 5 * 3600000).toISOString();
  const w = LS.retakeInfo(failed({ attemptsLeft: 1, retakeAvailableAt: later }));
  assert.equal(w.waiting, true);
  assert.ok(w.availableAt instanceof Date);
  const past = new Date(Date.now() - 3600000).toISOString();
  assert.equal(LS.retakeInfo(failed({ retakeAvailableAt: past })).waiting, false, "a past time means available now");
  // design §4.8 shape is accepted too
  const d = LS.retakeInfo(failed({ retake: { examId: "ex-9", state: "usedUp", retryAt: null, attemptsLeft: 0 } }));
  assert.equal(d.usedUp, true);
  assert.equal(d.examId, "ex-9");
  // result pending beats not passed; passed is passed
  assert.equal(LS.learnStatusOf(failed({ resultPending: true })), "pending");
  assert.equal(LS.learnStatusOf({ ...failed(), done: true }), "passed");
});

test("10.8 learnstatus: overdue keeps the overdue status but still offers the retake; route goes to the exam prep page", () => {
  const p = failed({ dueAt: dayOffset(-3), attemptsLeft: 1, retakeExamId: "ex-1" });
  assert.equal(LS.learnStatusOf(p), "overdue");
  assert.equal(LS.examAction(p), "retake");
  assert.equal(LS.retakeHref(p), "/exam-prep/p1/ex-1");
  assert.equal(LS.retakeHref(failed()), "/program/p1", "no exam id → the course details page");
  assert.equal(LS.examAction(failed({ dueAt: dayOffset(-3), attemptsLeft: 0 })), null);
  assert.equal(LS.examAction({ id: "p2", progress: 100, hasExam: true, done: false }), "first");
});

test("10.7 order: overdue → ready / retake → in progress → not started → in-person → passed; exam courses are never pushed out of the first 4", () => {
  const list = [
    { id: "passed", progress: 100, done: true, hasExam: true },
    { id: "notstarted", progress: 0, done: false, hasExam: true },
    { id: "inprog", progress: 40, done: false, hasExam: true },
    { id: "ready", progress: 100, done: false, hasExam: true, dueAt: dayOffset(40) },
    failed({ id: "retake" }),
    { id: "overdue", progress: 20, done: false, hasExam: true, dueAt: dayOffset(-2) },
    { id: "offline", mode: "offline", progress: 0, done: false, hasExam: false },
  ];
  assert.deepEqual(LS.sortForLearner(list).map((p) => p.id), ["overdue", "ready", "retake", "inprog", "notstarted", "offline", "passed"]);
  const many = [1, 2, 3, 4, 5].map((i) => ({ id: "o" + i, progress: 10, done: false, hasExam: true, dueAt: dayOffset(-i) }));
  const sorted = LS.sortForLearner([...many, { id: "ready", progress: 100, done: false, hasExam: true }]);
  const { top, rest } = LS.pickTop(sorted, 4);
  assert.equal(top.length, 4);
  assert.ok(top.some((p) => p.id === "ready"), "the ready-for-exam course stays in the first 4");
  assert.equal(top.length + rest.length, sorted.length);
});

test("5.4 / 10.4 MyLearning: compact list, 待补考 grouped under 待考试, 去补考 goes to the exam prep page, row is the only button", () => {
  const src = read("pages", "MyLearning.jsx");
  assert.match(src, /import \{[^}]*learnStatusOf[^}]*\} from '\.\.\/learnstatus\.js';/);
  assert.match(src, /ready: \(p, st\) => st === 'ready' \|\| st === 'retake',/);
  assert.match(src, /<ul className="ml-list">/);
  assert.match(src, /className=\{'ml-row'/);
  assert.match(src, /nav\(retakeHref\(p\)\)/);
  assert.doesNotMatch(src, /className=\{'pcard'/, "no more one-big-card-per-course");
  // the action inside the row is decorative (no nested <button>)
  const row = src.slice(src.indexOf('<ul className="ml-list">'));
  assert.equal((row.match(/<button\b/g) || []).length, 1);
  assert.match(src, /retakeTag: '待补考'/);
  assert.match(src, /retake: '去补考'/);
  assert.match(src, /retakeTag: 'Retake pending'/);
  assert.match(src, /retake: 'Retake exam'/);
  assert.match(src, /leftUnlimited: '考试次数不限'/);
});

test("10.7 / 9.1 Home: shared order + pickTop, retake button, category label, no employee ID on the profile strip", () => {
  const src = read("pages", "Home.jsx");
  assert.match(src, /const learn = sortForLearner\(items\.filter\(\(p\) => p\.status === 'assigned'\)\);/);
  assert.match(src, /const \{ top, rest \} = pickTop\(learn, 4\);/);
  assert.match(src, /nav\(retakeHref\(p\)\)\}>\{tt\.retake\}/);
  assert.match(src, /categoryLabel\(p\.category, lang\)/);
  assert.doesNotMatch(src, /me\.employeeId/);
});

test("5.1 ProgramDetail: failed exam reads 待补考 / 去补考", () => {
  const src = read("pages", "ProgramDetail.jsx");
  assert.match(src, /retakePending: '待补考'/);
  assert.match(src, /retakeExam: '去补考'/);
  assert.match(src, /block \? block\.action : isRetake \? s\.retakeExam : s\.startExam/);
});

test("5.3 / 10.9 ExamPrep: single column, one primary Start button, back is a text link, only the types in this exam", () => {
  const src = read("pages", "ExamPrep.jsx");
  assert.match(src, /<div className="ep2-col">/);
  assert.match(src, /className="btn lg ep2-go"/);
  assert.match(src, /className="link-btn ep2-back"/);
  assert.match(src, /nav\(withFrom\(`\/exam\/\$\{examId\}`, trailSrc\)\)/, "web-nav pinned expression kept");
  assert.doesNotMatch(src, /v2-prep-workspace|v2-prep-rail/, "the old two-column workspace is gone");
  assert.doesNotMatch(src, /ptsBreak/, "no more four default per-type points (F40)");
  // pure helpers
  const from = src.indexOf("export const totalOf");
  const to = src.indexOf("export default function ExamPrep");
  const J = (v) => JSON.parse(JSON.stringify(v));
  const H = loadEsm(src.slice(from, to), ["totalOf", "typeLinesOf"]);
  assert.deepEqual(J(H.totalOf({ totalPoints: 20 })), { min: 20, max: 20 });
  assert.deepEqual(J(H.totalOf({ totalPoints: { min: 18, max: 24 } })), { min: 18, max: 24 });
  assert.deepEqual(J(H.totalOf({ typePoints: null, pointsRange: null, totalPoints: 100 })), { min: 100, max: 100 }, "old exam: total from the server");
  assert.equal(H.totalOf({}), null);
  const lines = H.typeLinesOf({ typeSummary: [{ type: "mcq", count: 20, points: 1 }, { type: "open", count: 0, points: 10 }] });
  assert.deepEqual(JSON.parse(JSON.stringify(lines)), [{ type: "mcq", count: 20, points: 1 }], "types with zero questions are not listed");
  assert.deepEqual(JSON.parse(JSON.stringify(H.typeLinesOf({ typePoints: { mcq: 1, multi: 1, fill: 1, open: 10 }, mcqCount: 20, openCount: 0 }))), [], "old payload never lists absent types");
  // the copy reads 「单选 20 题 × 1 分」
  const T = vm.runInNewContext("(" + src.slice(src.indexOf("const T = {") + 10, src.indexOf("\n};", src.indexOf("const T = {")) + 2) + ")");
  assert.equal(T.zh.typeLine(T.zh.typeName.mcq, 20, 1), "单选 20 题 × 1 分");
  assert.equal(T.en.typeLine(T.en.typeName.mcq, 1, 1), "Single choice: 1 question × 1 pt");
});

test("QA D1（第三批）：课程页 40px 小进度环里「100%」放得下（内径 30px，留 2px 余量）", () => {
  const ring = read("components", "ProgressRing.jsx");
  assert.match(ring, /className=\{'v' \+ \(Math\.round\(p\) >= 100 \? ' v3' : ''\)\}/, "three-digit values are marked");
  assert.match(read("pages", "MyLearning.jsx"), /<ProgressRing p=\{p\.progress \|\| 0\} size=\{40\} sm /);
  const css = read("app.css");
  const px = (v) => { const m = /^([\d.]+)px/.exec(v || ""); return m ? +m[1] : NaN; };
  const fv = px(cssLast(css, ".ring.sm .lab .v.v3", "font-size", 1440)) || px(cssLast(css, ".ring.sm .lab .v", "font-size", 1440));
  const fp = px(cssLast(css, ".ring.sm .lab .v.v3+small", "font-size", 1440)) || 10;   // 缺省 small = max(.62em, 10px)
  // 内径 = 40 − 2 × 5（线宽）= 30px；数字约 0.62em、「%」约 0.8em、间隔 1px
  const w = 3 * 0.62 * fv + 0.8 * fp + 1;
  assert.ok(w <= 28, `「100%」约 ${w.toFixed(1)}px，须 ≤ 28px`);
});
