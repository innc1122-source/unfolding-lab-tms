// 题库批量导入解析（web/src/pages/admin/questionImport.js）：
//   1. 中英文分列的表头 → 写进 question / question_zh、options[].text / text_zh、explanation / explanation_zh、rubric / rubric_zh；
//   2. 只填一种语言：英文主字段回落到中文（服务端要求非空），只填英文时 *_zh 为 null（学员端 loc() 回落英文）；
//   3. 旧单语模板（题目 / 选项A / 解析）与无表头粘贴照旧可导 —— 单语列按中文读，结果与旧版一致；
//   4. 模板文件：web/public/templates（vite 构建源）与 public/dist/templates 两份内容一致，表头即 IMP_TEMPLATE_HEADERS，示例行全部可导入；
//   5. 解析出的记录原样走 POST /api/admin/questions/bulk，中英文字段分开入库。
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");

const ROOT = path.join(__dirname, "..");
const esm = (...p) => import(pathToFileURL(path.join(ROOT, ...p)).href);
const lib = () => esm("web", "src", "pages", "admin", "questionImport.js");

// 解析器只用到这些文案；值是键名本身，断言里直接比对。
// 第四批（2026-10-08）：模板示例里有了排序 / 匹配 / 分类 / 案例等新题型，它们的带参数文案也得是函数。
const S = new Proxy({}, { get: (_, k) => (typeof k === "string" && /^(impErrRange|impAnsPoints|impErrOrderN|impErrLong|impErrArrow|impErrPairs|impErrDistractors|impErrCats|impErrCatUnknown|impErrClassItems|impErrCaseDup|impErrCaseOrder|impErrCaseUnknown|impErrCaseBadSub|impErrCaseN|impAnsPairs|impAnsCats|impAnsSubs)$/.test(k) ? (x) => `${k}:${x}` : k) });
const strip = (r) => Object.fromEntries(Object.entries(r).filter(([k]) => !k.startsWith("_")));

test("question import: bilingual columns map to the English main field and the _zh field", async () => {
  const { impParseGrid, IMP_TEMPLATE_HEADERS } = await lib();
  const row = (o) => IMP_TEMPLATE_HEADERS.map((h) => (h in o ? o[h] : ""));
  const out = impParseGrid([
    IMP_TEMPLATE_HEADERS,
    row({ "题型 *": "单选", "题干(中文)": "中文题干", "Stem (EN)": "English stem", "选项A(中文)": "甲", "Option A (EN)": "Alpha", "选项B(中文)": "乙", "Option B (EN)": "Beta", "正确答案": "B", "解析(中文)": "中文解析", "Explanation (EN)": "English why" }),
    row({ "题型 *": "多选", "题干(中文)": "只有中文", "选项A(中文)": "一", "选项B(中文)": "二", "选项C(中文)": "三", "正确答案": "AC" }),
    row({ "题型 *": "单选", "Stem (EN)": "English only", "Option A (EN)": "Yes", "Option B (EN)": "No", "正确答案": "A" }),
    row({ "题型 *": "单选", "题干(中文)": "混合选项", "Stem (EN)": "Mixed options", "选项A(中文)": "仅中文", "Option B (EN)": "English only", "正确答案": "A" }),
    row({ "题型 *": "问答", "题干(中文)": "简述", "Stem (EN)": "Describe", "解析(中文)": "要点", "Explanation (EN)": "Key points", "分值": "20" }), // 第四批：模板表头「分值(问答)」改为「分值」（每题分值适用所有题型；旧表头照常可导，见下方旧模板用例）
    row({ "题型 *": "填空", "题干(中文)": "缩写", "Stem (EN)": "Abbr", "正确答案": "AML|反洗钱" }),
    row({ "题型 *": "判断", "题干(中文)": "对吗", "Stem (EN)": "True?", "正确答案": "错" }),
    row({ "题型 *": "单选", "选项A(中文)": "a", "选项B(中文)": "b", "正确答案": "A" }),
  ], S);
  assert.equal(out.bilingual, true);
  assert.equal(out.headerCols, IMP_TEMPLATE_HEADERS.length);
  const [full, zhOnly, enOnly, mixed, open, fill, tf, noStem] = out.rows;

  assert.equal(full._err, null);
  assert.deepEqual(strip(full), {
    type: "mcq", question: "English stem", question_zh: "中文题干",
    explanation: "English why", explanation_zh: "中文解析",
    options: [{ text: "Alpha", text_zh: "甲", ok: false }, { text: "Beta", text_zh: "乙", ok: true }],
  });

  // 只有中文：英文主字段回落到中文（与单题编辑器 buildBody 同一写法）
  assert.equal(zhOnly._err, null);
  assert.equal(zhOnly.question, "只有中文");
  assert.equal(zhOnly.question_zh, "只有中文");
  assert.deepEqual(zhOnly.options.map((o) => [o.text, o.text_zh, o.ok]), [["一", "一", true], ["二", "二", false], ["三", "三", true]]);
  assert.equal(zhOnly.explanation, "");
  assert.equal(zhOnly.explanation_zh, null);

  // 只有英文：_zh 一律 null，中文界面经 loc() 回落到英文，而不是把英文塞进中文字段
  assert.equal(enOnly._err, null);
  assert.equal(enOnly.question, "English only");
  assert.equal(enOnly.question_zh, null);
  assert.deepEqual(enOnly.options.map((o) => [o.text, o.text_zh]), [["Yes", null], ["No", null]]);

  assert.deepEqual(mixed.options.map((o) => [o.text, o.text_zh]), [["仅中文", "仅中文"], ["English only", null]]);

  assert.equal(open._err, null);
  assert.equal(open.type, "open");
  assert.equal(open.rubric, "Key points");
  assert.equal(open.rubric_zh, "要点");
  assert.equal(open.maxPoints, 20);
  assert.equal("explanation" in open, false);

  assert.deepEqual(fill.answers, ["AML", "反洗钱"]);
  assert.equal(fill.question, "Abbr");
  assert.equal(fill.question_zh, "缩写");

  // 第四批 4c（2026-10-08）：判断题开放后「判断」导入为独立的判断题 tf（answer 布尔），不再是「正确 / 错误」两个选项的单选题；
  // 判断题未开放时的旧写法见 test/question-import-types.test.js。
  assert.equal(tf.type, "tf");
  assert.equal(tf.answer, false);
  assert.equal("options" in tf, false);
  assert.equal(tf.question_zh, "对吗");

  assert.equal(noStem._err, "impErrStem");
});

test("question import: header spellings — language before or after, EN/英文/中文/ZH, any order", async () => {
  const { impHeaderMap } = await lib();
  const m = impHeaderMap(["Stem (EN)", "中文题干", "Type", "Option C (English)", "选项C（中文）", "选项E", "Option F", "答案", "英文解析", "Explanation (ZH)", "Points"]);
  assert.ok(m);
  assert.equal(m.questionEn, 0);
  assert.equal(m.questionZh, 1);
  assert.equal(m.type, 2);
  assert.equal(m.optionsEn[2], 3);
  assert.equal(m.optionsZh[2], 4);
  assert.equal(m.options[4], 5, "旧表头「选项E」不能被拆成「选项 + en」");
  assert.equal(m.options[5], 6, "旧表头「Option F」照旧");
  assert.equal(m.answer, 7);
  assert.equal(m.explEn, 8);
  assert.equal(m.explZh, 9);
  assert.equal(m.points, 10);
  assert.equal(m.bilingual, true);
  // 数据行不能被当成表头；只有题型没有任何题干列也不算表头
  assert.equal(impHeaderMap(["单选", "下列哪项…", "A", "B"]), null);
  assert.equal(impHeaderMap(["题型", "选项A(中文)", "正确答案"]), null);
});

test("question import: the old single-language template still imports, unlabelled columns read as Chinese", async () => {
  const { impParseGrid, IMP_FIXED } = await lib();
  const OLD = ["题型 *", "题目 *", "选项A", "选项B", "选项C", "选项D", "选项E", "选项F", "正确答案", "解析 / 评分要点", "分值(问答)"];
  const rows = [
    ["单选", "下列哪项属于洗钱行为?", "用非法所得购买房产并转售", "正常工资入账", "", "", "", "", "A", "洗钱是将非法所得合法化的行为", ""],
    ["问答", "请简述上报流程。", "", "", "", "", "", "", "", "要点:立即记录", "10"],
  ];
  const withHeader = impParseGrid([OLD, ...rows], S);
  assert.equal(withHeader.bilingual, false);
  assert.equal(withHeader.headerCols, OLD.length);
  // 与旧版解析器一致：同一段文字同时进英文主字段和 _zh
  assert.deepEqual(strip(withHeader.rows[0]), {
    type: "mcq", question: "下列哪项属于洗钱行为?", question_zh: "下列哪项属于洗钱行为?",
    explanation: "洗钱是将非法所得合法化的行为", explanation_zh: "洗钱是将非法所得合法化的行为",
    options: [{ text: "用非法所得购买房产并转售", text_zh: "用非法所得购买房产并转售", ok: true }, { text: "正常工资入账", text_zh: "正常工资入账", ok: false }],
  });
  assert.deepEqual(strip(withHeader.rows[1]), { type: "open", question: "请简述上报流程。", question_zh: "请简述上报流程。", rubric: "要点:立即记录", rubric_zh: "要点:立即记录", maxPoints: 10 });

  // 无表头粘贴：按旧模板固定列序
  const headerless = impParseGrid(rows, S);
  assert.equal(headerless.headerCols, 0);
  assert.deepEqual(headerless.rows.map(strip), withHeader.rows.map(strip));
  assert.equal(IMP_FIXED.question, 1);

  // 旧列与「中文」列同时存在时，「中文」列优先
  const both = impParseGrid([["题型", "题目", "题干(中文)", "Stem (EN)", "选项A", "选项B", "答案"], ["单选", "旧列", "新列", "New", "x", "y", "A"]], S);
  assert.equal(both.rows[0].question_zh, "新列");
  assert.equal(both.rows[0].question, "New");
});

test("question import: Excel paste of the bilingual header (tab separated) parses", async () => {
  const { impParseGrid, impSplitPaste } = await lib();
  const text = "题型\t题干(中文)\tStem (EN)\t选项A(中文)\tOption A (EN)\t选项B(中文)\tOption B (EN)\t正确答案\r\n单选\t问\tQ\t是\tYes\t否\tNo\tA\r\n";
  const out = impParseGrid(impSplitPaste(text), S);
  assert.equal(out.rows.length, 1);
  assert.equal(out.rows[0]._err, null);
  assert.equal(out.rows[0].question, "Q");
  assert.equal(out.rows[0].question_zh, "问");
  assert.deepEqual(out.rows[0].options, [{ text: "Yes", text_zh: "是", ok: true }, { text: "No", text_zh: "否", ok: false }]);
});

test("question import: shipped template — source and dist copies match, header is IMP_TEMPLATE_HEADERS, every example imports", async () => {
  const { impParseGrid, IMP_TEMPLATE_HEADERS } = await lib();
  const src = path.join(ROOT, "web", "public", "templates", "question-import-template.xlsx");
  const dist = path.join(ROOT, "public", "dist", "templates", "question-import-template.xlsx");
  assert.ok(fs.existsSync(src), "web/public/templates/question-import-template.xlsx 是模板源文件（vite 构建时拷进 dist）；用 web/scripts/question-template.mjs 生成");
  assert.ok(fs.existsSync(dist), "public/dist/templates/question-import-template.xlsx 缺失 —— 重新构建或运行 web/scripts/question-template.mjs");
  let XLSX;
  try { XLSX = (await import(pathToFileURL(path.join(ROOT, "web", "node_modules", "xlsx", "xlsx.mjs")).href)); } catch { XLSX = null; }
  if (!XLSX) return; // 没装 web 依赖的机器上只核对文件存在
  const read = (f) => {
    const wb = XLSX.read(fs.readFileSync(f), { type: "buffer" });
    return XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: false, defval: "" });
  };
  const grid = read(src);
  assert.deepEqual(read(dist), grid, "dist 里的模板与 web/public/templates 不一致 —— 重新运行 web/scripts/question-template.mjs");
  assert.deepEqual(grid[0], IMP_TEMPLATE_HEADERS);
  const out = impParseGrid(grid, S);
  assert.equal(out.bilingual, true);
  assert.ok(out.rows.length >= 5);
  assert.deepEqual(out.rows.filter((r) => r._err).map((r) => [r._row, r._err]), []);
  assert.ok(out.rows.some((r) => r.question_zh && r.question && r.question !== r.question_zh), "示例里至少有一题中英文都有");
});

test("question import: parsed bilingual rows go through POST /api/admin/questions/bulk with the languages kept apart", async () => {
  const { impParseGrid, IMP_TEMPLATE_HEADERS } = await lib();
  const { ADMIN, startServer, loginAs, tempDir } = require("./helpers.js");
  // 临时 config，绝不读写仓库根的活配置
  const srv = await startServer({ env: { LMS_CONFIG_PATH: path.join(tempDir("lms-qimp-cfg-"), "config.json") } });
  try {
    const admin = await loginAs(srv.base, ADMIN);
    const content = (await admin.get("/api/admin/content")).data;
    const courseId = content.courses[0].id;
    const row = (o) => IMP_TEMPLATE_HEADERS.map((k) => (k in o ? o[k] : ""));
    const out = impParseGrid([
      IMP_TEMPLATE_HEADERS,
      row({ "题型 *": "单选", "题干(中文)": "双语导入题干", "Stem (EN)": "Bilingual import stem", "选项A(中文)": "甲", "Option A (EN)": "Alpha", "选项B(中文)": "乙", "Option B (EN)": "Beta", "正确答案": "A", "解析(中文)": "因为", "Explanation (EN)": "Because" }),
      row({ "题型 *": "问答", "Stem (EN)": "English only import stem", "Explanation (EN)": "Points" }),
    ], S);
    const items = out.rows.map(strip);
    const r = await admin.post("/api/admin/questions/bulk", { courseId, items });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.deepEqual(r.data.results.map((x) => x.ok), [true, true]);
    const all = (await admin.get("/api/admin/questions")).data;
    const a = all.find((q) => q.question === "Bilingual import stem");
    assert.ok(a);
    assert.equal(a.question_zh, "双语导入题干");
    assert.deepEqual(a.options.map((o) => [o.text, o.text_zh, o.ok]), [["Alpha", "甲", true], ["Beta", "乙", false]]);
    assert.equal(a.explanation, "Because");
    assert.equal(a.explanation_zh, "因为");
    const b = all.find((q) => q.question === "English only import stem");
    assert.ok(b);
    assert.equal(b.question_zh, null);
    assert.equal(b.rubric, "Points");
    assert.equal(b.rubric_zh, null);
  } finally {
    await srv.stop();
  }
});
