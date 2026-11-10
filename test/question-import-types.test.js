// 题库批量导入 · 第四批新题型（web/src/pages/admin/questionImport.js，设计 §1.8）：
//   题型词；A–L 选项列；匹配「左 => 右」含干扰项；分类按同一语言匹配类别；多空填空答案写法；排序字母顺序；
//   案例分组及其错误（小题在前、编号不存在、编号重复、小题题型不允许、小题有错、小题数）；阶段开关提示；
//   模板表头含新列；旧 A–F 文件照旧（与旧解析器逐字段一致）；导出 → 再导入 原样往返（D12）。
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { pathToFileURL } = require("url");

const ROOT = path.join(__dirname, "..");
const lib = () => import(pathToFileURL(path.join(ROOT, "web", "src", "pages", "admin", "questionImport.js")).href);

// 文案：值是键名本身；带参数的文案返回「键名:参数」
const S = new Proxy({}, { get: (_, k) => (typeof k !== "string" ? undefined : Object.assign((...a) => `${k}:${a.join(",")}`, { toString: () => k, valueOf: () => k })) });
const err = (r) => (r._err == null ? null : String(r._err));
const strip = (r) => Object.fromEntries(Object.entries(r).filter(([k]) => !k.startsWith("_")));

async function parse(objs, opts) {
  const { impParseGrid, IMP_TEMPLATE_HEADERS } = await lib();
  const row = (o) => IMP_TEMPLATE_HEADERS.map((h) => (h in o ? o[h] : ""));
  return impParseGrid([IMP_TEMPLATE_HEADERS, ...objs.map(row)], S, opts);
}
const T = "题型 *", ZH = "题干(中文)", EN = "Stem (EN)", ANS = "正确答案", CASE = "案例编号 / Case ID";
const oz = (l) => `选项${l}(中文)`, oe = (l) => `Option ${l} (EN)`;

test("type words: every new type word maps to its key; cloze / case words win over fill / single", async () => {
  const { impTypeOf } = await lib();
  const cases = {
    "排序": "ordering", "ordering": "ordering", "Order": "ordering",
    "匹配": "matching", "连线": "matching", "Matching": "matching",
    "分类": "classify", "归类": "classify", "classify": "classify", "Classification": "classify",
    "多空填空": "cloze", "多空": "cloze", "完形填空": "cloze", "cloze": "cloze", "Multi-blank fill": "cloze",
    "案例": "case", "情境案例": "case", "情境案例题组": "case", "case": "case", "Scenario case": "case",
    "判断": "tf", "判断题": "tf", "true/false": "tf", "TF": "tf",
    "单选": "mcq", "多选": "multi", "填空": "fill", "问答": "open", "简答题": "open",
  };
  for (const [w, k] of Object.entries(cases)) assert.equal(impTypeOf(w), k, w);
  assert.equal(impTypeOf("其他"), null);
});

test("template headers: options A–L, points, case ID and the categories pair; header map finds every column", async () => {
  const { IMP_TEMPLATE_HEADERS, IMP_LETTERS, impHeaderMap } = await lib();
  assert.deepEqual(IMP_LETTERS, "ABCDEFGHIJKL".split(""));
  for (const h of ["选项L(中文)", "Option L (EN)", "案例编号 / Case ID", "分类(中文)", "Categories (EN)", "分值"]) assert.ok(IMP_TEMPLATE_HEADERS.includes(h), h);
  const m = impHeaderMap(IMP_TEMPLATE_HEADERS);
  assert.equal(m.hits, IMP_TEMPLATE_HEADERS.length);
  assert.equal(m.optionsZh[11], IMP_TEMPLATE_HEADERS.indexOf("选项L(中文)"));
  assert.equal(m.optionsEn[11], IMP_TEMPLATE_HEADERS.indexOf("Option L (EN)"));
  assert.equal(m.caseId, IMP_TEMPLATE_HEADERS.indexOf("案例编号 / Case ID"));
  assert.equal(m.catsZh, IMP_TEMPLATE_HEADERS.indexOf("分类(中文)"));
  assert.equal(m.catsEn, IMP_TEMPLATE_HEADERS.indexOf("Categories (EN)"));
  // 其他写法
  const m2 = impHeaderMap(["Type", "Stem", "Case ID", "Categories", "Option 12", "选项K"]);
  assert.deepEqual([m2.caseId, m2.cats, m2.options[11], m2.options[10]], [2, 3, 4, 5]);
});

test("mcq with options G–L: letters beyond F are options now", async () => {
  const out = await parse([{ [T]: "多选", [ZH]: "十二选", ...Object.fromEntries("ABCDEFGHIJKL".split("").map((l) => [oz(l), "项" + l])), [ANS]: "AL" }]);
  const r = out.rows[0];
  assert.equal(err(r), null);
  assert.equal(r.options.length, 12);
  assert.deepEqual(r.options.map((o) => o.ok).map(Number).join(""), "100000000001");
});

test("tf: 判断 imports as a stand-alone true/false question once tf is enabled; legacy mcq True/False when it is not", async () => {
  const on = await parse([{ [T]: "判断", [ZH]: "对吗", [EN]: "True?", [ANS]: "√" }, { [T]: "判断", [ZH]: "错吗", [ANS]: "False" }, { [T]: "判断", [ZH]: "x", [ANS]: "也许" }]);
  assert.deepEqual(strip(on.rows[0]), { type: "tf", question: "True?", question_zh: "对吗", explanation: "", explanation_zh: null, answer: true });
  assert.equal(on.rows[1].answer, false);
  assert.equal(err(on.rows[2]), "impErrTf");
  const off = await parse([{ [T]: "判断", [ZH]: "对吗", [ANS]: "对" }], { enabled: ["mcq", "multi", "fill", "open"] });
  assert.deepEqual(off.rows[0].type, "mcq");
  assert.deepEqual(off.rows[0].options, [{ text: "True", text_zh: "正确", ok: true }, { text: "False", text_zh: "错误", ok: false }]);
});

test("phase gate: a type word whose type is not enabled is a row error, never silently another type", async () => {
  const out = await parse([{ [T]: "排序", [ZH]: "步骤", [oz("A")]: "1", [oz("B")]: "2", [oz("C")]: "3" }], { enabled: ["mcq", "multi", "fill", "open"] });
  assert.equal(out.rows[0].type, "ordering");
  assert.equal(err(out.rows[0]), "impErrPhase");
});

test("ordering: options in the correct order; a letter sequence reorders; bad sequences, counts and duplicates are errors", async () => {
  const base = { [T]: "排序", [ZH]: "步骤", [EN]: "Steps", [oz("A")]: "甲", [oe("A")]: "One", [oz("B")]: "乙", [oe("B")]: "Two", [oz("C")]: "丙", [oe("C")]: "Three" };
  const out = await parse([
    base,
    { ...base, [ANS]: "CAB" },
    { ...base, [ANS]: "CA" },
    { ...base, [ANS]: "CAD" },
    { [T]: "排序", [ZH]: "太少", [oz("A")]: "a", [oz("B")]: "b" },
    { ...base, [oe("C")]: "one" },
  ]);
  assert.deepEqual(out.rows[0].items, [{ text: "One", text_zh: "甲" }, { text: "Two", text_zh: "乙" }, { text: "Three", text_zh: "丙" }]);
  assert.equal(err(out.rows[0]), null);
  assert.deepEqual(out.rows[1].items.map((x) => x.text), ["Three", "One", "Two"]);
  assert.equal(err(out.rows[2]), "impErrOrderSeq");
  assert.equal(err(out.rows[3]), "impErrOrderSeq");
  assert.equal(err(out.rows[4]), "impErrOrderN:3,8");
  assert.equal(err(out.rows[5]), "impErrOrderDup", "steps differ only in case");
});

test("matching: 「左 => 右」 in both language columns, → also accepted; 「=> 右」 is a distractor; malformed cells and duplicate rights are errors", async () => {
  const out = await parse([
    { [T]: "匹配", [ZH]: "配对", [EN]: "Match", [oz("A")]: "甲 => 一", [oe("A")]: "A => One", [oz("B")]: "乙 → 二", [oe("B")]: "B→Two", [oz("C")]: "=> 三", [oe("C")]: "=> Three" },
    { [T]: "匹配", [ZH]: "只有中文", [oz("A")]: "甲 => 一", [oz("B")]: "乙 => 二" },
    { [T]: "匹配", [ZH]: "缺箭头", [oz("A")]: "甲 一", [oz("B")]: "乙 => 二" },
    { [T]: "匹配", [ZH]: "一对", [oz("A")]: "甲 => 一", [oz("B")]: "=> 二" },
    { [T]: "匹配", [ZH]: "右项重复", [oz("A")]: "甲 => 一", [oz("B")]: "乙 => 一" },
    { [T]: "匹配", [ZH]: "干扰太多", [oz("A")]: "甲 => 一", [oz("B")]: "乙 => 二", [oz("C")]: "=> 三", [oz("D")]: "=> 四", [oz("E")]: "=> 五", [oz("F")]: "=> 六" },
  ]);
  const [ok, zhOnly, noArrow, onePair, dup, tooMany] = out.rows;
  assert.equal(err(ok), null);
  assert.deepEqual(ok.pairs, [
    { left: { text: "A", text_zh: "甲" }, right: { text: "One", text_zh: "一" } },
    { left: { text: "B", text_zh: "乙" }, right: { text: "Two", text_zh: "二" } },
  ]);
  assert.deepEqual(ok.distractors, [{ text: "Three", text_zh: "三" }]);
  assert.equal(String(ok._ans), "impAnsPairs:2,1");
  assert.deepEqual(zhOnly.pairs[0], { left: { text: "甲", text_zh: "甲" }, right: { text: "一", text_zh: "一" } });
  assert.equal(err(noArrow), "impErrArrow:A");
  assert.equal(err(onePair), "impErrPairs:2,8");
  assert.equal(err(dup), "impErrDupRight");
  assert.equal(err(tooMany), "impErrDistractors:3");
});

test("classify: categories from the 分类 columns; items match a category of the same language; unknown / conflicting / empty categories are errors", async () => {
  const C = { [T]: "分类", [ZH]: "归类", [EN]: "Sort", "分类(中文)": "甲类 | 乙类", "Categories (EN)": "Alpha | Beta" };
  const out = await parse([
    { ...C, [oz("A")]: "一 => 甲类", [oe("A")]: "one => Alpha", [oz("B")]: "二 => 乙类", [oe("B")]: "two => beta", [oz("C")]: "三 => 甲类", [oe("C")]: "three" },
    { ...C, [oz("A")]: "一 => 丙类", [oz("B")]: "二 => 乙类" },
    { ...C, [oz("A")]: "一 => 甲类", [oe("A")]: "one => Beta", [oz("B")]: "二 => 乙类" },
    { ...C, [oz("A")]: "一 => 甲类", [oz("B")]: "二 => 甲类" },
    { [T]: "分类", [ZH]: "一类", "分类(中文)": "甲类", [oz("A")]: "一 => 甲类", [oz("B")]: "二 => 甲类" },
    { ...C, [oe("A")]: "one => Alpha", [oe("B")]: "two => Beta" },
  ]);
  const [ok, unknown, conflict, empty, oneCat, enOnly] = out.rows;
  assert.equal(err(ok), null);
  assert.deepEqual(ok.categories, [{ text: "Alpha", text_zh: "甲类" }, { text: "Beta", text_zh: "乙类" }]);
  // 英文列只写项目、不写类别时按中文列的类别（第 3 项 three）
  assert.deepEqual(ok.items, [{ text: "one", text_zh: "一", cat: 0 }, { text: "two", text_zh: "二", cat: 1 }, { text: "three", text_zh: "三", cat: 0 }]);
  assert.equal(err(unknown), "impErrCatUnknown:A,丙类");
  assert.equal(err(conflict), "impErrCatUnknown:A,甲类 / Beta");
  assert.equal(err(empty), "impErrCatEmpty");
  assert.equal(err(oneCat), "impErrCats:2,5");
  assert.equal(err(enOnly), null);
  assert.deepEqual(enOnly.items.map((x) => [x.text, x.text_zh, x.cat]), [["one", null, 0], ["two", null, 1]]);
});

test("cloze: markers {{1}}…{{n}} once each in both stems; answers 「1: a / b ; 2: c」, alternatives | / 、; errors name the problem", async () => {
  const out = await parse([
    { [T]: "多空填空", [ZH]: "{{1}} 和 {{2}}", [EN]: "{{1}} and {{2}}", [ANS]: "1: AML / 反洗钱 ; 2: KYC|了解客户" },
    { [T]: "多空", [ZH]: "只有 {{1}}", [ANS]: "答案甲、答案乙" },
    { [T]: "多空", [ZH]: "{{1}} {{2}}", [EN]: "{{1}} only", [ANS]: "1: a; 2: b" },
    { [T]: "多空", [ZH]: "{{1}} {{1}}", [ANS]: "1: a" },
    { [T]: "多空", [ZH]: "{{1}} {{2}}", [ANS]: "1: a" },
    { [T]: "多空", [ZH]: "{{1}} {{2}}", [ANS]: "1: a\n2: b\n3: c" },
    { [T]: "多空", [ZH]: "没有空", [ANS]: "a" },
  ]);
  const [ok, single, mismatch, twice, missing, extra, none] = out.rows;
  assert.equal(err(ok), null);
  assert.deepEqual(ok.blanks, [{ answers: ["AML", "反洗钱"] }, { answers: ["KYC", "了解客户"] }]);
  assert.deepEqual(single.blanks, [{ answers: ["答案甲", "答案乙"] }]);
  assert.equal(err(mismatch), "impErrMarkers");
  assert.equal(err(twice), "impErrMarkers");
  assert.equal(err(missing), "impErrBlankAns");
  assert.equal(err(extra), "impErrBlankAns");
  assert.equal(err(none), "impErrMarkers");
});

test("case: a 案例 row plus the following rows with its ID become one item with sub-questions; preview keeps the sub-rows marked", async () => {
  const { impItems } = await lib();
  const out = await parse([
    { [T]: "案例", [ZH]: "案例材料第一行\n第二行", [EN]: "Case passage", [CASE]: "C1", "分值": "50" },
    { [T]: "单选", [ZH]: "小题一", [oz("A")]: "是", [oz("B")]: "否", [ANS]: "A", [CASE]: "c1", "分值": "3" },
    { [T]: "排序", [ZH]: "小题二", [oz("A")]: "1", [oz("B")]: "2", [oz("C")]: "3", [CASE]: "C1" },
    { [T]: "单选", [ZH]: "独立题", [oz("A")]: "是", [oz("B")]: "否", [ANS]: "B" },
  ]);
  const [host, s1, s2, alone] = out.rows;
  assert.equal(err(host), null);
  assert.equal(s1._sub, true);
  assert.equal(s1._parent, host._row);
  assert.equal(String(host._ans), "impAnsSubs:2");
  const items = impItems(out.rows);
  assert.equal(items.length, 2, "a case and its sub-rows count as one item");
  const c = items[0];
  assert.equal(c.type, "case");
  assert.equal(c.passage, "Case passage");
  assert.equal(c.passage_zh, "案例材料第一行\n第二行");
  assert.equal(c.question, "Case passage");
  assert.equal(c.question_zh, "案例材料第一行", "the case's own stem is the passage's first line");
  assert.equal("points" in c, false, "a case's points are the sum of its sub-questions");
  assert.deepEqual(c.items.map((x) => [x.type, x.question_zh, x.points]), [["mcq", "小题一", 3], ["ordering", "小题二", undefined]]);
  assert.equal(items[1].question_zh, "独立题");
  assert.equal(alone._sub, undefined);
});

test("case errors: sub-row before its case, unknown ID, duplicate ID, open/case sub, a bad sub-row, too few subs, missing ID", async () => {
  const mcq = (id, stem = "小题") => ({ [T]: "单选", [ZH]: stem, [oz("A")]: "是", [oz("B")]: "否", [ANS]: "A", [CASE]: id });
  const out = await parse([
    mcq("C2", "在前"),
    { [T]: "案例", [ZH]: "材料二", [CASE]: "C2" },
    mcq("C2"), mcq("C2"),
    mcq("C9", "编号不存在"),
    { [T]: "案例", [ZH]: "重复编号", [CASE]: "c2" },
    { [T]: "案例", [ZH]: "材料三", [CASE]: "C3" },
    { [T]: "问答", [ZH]: "不能做小题", [CASE]: "C3" },
    mcq("C3"),
    { [T]: "案例", [ZH]: "材料四", [CASE]: "C4" },
    { [T]: "单选", [ZH]: "坏小题", [oz("A")]: "是", [ANS]: "A", [CASE]: "C4" },
    mcq("C4"),
    { [T]: "案例", [ZH]: "材料五", [CASE]: "C5" },
    mcq("C5"),
    { [T]: "案例", [ZH]: "没编号" },
  ]);
  const e = out.rows.map(err);
  assert.equal(e[0], "impErrCaseOrder:C2");
  assert.equal(e[1], null, "C2 itself is fine with its two later subs");
  assert.equal(e[4], "impErrCaseUnknown:C9");
  assert.equal(e[5], "impErrCaseDup:c2");
  assert.equal(e[7], "impErrCaseSub");
  assert.equal(e[6], `impErrCaseBadSub:${out.rows[7]._row}`);
  assert.equal(e[10], "impErrOpts");
  assert.equal(e[9], `impErrCaseBadSub:${out.rows[10]._row}`);
  assert.equal(e[12], "impErrCaseN:2,8");
  assert.equal(e[14], "impErrCaseId");
  const { impItems } = await lib();
  assert.deepEqual(impItems(out.rows).map((x) => x.passage_zh), ["材料二"]);
});

test("old A–F files parse exactly as the pre-batch-4 parser did (snapshot of the existing fixture)", async () => {
  const { impParseGrid } = await lib();
  const OLD = ["题型 *", "题目 *", "选项A", "选项B", "选项C", "选项D", "选项E", "选项F", "正确答案", "解析 / 评分要点", "分值(问答)"];
  const rows = [
    ["单选", "下列哪项属于洗钱行为?", "用非法所得购买房产并转售", "正常工资入账", "", "", "", "", "A", "洗钱是将非法所得合法化的行为", ""],
    ["多选", "哪些是 CDD?", "核实身份", "了解资金来源", "隐匿资产", "", "", "持续监控", "ABF", "", "3"],
    ["填空", "缩写?", "", "", "", "", "", "", "AML|反洗钱 / Anti-ML", "", ""],
    ["问答", "请简述上报流程。", "", "", "", "", "", "", "", "要点:立即记录", "20"],
  ];
  const out = impParseGrid([OLD, ...rows], S);
  assert.equal(out.headerCols, OLD.length);
  assert.deepEqual(out.rows.map(strip), [
    { type: "mcq", question: "下列哪项属于洗钱行为?", question_zh: "下列哪项属于洗钱行为?", explanation: "洗钱是将非法所得合法化的行为", explanation_zh: "洗钱是将非法所得合法化的行为",
      options: [{ text: "用非法所得购买房产并转售", text_zh: "用非法所得购买房产并转售", ok: true }, { text: "正常工资入账", text_zh: "正常工资入账", ok: false }] },
    { type: "multi", question: "哪些是 CDD?", question_zh: "哪些是 CDD?", explanation: "", explanation_zh: null, points: 3,
      options: [{ text: "核实身份", text_zh: "核实身份", ok: true }, { text: "了解资金来源", text_zh: "了解资金来源", ok: true }, { text: "隐匿资产", text_zh: "隐匿资产", ok: false }, { text: "持续监控", text_zh: "持续监控", ok: true }] },
    { type: "fill", question: "缩写?", question_zh: "缩写?", explanation: "", explanation_zh: null, answers: ["AML", "反洗钱", "Anti-ML"] },
    { type: "open", question: "请简述上报流程。", question_zh: "请简述上报流程。", rubric: "要点:立即记录", rubric_zh: "要点:立即记录", maxPoints: 20 },
  ]);
  // 无表头粘贴：旧固定列序照旧
  assert.deepEqual(impParseGrid(rows, S).rows.map(strip), out.rows.map(strip));
});

test("export → re-import round trip: every type (incl. a case and legacy True/False mcq) comes back as the same request body", async () => {
  const { impExportGrid, impParseGrid, impItems, IMP_TEMPLATE_HEADERS } = await lib();
  const bank = [
    { id: 1, type: "mcq", question: "Q1", question_zh: "题一", explanation: "Why", explanation_zh: "因为", points: 2, options: [{ text: "A", text_zh: "甲", ok: false }, { text: "B", text_zh: null, ok: true }] },
    { id: 2, type: "multi", question: "多", question_zh: "多", explanation: "", explanation_zh: null, options: [{ text: "x", text_zh: "x", ok: true }, { text: "y", text_zh: "y", ok: true }, { text: "z", text_zh: "z", ok: false }] },
    { id: 3, type: "mcq", question: "TF legacy", question_zh: null, explanation: "", explanation_zh: null, options: [{ text: "True", text_zh: "正确", ok: false }, { text: "False", text_zh: "错误", ok: true }] },
    { id: 4, type: "tf", question: "T?", question_zh: "对?", explanation: "", explanation_zh: null, answer: true },
    { id: 5, type: "fill", question: "F", question_zh: "填", explanation: "", explanation_zh: null, answers: ["AML", "反洗钱"] },
    { id: 6, type: "cloze", question: "{{1}} {{2}}", question_zh: "{{1}}、{{2}}", explanation: "", explanation_zh: null, points: 4, blanks: [{ answers: ["a", "b"] }, { answers: ["c"] }] },
    { id: 7, type: "ordering", question: "O", question_zh: "序", explanation: "", explanation_zh: null, items: [{ text: "s1", text_zh: "一" }, { text: "s2", text_zh: null }, { text: "s3", text_zh: "三" }] },
    { id: 8, type: "matching", question: "M", question_zh: "配", explanation: "", explanation_zh: null,
      pairs: [{ left: { text: "L1", text_zh: "左一" }, right: { text: "R1", text_zh: "右一" } }, { left: { text: "L2", text_zh: null }, right: { text: "R2", text_zh: null } }],
      distractors: [{ text: "R3", text_zh: "右三" }] },
    { id: 9, type: "classify", question: "C", question_zh: "类", explanation: "", explanation_zh: null,
      categories: [{ text: "Cat A", text_zh: "甲类" }, { text: "Cat B", text_zh: "乙类" }],
      items: [{ text: "i1", text_zh: "项一", cat: 1 }, { text: "i2", text_zh: null, cat: 0 }] },
    { id: 10, type: "open", question: "Open", question_zh: "简答", rubric: "Points", rubric_zh: "要点", maxPoints: 15 },
    { id: 11, type: "case", question: "Passage line", question_zh: "材料", passage: "Passage line", passage_zh: "材料", explanation: "", explanation_zh: null,
      items: [
        { sid: "s1", type: "mcq", question: "sub1", question_zh: "小一", points: 3, explanation: "", explanation_zh: null, options: [{ text: "Y", text_zh: "是", ok: true }, { text: "N", text_zh: "否", ok: false }] },
        { sid: "s2", type: "tf", question: "sub2", question_zh: null, points: null, explanation: "", explanation_zh: null, answer: false },
      ] },
    { id: 12, type: "zzz", unsupported: true, question: "future" },
  ];
  const { grid, skipped } = impExportGrid(bank);
  assert.equal(skipped, 1);
  assert.deepEqual(grid[0], IMP_TEMPLATE_HEADERS);
  assert.ok(grid.slice(1).every((r) => r.length === IMP_TEMPLATE_HEADERS.length));
  const out = impParseGrid(grid, S);
  assert.deepEqual(out.rows.filter((r) => r._err).map((r) => [r._row, String(r._err)]), []);
  const got = impItems(out.rows);
  // 题库条目 → 期望的请求体（id、sid 等服务端字段不在请求体里）
  const want = (q) => {
    const { id, sid, unsupported, ...rest } = q; // eslint-disable-line no-unused-vars
    if (rest.points == null) delete rest.points;
    if (rest.type === "case") rest.items = rest.items.map(want);
    return rest;
  };
  const norm = (o) => JSON.parse(JSON.stringify(o, Object.keys(o).length ? undefined : undefined));
  const sortKeys = (v) => (Array.isArray(v) ? v.map(sortKeys) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])])) : v);
  assert.equal(got.length, 11);
  bank.slice(0, 11).forEach((q, i) => assert.deepEqual(sortKeys(norm(got[i])), sortKeys(want(q)), `#${q.id} ${q.type}`));
});
