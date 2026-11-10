// 受控人才标签 · 写法映射（modules/talent/controlled-tags.js；12.2 组 1，设计 b12-design 第 5.1、5.2、5.4 节）：
//   1. 第 5.2 节表里的写法（含首尾 emoji、全角、Hi-Po、大小写、两种语序、迁移 85 之后的「高潜 HiPo」「关键人才 Key talent」）都映射到对应 key；
//   2. 不映射清单（「高潜 HiPo（2025）」「核心人才」「骨干 Core performer」「待观察 Watch list」「Retention risk」）保持为自由标签；
//   3. normalizeTags / mapTags 去重保序、只在真有改写时 changed；controlledKeysOf 只认 canonical；
//   4. PUT 校验（tag_reserved 先于 controlled_tags_use_endpoint）、applyControlled、diffControlled、reasonOf 4–300 字。
// 源码里不放字面 emoji（F48），用 String.fromCodePoint 拼。
const test = require("node:test");
const assert = require("node:assert/strict");
const CT = require("../modules/talent/controlled-tags.js");

const E = (...cps) => String.fromCodePoint(...cps);
const STAR = E(0x1f31f), KEYCAP = E(0x1f511), COMPASS = E(0x1f9ed), FIRE_VS = E(0x1f525, 0xfe0f), FLAG = E(0x1f1f5, 0x1f1ed), THUMB_TONE = E(0x1f44d, 0x1f3fd);

test("controlled tags: definitions match the design table (5.1)", () => {
  assert.deepEqual([...CT.KEYS], ["hipo", "key", "flight"]);
  assert.deepEqual({ ...CT.CANONICAL }, { hipo: "高潜 HiPo", key: "关键人才 Key talent", flight: "流失风险 Flight risk" });
  assert.deepEqual(CT.LABELS.hipo, { zh: "高潜", en: "High potential" });
  assert.deepEqual(CT.LABELS.key, { zh: "关键人才", en: "Key talent" });
  assert.deepEqual(CT.LABELS.flight, { zh: "流失风险", en: "Flight risk" });
  assert.equal(CT.REASON_MIN, 4);
  assert.equal(CT.REASON_MAX, 300);
  assert.equal(CT.keyOf("继任候选 Successor"), null, "Successor stays a free preset tag");
});

test("controlled tags: every spelling in the 5.2 table maps to its key", () => {
  const cases = {
    hipo: [
      STAR + " 高潜 HiPo", "高潜 HiPo", "高潜", "HiPo", "Hi-Po", "High potential", "HiPo 高潜", "高潜力", "高潜人才",
      "hipo", "HIPO", "Hi Po", "hi_po", "High-Potential", "high potentials", "ＨｉＰｏ", "高潜（HiPo）", "高潜/HiPo", "高潜 | HiPo",
      "HiPo " + STAR, "  高潜 HiPo  ", "高潜 · HiPo", "Hi‐Po", "Hi–Po", "高潛",
    ],
    key: [
      KEYCAP + " 关键人才 Key talent", "关键人才 Key talent", "关键人才", "Key talent", "Key Talents", "KEY TALENT",
      "Key talent 关键人才", "关键人才-Key talent", "Key‐talent", "關鍵人才", FIRE_VS + "关键人才",
    ],
    flight: [
      "流失风险 Flight risk", "流失风险", "Flight risk", "离职风险", "FLIGHT RISK", "Flight-risk", "Flight risk 流失风险",
      "离职风险 Flight risk", FLAG + " 流失风险", "流失风险 " + THUMB_TONE, "Flight risks",
    ],
  };
  for (const [key, list] of Object.entries(cases)) {
    for (const s of list) {
      assert.equal(CT.keyOf(s), key, `keyOf(${JSON.stringify(s)})`);
      assert.equal(CT.canonicalOf(s), CT.CANONICAL[key], `canonicalOf(${JSON.stringify(s)})`);
    }
  }
});

test("controlled tags: unmappable spellings stay free tags", () => {
  for (const s of ["高潜 HiPo（2025）", "核心人才", "骨干 Core performer", COMPASS + " 骨干 Core performer", "待观察 Watch list",
    "Retention risk", "继任候选 Successor", "高", "Key", "Risk", "Talent", "HiPo candidate", "非高潜", "高潜候选", "", "   ", STAR]) {
    assert.equal(CT.keyOf(s), null, JSON.stringify(s));
    assert.equal(CT.canonicalOf(s), null, JSON.stringify(s));
  }
  for (const v of [null, undefined, 1, {}, ["高潜"]]) assert.equal(CT.keyOf(v), null);
  // © ® ™ 这类排版符号不算 emoji：不会被当作 emoji 剥掉而误映射
  assert.equal(CT.keyOf("© 高潜"), null);
});

test("controlled tags: canonical / reserved spelling predicates", () => {
  assert.equal(CT.isCanonical("高潜 HiPo"), true);
  assert.equal(CT.isCanonical("HiPo"), false);
  assert.equal(CT.isReservedSpelling("HiPo"), true);
  assert.equal(CT.isReservedSpelling(STAR + " 高潜 HiPo"), true);
  assert.equal(CT.isReservedSpelling("高潜 HiPo"), false);
  assert.equal(CT.isReservedSpelling("核心人才"), false);
});

test("controlled tags: controlledKeysOf counts only the exact canonical values; heldKeysOf accepts any spelling", () => {
  assert.deepEqual(CT.controlledKeysOf(["流失风险 Flight risk", "高潜 HiPo", "继任候选 Successor"]), ["hipo", "flight"]);
  assert.deepEqual(CT.controlledKeysOf(["HiPo", "高潜", "Key talent"]), []);
  assert.deepEqual(CT.controlledKeysOf(JSON.stringify(["关键人才 Key talent", "关键人才 Key talent"])), ["key"]);
  assert.deepEqual(CT.controlledKeysOf("not json"), []);
  assert.deepEqual(CT.controlledKeysOf(null), []);
  assert.deepEqual(CT.heldKeysOf(["Flight risk", "HiPo", "x"]), ["hipo", "flight"]);
});

test("controlled tags: mapTags / normalizeTags map, dedupe and keep first positions", () => {
  const r = CT.mapTags(["骨干", "HiPo", STAR + " 高潜 HiPo", "高潜 HiPo（2025）", "关键人才", "骨干", "高潜 HiPo", "Flight risk"]);
  assert.deepEqual(r.tags, ["骨干", "高潜 HiPo", "高潜 HiPo（2025）", "关键人才 Key talent", "流失风险 Flight risk"]);
  assert.equal(r.changed, true);
  assert.deepEqual(r.mapped, [
    { from: "HiPo", key: "hipo" }, { from: STAR + " 高潜 HiPo", key: "hipo" }, { from: "关键人才", key: "key" }, { from: "Flight risk", key: "flight" },
  ]);
  // 已规范的列表：不改
  const same = CT.mapTags(["高潜 HiPo", "继任候选 Successor"]);
  assert.equal(same.changed, false);
  assert.deepEqual(same.mapped, []);
  assert.deepEqual(same.tags, ["高潜 HiPo", "继任候选 Successor"]);
  // 非字符串元素原样保留、按 JSON 去重
  assert.deepEqual(CT.normalizeTags([1, "高潜", 1, null]), [1, "高潜 HiPo", null]);
  assert.deepEqual(CT.normalizeTags(JSON.stringify(["高潜", "高潜力"])), ["高潜 HiPo"]);
  assert.deepEqual(CT.normalizeTags(undefined), []);
  // 幂等
  assert.deepEqual(CT.normalizeTags(r.tags), r.tags);
  assert.equal(CT.mapTags(r.tags).changed, false);
  assert.deepEqual(CT.freeTagsOf(["高潜 HiPo", "HiPo", "骨干", "继任候选 Successor"]), ["骨干", "继任候选 Successor"]);
});

test("controlled tags: applyControlled adds the canonical value, removes every spelling, reports unchanged", () => {
  assert.deepEqual(CT.applyControlled(["骨干"], "hipo", "add"), { tags: ["骨干", "高潜 HiPo"], changed: true });
  assert.deepEqual(CT.applyControlled(["HiPo"], "hipo", "add"), { tags: ["HiPo"], changed: false }, "already held under another spelling");
  assert.deepEqual(CT.applyControlled(["高潜 HiPo", "骨干", "HiPo"], "hipo", "remove"), { tags: ["骨干"], changed: true });
  assert.deepEqual(CT.applyControlled(["骨干"], "flight", "remove"), { tags: ["骨干"], changed: false });
  assert.deepEqual(CT.applyControlled(JSON.stringify(["x"]), "key", "add"), { tags: ["x", "关键人才 Key talent"], changed: true });
  assert.throws(() => CT.applyControlled([], "successor", "add"), TypeError);
  assert.throws(() => CT.applyControlled([], "hipo", "toggle"), TypeError);
});

test("controlled tags: diffControlled compares the held sets (any spelling)", () => {
  assert.deepEqual(CT.diffControlled(["HiPo"], ["高潜 HiPo", "Flight risk"]), { added: ["flight"], removed: [] });
  assert.deepEqual(CT.diffControlled(["高潜 HiPo", "关键人才 Key talent"], ["骨干"]), { added: [], removed: ["hipo", "key"] });
  assert.deepEqual(CT.diffControlled(null, []), { added: [], removed: [] });
});

test("controlled tags: PUT submission check — tag_reserved first, then controlled set must not change", () => {
  const cur = ["高潜 HiPo", "骨干"];
  assert.deepEqual(CT.checkTagSubmission(cur, ["高潜 HiPo", "骨干", "新标签"]), { ok: true, tags: ["高潜 HiPo", "骨干", "新标签"] });
  assert.deepEqual(CT.checkTagSubmission(cur, ["高潜 HiPo", "骨干", "骨干"]), { ok: true, tags: ["高潜 HiPo", "骨干"] });
  assert.deepEqual(CT.checkTagSubmission(cur, ["骨干"]), { ok: false, code: "controlled_tags_use_endpoint" }, "dropping a controlled tag");
  assert.deepEqual(CT.checkTagSubmission(cur, ["高潜 HiPo", "流失风险 Flight risk"]), { ok: false, code: "controlled_tags_use_endpoint" }, "adding one");
  assert.deepEqual(CT.checkTagSubmission(cur, ["高潜 HiPo", "HiPo"]), { ok: false, code: "tag_reserved", field: "HiPo" });
  assert.deepEqual(CT.checkTagSubmission([], ["Flight risk"]), { ok: false, code: "tag_reserved", field: "Flight risk" });
  // 旧写法的当前值（迁移前）也按持有判断
  assert.deepEqual(CT.checkTagSubmission(["HiPo"], ["高潜 HiPo"]), { ok: true, tags: ["高潜 HiPo"] });
});

test("controlled tags: reason must be 4–300 characters after trimming", () => {
  assert.equal(CT.reasonOf("  abc "), null);
  assert.equal(CT.reasonOf("年度校准"), "年度校准");
  assert.equal(CT.reasonOf("  abcd  "), "abcd");
  assert.equal(CT.reasonOf("字".repeat(300)), "字".repeat(300));
  assert.equal(CT.reasonOf("字".repeat(301)), null);
  assert.equal(CT.reasonOf(E(0x20000).repeat(4)), E(0x20000).repeat(4), "counted in characters, not UTF-16 units");
  assert.equal(CT.reasonOf(null), null);
  assert.equal(CT.reasonOf(1234), null);
});

test("controlled tags: labels by language", () => {
  assert.equal(CT.labelOf("hipo", "en"), "High potential");
  assert.equal(CT.labelOf("flight", "zh"), "流失风险");
  assert.equal(CT.labelOf("x", "en"), "x");
  assert.equal(CT.tagLabel("关键人才 Key talent", "en"), "Key talent");
  assert.equal(CT.tagLabel("骨干", "en"), "骨干");
  assert.equal(CT.migrationReason(["HiPo", "高潜", "HiPo"]), "存量标签纳入受控标签（原写法：HiPo、高潜）");
  assert.equal(CT.migrationReason([]), "存量标签纳入受控标签");
});
