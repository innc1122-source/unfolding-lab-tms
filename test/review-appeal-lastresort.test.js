// 第二批 2.8 集成复核（2026-10-08）：回避之后没有任何可处理的 HRBP 与绩效管理员时，超级管理员作为最后处理人
// 解除回避（申诉人本人除外），保证「不会出现无人处理的申诉」；处理人列表带 lastResort。
//   场景：Dept Z 没有 HRBP（走兜底）；内置管理员 P-AD 是直属上级、绩效与人才管理员 P-PT 是其上级兼部门负责人
//   （汇报线回避）；超管在申诉前用 2.6 改过这条评级（此前改过评级回避）→ 三个兜底人都回避 → 超管兜底。
"use strict";
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const W = require("./fixtures/appeal-world.js");

let w, Z;
before(async () => {
  w = await W.bootWorld(new Date("2026-10-09T10:00:00+08:00").toISOString());
  await W.buildAppealWorld(w);
  await w.makeDept("Dept Z", "R Group");
  await w.patch("P-AD", { managerId: w.id("P-PT") });
  await w.person("Z-E", "Zara Appellant", "Dept Z", "P-AD");
  await w.setOwner("Dept Z", "P-PT");
  // 测试库自带第二个超管 DEMO-ADMIN（没有回避，会正常接手）：先停用，场景才是「所有兜底人都回避」
  const off = await w.admin.put("/api/admin/employees/u-demo-admin", { active: false });
  assert.equal(off.status, 200, JSON.stringify(off.data));
  w.managerOf["Z-E"] = "P-AD"; w.unitOf["Z-E"] = "Dept Z";
  Z = await w.runV2Cycle("2026Q3 LastResort", { "Z-E": "B" }, { units: { "Dept Z": "P-PT" } });
});
after(async () => { if (w) await w.stop(); });

test("all fallback handlers conflicted → the super-admin handles the appeal as last resort; the conflicted others still get 404", async () => {
  const prof = (await w.admin.get(`/api/admin/employees/${w.id("Z-E")}/profile`)).data;
  const ev = prof.events.find((e) => e.source === "record" && e.type === "performance" && e.title === "2026Q3 LastResort");
  assert.ok(ev, "archived record");
  const am = await w.admin.put(`/api/admin/records/${ev.id}`, { type: "performance", date: ev.date, title: ev.title, fields: { ...ev.detail, rating: "B+" }, ratingReason: "archive correction" });
  assert.equal(am.status, 200, JSON.stringify(am.data));
  const id = await w.submitOk("Z-E", Z.items["Z-E"]);
  for (const eid of ["P-AD", "P-PT"]) {
    const r = await (await w.as(eid)).get(`/api/admin/review-appeals/${id}`);
    assert.equal(r.status, 404, eid + " is in the reporting line: " + JSON.stringify(r.data));
  }
  const d = (await w.admin.get(`/api/admin/review-appeals/${id}`)).data;
  assert.equal(d.view, "full", "super-admin is the last-resort handler");
  assert.equal(d.appeal.route, "fallback");
  const st = await w.admin.post(`/api/admin/review-appeals/${id}/start`, {});
  assert.equal(st.status, 200, JSON.stringify(st.data));
});
