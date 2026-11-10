// F58（负责人 10/9 定）考试设置「考前须知（选填）」——HTTP 端到端。验收用例 58-1、58-2（数据面）、58-4、58-5、58-6（数据面）。
//   中英文两栏 preNotice / preNotice_zh：纯文本、保留换行（\r\n 统一为 \n）、去首尾空白，各不超过 1000 字（按字符计）；
//   超长整单 400 pre_notice_too_long（不截断、不写库）；空 = null；修改时不带这个键 = 保留原值；
//   员工端 /api/programs/:id 的 exams[]（examSummary）带回两栏；改动走 exam.update 审计；只读 / 无培训权限的角色不能改。
"use strict";
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { DatabaseSync } = require("node:sqlite");
const { ADMIN, EMPLOYEE, startServer, loginAs } = require("./helpers.js");

let srv, admin, emp, courseId, qId, examId;
const EN = "  Bring a pen.\r\nDo not open other tabs.\r\n\r\n<b>Bold?</b> <script>alert(1)</script>  ";
const EN_SAVED = "Bring a pen.\nDo not open other tabs.\n\n<b>Bold?</b> <script>alert(1)</script>";
const ZH = "\n请提前准备纸笔。\n考试期间不得查阅资料。\n";
const ZH_SAVED = "请提前准备纸笔。\n考试期间不得查阅资料。";

const payload = (extra) => ({ programId: "nho", title: "F58 notice exam", title_zh: "F58 须知考试", status: "published", courseIds: [courseId], passingScore: 60, mcqCount: 1, openCount: 0, mode: "fixed", questionIds: [qId], maxAttempts: 0, retakeCooldownHours: 0, ...extra });
const adminExam = async () => (await admin.get("/api/admin/exams/" + examId)).data;
const learnerExam = async () => (await emp.get("/api/programs/nho")).data.exams.find((e) => e.id === examId);
function auditRows() {
  const db = new DatabaseSync(srv.dbPath, { readOnly: true });
  try { return db.prepare("SELECT action, target, beforeJson, afterJson FROM audit_logs WHERE action = 'exam.update' AND target = ? ORDER BY id").all(examId); }
  finally { db.close(); }
}
async function makeAdminWith(empId, grants) {
  const role = await admin.post("/api/admin/roles", { name: "F58 " + empId, name_zh: "F58 " + empId, grants });
  assert.equal(role.status, 200, JSON.stringify(role.data));
  const created = await admin.post("/api/admin/employees", { name: empId, employeeId: empId, programIds: [] });
  assert.equal(created.status, 200, JSON.stringify(created.data));
  const db = new DatabaseSync(srv.dbPath, { readOnly: true });
  let row;
  try { row = db.prepare("SELECT id FROM users WHERE employeeId = ?").get(empId); } finally { db.close(); }
  assert.ok(row, "employee row " + empId);
  assert.equal((await admin.put("/api/admin/employees/" + row.id, { adminRoleId: role.data.role.id })).status, 200);
  const c = await loginAs(srv.base, { employeeId: empId, password: created.data.password });
  assert.equal((await c.post("/api/auth/change-password", { currentPassword: created.data.password, newPassword: empId + "-pw-2026" })).status, 200);
  return c;
}

before(async () => {
  srv = await startServer();
  admin = await loginAs(srv.base, ADMIN);
  emp = await loginAs(srv.base, EMPLOYEE);
  const program = (await admin.get("/api/admin/content")).data.programs.find((p) => p.id === "nho");
  courseId = program.courseIds[0];
  const q = await admin.post("/api/admin/questions", { courseId, type: "mcq", question: "F58 Q", options: [{ text: "yes", ok: true }, { text: "no", ok: false }], explanation: "" });
  assert.equal(q.status, 200, JSON.stringify(q.data));
  qId = q.data.id || (q.data.question && q.data.question.id);
});
after(() => srv.stop());

test("58-1：新建时保存中英文须知（换行统一、去首尾空白、HTML 按原文存），详情与列表读回", async () => {
  const r = await admin.post("/api/admin/exams", payload({ preNotice: EN, preNotice_zh: ZH }));
  assert.equal(r.status, 200, JSON.stringify(r.data));
  examId = r.data.id;
  const d = await adminExam();
  assert.equal(d.preNotice, EN_SAVED, "English kept as plain text, line breaks normalised to \\n");
  assert.equal(d.preNotice_zh, ZH_SAVED);
  const row = (await admin.get("/api/admin/exams")).data.find((e) => e.id === examId);
  assert.equal(row.preNotice, EN_SAVED, "list GET carries it too");
  assert.equal(row.preNotice_zh, ZH_SAVED);
});

test("58-2 / 58-6（数据面）：员工端考前说明数据带回两栏原文（HTML 不被解析或剥离，渲染时按文本转义）", async () => {
  const ex = await learnerExam();
  assert.ok(ex, "exam visible to the learner");
  assert.equal(ex.preNotice, EN_SAVED);
  assert.equal(ex.preNotice_zh, ZH_SAVED);
});

test("58-1：超过 1000 字 → 400 pre_notice_too_long（中英文提示），不写库；恰好 1000 字（去首尾空白后）可保存", async () => {
  const before = await adminExam();
  for (const [k, label] of [["preNotice", /English/], ["preNotice_zh", /Chinese/]]) {
    const r = await admin.put("/api/admin/exams/" + examId, payload({ preNotice: EN_SAVED, preNotice_zh: ZH_SAVED, [k]: "字".repeat(1001) }));
    assert.equal(r.status, 400, k + ": " + JSON.stringify(r.data));
    assert.equal(r.data.code, "pre_notice_too_long", k);
    assert.match(r.data.error, label);
    assert.match(r.data.error, /1000/);
    assert.match(r.data.error_zh, /超过 1000 字/);
  }
  const after1 = await adminExam();
  assert.equal(after1.preNotice, before.preNotice, "rejected save wrote nothing");
  assert.equal(after1.preNotice_zh, before.preNotice_zh);
  assert.equal(after1.updatedAt, before.updatedAt);
  // 边界：1000 个汉字 + 首尾空白 → 通过；emoji 之外的代理对也按 1 个字计（1000 个 𠀀 可存）
  const ok = await admin.put("/api/admin/exams/" + examId, payload({ preNotice: "  " + "a".repeat(1000) + "\n", preNotice_zh: "𠀀".repeat(1000) }));
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  const d = await adminExam();
  assert.equal(d.preNotice.length, 1000);
  assert.equal(Array.from(d.preNotice_zh).length, 1000);
  // 非字符串 → 400 pre_notice_invalid
  const bad = await admin.put("/api/admin/exams/" + examId, payload({ preNotice: { html: "<b>x</b>" } }));
  assert.equal(bad.status, 400);
  assert.equal(bad.data.code, "pre_notice_invalid");
});

test("修改时不带须知字段（列表行的发布 / 下线）= 保留原值", async () => {
  assert.equal((await admin.put("/api/admin/exams/" + examId, payload({ preNotice: EN, preNotice_zh: ZH }))).status, 200);
  const r = await admin.put("/api/admin/exams/" + examId, payload({ status: "draft" }));
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const d = await adminExam();
  assert.equal(d.status, "draft");
  assert.equal(d.preNotice, EN_SAVED, "kept");
  assert.equal(d.preNotice_zh, ZH_SAVED, "kept");
  assert.equal((await admin.put("/api/admin/exams/" + examId, payload({ status: "published" }))).status, 200);
});

test("58-5：改动写 exam.update 审计，前后值都在载荷里", async () => {
  const n0 = auditRows().length;
  const r = await admin.put("/api/admin/exams/" + examId, payload({ preNotice: EN, preNotice_zh: "新的须知\n第二行" }));
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const rows = auditRows();
  assert.equal(rows.length, n0 + 1, "one audit row");
  const last = rows[rows.length - 1];
  assert.equal(JSON.parse(last.beforeJson).preNotice_zh, ZH_SAVED);
  assert.equal(JSON.parse(last.afterJson).preNotice_zh, "新的须知\n第二行");
  assert.equal(JSON.parse(last.afterJson).preNotice, EN_SAVED);
});

test("58-5：只读培训角色与无培训权限的角色不能改（403 / 404），内容不变", async () => {
  const before = await adminExam();
  const reader = await makeAdminWith("F58-READ", { learning: "read" });
  const perf = await makeAdminWith("F58-PERF", { performance: "manage" });
  // 只读档：403；完全没有培训权限：现有口径是整组路由不可见（404 Not found），两者都不写库
  for (const [who, c, want] of [["learning read", reader, [403]], ["performance only", perf, [403, 404]]]) {
    const r = await c.put("/api/admin/exams/" + examId, payload({ preNotice: "hacked", preNotice_zh: "篡改" }));
    assert.ok(want.includes(r.status), who + ": " + r.status + " " + JSON.stringify(r.data));
  }
  const d = await adminExam();
  assert.equal(d.preNotice, before.preNotice);
  assert.equal(d.preNotice_zh, before.preNotice_zh);
});

test("58-4：清空两栏（空串 / 只有空白）→ 存 null，员工端两栏都是 null（只显示系统须知）", async () => {
  const r = await admin.put("/api/admin/exams/" + examId, payload({ preNotice: "", preNotice_zh: "  \n\t " }));
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const d = await adminExam();
  assert.equal(d.preNotice, null);
  assert.equal(d.preNotice_zh, null);
  const ex = await learnerExam();
  assert.equal(ex.preNotice, null);
  assert.equal(ex.preNotice_zh, null);
  // 只填一种语言：另一栏为 null，员工端由界面按语言回退显示
  assert.equal((await admin.put("/api/admin/exams/" + examId, payload({ preNotice_zh: "只有中文" }))).status, 200);
  const ex2 = await learnerExam();
  assert.equal(ex2.preNotice, null);
  assert.equal(ex2.preNotice_zh, "只有中文");
});
