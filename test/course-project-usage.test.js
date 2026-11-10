// 课程库「培养项目：<名称>」/「独立课程」标签（负责人 2026-10-06「不清楚哪些是项目的、哪些不是项目的」）：
// GET /api/admin/content 给每门课带一个只读的 usedInProjects = 引用该课程的培养项目 [{ id, title, title_zh, status }]。
// 口径与 courseUsage 相同：只认 type "course" 且 refId 指向该课的活动；一个项目不论几个期次、几个活动引用，
// 只算一次；线上活动 / 线下活动 / 考试活动不算。进行中、筹备中、收尾中排在已关闭前面。
// 这个字段是现算的：课程 PUT 原样回传 GET 对象时不落库，缓存的课程对象也不被改写。
"use strict";
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { DatabaseSync } = require("node:sqlite");
const { ADMIN, startServer, loginAs } = require("./helpers.js");

const C1 = "culture-conduct", C2 = "data-privacy", C3 = "compliance";
let srv, admin, EXAM, pA, pB, pC;

function cohort(id, acts) {
  return {
    id, name: "Cohort " + id, startAt: "2026-01-01", endAt: "2026-12-31", capacity: 10, classes: [],
    phases: [{ id: "ph-" + id, name: "Phase", gateMode: "time", activities: acts }],
  };
}
async function content() {
  const r = await admin.get("/api/admin/content");
  assert.equal(r.status, 200);
  const by = {};
  for (const c of r.data.courses) by[c.id] = c;
  return { data: r.data, by };
}
const ids = (list) => list.map((p) => p.id);
function storedCourse(id) {
  const db = new DatabaseSync(srv.dbPath, { readOnly: true });
  try { return JSON.parse(db.prepare("SELECT json FROM content WHERE kind = 'course' AND id = ?").get(id).json); } finally { db.close(); }
}

before(async () => {
  srv = await startServer();
  admin = await loginAs(srv.base, ADMIN);
  EXAM = (await admin.get("/api/admin/exams")).data[0].id;
  const mk = async (title, title_zh) => (await admin.post("/api/admin/tprojects", { title, title_zh })).data.id;
  pA = await mk("Usage A", "引用项目 A");
  pB = await mk("Usage B", "引用项目 B");
  pC = await mk("Usage C", null);
  // A：两个期次都引用 C1（只算一次），第二期次另引用 C2；进行中
  let r = await admin.put("/api/admin/tprojects/" + pA, { status: "running", cohorts: [
    cohort("ua-1", [{ id: "ua-c1a", type: "course", refId: C1 }, { id: "ua-c1b", type: "course", refId: C1 }]),
    cohort("ua-2", [{ id: "ua-c1c", type: "course", refId: C1 }, { id: "ua-c2", type: "course", refId: C2 }]),
  ] });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  // B：筹备中，引用 C1
  r = await admin.put("/api/admin/tprojects/" + pB, { status: "planning", cohorts: [cohort("ub-1", [{ id: "ub-c1", type: "course", refId: C1 }])] });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  // C：只有不引用课程的活动（线上活动标题与 C3 同名、线下活动、考试）——不算引用 C3
  r = await admin.put("/api/admin/tprojects/" + pC, { status: "running", cohorts: [cohort("uc-1", [
    { id: "uc-on", type: "online", title: C3, completion: "trainer", url: null },
    { id: "uc-off", type: "offline", title: C3 },
    { id: "uc-ex", type: "exam", refId: EXAM },
  ])] });
  assert.equal(r.status, 200, JSON.stringify(r.data));
});
after(async () => { if (srv) await srv.stopAsync(); });

test("every course carries usedInProjects; shape is exactly { id, title, title_zh, status }", async () => {
  const { data, by } = await content();
  assert.ok(data.courses.length >= 3);
  for (const c of data.courses) assert.ok(Array.isArray(c.usedInProjects), c.id + " has usedInProjects");
  assert.ok(Array.isArray(data.programs), "programs unchanged");
  for (const p of by[C1].usedInProjects) assert.deepEqual(Object.keys(p).sort(), ["id", "status", "title", "title_zh"]);
  const a = by[C1].usedInProjects.find((p) => p.id === pA);
  assert.deepEqual(a, { id: pA, title: "Usage A", title_zh: "引用项目 A", status: "running" });
});

test("a project counts once per course; running sorts before planning; only course activities count", async () => {
  const { by } = await content();
  const c1 = ids(by[C1].usedInProjects).filter((id) => [pA, pB, pC].includes(id));
  assert.deepEqual(c1, [pA, pB], "C1: A once (two cohorts, three activities), then B; C has no course activity");
  assert.ok(ids(by[C2].usedInProjects).includes(pA));
  assert.ok(!ids(by[C2].usedInProjects).includes(pB));
  for (const c of [C1, C2, C3]) assert.ok(!ids(by[c].usedInProjects).includes(pC), c + ": online / offline / exam activities are not course references");
});

test("derived live: status change and removed reference show up on the next GET", async () => {
  // A 关闭 → 排到 B（筹备中）后面，状态随之变化
  assert.equal((await admin.put("/api/admin/tprojects/" + pA, { status: "closed" })).status, 200);
  let { by } = await content();
  let c1 = by[C1].usedInProjects.filter((p) => [pA, pB].includes(p.id));
  assert.deepEqual(c1.map((p) => [p.id, p.status]), [[pB, "planning"], [pA, "closed"]]);
  // B 去掉对 C1 的引用 → C1 不再列出 B
  assert.equal((await admin.put("/api/admin/tprojects/" + pB, { cohorts: [cohort("ub-1", [{ id: "ub-off", type: "offline", title: "Kickoff" }])] })).status, 200);
  ({ by } = await content());
  assert.ok(!ids(by[C1].usedInProjects).includes(pB));
  assert.ok(ids(by[C1].usedInProjects).includes(pA));
});

test("read-only: echoing the GET object back in a course PUT does not persist usedInProjects", async () => {
  const { by } = await content();
  const course = by[C2];
  assert.ok(course.usedInProjects.length > 0, "precondition: C2 is used by a project");
  const r = await admin.put("/api/admin/content/courses/" + C2, { ...course, description: "Echo test" });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const stored = storedCourse(C2);
  assert.equal(stored.description, "Echo test", "the PUT itself went through");
  assert.ok(!("usedInProjects" in stored), "derived field never reaches the course document");
  // 未被改写的课程文档同样不带这个字段（GET 用的是副本，不装饰缓存对象）
  assert.ok(!("usedInProjects" in storedCourse(C3)));
  // 去掉引用后，下一次 GET 不会读到已落库的旧值
  assert.equal((await admin.put("/api/admin/tprojects/" + pA, { status: "running" })).status, 200);
  assert.equal((await admin.put("/api/admin/tprojects/" + pA, { cohorts: [cohort("ua-1", [{ id: "ua-c1a", type: "course", refId: C1 }])] })).status, 200);
  const after2 = (await content()).by;
  assert.ok(!ids(after2[C2].usedInProjects).includes(pA), "C2 no longer used by A");
});
