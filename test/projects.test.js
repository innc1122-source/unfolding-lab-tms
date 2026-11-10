// Regression coverage for the PR #3 training-project and class-management layer.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { ADMIN, startServer, loginAs } = require("./helpers.js");

let srv, admin;
before(async () => {
  srv = await startServer();
  admin = await loginAs(srv.base, ADMIN);
});
after(() => srv.stop());

test("admin can create a training project and persist a class", async () => {
  const created = await admin.post("/api/admin/tprojects", {
    title: "Leadership Practice Project",
    title_zh: "领导力实践项目",
    category: "Leadership",
  });
  assert.equal(created.status, 200);
  assert.match(created.data.id, /^tp-/);

  const project = await admin.get("/api/admin/tprojects/" + created.data.id);
  assert.equal(project.status, 200);
  assert.equal(project.data.title_zh, "领导力实践项目");

  const cohorts = [{
    id: "cohort-demo",
    name: "Demo Cohort",
    startAt: "2026-08-13",
    endAt: "2026-09-13",
    capacity: 30,
    classes: [{ id: "class-a", name: "Class A", headId: null }],
    phases: [],
  }];
  const saved = await admin.put("/api/admin/tprojects/" + created.data.id, { cohorts });
  assert.equal(saved.status, 200);

  const refreshed = await admin.get("/api/admin/tprojects/" + created.data.id);
  assert.equal(refreshed.status, 200);
  assert.equal(refreshed.data.cohorts[0].classes[0].name, "Class A");

  const list = await admin.get("/api/admin/tprojects");
  assert.equal(list.status, 200);
  assert.equal(list.data.find((item) => item.id === created.data.id).cohortCount, 1);
});

// The 培训项目 card now has a delete entry, so the two sides of its guard are
// worth pinning: an empty project goes away, and one that already carries
// learners must be closed instead — deleting it would take their history with it.
test("training project deletes only while it has no learners", async () => {
  const empty = await admin.post("/api/admin/tprojects", { title: "Throwaway", title_zh: "临时项目" });
  assert.equal(empty.status, 200);
  const gone = await admin.del("/api/admin/tprojects/" + empty.data.id);
  assert.equal(gone.status, 200);
  assert.equal((await admin.get("/api/admin/tprojects/" + empty.data.id)).status, 404);

  const used = await admin.post("/api/admin/tprojects", { title: "Has learners", title_zh: "有学员" });
  assert.equal(used.status, 200);
  const cohorts = [{
    id: "cohort-guard", name: "Guard Cohort", startAt: "2026-08-13", endAt: "2026-09-13",
    capacity: 10, classes: [], phases: [],
  }];
  assert.equal((await admin.put("/api/admin/tprojects/" + used.data.id, { cohorts })).status, 200);
  const roster = await admin.get("/api/admin/roster");
  const learner = roster.data.find((u) => u.employeeId === "DP-1001");
  assert.ok(learner, "seeded employee present in roster");
  const added = await admin.post(`/api/admin/tprojects/${used.data.id}/members`, {
    cohortId: "cohort-guard", userIds: [learner.id],
  });
  assert.equal(added.status, 200);
  assert.equal(added.data.count, 1);

  const refused = await admin.del("/api/admin/tprojects/" + used.data.id);
  assert.equal(refused.status, 400);
  assert.equal(refused.data.code, "has_history");
  assert.equal(refused.data.learners, 1);
  // The refusal must not have deleted anything on its way out.
  assert.equal((await admin.get("/api/admin/tprojects/" + used.data.id)).status, 200);

  // Withdrawing everyone clears the guard: it counts the same population the
  // UI memberCount does (ACTIVE learners), so a fully-withdrawn project with no
  // attendance deletes cleanly instead of 400-ing behind a visible delete button.
  assert.equal((await admin.post(`/api/admin/tprojects/${used.data.id}/members/update`, {
    userId: learner.id, action: "withdraw",
  })).status, 200);
  assert.equal((await admin.del("/api/admin/tprojects/" + used.data.id)).status, 200);
  assert.equal((await admin.get("/api/admin/tprojects/" + used.data.id)).status, 404);
});
