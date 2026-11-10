// 批量接口「超上限整批拒绝」回归测试。
//
// 背景：全公司约 4,000 人。原先 employees/bulk、records/bulk、secondary-lines/bulk、
// questions/bulk 四个批量接口用 body.rows.slice(0, N) 静默截断（500 / 1000 / 2000 /
// 200），超出部分被丢弃而响应仍是 200，HR 以为全部导入成功。修复后的口径与
// bulk-update / bulk-reset 一致：行数 > 上限 → 整批 400 code:"over_cap"（带 selected
// 与 cap 两个数字和中英双语提示），且在任何写库之前返回；行数 == 上限 → 正常处理。
//
// 上限旋钮（默认值见 server.js 各接口注释）：
//   LMS_BULK_CAP            bulk-update + 三个人员类导入（默认 10000）
//   LMS_QUESTIONS_BULK_CAP  questions/bulk（默认 200，与页面「每次最多 200 题」一致）
// 测试把两个旋钮都调到 3，用 3 行 / 4 行验证同一条守卫，不需要真造 10,000 行。

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { ADMIN, startServer: startRaw, loginAs, tempDir } = require("./helpers.js");

// 每台测试服都指向一个临时的、尚不存在的 config（绝不读写仓库根的活配置 config.json）。
function startServer(opts = {}) {
  const cfg = path.join(tempDir("lms-cap-cfg-"), "config.json");
  return startRaw({ ...opts, env: { LMS_CONFIG_PATH: cfg, ...(opts.env || {}) } });
}

const CAP = 3;
let srv, admin;
before(async () => {
  srv = await startServer({ env: { LMS_BULK_CAP: String(CAP), LMS_QUESTIONS_BULK_CAP: String(CAP) } });
  admin = await loginAs(srv.base, ADMIN);
});
after(() => srv.stop());

function assertOverCap(r, selected) {
  assert.equal(r.status, 400, `超上限必须 400，实际 ${r.status} ${JSON.stringify(r.data)}`);
  assert.equal(r.data.code, "over_cap");
  assert.equal(r.data.selected, selected);
  assert.equal(r.data.cap, CAP);
  const msg = String(r.data.error || "");
  assert.ok(msg.includes(String(selected)) && msg.includes(String(CAP)), `错误文案应含选中数与上限: ${msg}`);
  assert.ok(/[一-鿿]/.test(msg) && /[A-Za-z]/.test(msg), `错误文案应为中英双语: ${msg}`);
  assert.ok(!Array.isArray(r.data.results), "400 不得夹带部分 results");
}

async function rosterByEmpId() {
  const r = await admin.get("/api/admin/roster");
  assert.equal(r.status, 200);
  return new Map(r.data.map((u) => [u.employeeId, u]));
}

const empRow = (employeeId) => ({ employeeId, name: "Cap Probe " + employeeId, department: "Cap Dept" });

// 三个人员类接口共用的测试对象（由第一个测试建出）。
const people = ["CAP-A01", "CAP-A02", "CAP-A03"];

test("employees/bulk：刚好等于上限 → 全部创建；超上限 1 行 → 400 over_cap 且一个账号都没建", async () => {
  const ok = await admin.post("/api/admin/employees/bulk", { rows: people.map(empRow), programIds: [] });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.deepEqual(ok.data.results.map((x) => x.status), ["created", "created", "created"]);

  const overIds = ["CAP-B01", "CAP-B02", "CAP-B03", "CAP-B04"];
  const over = await admin.post("/api/admin/employees/bulk", { rows: overIds.map(empRow), programIds: [] });
  assertOverCap(over, 4);
  const roster = await rosterByEmpId();
  for (const id of people) assert.ok(roster.has(id), `等于上限那批应已创建 ${id}`);
  for (const id of overIds) assert.ok(!roster.has(id), `超上限整批拒绝后不应存在 ${id}`);
});

test("records/bulk：刚好等于上限 → 全部创建；超上限 1 行 → 400 over_cap 且一条记录都没写", async () => {
  const roster = await rosterByEmpId();
  const ok = await admin.post("/api/admin/records/bulk", {
    rows: people.map((employeeId, i) => ({ employeeId, type: "荣誉", date: "2026-07-01", title: "cap-ok-" + i, fields: { awardName: "cap-ok-" + i } })),
  });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.deepEqual(ok.data.results.map((x) => x.status), ["created", "created", "created"]);

  const over = await admin.post("/api/admin/records/bulk", {
    rows: [...people, people[0]].map((employeeId, i) => ({ employeeId, type: "荣誉", date: "2026-07-02", title: "cap-over-" + i, fields: { awardName: "cap-over-" + i } })),
  });
  assertOverCap(over, 4);
  for (const id of people) {
    const prof = await admin.get("/api/admin/employees/" + roster.get(id).id + "/profile");
    assert.equal(prof.status, 200);
    const titles = prof.data.events.map((e) => e.title);
    assert.ok(titles.some((t) => String(t).startsWith("cap-ok-")), `${id} 应有等于上限那批的记录`);
    assert.ok(!titles.some((t) => String(t).startsWith("cap-over-")), `${id} 不应有超上限那批的任何记录`);
  }
});

test("secondary-lines/bulk：刚好等于上限 → 全部创建；超上限 1 行 → 400 over_cap 且一条兼任都没写", async () => {
  const roster = await rosterByEmpId();
  const ok = await admin.post("/api/admin/secondary-lines/bulk", {
    rows: people.map((employeeId) => ({ employeeId, kind: "concurrent", position: "Cap OK" })),
  });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.equal(ok.data.created, CAP);

  const over = await admin.post("/api/admin/secondary-lines/bulk", {
    rows: [...people, people[0]].map((employeeId, i) => ({ employeeId, kind: "concurrent", position: "Cap Over " + i })),
  });
  assertOverCap(over, 4);
  for (const id of people) {
    const lines = await admin.get("/api/admin/employees/" + roster.get(id).id + "/secondary-lines");
    assert.equal(lines.status, 200);
    assert.equal(lines.data.length, 1, `${id} 只应有等于上限那批的 1 条兼任`);
  }
});

test("questions/bulk：刚好等于上限 → 全部入库；超上限 1 题 → 400 over_cap 且一题都没写", async () => {
  const { data: content } = await admin.get("/api/admin/content");
  const courseId = content.courses[0].id;
  const q = (stem) => ({ type: "mcq", question: stem, options: [{ text: "right", ok: true }, { text: "wrong", ok: false }] });
  const before = (await admin.get("/api/admin/questions")).data.length;

  const ok = await admin.post("/api/admin/questions/bulk", { courseId, items: [1, 2, 3].map((i) => q("Cap OK question " + i)) });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.equal(ok.data.results.filter((r) => r.ok).length, CAP);
  assert.equal((await admin.get("/api/admin/questions")).data.length, before + CAP);

  const over = await admin.post("/api/admin/questions/bulk", { courseId, items: [1, 2, 3, 4].map((i) => q("Cap Over question " + i)) });
  assertOverCap(over, 4);
  const after = (await admin.get("/api/admin/questions")).data;
  assert.equal(after.length, before + CAP, "超上限整批拒绝后题库数量不变");
  assert.ok(!after.some((x) => String(x.question).startsWith("Cap Over")), "不应有超上限那批的任何题目");
});

test("bulk-update（同用 LMS_BULK_CAP）：刚好等于上限 → 全部更新；超上限 1 人 → 400 over_cap 且无人被改", async () => {
  const roster = await rosterByEmpId();
  const ids = people.map((e) => roster.get(e).id);
  const ok = await admin.post("/api/admin/employees/bulk-update", { userIds: ids, fields: { department: "Cap Dept 2" } });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));

  const extra = roster.get("DP-1001");
  assert.ok(extra, "种子员工 DP-1001 应存在");
  const over = await admin.post("/api/admin/employees/bulk-update", { userIds: [...ids, extra.id], fields: { department: "Cap Dept 3" } });
  assertOverCap(over, 4);
  const after = await rosterByEmpId();
  for (const e of people) assert.equal(after.get(e).department, "Cap Dept 2");
  assert.equal(after.get("DP-1001").department, extra.department, "超上限整批拒绝后 DP-1001 部门不变");
});

// ---- 旋钮相互独立 + 默认值（第二台测试服）----
// 上面那台两个旋钮都是 3，接线接反（questions 读了 LMS_BULK_CAP，或反过来）也测不出
// 来。这里用两个不同的值，并把 LMS_RESET_CAP 设成非法值，验证：
//   · questions/bulk 只看 LMS_QUESTIONS_BULK_CAP；人员类导入只看 LMS_BULK_CAP；
//   · 非法 / 非正数的旋钮值回落到默认（LMS_RESET_CAP 默认 10000）；
//   · 默认上限 10000 / 200 本身——用 10001 个「空」元素探测，它们在任何写库之前就被
//     拒绝，所以不必真造 10,000 名员工，请求体也只有几十 KB。
let srv2, admin2;
async function second() {
  if (!srv2) {
    srv2 = await startServer({ env: { LMS_BULK_CAP: "5", LMS_QUESTIONS_BULK_CAP: "2", LMS_RESET_CAP: "abc" } });
    admin2 = await loginAs(srv2.base, ADMIN);
  }
  return admin2;
}
after(() => { if (srv2) srv2.stop(); });

test("旋钮相互独立：LMS_BULK_CAP=5、LMS_QUESTIONS_BULK_CAP=2 → 3 题被拒（cap=2），4 行人员导入照常创建", async () => {
  const a = await second();
  const { data: content } = await a.get("/api/admin/content");
  const courseId = content.courses[0].id;
  const q = (stem) => ({ type: "mcq", question: stem, options: [{ text: "right", ok: true }, { text: "wrong", ok: false }] });
  const before = (await a.get("/api/admin/questions")).data.length;
  const qr = await a.post("/api/admin/questions/bulk", { courseId, items: [1, 2, 3].map((i) => q("Indep question " + i)) });
  assert.equal(qr.status, 400);
  assert.equal(qr.data.code, "over_cap");
  assert.equal(qr.data.cap, 2, "questions/bulk 必须读 LMS_QUESTIONS_BULK_CAP，而不是 LMS_BULK_CAP");
  assert.equal((await a.get("/api/admin/questions")).data.length, before);

  const ids = ["IND-01", "IND-02", "IND-03", "IND-04"];
  const er = await a.post("/api/admin/employees/bulk", { rows: ids.map(empRow), programIds: [] });
  assert.equal(er.status, 200, "4 行 < LMS_BULK_CAP=5，不得被 questions 的上限 2 误伤: " + JSON.stringify(er.data));
  assert.equal(er.data.results.filter((x) => x.status === "created").length, 4);
});

test("非法旋钮回落默认：LMS_RESET_CAP=abc → bulk-reset 10001 人 over_cap cap=10000、10000 人不拦；人员导入仍按 LMS_BULK_CAP=5 拒 6 行且一行未写", async () => {
  // 这台 LMS_BULK_CAP=5，所以人员类接口用 5+1 验证；bulk-reset 用非法值验证默认 10000。
  const a = await second();
  const rosterBefore = (await a.get("/api/admin/roster")).data.length;
  const r1 = await a.post("/api/admin/employees/bulk-reset", { userIds: Array.from({ length: 10001 }, (_, i) => "u-none-" + i) });
  assert.equal(r1.status, 400, JSON.stringify(r1.data).slice(0, 300));
  assert.equal(r1.data.code, "over_cap");
  assert.equal(r1.data.cap, 10000);
  assert.equal(r1.data.selected, 10001);
  const r2 = await a.post("/api/admin/employees/bulk-reset", { userIds: Array.from({ length: 10000 }, (_, i) => "u-none-" + i) });
  assert.notEqual(r2.data && r2.data.code, "over_cap", "刚好 10000 不得被上限拒绝");
  const six = Array.from({ length: 6 }, (_, i) => empRow("DEF-0" + i));
  const r3 = await a.post("/api/admin/employees/bulk", { rows: six, programIds: [] });
  assert.equal(r3.status, 400);
  assert.equal(r3.data.cap, 5);
  assert.equal((await a.get("/api/admin/roster")).data.length, rosterBefore);
});

test("默认上限（未设置旋钮）：三个人员类导入与 bulk-update 为 10000，questions/bulk 为 200", async () => {
  // 主测试服设了旋钮；这里临时起一台不带任何上限旋钮的。
  const env = { LMS_BULK_CAP: "", LMS_QUESTIONS_BULK_CAP: "", LMS_RESET_CAP: "" };
  const s3 = await startServer({ env });
  try {
    const a = await loginAs(s3.base, ADMIN);
    const rosterBefore = (await a.get("/api/admin/roster")).data.length;
    const blank = Array.from({ length: 10001 }, () => ({}));
    for (const ep of ["/api/admin/employees/bulk", "/api/admin/records/bulk", "/api/admin/secondary-lines/bulk"]) {
      const r = await a.post(ep, { rows: blank, programIds: [] });
      assert.equal(r.status, 400, ep + " " + JSON.stringify(r.data).slice(0, 200));
      assert.equal(r.data.code, "over_cap", ep);
      assert.equal(r.data.cap, 10000, ep);
      assert.equal(r.data.selected, 10001, ep);
    }
    const u = await a.post("/api/admin/employees/bulk-update", { userIds: Array.from({ length: 10001 }, (_, i) => "u-none-" + i), fields: { department: "X" } });
    assert.equal(u.data.code, "over_cap");
    assert.equal(u.data.cap, 10000);
    const { data: content } = await a.get("/api/admin/content");
    const qBefore = (await a.get("/api/admin/questions")).data.length;
    const q = await a.post("/api/admin/questions/bulk", { courseId: content.courses[0].id, items: Array.from({ length: 201 }, (_, i) => ({ type: "mcq", question: "Default cap " + i, options: [{ text: "a", ok: true }, { text: "b", ok: false }] })) });
    assert.equal(q.status, 400);
    assert.equal(q.data.code, "over_cap");
    assert.equal(q.data.cap, 200);
    assert.equal((await a.get("/api/admin/questions")).data.length, qBefore);
    assert.equal((await a.get("/api/admin/roster")).data.length, rosterBefore);
  } finally { s3.stop(); }
});
