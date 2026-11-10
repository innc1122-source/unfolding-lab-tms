// 关键岗位清单 · 纯函数（modules/talent/key-positions.js；12.2 组 1，设计 b12-design 第 4.1–4.4 节）：
//   validateRows 各校验码、同键去重（第一行有效、与入参顺序无关）、create / update / unchanged 判定、1,000 行上限、
//   previewHash 稳定且随数据变化、范围外计数；parseIsKey / validateOne；从继任计划带入的辅助函数。
const test = require("node:test");
const assert = require("node:assert/strict");
const KP = require("../modules/talent/key-positions.js");
const { positionKey } = require("../modules/talent/filter-model.js");

const DEPTS = [
  { id: "d-fin", name: "Finance" },
  { id: "d-it", name: "IT" },
  { id: "d-ops", name: "Operations" },
];
const lookups = (extra) => ({
  resolveDept: (t) => DEPTS.find((d) => d.name.toLowerCase() === String(t).toLowerCase() || ("Group / " + d.name).toLowerCase() === String(t).toLowerCase()) || null,
  deptAllows: (d) => d.id !== "d-ops",
  existing: [
    { id: "kp-1", name: "Finance Manager", nameKey: positionKey("Finance Manager"), deptId: "d-fin", deptName: "Finance", isKey: 1, note: "CFO pipeline" },
    { id: "kp-2", name: "Ops Lead", nameKey: positionKey("Ops Lead"), deptId: "d-ops", deptName: "Operations", isKey: 1, note: null },
  ],
  rowAllows: (r) => r.deptId !== "d-ops",
  ...(extra || {}),
});
const codesOf = (row) => row.codes.map((c) => c.code).sort();

test("key positions: constants and the shared position key", () => {
  assert.equal(KP.MAX_ROWS, 1000);
  assert.equal(KP.NAME_MAX, 80);
  assert.equal(KP.NAME_MAX, require("../modules/talent/succession-import.js").POSITION_MAX);
  assert.equal(KP.NOTE_MAX, 300);
  assert.equal(KP.positionKey, positionKey, "reuses filter-model positionKey");
  for (const c of ["name_required", "name_too_long", "dept_required", "dept_unknown", "dept_out_of_scope", "dup_in_file", "is_key_invalid", "note_too_long"]) {
    assert.equal(KP.CODES[c], "error", c);
  }
});

test("key positions: parseIsKey accepts 是/否/Y/N/1/0 and defaults blank to key", () => {
  for (const v of ["", "  ", null, undefined, "是", "Y", "yes", "1", "TRUE", "关键", true, 1]) assert.equal(KP.parseIsKey(v), 1, JSON.stringify(v));
  for (const v of ["否", "n", "No", "0", "false", "非关键", "Non-key", false, 0]) assert.equal(KP.parseIsKey(v), 0, JSON.stringify(v));
  for (const v of ["maybe", "2", "可能"]) assert.equal(KP.parseIsKey(v), null, v);
});

test("key positions: validateOne for create and partial update", () => {
  assert.deepEqual(KP.validateOne({ name: "  Team   Lead - Sales ", note: "  x " }),
    { ok: true, value: { name: "Team Lead - Sales", nameKey: positionKey("Team Lead - Sales"), isKey: 1, note: "x" } });
  assert.deepEqual(KP.validateOne({ name: " " }), { ok: false, code: "name_required", field: "name" });
  assert.deepEqual(KP.validateOne({ name: "x".repeat(81) }), { ok: false, code: "name_too_long", field: "name" });
  assert.equal(KP.validateOne({ name: "岗".repeat(80) }).ok, true);
  assert.deepEqual(KP.validateOne({ name: "A", isKey: "maybe" }), { ok: false, code: "is_key_invalid", field: "isKey" });
  assert.deepEqual(KP.validateOne({ name: "A", note: "n".repeat(301) }), { ok: false, code: "note_too_long", field: "note" });
  assert.deepEqual(KP.validateOne({ isKey: false }, { partial: true }), { ok: true, value: { isKey: 0 } });
  assert.deepEqual(KP.validateOne({ note: "" }, { partial: true }), { ok: true, value: { note: null } });
  assert.deepEqual(KP.auditView({ name: "A", deptName: "IT", isKey: 0, note: "" }), { name: "A", dept: "IT", isKey: false, note: null });
});

test("key positions import: every validation code", () => {
  const r = KP.validateRows([
    { line: 2, name: "", dept: "IT", isKey: "", note: "" },
    { line: 3, name: "x".repeat(81), dept: "IT", isKey: "", note: "" },
    { line: 4, name: "Data Lead", dept: "", isKey: "", note: "" },
    { line: 5, name: "Data Analyst", dept: "Marketing", isKey: "", note: "" },
    { line: 6, name: "Ops Analyst", dept: "Operations", isKey: "", note: "" },
    { line: 7, name: "QA Lead", dept: "IT", isKey: "maybe", note: "" },
    { line: 8, name: "QA Manager", dept: "IT", isKey: "", note: "n".repeat(301) },
    { line: 9, name: "Ops Lead", dept: "IT", isKey: "", note: "" },
  ], lookups());
  const by = new Map(r.rows.map((x) => [x.line, x]));
  assert.deepEqual(codesOf(by.get(2)), ["name_required"]);
  assert.deepEqual(codesOf(by.get(3)), ["name_too_long"]);
  assert.deepEqual(codesOf(by.get(4)), ["dept_required"]);
  assert.deepEqual(codesOf(by.get(5)), ["dept_unknown"]);
  assert.deepEqual(codesOf(by.get(6)), ["dept_out_of_scope"]);
  assert.deepEqual(codesOf(by.get(7)), ["is_key_invalid"]);
  assert.deepEqual(codesOf(by.get(8)), ["note_too_long"]);
  assert.deepEqual(codesOf(by.get(9)), ["position_out_of_scope"], "same key exists in a department outside the scope");
  assert.equal(r.outOfScope, 2, "dept_out_of_scope + position_out_of_scope");
  assert.deepEqual(r.summary, { create: 0, update: 0, unchanged: 0, error: 8 });
  assert.deepEqual(r.writes, []);
  for (const x of r.rows) assert.equal(x.action, "error");
});

test("key positions import: create / update / unchanged, name merge, blank note keeps the old note", () => {
  const r = KP.validateRows([
    { line: 2, name: "finance  manager", dept: "Finance", isKey: "是", note: "" },          // unchanged（写法不同 → name_merged）
    { line: 3, name: "IT Director", dept: "Group / IT", isKey: "", note: "new" },            // create
    { line: 4, name: "Finance-Manager", dept: "Finance", isKey: "", note: "" },              // dup_in_file
  ], lookups());
  const by = new Map(r.rows.map((x) => [x.line, x]));
  assert.equal(by.get(2).action, "unchanged");
  assert.deepEqual(by.get(2).codes, [{ code: "name_merged", level: "info" }]);
  assert.equal(by.get(2).name, "Finance Manager");
  assert.equal(by.get(2).note, "CFO pipeline");
  assert.equal(by.get(2).existingId, "kp-1");
  assert.equal(by.get(3).action, "create");
  assert.equal(by.get(3).dept, "IT");
  assert.equal(by.get(3).deptId, "d-it");
  assert.equal(by.get(3).isKey, 1);
  assert.deepEqual(codesOf(by.get(4)), ["dup_in_file"]);
  assert.deepEqual(r.summary, { create: 1, update: 0, unchanged: 1, error: 1 });
  assert.deepEqual(r.writes, [{ line: 3, action: "create", existingId: null, name: "IT Director", nameKey: positionKey("IT Director"),
    deptId: "d-it", deptName: "IT", isKey: 1, note: "new", source: "import" }]);

  // 部门、是否关键、备注任一变化 → update
  for (const [row, field] of [
    [{ line: 2, name: "Finance Manager", dept: "IT", isKey: "", note: "" }, "dept"],
    [{ line: 2, name: "Finance Manager", dept: "Finance", isKey: "否", note: "" }, "isKey"],
    [{ line: 2, name: "Finance Manager", dept: "Finance", isKey: "", note: "changed" }, "note"],
  ]) {
    const u = KP.validateRows([row], lookups({ source: "succession" }));
    assert.equal(u.rows[0].action, "update", field);
    assert.equal(u.writes.length, 1);
    assert.equal(u.writes[0].existingId, "kp-1");
    assert.equal(u.writes[0].name, "Finance Manager");
    assert.equal(u.writes[0].source, "succession");
  }
});

test("key positions import: duplicates keep the first line regardless of input order", () => {
  const rows = [
    { line: 5, name: "Data Lead", dept: "IT", isKey: "", note: "second" },
    { line: 2, name: "DATA LEAD", dept: "IT", isKey: "", note: "first" },
  ];
  const r = KP.validateRows(rows, lookups());
  const by = new Map(r.rows.map((x) => [x.line, x]));
  assert.equal(by.get(2).action, "create");
  assert.deepEqual(codesOf(by.get(5)), ["dup_in_file"]);
  assert.equal(r.writes.length, 1);
  assert.equal(r.writes[0].note, "first");
});

test("key positions import: 1,000-row cap", () => {
  const mk = (n) => Array.from({ length: n }, (_, i) => ({ line: i + 2, name: "P" + i, dept: "IT", isKey: "", note: "" }));
  assert.equal(KP.validateRows(mk(1000), lookups()).summary.create, 1000);
  assert.deepEqual(KP.validateRows(mk(1001), lookups()), { error: { code: "over_cap", cap: 1000, count: 1001 } });
});

test("key positions import: previewHash is order-independent and changes when the data changes", () => {
  const rows = [
    { line: 2, name: "IT Director", dept: "IT", isKey: "", note: "" },
    { line: 3, name: "Finance Manager", dept: "Finance", isKey: "", note: "" },
  ];
  const a = KP.validateRows(rows, lookups()).previewHash;
  assert.match(a, /^[0-9a-f]{16}$/);
  assert.equal(KP.validateRows([...rows].reverse(), lookups()).previewHash, a);
  // 库里新增了同键岗位 → 动作从 create 变 update → 哈希不同
  const L2 = lookups();
  L2.existing = [...L2.existing, { id: "kp-9", name: "IT Director", deptId: "d-fin", deptName: "Finance", isKey: 1, note: null }];
  assert.notEqual(KP.validateRows(rows, L2).previewHash, a);
  // 备注改了 → 不同
  assert.notEqual(KP.validateRows([{ ...rows[0], note: "x" }, rows[1]], lookups()).previewHash, a);
});

test("key positions: unmatched succession positions and the prefilled rows", () => {
  const succ = [
    { positionName: "Finance Manager", userId: "u1", readiness: "ready" },
    { positionName: "Data Lead", userId: "u2", readiness: "oneYear" },
    { positionName: "data-lead", userId: "u3", readiness: "twoYears" },
    { positionName: "Branch Head", userId: "u4", readiness: "ready" },
  ];
  const un = KP.unmatchedSuccessionPositions(succ, lookups().existing);
  assert.deepEqual(un, [
    { name: "Branch Head", nameKey: positionKey("Branch Head"), count: 1 },
    { name: "Data Lead", nameKey: positionKey("Data Lead"), count: 2 },
  ]);
  const rows = KP.rowsFromSuccession(un, [
    { position: "Data Lead", deptName: "IT" }, { position: "DATA LEAD", deptName: "IT" },
    { position: "Branch Head", department: "Operations" }, { position: "Branch Head", department: "Finance" },
  ]);
  assert.deepEqual(rows, [
    { line: 1, name: "Branch Head", dept: "", isKey: "", note: "" },        // 在任者部门不唯一 → 留空
    { line: 2, name: "Data Lead", dept: "IT", isKey: "", note: "" },
  ]);
  const v = KP.validateRows(rows, lookups({ source: "succession" }));
  assert.deepEqual(codesOf(v.rows[0]), ["dept_required"]);
  assert.equal(v.writes[0].source, "succession");
});
