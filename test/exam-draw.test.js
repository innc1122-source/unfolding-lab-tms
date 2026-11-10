// 组卷「随机抽题，再调整」（第四批 6.2）：web/src/pages/admin/exam/drawPaper.js 纯函数
//   精确题数、按模块轮流均衡、案例整组抽、「只从未加入的题中抽」、题库不够时的 short 报告、固定种子可复现、
//   「预览一套随机试卷」按分组（客观题合池）抽，与服务端开考同一口径。
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { pathToFileURL } = require("url");

const ROOT = path.join(__dirname, "..");
const lib = () => import(pathToFileURL(path.join(ROOT, "web", "src", "pages", "admin", "exam", "drawPaper.js")).href);

// 题库：单选 12 道（3 个模块各 4 道）、多选 3 道（M1）、排序 2 道、简答 3 道、案例 2 组
const BANK = [
  ...Array.from({ length: 12 }, (_, i) => ({ id: `s${i}`, type: "mcq", moduleId: `M${(i % 3) + 1}` })),
  ...Array.from({ length: 3 }, (_, i) => ({ id: `m${i}`, type: "multi", moduleId: "M1" })),
  { id: "o0", type: "ordering", moduleId: "M2" }, { id: "o1", type: "ordering", moduleId: null },
  ...Array.from({ length: 3 }, (_, i) => ({ id: `p${i}`, type: "open", moduleId: "M3" })),
  { id: "c0", type: "case", moduleId: "M1", items: [{ sid: "s1" }, { sid: "s2" }] },
  { id: "c1", type: "case", moduleId: "M2", items: [{ sid: "s1" }, { sid: "s2" }, { sid: "s3" }] },
  { id: "x0", type: "mcq", moduleId: "M1", unsupported: true },
];
const byId = new Map(BANK.map((q) => [q.id, q]));

test("drawPaper: exact counts per type, ids in type order, no duplicates, unsupported rows never drawn", async () => {
  const { drawPaper, seededRng } = await lib();
  const r = drawPaper(BANK, { counts: { mcq: 5, multi: 2, ordering: 1, open: 2, case: 1 } }, seededRng(7));
  assert.deepEqual(r.short, []);
  assert.equal(r.ids.length, 11);
  assert.equal(new Set(r.ids).size, r.ids.length);
  const types = r.ids.map((id) => byId.get(id).type);
  assert.deepEqual(types, ["mcq", "mcq", "mcq", "mcq", "mcq", "multi", "multi", "ordering", "open", "open", "case"]);
  assert.ok(!r.ids.includes("x0"));
});

test("drawPaper: module round-robin — 6 single-choice from 3 modules of 4 gives 2 per module; balance off can cluster", async () => {
  const { drawPaper, seededRng } = await lib();
  for (let seed = 1; seed <= 50; seed++) {
    const r = drawPaper(BANK, { counts: { mcq: 6 }, balance: true }, seededRng(seed));
    const per = {};
    for (const id of r.ids) { const m = byId.get(id).moduleId; per[m] = (per[m] || 0) + 1; }
    assert.deepEqual(Object.values(per).sort(), [2, 2, 2], `seed ${seed}: ${JSON.stringify(per)}`);
  }
  // 不均衡：50 个种子里至少有一次某模块多于 2 道（证明均衡确实起作用而不是巧合）
  let clustered = false;
  for (let seed = 1; seed <= 50 && !clustered; seed++) {
    const r = drawPaper(BANK, { counts: { mcq: 6 }, balance: false }, seededRng(seed));
    const per = {};
    for (const id of r.ids) { const m = byId.get(id).moduleId; per[m] = (per[m] || 0) + 1; }
    clustered = Object.values(per).some((n) => n > 2);
  }
  assert.ok(clustered);
});

test("drawPaper: case groups are drawn as whole units (caseCount alias), never split", async () => {
  const { drawPaper, seededRng } = await lib();
  const r = drawPaper(BANK, { caseCount: 2 }, seededRng(3));
  assert.deepEqual([...r.ids].sort(), ["c0", "c1"]);
  assert.deepEqual(r.short, []);
});

test("drawPaper: exclude (only questions not on the paper) and the short report", async () => {
  const { drawPaper, seededRng } = await lib();
  const r = drawPaper(BANK, { counts: { multi: 3, ordering: 5 }, exclude: ["m0", "m1"] }, seededRng(11));
  assert.deepEqual(r.ids.filter((id) => id.startsWith("m")), ["m2"]);
  assert.deepEqual(r.short, [{ type: "multi", want: 3, got: 1 }, { type: "ordering", want: 5, got: 2 }]);
  // 0、负数、非数字都当 0，不出现在 short 里
  const z = drawPaper(BANK, { counts: { mcq: 0, multi: -2, fill: "x" } }, seededRng(1));
  assert.deepEqual(z, { ids: [], short: [] });
});

test("drawPaper: seeded determinism — same seed same paper, different seeds differ", async () => {
  const { drawPaper, seededRng } = await lib();
  const rules = { counts: { mcq: 6, open: 2 } };
  assert.deepEqual(drawPaper(BANK, rules, seededRng(42)).ids, drawPaper(BANK, rules, seededRng(42)).ids);
  const seen = new Set();
  for (let s = 1; s <= 20; s++) seen.add(drawPaper(BANK, rules, seededRng(s)).ids.join(","));
  assert.ok(seen.size > 1);
});

test("drawPaper: random-mode preview pools objective types like the server (mcqCount / openCount / caseCount)", async () => {
  const { drawPaper, seededRng, drawGroupOf } = await lib();
  assert.equal(drawGroupOf("ordering"), "objective");
  assert.equal(drawGroupOf("tf"), "objective");
  assert.equal(drawGroupOf("open"), "open");
  assert.equal(drawGroupOf("case"), "case");
  const r = drawPaper(BANK, { groups: { objective: 16, open: 1, case: 3 } }, seededRng(5));
  const groups = r.ids.map((id) => drawGroupOf(byId.get(id).type));
  assert.equal(groups.filter((g) => g === "objective").length, 16);
  assert.equal(groups.filter((g) => g === "open").length, 1);
  assert.deepEqual(r.short, [{ type: "case", want: 3, got: 2 }]);
  // 客观题池 = 单选 12 + 多选 3 + 排序 2 = 17，16 道里必然混有不止一种题型
  assert.ok(new Set(r.ids.filter((id) => drawGroupOf(byId.get(id).type) === "objective").map((id) => byId.get(id).type)).size > 1);
});
