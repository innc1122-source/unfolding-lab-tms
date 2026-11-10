// 继任计划批量导入的浏览器端解析（web/src/pages/admin/successionImport.js；第 5 批 8.2，设计 §9.1 / §9.2 / §14）：
//   1. 中英文表头（同一格中英混写、只写中文、只写英文、列序随意）都能认出；
//   2. 没有能识别的表头时按固定列序（模板列序）读取；
//   3. 跳过空行，保留 Excel 行号；输出的是原始字符串，前端不判断数据对不对；
//   4. 超过 2,000 行时标出 overCap（页面据此提示，不截断）；
//   5. 模板文件：web/public/templates 与 public/dist/templates 两份一致，表头即 SUCC_TEMPLATE_HEADERS，示例行都能解析。
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");

const ROOT = path.join(__dirname, "..");
const esm = (...p) => import(pathToFileURL(path.join(ROOT, ...p)).href);
const lib = () => esm("web", "src", "pages", "admin", "successionImport.js");
const loadXlsx = async () => {
  try { return await import(pathToFileURL(path.join(ROOT, "web", "node_modules", "xlsx", "xlsx.mjs")).href); } catch { return null; }
};

test("succession import parse: the template header maps every column, rows keep Excel line numbers", async () => {
  const { succParseGrid, SUCC_TEMPLATE_HEADERS } = await lib();
  const out = succParseGrid([
    SUCC_TEMPLATE_HEADERS,
    ["  财务经理 Finance Manager ", "T-00001", "示例员工", "1–2 年内就绪", "轮岗中"],
    ["", "", "", "", ""],
    ["财务经理", "t-00002", "", "Ready now", ""],
    [],
    ["IT Lead", "", "", "", ""],
  ]);
  assert.equal(out.headerCols, 5);
  assert.equal(out.overCap, false);
  assert.deepEqual(out.rows, [
    { line: 2, positionName: "财务经理 Finance Manager", employeeId: "T-00001", name: "示例员工", readiness: "1–2 年内就绪", note: "轮岗中" },
    { line: 4, positionName: "财务经理", employeeId: "t-00002", name: "", readiness: "Ready now", note: "" },
    { line: 6, positionName: "IT Lead", employeeId: "", name: "", readiness: "", note: "" },
  ]);
});

test("succession import parse: header spellings — Chinese only, English only, any order, extra columns ignored", async () => {
  const { succHeaderMap, succParseGrid } = await lib();
  const zh = succHeaderMap(["备注", "就绪度", "姓名", "工号", "关键岗位"]);
  assert.deepEqual(
    { p: zh.positionName, e: zh.employeeId, n: zh.name, r: zh.readiness, o: zh.note, hits: zh.hits },
    { p: 4, e: 3, n: 2, r: 1, o: 0, hits: 5 },
  );
  const en = succHeaderMap(["Employee ID", "Position name", "Successor name", "Readiness", "Remarks", "Department"]);
  assert.equal(en.employeeId, 0);
  assert.equal(en.positionName, 1, "「Position name」是岗位列，不能被当成姓名列");
  assert.equal(en.name, 2);
  assert.equal(en.readiness, 3);
  assert.equal(en.note, 4);
  assert.equal(en.hits, 5);
  const loose = succHeaderMap(["Key Position*", "Successor Employee ID *", "Name (optional)", "Readiness*", "Notes"]);
  assert.deepEqual([loose.positionName, loose.employeeId, loose.name, loose.readiness, loose.note], [0, 1, 2, 3, 4]);
  // 全角括号、冒号、星号都去掉后再比
  const full = succHeaderMap(["关键岗位：", "继任人工号（必填）*", "就绪度【必填】"]);
  assert.deepEqual([full.positionName, full.employeeId, full.readiness, full.name, full.note], [0, 1, 2, -1, -1]);

  // 列序随意：按表头取值；表头之外的列不读
  const out = succParseGrid([
    ["Readiness", "Department", "Employee ID", "Key position"],
    ["2年以上", "Finance", "T-00009", "CFO"],
  ]);
  assert.equal(out.headerCols, 3);
  assert.deepEqual(out.rows, [{ line: 2, positionName: "CFO", employeeId: "T-00009", name: "", readiness: "2年以上", note: "" }]);

  // 只缺岗位或只缺工号都不算表头（数据行不会被误当成表头）
  assert.equal(succHeaderMap(["财务经理", "T-00001", "张三", "即刻就绪", ""]), null);
  assert.equal(succHeaderMap(["关键岗位", "姓名", "就绪度"]), null);
  assert.equal(succHeaderMap(["工号", "姓名", "就绪度"]), null);
});

test("succession import parse: without a recognizable header, columns are read in the fixed template order", async () => {
  const { succParseGrid, SUCC_FIXED } = await lib();
  assert.deepEqual(SUCC_FIXED, { positionName: 0, employeeId: 1, name: 2, readiness: 3, note: 4 });
  const out = succParseGrid([
    [],
    ["财务经理", "T-00001", "张三", "即刻", "备注一"],
    ["  ", " "],
    ["HR Business Partner", "T-00003", "", "oneYear"],
  ]);
  assert.equal(out.headerCols, 0);
  assert.deepEqual(out.rows, [
    { line: 2, positionName: "财务经理", employeeId: "T-00001", name: "张三", readiness: "即刻", note: "备注一" },
    { line: 4, positionName: "HR Business Partner", employeeId: "T-00003", name: "", readiness: "oneYear", note: "" },
  ]);
  // 值原样保留（不判断就绪度写法、不改工号大小写、不校验长度）—— 这些都是服务端预览的事
  const raw = succParseGrid([["x".repeat(120), "t-1", "", "someday", "n"]]).rows[0];
  assert.equal(raw.positionName.length, 120);
  assert.equal(raw.employeeId, "t-1");
  assert.equal(raw.readiness, "someday");
  // 空表、只有表头
  assert.deepEqual(succParseGrid([]), { rows: [], headerCols: 0, overCap: false });
  assert.deepEqual(succParseGrid(null), { rows: [], headerCols: 0, overCap: false });
  const onlyHeader = succParseGrid([["关键岗位", "工号"]]);
  assert.deepEqual(onlyHeader.rows, []);
  assert.equal(onlyHeader.headerCols, 2);
});

test("succession import parse: more than 2,000 data rows is flagged, never truncated", async () => {
  const { succParseGrid, SUCC_MAX_ROWS, SUCC_TEMPLATE_HEADERS } = await lib();
  assert.equal(SUCC_MAX_ROWS, 2000);
  const mk = (n) => [SUCC_TEMPLATE_HEADERS, ...Array.from({ length: n }, (_, i) => ["岗位", `T-${String(i + 1).padStart(5, "0")}`, "", "即刻就绪", ""])];
  const at = succParseGrid(mk(2000));
  assert.equal(at.rows.length, 2000);
  assert.equal(at.overCap, false);
  const over = succParseGrid(mk(2001));
  assert.equal(over.rows.length, 2001, "不静默截断");
  assert.equal(over.overCap, true);
  assert.equal(over.rows[2000].line, 2002);
});

test("succession import parse: CSV text (quotes, commas and line breaks inside quotes, BOM) parses to the same rows", async () => {
  const { succSplitCsv, succParseGrid } = await lib();
  const text = "﻿关键岗位 Key position *,继任人工号 Successor employee ID *,继任人姓名 Name,就绪度 Readiness *,备注 Notes\r\n"
    + "\"Finance Manager, APAC\",T-00001,,Ready now,\"line one\nline two\"\r\n"
    + ",,,,\r\n"
    + "CFO,T-00002,\"Lee \"\"JJ\"\"\",2 年以上就绪,\r\n";
  const grid = succSplitCsv(text);
  assert.equal(grid.length, 4);
  const out = succParseGrid(grid);
  assert.equal(out.headerCols, 5);
  assert.deepEqual(out.rows, [
    { line: 2, positionName: "Finance Manager, APAC", employeeId: "T-00001", name: "", readiness: "Ready now", note: "line one\nline two" },
    { line: 4, positionName: "CFO", employeeId: "T-00002", name: "Lee \"JJ\"", readiness: "2 年以上就绪", note: "" },
  ]);
});

test("succession import parse: payload rows carry exactly the contract fields; preview helpers", async () => {
  const { succPayloadRows, succCodeLevel, succSummary, SUCC_CODES, SUCC_CODE_TEXT, SUCC_READINESS, SUCC_READINESS_TEXT } = await lib();
  assert.deepEqual(succPayloadRows([{ line: 3, positionName: "A", employeeId: "T-1", name: null, readiness: "ready", note: undefined, extra: 1 }]),
    [{ line: 3, positionName: "A", employeeId: "T-1", name: "", readiness: "ready", note: "" }]);
  assert.equal(succCodeLevel({ code: "position_new", level: "error" }), "error", "以服务端的 level 为准");
  assert.equal(succCodeLevel({ code: "position_new" }), "info");
  assert.equal(succCodeLevel({ code: "employee_not_found" }), "error");
  assert.equal(succCodeLevel({ code: "something_new" }), "error", "未知码按错误处理");
  assert.deepEqual(succSummary({ rows: [{ action: "create" }, { action: "error" }, { action: "create" }], summary: { update: 0 } }),
    { create: 2, update: 0, unchanged: 0, error: 1, total: 3 });
  assert.deepEqual(succSummary({ rows: [], summary: { create: 5, update: 1, unchanged: 2, error: 3 } }),
    { create: 5, update: 1, unchanged: 2, error: 3, total: 0 });
  // 校验码说明：中英文键一致，且覆盖设计 §9.3 的全部校验码
  assert.deepEqual(Object.keys(SUCC_CODE_TEXT.zh).sort(), Object.keys(SUCC_CODE_TEXT.en).sort());
  assert.deepEqual(Object.keys(SUCC_CODE_TEXT.zh).sort(), Object.keys(SUCC_CODES).sort());
  for (const k of ["position_required", "position_too_long", "employee_required", "employee_not_found", "employee_out_of_scope",
    "employee_inactive", "readiness_required", "readiness_invalid", "note_too_long", "duplicate_in_file",
    "position_merged", "position_new", "name_mismatch", "successor_is_holder"]) assert.ok(SUCC_CODES[k], k);
  assert.deepEqual(SUCC_READINESS, ["ready", "oneYear", "twoYears"]);
  assert.deepEqual(Object.keys(SUCC_READINESS_TEXT.zh), SUCC_READINESS);
  assert.deepEqual(Object.keys(SUCC_READINESS_TEXT.en), SUCC_READINESS);
});

test("succession import parse: sheets whose used range starts below row 1 keep the real Excel line numbers", async () => {
  const XLSX = await loadXlsx();
  if (!XLSX) return; // 没装 web 依赖的机器上跳过
  const { succSheetGrid, succParseGrid } = await lib();
  const ws = XLSX.utils.aoa_to_sheet([["关键岗位", "工号", "姓名", "就绪度", "备注"], ["CFO", "T-00005", "", "即刻就绪", ""]], { origin: "B3" });
  const out = succParseGrid(succSheetGrid(XLSX, ws));
  assert.equal(out.headerCols, 5);
  assert.deepEqual(out.rows, [{ line: 4, positionName: "CFO", employeeId: "T-00005", name: "", readiness: "即刻就绪", note: "" }]);
  assert.deepEqual(succSheetGrid(XLSX, {}), []);
});

test("succession import parse: shipped template — source and dist copies match, header is SUCC_TEMPLATE_HEADERS, every example parses", async () => {
  const { succParseGrid, succSheetGrid, SUCC_TEMPLATE_HEADERS, SUCC_READINESS_TEXT } = await lib();
  const src = path.join(ROOT, "web", "public", "templates", "succession-import-template.xlsx");
  const dist = path.join(ROOT, "public", "dist", "templates", "succession-import-template.xlsx");
  assert.ok(fs.existsSync(src), "web/public/templates/succession-import-template.xlsx 是模板源文件（vite 构建时拷进 dist）；用 web/scripts/succession-template.mjs 生成");
  assert.ok(fs.existsSync(dist), "public/dist/templates/succession-import-template.xlsx 缺失 —— 重新构建或运行 web/scripts/succession-template.mjs");
  const XLSX = await loadXlsx();
  if (!XLSX) return; // 没装 web 依赖的机器上只核对文件存在
  const book = (f) => XLSX.read(fs.readFileSync(f), { type: "buffer" });
  const wbSrc = book(src);
  const wbDist = book(dist);
  assert.deepEqual(wbSrc.SheetNames, ["继任计划 Succession", "填写说明 Instructions"]);
  assert.deepEqual(wbDist.SheetNames, wbSrc.SheetNames);
  const gridOf = (wb, i) => succSheetGrid(XLSX, wb.Sheets[wb.SheetNames[i]]);
  const grid = gridOf(wbSrc, 0);
  assert.deepEqual(gridOf(wbDist, 0), grid, "dist 里的模板与 web/public/templates 不一致 —— 重新运行 web/scripts/succession-template.mjs");
  assert.deepEqual(gridOf(wbDist, 1), gridOf(wbSrc, 1));
  assert.deepEqual(grid[0], SUCC_TEMPLATE_HEADERS);
  const out = succParseGrid(grid);
  assert.equal(out.headerCols, SUCC_TEMPLATE_HEADERS.length);
  assert.equal(out.rows.length, 2, "示例行 2 条");
  for (const r of out.rows) {
    assert.ok(r.positionName, `第 ${r.line} 行缺岗位`);
    assert.match(r.employeeId, /^T-\d{5}$/, `第 ${r.line} 行工号应是 T-00001 这类占位格式`);
    assert.ok(r.readiness, `第 ${r.line} 行缺就绪度`);
  }
  assert.deepEqual(out.rows.map((r) => r.line), [2, 3]);
  // 说明页写明三种就绪度取值（中英文）与每次 2,000 行上限
  const notes = gridOf(wbSrc, 1).map((r) => r.join(" ")).join("\n");
  for (const k of Object.keys(SUCC_READINESS_TEXT.zh)) {
    assert.ok(notes.includes(SUCC_READINESS_TEXT.zh[k]), `说明页缺「${SUCC_READINESS_TEXT.zh[k]}」`);
    assert.ok(notes.includes(SUCC_READINESS_TEXT.en[k]), `说明页缺「${SUCC_READINESS_TEXT.en[k]}」`);
  }
  assert.ok(notes.includes("2,000"));
});
