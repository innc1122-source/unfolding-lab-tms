// 上线前全覆盖 P 组（绩效，10/12）：
//   CX-168 有人员管理权限的非超管不能为本人新增、删除绩效记录（403 rating_self_amend，与修改评级同一护栏）；给他人照常；
//   CX-174 该类报错中英文分开（error 英文、error_zh 中文）。
"use strict";
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { ADMIN, startServer, loginAs } = require("./helpers.js");

let srv, admin, hr, hrId, otherId;
before(async () => {
  srv = await startServer();
  admin = await loginAs(srv.base, ADMIN);
  const role = await admin.post("/api/admin/roles", { name: "P people", name_zh: "P 人员", grants: { people: "manage", talent: "manage" } });
  assert.equal(role.status, 200, JSON.stringify(role.data));
  const made = (await admin.post("/api/admin/employees", { name: "HR Self", employeeId: "P-HR" })).data;
  await admin.post("/api/admin/employees", { name: "Other", employeeId: "P-OTHER" });
  const roster = (await admin.get("/api/admin/roster")).data;
  hrId = roster.find((u) => u.employeeId === "P-HR").id;
  otherId = roster.find((u) => u.employeeId === "P-OTHER").id;
  assert.equal((await admin.put("/api/admin/employees/" + hrId, { adminRoleId: role.data.role.id })).status, 200);
  hr = await loginAs(srv.base, { employeeId: "P-HR", password: made.password });
  await hr.post("/api/auth/change-password", { currentPassword: made.password, newPassword: "p-hr-pass-1a" });
});
after(async () => { if (srv) await srv.stopAsync(); });

const perf = { type: "performance", date: "2026-09-30", fields: { period: "2026-Q3", rating: "A+" } };

test("CX-168: an HR user cannot add a performance record for themselves; for someone else it works", async () => {
  const self = await hr.post("/api/admin/employees/" + hrId + "/records", perf);
  assert.equal(self.status, 403, JSON.stringify(self.data));
  assert.equal(self.data.code, "rating_self_amend");
  assert.ok(self.data.error_zh && !/[一-鿿]/.test(self.data.error), "CX-174: English and Chinese are separate");
  const other = await hr.post("/api/admin/employees/" + otherId + "/records", perf);
  assert.equal(other.status, 200, JSON.stringify(other.data));
});

test("CX-168: an HR user cannot delete their own performance record (created by the super admin)", async () => {
  const mine = await admin.post("/api/admin/employees/" + hrId + "/records", { ...perf, fields: { period: "2026-Q2", rating: "B" } });
  assert.equal(mine.status, 200, JSON.stringify(mine.data));
  const id = (mine.data.record || mine.data).id;
  assert.ok(id, JSON.stringify(mine.data));
  const del = await hr.del("/api/admin/records/" + id);
  assert.equal(del.status, 403, JSON.stringify(del.data));
  assert.equal(del.data.code, "rating_self_amend");
  assert.equal((await admin.del("/api/admin/records/" + id)).status, 200, "the super admin still can");
});
