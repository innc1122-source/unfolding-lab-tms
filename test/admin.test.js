// Baseline regression tests: admin permissions, employee management,
// content editing validation, question bank, regrade, CSV exports,
// and the schema_migrations bookkeeping.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { DatabaseSync } = require("node:sqlite");
const { ADMIN, EMPLOYEE, startServer, loginAs, completeAllModules } = require("./helpers.js");

let srv, admin, emp;
before(async () => {
  srv = await startServer();
  admin = await loginAs(srv.base, ADMIN);
  emp = await loginAs(srv.base, EMPLOYEE);
});
after(() => srv.stop());

test("admin endpoints are refused for employees and anonymous users", async () => {
  for (const p of ["/api/admin/employees", "/api/admin/overview", "/api/admin/content", "/api/admin/questions", "/api/admin/attempts"]) {
    assert.equal((await emp.get(p)).status, 403, p + " must be admin-only");
  }
  const anon = require("./helpers.js").makeClient(srv.base);
  assert.equal((await anon.get("/api/admin/employees")).status, 401);
});

test("employee create validates and rejects duplicate IDs", async () => {
  assert.equal((await admin.post("/api/admin/employees", { name: "", employeeId: "" })).status, 400);
  const first = await admin.post("/api/admin/employees", { name: "Dup Test", employeeId: "DP-DUP1", department: "QA" });
  assert.equal(first.status, 200);
  const dup = await admin.post("/api/admin/employees", { name: "Dup Again", employeeId: "dp-dup1" });
  assert.equal(dup.status, 400, "employee IDs are case-insensitively unique");
});

test("bulk import creates rows, skips duplicates and incomplete lines", async () => {
  const r = await admin.post("/api/admin/employees/bulk", {
    rows: [
      { employeeId: "DP-B001", name: "Bulk One", department: "Ops" },
      { employeeId: "DP-B002", name: "Bulk Two" },
      { employeeId: "DP-DUP1", name: "Already There" },
      { employeeId: "", name: "No ID" },
    ],
  });
  assert.equal(r.status, 200);
  const by = Object.fromEntries(r.data.results.map((x) => [x.employeeId, x.status]));
  assert.equal(by["DP-B001"], "created");
  assert.equal(by["DP-B002"], "created");
  assert.equal(by["DP-DUP1"], "skipped");
  // New hires are auto-assigned every program with a due date.
  const employees = await admin.get("/api/admin/employees");
  const u = employees.data.find((x) => x.employeeId === "DP-B001");
  assert.equal(u.programs.nho.assigned, true);
  assert.ok(u.programs.nho.dueAt);
});

test("bulk assign/unassign updates many employees at once", async () => {
  const employees = await admin.get("/api/admin/employees");
  const ids = employees.data.filter((x) => ["DP-B001", "DP-B002"].includes(x.employeeId)).map((x) => x.id);
  const un = await admin.post("/api/admin/assignments/bulk", { userIds: ids, programId: "nho", action: "unassign" });
  assert.equal(un.data.count, 2);
  const re = await admin.post("/api/admin/assignments/bulk", { userIds: ids, programId: "nho", dueAt: "2030-06-30", action: "assign" });
  assert.equal(re.data.count, 2);
  const after = await admin.get("/api/admin/employees");
  assert.equal(after.data.find((x) => x.employeeId === "DP-B001").programs.nho.dueAt, "2030-06-30");
});

test("program settings are validated and clamped server-side", async () => {
  const { data: content } = await admin.get("/api/admin/content");
  const p = content.programs.find((x) => x.id === "nho");
  const bad = await admin.put("/api/admin/content/programs/nho", { ...p, title: "" });
  assert.equal(bad.status, 400);
  const clamped = await admin.put("/api/admin/content/programs/nho", { ...p, passingScore: 999, examMcqCount: -3 });
  assert.equal(clamped.status, 200);
  const { data: c2 } = await admin.get("/api/admin/content");
  const p2 = c2.programs.find((x) => x.id === "nho");
  assert.equal(p2.passingScore, 100);
  assert.ok(p2.examMcqCount >= 1);
  // Restore the seeded values so other tests keep passing.
  await admin.put("/api/admin/content/programs/nho", p);
});

test("course PUT rejects malformed modules; question POST validates by type", async () => {
  const { data: content } = await admin.get("/api/admin/content");
  const c = content.courses[0];
  const bad = await admin.put("/api/admin/content/courses/" + c.id, { ...c, modules: [{ title: "no id" }] });
  assert.equal(bad.status, 400);

  assert.equal((await admin.post("/api/admin/questions", { courseId: c.id, type: "mcq", question: "Q?", options: [{ text: "a", ok: false }, { text: "b", ok: false }] })).status, 400, "mcq needs exactly one correct option");
  assert.equal((await admin.post("/api/admin/questions", { courseId: c.id, type: "fill", question: "Q?", answers: [] })).status, 400, "fill needs an accepted answer");

  const ok = await admin.post("/api/admin/questions", { courseId: c.id, type: "mcq", question: "Baseline test question?", options: [{ text: "right", ok: true }, { text: "wrong", ok: false }], explanation: "x" });
  assert.equal(ok.status, 200);
  assert.equal((await admin.del("/api/admin/questions/" + ok.data.id)).status, 200);
});

test("HR regrade of an open answer recomputes the total and marks the override", async () => {
  await completeAllModules(emp, "nho");
  const start = await emp.post("/api/exam/start", { programId: "nho" });
  const submit = await emp.post(`/api/exam/${start.data.attemptId}/submit`, { answers: {} });
  assert.equal(submit.status, 200);

  const open = submit.data.detail.find((d) => d.type === "open");
  assert.ok(open, "seeded exam draws one open question");

  const r = await admin.post(`/api/admin/attempts/${start.data.attemptId}/regrade`, { questionId: open.id, score: open.maxPoints });
  assert.equal(r.status, 200);
  assert.ok(r.data.percent > submit.data.percent, "score went up after the override");
  const d = r.data.detail.find((x) => x.id === open.id);
  assert.equal(d.overridden, true);
  assert.equal(d.score, open.maxPoints);
});

test("CSV exports respond with UTF-8 BOM and expected headers", async () => {
  for (const [p, header] of [
    ["/api/admin/export/completion.csv", "Employee ID,Name,Department"],
    ["/api/admin/export/attempts.csv", "Employee ID,Name,Program"],
  ]) {
    const res = await admin.raw("GET", p);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /text\/csv/);
    // Response.text() strips the BOM per the encoding spec — check raw bytes.
    const bytes = Buffer.from(await res.arrayBuffer());
    assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], "BOM present for Excel");
    assert.ok(bytes.subarray(3).toString("utf8").startsWith(header), p + " header row");
  }
});

test("schema_migrations records every known migration exactly once", async () => {
  const db = new DatabaseSync(srv.dbPath, { readOnly: true });
  try {
    const rows = db.prepare("SELECT version, name FROM schema_migrations ORDER BY version").all();
    // 62 = 结构迁移 question-points、63 = exam-fixed-questions、64 = 数据迁移 rbac-roles-consolidate（2026-10-06；59–61 为数据迁移，号空间共用）
    // 69 = review-hod-proxy（2026-10-08 第二批波次 1）；67 = users-potential-at（结构）、68 = perf-talent-people-read（数据），
    // 第二批波次 2 合入；70 = review-appeals（绩效申诉与 HRBP 分工，第二批 2.8）、71 = 记录类型「经理可见」（8.3）、72 = attachment-media（第三批 5.7 课件内视频）；
    // 第四批：73 = question-types-and-exam-options（题型 data 列、考试 shuffleOptions / partialCredit / caseCount）、74 = assignment-source（自主学习）（下一个可用为 75）
    // 第五批（80–84 预留）：80 = talent-filters（结构：人才筛选两张表、succession 三列）、81 = promotion-default-filter（数据：内置晋升筛选）
    // F48：85 = talent-tags-strip-emoji（数据：人才标签去 emoji；82–84 仍预留给第五批返工）
    // F58：90 = exam-pre-notice（结构：exams.preNotice / preNotice_zh；86–89 预留给工作台 12.2）
    // F61：91 = talent-filter-role-type-to-track（数据：已保存筛选的「管理者 / 个人贡献者」条件改写为职级通道）
    // 12.2 工作台：86 = workbench-key-positions-tag-events（结构：key_positions / talent_tag_events / workbench_snapshots）、87 = talent-tags-controlled-map（数据：存量标签纳入受控标签）；88–89 预留给工作台返工
    // F62：92 = promotion-threshold-f62（数据：内置晋升筛选换成公司晋升门槛默认；被改过的保留并提示可恢复默认）；93 = promotion-threshold-f62-missing-fail（数据：首版默认的两条绩效叶子 missing 改为 fail）
    assert.deepEqual(rows.map((r) => r.version), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51, 52, 53, 54, 55, 56, 57, 58, 59, 60, 61, 62, 63, 64, 65, 66, 67, 68, 69, 70, 71, 72, 73, 74, 80, 81, 85, 86, 87, 90, 91, 92, 93, 94, 95, 96, 97, 98, 99]);   // 94 = CX-048 停用 DEMO-ADMIN（2026-10-09）；95 = 组织绩效（2026-10-10）
    assert.ok(["preNotice", "preNotice_zh"].every((k) => db.prepare("PRAGMA table_info(exams)").all().some((c) => c.name === k)), "exam pre-notice (migration 90)");
    assert.ok(["updatedAt", "createdBy", "source"].every((k) => db.prepare("PRAGMA table_info(succession)").all().some((c) => c.name === k)), "succession trail columns (migration 80)");
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM talent_filters WHERE builtinKey = 'promotion' AND visibility = 'shared'").get().n, 1, "built-in promotion filter (migration 81)");
    assert.ok(db.prepare("PRAGMA table_info(questions)").all().some((c) => c.name === "data"), "questions.data (migration 73)");
    assert.ok(["shuffleOptions", "partialCredit", "caseCount"].every((k) => db.prepare("PRAGMA table_info(exams)").all().some((c) => c.name === k)), "exam options (migration 73)");
    assert.ok(db.prepare("PRAGMA table_info(assignments)").all().some((c) => c.name === "source"), "assignments.source (migration 74)");
    assert.ok(db.prepare("PRAGMA table_info(users)").all().some((c) => c.name === "potentialAt"), "users.potentialAt (migration 67)");
    // 第三批 5.7：迁移 72 建 attachment_media，(attachmentId, seq) 唯一
    assert.ok(db.prepare("PRAGMA table_info(attachment_media)").all().some((c) => c.name === "slides"), "attachment_media (migration 72)");
    assert.ok(db.prepare("PRAGMA index_list(attachment_media)").all().some((i) => i.name === "idx_attachment_media_att_seq" && i.unique), "attachment_media unique (attachmentId, seq)");
    // v39 splits the bilingual record labels: label holds English, label_zh the
    // Chinese, so loc() can render one language instead of printing both.
    for (const tbl of ["record_types", "record_fields"]) {
      assert.ok(db.prepare(`PRAGMA table_info(${tbl})`).all().some((c) => c.name === "label_zh"), tbl + ".label_zh");
    }
    // Every row of BOTH tables, not one sample: this suite once passed with all 36
    // seeded record_fields back to "期间 Period" on a fresh database, because the
    // only assertion here looked at record_types. A schema migration runs before
    // seeding, so a seed that still carries bilingual strings re-creates the bug
    // that v39 fixed — which only a per-row check catches.
    const cjk = /[\u4e00-\u9fff]/;
    for (const tbl of ["record_types", "record_fields"]) {
      const idCol = tbl === "record_types" ? "key" : "id";
      for (const row of db.prepare(`SELECT ${idCol} AS id, label, label_zh FROM ${tbl}`).all()) {
        const where = `${tbl}.${row.id}`;
        assert.ok(row.label && row.label_zh, where + " has both labels");
        assert.ok(!cjk.test(row.label), where + ' English label carries Chinese: "' + row.label + '"');
        // Not "the Chinese name holds no English" — a proper noun legitimately does
        // ("Lark 名称"). The invariant for a seeded row is that the two names really
        // are two names; a single-language fallback is only for HR-created fields.
        assert.notEqual(row.label_zh, row.label, where + ' has two distinct names');
      }
    }
    // v38 adds the three columns the UI had no way to fake: a self-review
    // deadline, a department head, and a per-exam switch for blur recording.
    assert.ok(db.prepare("PRAGMA table_info(review_cycles)").all().some((c) => c.name === "dueAt"));
    assert.ok(db.prepare("PRAGMA table_info(departments)").all().some((c) => c.name === "ownerId"));
    assert.ok(db.prepare("PRAGMA table_info(exams)").all().some((c) => c.name === "recordBlur"));
    // v37 gives grade appeals their own table, with one open appeal per attempt.
    const appeals = db.prepare("PRAGMA table_info(attempt_appeals)").all().map((c) => c.name);
    for (const col of ["attemptId", "userId", "reason", "status", "resolvedBy", "resolution"])
      assert.ok(appeals.includes(col), "attempt_appeals." + col);
    const users = db.prepare("PRAGMA table_info(users)").all().map((c) => c.name);
    for (const col of ["mustChangePassword", "department", "active", "email", "managerId", "larkUserId", "phone", "position", "jobLevel", "hireDate", "talentTags", "potential", "empStatus", "extras"])
      assert.ok(users.includes(col), "users." + col);
    // v45 gives the self-service password reset its own token table. tokenHash,
    // never a token: the column name is part of the contract (store.js only ever
    // writes a sha256 into it), so a rename that reintroduced plaintext would have
    // to break this line first.
    const pwr = db.prepare("PRAGMA table_info(password_resets)").all().map((c) => c.name);
    for (const col of ["id", "userId", "tokenHash", "expiresAt", "usedAt", "createdAt", "requestedFor"])
      assert.ok(pwr.includes(col), "password_resets." + col);
    assert.equal(pwr.includes("token"), false, "password_resets must have no plaintext token column");
    const atts = db.prepare("PRAGMA table_info(attachments)").all().map((c) => c.name);
    for (const col of ["ownerKind", "ownerId"]) assert.ok(atts.includes(col), "attachments." + col);
  } finally {
    db.close();
  }
});
