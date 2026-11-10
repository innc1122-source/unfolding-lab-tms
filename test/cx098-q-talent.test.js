// 上线前全覆盖 Q 组（人才模块，10/11）：
//   CX-098 单条录入继任：同一「岗位 + 继任人」（岗位名只差大小写、空格、连字符也算）回 409 already_listed，不再插第二行；
//   CX-106 岗位名超过 80 字回 400 position_too_long（原来静默截断）；继任人不存在 / 范围外 400 successor_not_found；就绪度无效 400 readiness_invalid；
//   CX-099 继任页（withPositions=1）带 keyPositions：清单上标为关键的岗位（含空缺），录入下拉可选；
//   CX-103 AI 服务未接入时画像 canGenerate=false（state = not_configured），页面据此置灰。
"use strict";
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { ADMIN, startServer, loginAs, tempDir } = require("./helpers.js");

let srv, admin;
const emp = {};
async function makeEmployee(empId, patch) {
  const created = await admin.post("/api/admin/employees", { name: "Name " + empId, employeeId: empId });
  assert.equal(created.status, 200, "create " + empId);
  const u = (await admin.get("/api/admin/roster")).data.find((x) => x.employeeId === empId);
  emp[empId] = u.id;
  if (patch) assert.equal((await admin.put("/api/admin/employees/" + u.id, patch)).status, 200, "patch " + empId);
}
before(async () => {
  srv = await startServer({ env: { LMS_DISABLE_AI: "1" } });
  admin = await loginAs(srv.base, ADMIN);
  await makeEmployee("CQ-1", { position: "Analyst" });
  await makeEmployee("CQ-2", { position: "Analyst" });
});
after(async () => { if (srv) await srv.stopAsync(); });

test("CX-098: adding the same successor to the same position twice is refused (409 already_listed), spelling variants included", async () => {
  const a = await admin.post("/api/admin/succession", { positionName: "Finance Lead", userId: emp["CQ-1"], readiness: "oneYear" });
  assert.equal(a.status, 200, JSON.stringify(a.data));
  for (const name of ["Finance Lead", "finance  lead", " FINANCE LEAD "]) {
    const b = await admin.post("/api/admin/succession", { positionName: name, userId: emp["CQ-1"], readiness: "ready" });
    assert.equal(b.status, 409, name);
    assert.equal(b.data.code, "already_listed");
    assert.equal(b.data.id, a.data.entry.id);
    assert.ok(b.data.error_zh);
  }
  const other = await admin.post("/api/admin/succession", { positionName: "Finance Lead", userId: emp["CQ-2"], readiness: "ready" });
  assert.equal(other.status, 200, "a different successor for the same position is fine");
  const rows = (await admin.get("/api/admin/succession")).data.filter((r) => r.userId === emp["CQ-1"]);
  assert.equal(rows.length, 1, "still one row for CQ-1");
});

test("CX-106: position name over 80 characters → 400 position_too_long; bad successor / readiness get their own codes", async () => {
  const long = await admin.post("/api/admin/succession", { positionName: "x".repeat(81), userId: emp["CQ-2"], readiness: "ready" });
  assert.equal(long.status, 400);
  assert.equal(long.data.code, "position_too_long");
  const ok80 = await admin.post("/api/admin/succession", { positionName: "y".repeat(80), userId: emp["CQ-2"], readiness: "ready" });
  assert.equal(ok80.status, 200);
  assert.equal(ok80.data.entry.positionName.length, 80);
  const noPos = await admin.post("/api/admin/succession", { positionName: "  ", userId: emp["CQ-2"], readiness: "ready" });
  assert.equal(noPos.data.code, "position_required");
  const noUser = await admin.post("/api/admin/succession", { positionName: "Ops Lead", userId: "u-nobody", readiness: "ready" });
  assert.equal(noUser.status, 400);
  assert.equal(noUser.data.code, "successor_not_found");
  const badReady = await admin.post("/api/admin/succession", { positionName: "Ops Lead", userId: emp["CQ-2"], readiness: "soon" });
  assert.equal(badReady.status, 400);
  assert.equal(badReady.data.code, "readiness_invalid");
});

test("CX-099: the succession tab payload lists key positions from the key-position list, vacant ones included", async () => {
  const d = await admin.post("/api/admin/departments", { name: "CQ Dept" });
  assert.equal(d.status, 200);
  const kp = await admin.post("/api/admin/key-positions", { name: "Vacant Head of Risk", deptId: d.data.department.id, isKey: true });
  assert.equal(kp.status, 200, JSON.stringify(kp.data));
  const r = await admin.get("/api/admin/succession?withPositions=1&vacancies=1");
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.data.keyPositions), "keyPositions present");
  assert.ok(r.data.keyPositions.includes("Vacant Head of Risk"));
});

test("CX-103: with the AI service not connected the portrait cannot be generated (canGenerate=false)", async () => {
  // ai 模块与画像功能开着、LMS_DISABLE_AI=1 → state = not_configured
  const dir = tempDir("cx103");
  const cfg = path.join(dir, "config.json");
  fs.writeFileSync(cfg, JSON.stringify({ modules: { ai: true }, ai: { features: { portrait: true } } }));
  const s2 = await startServer({ env: { LMS_CONFIG_PATH: cfg, LMS_DISABLE_AI: "1" } });
  try {
    const a2 = await loginAs(s2.base, ADMIN);
    await a2.post("/api/admin/employees", { name: "Portrait Person", employeeId: "CQ-P" });
    const u = (await a2.get("/api/admin/roster")).data.find((x) => x.employeeId === "CQ-P");
    const r = await a2.get("/api/admin/talent-portraits?userId=" + u.id);
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.state, "not_configured");
    assert.equal(r.data.canGenerate, false);
  } finally { await s2.stopAsync(); }
});
