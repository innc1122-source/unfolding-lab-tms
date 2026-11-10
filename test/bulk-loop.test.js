// bulk-update 循环汇报整批拒绝（2026-09-25 Chelsea 拍板）：单人 PUT 早有 managerCycle，
// 批量改上级之前没有，一批里含 M 的上级链上的人就会形成 A → … → A 的环。
// 现在：只要把选中的人都挂到 M 之下会成环，整批 400 reporting_loop、双语、一行不改；
// 不成环的批次、以及 M 自己在选择里（自挂上级照旧逐个跳过）都照常执行。

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { ADMIN, startServer, loginAs } = require("./helpers.js");

let srv, admin;
const id = {};

before(async () => {
  srv = await startServer();
  admin = await loginAs(srv.base, ADMIN);
  // 汇报链：LOOP-C → LOOP-B → LOOP-A（A 最上级）；LOOP-X 无上级。
  for (const e of ["LOOP-A", "LOOP-B", "LOOP-C", "LOOP-X"]) {
    const r = await admin.post("/api/admin/employees", { name: e, employeeId: e });
    assert.ok(r.status === 200 || r.status === 201, JSON.stringify(r.data));
  }
  const roster = (await admin.get("/api/admin/roster")).data;
  for (const e of ["LOOP-A", "LOOP-B", "LOOP-C", "LOOP-X"]) id[e] = roster.find((u) => u.employeeId === e).id;
  assert.equal((await admin.put("/api/admin/employees/" + id["LOOP-B"], { managerId: id["LOOP-A"] })).status, 200);
  assert.equal((await admin.put("/api/admin/employees/" + id["LOOP-C"], { managerId: id["LOOP-B"] })).status, 200);
});
after(() => srv && srv.stop());

async function managers() {
  const roster = (await admin.get("/api/admin/roster")).data;
  const m = {};
  for (const e of Object.keys(id)) m[e] = roster.find((u) => u.id === id[e]).managerId || null;
  return m;
}

test("把上级链上的人（A）挂到 C 之下 → 整批 400 reporting_loop，双语，一行不改", async () => {
  const beforeM = await managers();
  const r = await admin.post("/api/admin/employees/bulk-update", {
    userIds: [id["LOOP-X"], id["LOOP-A"]], fields: { managerId: id["LOOP-C"] },
  });
  assert.equal(r.status, 400);
  assert.equal(r.data.code, "reporting_loop");
  assert.match(r.data.error, /[一-鿿]/);
  assert.match(r.data.error, /reporting loop/);
  assert.deepEqual(await managers(), beforeM, "整批拒绝 = LOOP-X 也没改");
});

test("不成环的批次照常执行；M 自己在选择里仍按自挂上级逐个跳过", async () => {
  const r = await admin.post("/api/admin/employees/bulk-update", {
    userIds: [id["LOOP-X"], id["LOOP-C"]], fields: { managerId: id["LOOP-C"] },
  });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const m = await managers();
  assert.equal(m["LOOP-X"], id["LOOP-C"]);
  assert.equal(m["LOOP-C"], id["LOOP-B"], "C 不会成为自己的上级");
});
