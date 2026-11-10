// 培养项目列表改表格（12.1 / F53，2026-10-09）：GET /api/admin/tprojects 每行带
//   startAt（各期次最早开始，yyyy-mm-dd）、endAt（最晚结束）、currentCohort（今天落在起止之间的第几期，1 起；
//   无结束日视为未结束；都不在期内为 null）、ownerName（负责人姓名，服务端带出，不依赖受数据范围限制的花名册）。
// 没有期次 / 期次没写日期时都是 null。原有字段不变。
"use strict";
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { startServer, loginAs, ADMIN } = require("./helpers.js");

let srv, admin;
const cohort = (id, startAt, endAt) => ({ id, name: "Cohort " + id, startAt, endAt, capacity: 10, classes: [],
  phases: [{ id: "ph-" + id, name: "Phase", gateMode: "time", activities: [] }] });
const ymd = (d) => d.toISOString().slice(0, 10);
const day = (n) => ymd(new Date(Date.now() + n * 86400000));

before(async () => { srv = await startServer(); admin = await loginAs(srv.base, ADMIN); });
after(() => srv && srv.stop());

test("列表带起止日期、当前期次与负责人姓名；原字段保留", async () => {
  const id = (await admin.post("/api/admin/tprojects", { title: "List fields", title_zh: "列表字段" })).data.id;
  const put = await admin.put("/api/admin/tprojects/" + id, { status: "running", cohorts: [
    cohort("lf-1", day(-200), day(-100)),       // 已结束
    cohort("lf-2", day(-10), day(30)),          // 今天在期内 → 第 2 期
    cohort("lf-3", day(60), null),              // 未开始
  ] });
  assert.equal(put.status, 200, JSON.stringify(put.data));
  const list = (await admin.get("/api/admin/tprojects")).data;
  const row = list.find((p) => p.id === id);
  assert.ok(row);
  assert.equal(row.startAt, day(-200));
  assert.equal(row.endAt, day(30), "最晚的结束日期（没写结束日的期次不参与）");
  assert.equal(row.currentCohort, 2);
  for (const k of ["id", "code", "title", "status", "ownerId", "cohortCount", "classCount", "memberCount", "progress", "pendingNominations"]) assert.ok(k in row, k);
  assert.equal(row.cohortCount, 3);
  if (row.ownerId) assert.equal(typeof row.ownerName, "string");
  else assert.equal(row.ownerName, null);
});

test("没有期次时日期与当前期次为 null；无结束日的期次今天已开始即为当前期次", async () => {
  const empty = (await admin.post("/api/admin/tprojects", { title: "No cohorts", title_zh: "无期次" })).data.id;
  const open = (await admin.post("/api/admin/tprojects", { title: "Open ended", title_zh: "无结束日" })).data.id;
  assert.equal((await admin.put("/api/admin/tprojects/" + open, { status: "running", cohorts: [cohort("oe-1", day(-5), null)] })).status, 200);
  const list = (await admin.get("/api/admin/tprojects")).data;
  const e = list.find((p) => p.id === empty), o = list.find((p) => p.id === open);
  assert.equal(e.startAt, null); assert.equal(e.endAt, null); assert.equal(e.currentCohort, null);
  assert.equal(o.startAt, day(-5)); assert.equal(o.endAt, null); assert.equal(o.currentCohort, 1);
});
