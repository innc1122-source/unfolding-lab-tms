// Batch 1 regression tests: exams as first-class objects — migration from the
// legacy program config, idempotency across restarts, program/exam CRUD, and
// exam-driven rules on the employee side.
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

test("migration created one Final Exam per program with the legacy rules", async () => {
  const { data: exams } = await admin.get("/api/admin/exams");
  const e = exams.find((x) => x.id === "exam-nho");
  assert.ok(e, "exam-nho exists");
  assert.equal(e.title, "New Hire Onboarding Final Exam");
  assert.equal(e.programId, "nho");
  assert.equal(e.status, "published");
  assert.equal(e.passingScore, 80);
  assert.equal(e.mcqCount, 8);
  assert.equal(e.openCount, 1);
  assert.equal(e.timeLimitMinutes, 20);
  assert.equal(e.courseIds.length, 3, "linked to every course of the program");
});

test("migration is idempotent: a restart on the same database adds nothing", async () => {
  const dbPath = srv.dbPath;
  srv.stop();
  await new Promise((r) => setTimeout(r, 400));
  srv = await startServer({ dbPath });
  admin = await loginAs(srv.base, ADMIN);
  emp = await loginAs(srv.base, EMPLOYEE);
  const { data: exams } = await admin.get("/api/admin/exams");
  assert.equal(exams.filter((e) => e.programId === "nho").length, 1, "still exactly one migrated exam");
});

test("new attempts carry the examId; exam rules drive grading", async () => {
  await completeAllModules(emp, "nho");
  const start = await emp.post("/api/exam/start", { programId: "nho" });
  assert.equal(start.status, 200);
  assert.equal(start.data.examId, "exam-nho");
  const submit = await emp.post(`/api/exam/${start.data.attemptId}/submit`, { answers: {} });
  assert.equal(submit.status, 200);
  assert.equal(submit.data.examTitle, "New Hire Onboarding Final Exam");

  const db = new DatabaseSync(srv.dbPath, { readOnly: true });
  try {
    const row = db.prepare("SELECT examId FROM attempts WHERE id = ?").get(start.data.attemptId);
    assert.equal(row.examId, "exam-nho");
  } finally { db.close(); }
});

test("program create → exam create → employee takes the new exam by examId", async () => {
  // 1. New program (draft), invisible to employees until published.
  const bad = await admin.post("/api/admin/programs", { title: "" });
  assert.equal(bad.status, 400);
  const created = await admin.post("/api/admin/programs", { title: "Security Refresher", title_zh: "安全复训", defaultDueDays: 14 });
  assert.equal(created.status, 200);
  const pid = created.data.id;
  assert.ok(pid.startsWith("p-"), "system-generated id");

  // 2. Exam creation on a program with no courses is refused.
  const noCourses = await admin.post("/api/admin/exams", { programId: pid, title: "Refresher Exam", courseIds: [] });
  assert.equal(noCourses.status, 400);

  // 3. Reuse an existing NHO course? Not allowed — course belongs to another program.
  const wrongCourse = await admin.post("/api/admin/exams", { programId: pid, title: "Refresher Exam", courseIds: ["culture-conduct"] });
  assert.equal(wrongCourse.status, 400);

  // 4. Second exam on NHO with a smaller draw, draft first.
  const quiz = await admin.post("/api/admin/exams", {
    programId: "nho", title: "Culture Quiz", courseIds: ["culture-conduct"],
    passingScore: 60, mcqCount: 3, openCount: 0, timeLimitMinutes: null, status: "draft",
  });
  assert.equal(quiz.status, 200);

  // Draft exams are not startable by employees.
  const startDraft = await emp.post("/api/exam/start", { examId: quiz.data.id });
  assert.equal(startDraft.status, 404);

  // 5. Publish it (pool check runs: culture-conduct must have ≥3 objective questions).
  const pub = await admin.put("/api/admin/exams/" + quiz.data.id, {
    title: "Culture Quiz", courseIds: ["culture-conduct"],
    passingScore: 60, mcqCount: 3, openCount: 0, timeLimitMinutes: null, status: "published",
  });
  assert.equal(pub.status, 200, JSON.stringify(pub.data));

  // 6. Employee sees both exams on the program and starts the quiz by examId.
  const { data: prog } = await emp.get("/api/programs/nho");
  assert.equal(prog.exams.length, 2);
  const start = await emp.post("/api/exam/start", { examId: quiz.data.id });
  assert.equal(start.status, 200);
  assert.equal(start.data.questions.length, 3, "draw count comes from the exam");
  assert.equal(start.data.passingScore, 60);
  // Legacy programId start is ambiguous with two exams.
  const ambiguous = await emp.post("/api/exam/start", { programId: "nho" });
  assert.equal(ambiguous.status, 400);
  // Clean up: archive the quiz so later tests see one startable exam again.
  await admin.put("/api/admin/exams/" + quiz.data.id, {
    title: "Culture Quiz", courseIds: ["culture-conduct"],
    passingScore: 60, mcqCount: 3, openCount: 0, status: "archived",
  });
});

test("publishing an exam with an insufficient pool is refused with the gap", async () => {
  const r = await admin.post("/api/admin/exams", {
    programId: "nho", title: "Impossible Exam", courseIds: ["culture-conduct"],
    mcqCount: 50, openCount: 10, status: "published",
  });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /Not enough questions/);
});

test("draft programs are hidden from employees and not auto-assigned", async () => {
  const created = await admin.post("/api/admin/programs", { title: "Hidden Draft Program" });
  const pid = created.data.id;
  // Assign it to the employee anyway — still hidden because it's a draft.
  const employees = await admin.get("/api/admin/employees");
  const u = employees.data.find((x) => x.employeeId === EMPLOYEE.employeeId);
  await admin.post("/api/admin/assignments", { userId: u.id, items: [{ programId: pid, assigned: true }] });
  const list = await emp.get("/api/programs");
  assert.equal(list.data.find((p) => p.id === pid), undefined, "draft stays invisible");
  // New employees are not auto-assigned draft programs.
  const nu = await admin.post("/api/admin/employees", { name: "Draft Check", employeeId: "DP-DRF1" });
  assert.equal(nu.data.assigned.find((a) => a.programId === pid), undefined);
  // Publish → visible to the already-assigned employee.
  await admin.put("/api/admin/programs/" + pid, { title: "Hidden Draft Program", status: "published" });
  const list2 = await emp.get("/api/programs");
  assert.ok(list2.data.find((p) => p.id === pid), "published + assigned = visible");
});

test("employee program detail derives legacy exam fields from the exam object", async () => {
  const { data: exam } = await admin.get("/api/admin/exams/exam-nho");
  const upd = await admin.put("/api/admin/exams/exam-nho", { ...exam, passingScore: 85 });
  assert.equal(upd.status, 200);
  const { data: prog } = await emp.get("/api/programs/nho");
  assert.equal(prog.passingScore, 85, "top-level legacy field mirrors the exam");
  assert.equal(prog.exams.find((e) => e.id === "exam-nho").passingScore, 85);
  await admin.put("/api/admin/exams/exam-nho", { ...exam, passingScore: 80 });
});

test("exam question pool endpoint returns only linked-course questions", async () => {
  const { data: pool } = await admin.get("/api/admin/exams/exam-nho/questions");
  assert.ok(pool.length > 0);
  const { data: exam } = await admin.get("/api/admin/exams/exam-nho");
  for (const q of pool) assert.ok(exam.courseIds.includes(q.courseId));
});
