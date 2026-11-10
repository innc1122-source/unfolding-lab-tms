// Roster payload contract, employment-status semantics, review-cycle discard
// guards, and the org-diagnostics endpoint (previously UI-verified only).
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { ADMIN, EMPLOYEE, startServer, loginAs, makeClient } = require("./helpers.js");

let srv, admin, emp;
before(async () => {
  srv = await startServer();
  admin = await loginAs(srv.base, ADMIN);
  emp = await loginAs(srv.base, EMPLOYEE);
});
after(() => srv.stop());

// The roster is what the employee table renders. It dropped the talent columns
// when it was slimmed down, which silently emptied the 职位 column and the
// job-level tag for every employee.
test("roster carries the talent columns the employee table renders", async () => {
  const r = await admin.get("/api/admin/roster");
  assert.equal(r.status, 200);
  const juan = r.data.find((u) => u.employeeId === "DP-1001");
  assert.ok(juan, "seeded employee present in roster");
  for (const k of ["position", "jobLevel", "empStatus", "hireDate"]) {
    assert.ok(k in juan, `roster must expose ${k}`);
  }
  assert.equal(juan.jobLevel, "MB2");
  assert.equal(juan.empStatus, "regular");
  assert.ok(juan.position, "position is populated, not null");
  // Still the light endpoint: no per-course progress computation rides along.
  assert.ok(!("programs" in juan), "roster stays free of per-course progress");
  assert.equal((await emp.get("/api/admin/roster")).status, 403);
});

// Employment status and account status are different facts; the roster has to
// carry both so the table can tell a leaver from a switched-off login.
test("exit side effect sets empStatus and disables the account together", async () => {
  const created = await admin.post("/api/admin/employees", {
    name: "Exit Fixture", employeeId: "QA-EXIT-1", department: "Customer Care",
    position: "Support Agent", jobLevel: "PD2", hireDate: "2025-03-01",
  });
  assert.equal(created.status, 200);
  const roster = (await admin.get("/api/admin/roster")).data;
  const u = roster.find((x) => x.employeeId === "QA-EXIT-1");
  // Hire data entered on the create form is persisted, not silently dropped.
  assert.equal(u.hireDate, "2025-03-01");
  assert.equal(u.position, "Support Agent");
  assert.equal(u.jobLevel, "PD2");

  const rec = await admin.post(`/api/admin/employees/${u.id}/records`, {
    type: "exit", date: "2026-08-01", title: "离职",
    fields: { exitType: "Voluntary", syncStatus: true },
  });
  assert.equal(rec.status, 200);
  const after = (await admin.get("/api/admin/roster")).data.find((x) => x.employeeId === "QA-EXIT-1");
  assert.equal(after.empStatus, "exited");
  assert.equal(after.active, false);
});

test("a cycle launched by mistake can be discarded, but only while untouched", async () => {
  const c = await admin.post("/api/admin/review-cycles", { name: "QA Wrong Scope" });
  assert.equal(c.status, 200);
  const id = c.data.cycle.id;
  assert.ok(c.data.participants > 0, "company-wide scope picked people up");
  // Leavers are never enrolled, even before their account is disabled.
  const items = (await admin.get(`/api/admin/review-cycles/${id}`)).data.items;
  assert.ok(!items.some((i) => i.employeeId === "QA-EXIT-1"), "exited employee excluded from a new cycle");

  assert.equal((await emp.del(`/api/admin/review-cycles/${id}`)).status, 403, "employees cannot delete cycles");
  const gone = await admin.del(`/api/admin/review-cycles/${id}`);
  assert.equal(gone.status, 200);
  assert.equal(gone.data.removed, c.data.participants, "participant rows cleaned up with the cycle");
  assert.equal((await admin.get(`/api/admin/review-cycles/${id}`)).status, 404);

  // Once anyone has submitted, deleting is refused — that is history now.
  const c2 = await admin.post("/api/admin/review-cycles", { name: "QA Real Cycle" });
  const mine = (await emp.get("/api/me/reviews")).data.mine;
  const item = mine.find((i) => i.cycle === "QA Real Cycle");
  assert.ok(item, "employee sees the open cycle in their inbox");
  // Self-review requires feedback plus at least one next-quarter goal.
  assert.equal((await emp.post(`/api/me/reviews/${item.id}/self`, { feedback: "沟通再多一点", goalsNext: ["把交付周期压到两周"] })).status, 200);
  const refused = await admin.del(`/api/admin/review-cycles/${c2.data.cycle.id}`);
  assert.equal(refused.status, 400, "a cycle with submissions can only be closed");
  assert.equal((await admin.get(`/api/admin/review-cycles/${c2.data.cycle.id}`)).status, 200, "cycle survived the refused delete");
});

// The matrix layer is additive: it must never disturb the solid line the org
// tree, performance routing and depth analysis are all built on.
test("dotted lines and concurrent posts sit alongside the solid line", async () => {
  // The dotted-line partner has to be someone the chart actually shows, or the
  // link is (correctly) not shippable — the seed's only other employee is the
  // exited archive demo, so make a live colleague for this test.
  assert.equal((await admin.post("/api/admin/employees", {
    name: "Matrix Colleague", employeeId: "QA-MATRIX-1", department: "Customer Care", position: "Risk Analyst",
  })).status, 200);
  const roster = (await admin.get("/api/admin/roster")).data.filter((u) => u.role !== "admin");
  const juan = roster.find((u) => u.employeeId === "DP-1001");
  const other = roster.find((u) => u.employeeId === "QA-MATRIX-1");
  assert.ok(juan && other, "fixtures present");
  const solidBefore = juan.managerId;

  const made = await admin.post(`/api/admin/employees/${juan.id}/secondary-lines`,
    { kind: "dotted", managerId: other.id, position: "合规事务" });
  assert.equal(made.status, 200);
  assert.equal(made.data.line.managerName, other.name, "manager reference resolved for the client");

  const conc = await admin.post(`/api/admin/employees/${juan.id}/secondary-lines`,
    { kind: "concurrent", position: "反洗钱专员(兼)", department: "Internal Audit" });
  assert.equal(conc.status, 200);

  // Validation: each kind has its own required field, and the obvious nonsense
  // cases are refused rather than stored.
  assert.equal((await admin.post(`/api/admin/employees/${juan.id}/secondary-lines`, { kind: "dotted" })).status, 400, "dotted needs a manager");
  assert.equal((await admin.post(`/api/admin/employees/${juan.id}/secondary-lines`, { kind: "concurrent" })).status, 400, "concurrent needs a position");
  assert.equal((await admin.post(`/api/admin/employees/${juan.id}/secondary-lines`, { kind: "dotted", managerId: juan.id })).status, 400, "no self-reference");
  assert.equal((await admin.post(`/api/admin/employees/${juan.id}/secondary-lines`, { kind: "dotted", managerId: solidBefore })).status, 400, "solid-line duplicate is meaningless");
  assert.equal((await admin.post(`/api/admin/employees/${juan.id}/secondary-lines`, { kind: "dotted", managerId: other.id, position: "合规事务" })).status, 400, "exact duplicate refused");
  assert.equal((await emp.post(`/api/admin/employees/${juan.id}/secondary-lines`, { kind: "dotted", managerId: other.id })).status, 403);

  // The solid line is untouched, and both views of the matrix resolve.
  const prof = await admin.get(`/api/admin/employees/${juan.id}/profile`);
  assert.equal(prof.data.user.managerId, solidBefore, "solid line unchanged by matrix edits");
  assert.equal(prof.data.secondaryLines.length, 2);
  const mirror = await admin.get(`/api/admin/employees/${other.id}/profile`);
  assert.ok(mirror.data.secondaryReports.some((r) => r.userId === juan.id), "shows up as a dotted report on the other side");

  // The chart ships nodes + drawable dashed links; diagnostics counts the layer.
  const chart = await admin.get("/api/admin/org-chart");
  assert.ok(Array.isArray(chart.data.nodes), "chart returns { nodes, secondary }");
  assert.ok(chart.data.secondary.some((r) => r.userId === juan.id && r.managerId === other.id));
  // A concurrent post with no manager is not drawable and must not be shipped as a link.
  assert.ok(chart.data.secondary.every((r) => r.managerId), "links always have both ends");
  const diag = await admin.get("/api/admin/org-diagnostics");
  assert.equal(diag.data.matrix.dottedLines, 1);
  assert.equal(diag.data.matrix.concurrentPosts, 1);
  assert.equal(diag.data.matrix.peopleWithDotted, 1);

  // Removing a line leaves the solid line and the person alone.
  assert.equal((await emp.del(`/api/admin/secondary-lines/${made.data.line.id}`)).status, 403);
  assert.equal((await admin.del(`/api/admin/secondary-lines/${made.data.line.id}`)).status, 200);
  const after = await admin.get(`/api/admin/employees/${juan.id}/profile`);
  assert.equal(after.data.secondaryLines.length, 1);
  assert.equal(after.data.user.managerId, solidBefore);
});

test("bulk import of matrix lines reports per-row outcomes", async () => {
  const roster = (await admin.get("/api/admin/roster")).data.filter((u) => u.role !== "admin");
  const a = roster.find((u) => u.employeeId === "DP-1001");
  const b = roster.find((u) => u.employeeId === "QA-MATRIX-1"); // created by the test above
  const r = await admin.post("/api/admin/secondary-lines/bulk", {
    rows: [
      { employeeId: a.employeeId, kind: "dotted", managerEmployeeId: b.employeeId, position: "区域项目" },
      { employeeId: "NOPE-999", kind: "dotted", managerEmployeeId: b.employeeId },
      { employeeId: a.employeeId, kind: "concurrent" },
      { employeeId: a.employeeId, kind: "dotted", managerEmployeeId: a.employeeId },
    ],
  });
  assert.equal(r.status, 200);
  assert.equal(r.data.created, 1);
  assert.equal(r.data.skipped, 3);
  assert.equal(r.data.results[0].status, "created");
  assert.match(r.data.results[1].reason, /not found/);
  assert.equal((await emp.post("/api/admin/secondary-lines/bulk", { rows: [] })).status, 403);
});

// Onboarding a group and running a talent review both need a batch path; the
// imported roster shares one unusable hash, so without bulk reset nobody signs
// in at all, and without bulk potential the 9-box axis stays empty.
test("bulk password reset issues one-time passwords and skips who it should", async () => {
  // A throwaway target: resetting a password kills that user's sessions, so
  // touching the shared DP-1001 fixture would log out `emp` for later tests.
  assert.equal((await admin.post("/api/admin/employees", {
    name: "Reset Fixture", employeeId: "QA-RESET-1", department: "Customer Care",
  })).status, 200);
  const roster = (await admin.get("/api/admin/roster")).data;
  const live = roster.find((u) => u.employeeId === "QA-RESET-1");
  const gone = roster.find((u) => u.employeeId === "QA-EXIT-1"); // exited earlier in this file
  const me = roster.find((u) => u.role === "admin");

  const r = await admin.post("/api/admin/employees/bulk-reset", { userIds: [live.id, gone.id, me.id] });
  assert.equal(r.status, 200);
  assert.equal(r.data.issued.length, 1, "only the live employee gets one");
  assert.equal(r.data.issued[0].employeeId, "QA-RESET-1");
  assert.match(r.data.issued[0].password, /^\S{6,}$/);
  const reasons = r.data.skipped.map((x) => x.reason);
  assert.ok(reasons.includes("inactive"), "leaver skipped");
  assert.ok(reasons.includes("self"), "own account skipped — never lock yourself out");

  // The issued password works exactly once, then a change is forced.
  const pw = r.data.issued[0].password;
  const fresh = makeClient(srv.base);
  assert.equal((await fresh.post("/api/auth/login", { employeeId: "QA-RESET-1", password: pw })).status, 200);
  assert.equal((await fresh.get("/api/me/growth")).status, 403, "must change the temp password first");
  assert.equal((await fresh.post("/api/auth/change-password", { currentPassword: pw, newPassword: "Rolled#2026x" })).status, 200);
  assert.equal((await fresh.get("/api/me/growth")).status, 200);

  assert.equal((await admin.post("/api/admin/employees/bulk-reset", { userIds: [] })).status, 400);
  assert.equal((await emp.post("/api/admin/employees/bulk-reset", { userIds: [live.id] })).status, 403);
});

test("bulk potential fills the 9-box vertical axis", async () => {
  const roster = (await admin.get("/api/admin/roster")).data.filter((u) => u.role !== "admin");
  const target = roster.find((u) => u.employeeId === "DP-1001");

  assert.equal((await admin.post("/api/admin/employees/bulk-update",
    { userIds: [target.id], fields: { potential: "Excellent" } })).status, 400, "off-scale value refused");
  assert.equal((await admin.post("/api/admin/employees/bulk-update",
    { userIds: [target.id], fields: { potential: "High" } })).status, 200);

  const grid = await admin.get("/api/admin/talent-review");
  const row = grid.data.rows.find((r) => r.employeeId === "DP-1001");
  assert.equal(row.potential, "High");
  assert.notEqual(row.potBucket, null, "potential bucket resolved for the grid");
  assert.notEqual(row.perfBucket, null, "seeded performance record gives the other axis");

  // Clearing is a real operation, not a no-op.
  assert.equal((await admin.post("/api/admin/employees/bulk-update",
    { userIds: [target.id], fields: { potential: "" } })).status, 200);
  const after = await admin.get("/api/admin/talent-review");
  assert.equal(after.data.rows.find((r) => r.employeeId === "DP-1001").potBucket, null);
});

test("org diagnostics reports spans, depth and unmapped levels", async () => {
  const r = await admin.get("/api/admin/org-diagnostics");
  assert.equal(r.status, 200);
  for (const k of ["kpis", "spans", "tracks", "grades", "depts", "talent", "findings"]) {
    assert.ok(k in r.data, `diagnostics must report ${k}`);
  }
  assert.ok(Array.isArray(r.data.findings));
  // Findings are localized client-side, so each one is a key plus params.
  for (const f of r.data.findings) {
    assert.equal(typeof f.key, "string");
    assert.ok(f.key.length, "finding carries a key for the client to localize");
  }
  // Admin service accounts are people-management noise and stay out of the tree.
  assert.ok(!r.data.spans.some((s) => s.employeeId === "ADMIN"), "admin excluded from spans");
  assert.equal((await emp.get("/api/admin/org-diagnostics")).status, 403);
  assert.equal((await makeClient(srv.base).get("/api/admin/org-diagnostics")).status, 401);
});
