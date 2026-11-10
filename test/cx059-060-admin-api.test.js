// 上线前测试 CX-059 / CX-060（10/11）：指派接口空请求体回 400；删除不存在的题目回 404 且不写审计
const test = require("node:test");
const assert = require("node:assert/strict");
const { startServer, loginAs, ADMIN } = require("./helpers.js");
let srv, admin;
test.before(async () => { srv = await startServer(); admin = await loginAs(srv.base, ADMIN); });
test.after(() => srv && srv.stop());
test("CX-059: POST /api/admin/assignments with an empty body is a 400, not a 500", async () => {
  const r = await admin.post("/api/admin/assignments", {});
  assert.equal(r.status, 400, JSON.stringify(r.data));
  const r2 = await admin.post("/api/admin/assignments", { userId: "nope", items: [] });
  assert.equal(r2.status, 400);
});
test("CX-060: DELETE a question that does not exist is a 404 and writes no audit row", async () => {
  const before = (await admin.get("/api/admin/audit?action=question.delete")).data;
  const r = await admin.del("/api/admin/questions/q-does-not-exist");
  assert.equal(r.status, 404, JSON.stringify(r.data));
  assert.equal(r.data.code, "not_found");
  const after = (await admin.get("/api/admin/audit?action=question.delete")).data;
  assert.deepEqual(after, before, "no question.delete audit row for a missing question");
});
