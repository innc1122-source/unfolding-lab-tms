// 组织绩效（负责人 2026-10-10，迁移 95）：一级部门负责人互评 + 季度组织绩效结果（导入后写进负责人本人的绩效档案）。
//   1. modules/performance/orgperf.js：作答校验、汇总（0 = 不适用不进平均、只算已提交、不带评分部门）；
//   2. 后台：建轮 → 开放（快照一级部门与负责人）→ 进度 / 提醒 / 退回 → 结束 → 导出；
//   3. 员工端：负责人只看到其他部门（不含本部门），草稿、未打完分不能提交、提交后不能改；
//      被评部门看本部门汇总需评分部门 ≥ 3（否则隐藏）；读接口不出现评分人与评分部门（匿名）；
//   4. 季度结果导入：预览标出问题行、坏行不写、写进当时负责人的绩效档案、同季度重导改同一条记录；
//   5. 范围受限的绩效角色只读（写 403 scope_limited）；普通员工看不到「组织互评」视图。
// 真服务 + 一次性库（helpers.startServer），永不碰 lms.db。
"use strict";
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { DatabaseSync } = require("node:sqlite");
const { ADMIN, startServer, loginAs, makeClient } = require("./helpers.js");
const OP = require("../modules/performance/orgperf.js");

test("orgperf.js: answer check, summary excludes 0 and unsubmitted, carries no rater", () => {
  assert.deepEqual(OP.dimKeys(), ["resp", "expert", "process"]);
  assert.equal(OP.checkAnswer({ scores: { resp: 11 } }).code, "bad_score");
  assert.equal(OP.checkAnswer({ scores: { resp: 2.5 } }).code, "bad_score");
  assert.equal(OP.checkAnswer({ scores: { resp: 3 }, issue: "x".repeat(1001) }).code, "issue_too_long");
  assert.equal(OP.checkAnswer({ scores: { resp: 0, expert: 7 } }).complete, false, "every dimension needs a value");
  assert.equal(OP.checkAnswer({ scores: { resp: 0, expert: 7, process: 9 } }).complete, true, "0 = not applicable still counts as answered");
  const targets = [{ dept1Id: "T", dept1: "Target" }];
  const ans = [
    { raterDept1Id: "A", targetDept1Id: "T", scores: { resp: 0, expert: 6, process: 8 }, issue: "b-issue" },
    { raterDept1Id: "B", targetDept1Id: "T", scores: { resp: 4, expert: 8, process: 8 }, issue: "a-issue" },
    { raterDept1Id: "C", targetDept1Id: "T", scores: { resp: 10, expert: 10, process: 10 }, issue: "draft-only" },   // 未提交
    { raterDept1Id: "T", targetDept1Id: "T", scores: { resp: 10, expert: 10, process: 10 } },                       // 自评永不计
  ];
  const [sum] = OP.summarize(targets, ans, ["A", "B", "T"]);
  assert.deepEqual(sum.dims, { resp: { avg: 4, n: 1 }, expert: { avg: 7, n: 2 }, process: { avg: 8, n: 2 } });
  assert.equal(sum.overall, 6.3);
  assert.equal(sum.raters, 2);
  assert.deepEqual(sum.issues, ["a-issue", "b-issue"], "sorted, unsubmitted left out");
  assert.ok(!JSON.stringify(sum).includes('"A"') && !JSON.stringify(sum).includes("raterDept1Id"), "no rating department in the summary");
  assert.equal(OP.bandOf(8).en, "STRONG");
  assert.equal(OP.bandOf(0), null);
});

let srv, admin;
const P = {};   // employeeId → { id, c }
const dept = {};
const dbRead = (fn) => { const d = new DatabaseSync(srv.dbPath, { readOnly: true }); try { return fn(d); } finally { d.close(); } };
async function person(eid, name, department, extra) {
  const r = await admin.post("/api/admin/employees", { name, employeeId: eid, department, jobLevel: "MB2", programIds: [] });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const id = dbRead((d) => d.prepare("SELECT id FROM users WHERE employeeId = ?").get(eid)).id;
  if (extra) assert.equal((await admin.put(`/api/admin/employees/${id}`, extra)).status, 200);
  const c = makeClient(srv.base);
  await c.login({ employeeId: eid, password: r.data.password });
  assert.equal((await c.post("/api/auth/change-password", { currentPassword: r.data.password, newPassword: eid + "-pw-2026" })).status, 200);
  P[eid] = { id, c };
}
const NAMES = { A: "OP Alpha Dept", B: "OP Beta Dept", C: "OP Gamma Dept", D: "OP Delta Dept" };
let RID;
const full = (targets, scoreOf) => Object.fromEntries(targets.map((t) => [t.dept1Id, { scores: scoreOf(t), issue: "Blocker at " + t.dept1 }]));

before(async () => {
  srv = await startServer();
  admin = await loginAs(srv.base, ADMIN);
  for (const [k, n] of Object.entries(NAMES)) {
    await person("OP-HOD-" + k, "Head " + k, n);
    dept[k] = (await admin.get("/api/admin/departments")).data.find((x) => x.name === n).id;
    assert.equal((await admin.put(`/api/admin/departments/${dept[k]}`, { ownerId: P["OP-HOD-" + k].id })).status, 200);
  }
  await person("OP-EMP", "Plain Employee", NAMES.A, { managerId: P["OP-HOD-A"].id });
});
after(async () => { if (srv) await srv.stopAsync(); });

test("admin: create a draft round; quarter format; one non-closed round per quarter; open snapshots heads and notifies them", async () => {
  assert.equal((await admin.post("/api/admin/orgperf/rounds", { quarter: "2026Q3" })).data.code, "bad_quarter");
  const c = await admin.post("/api/admin/orgperf/rounds", { quarter: "2026-Q3", dueOn: "2026-10-31" });
  assert.equal(c.status, 200, JSON.stringify(c.data));
  RID = c.data.round.id;
  assert.equal(c.data.round.status, "draft");
  assert.equal(c.data.round.name, "2026-Q3 一级部门互评");
  assert.equal((await admin.post("/api/admin/orgperf/rounds", { quarter: "2026-Q3" })).data.code, "round_exists");
  // 草稿阶段负责人看不到
  assert.deepEqual((await P["OP-HOD-A"].c.get("/api/me/reviews/orgperf")).data.rounds, []);
  const o = await admin.put(`/api/admin/orgperf/rounds/${RID}`, { action: "open" });
  assert.equal(o.status, 200, JSON.stringify(o.data));
  const r = o.data.round;
  assert.equal(r.status, "open");
  for (const k of Object.keys(NAMES)) {
    const rr = r.raters.find((x) => x.dept1Id === dept[k]);
    assert.ok(rr && rr.raterId === P["OP-HOD-" + k].id && !rr.submittedAt, "head of " + k + " is a rater");
  }
  const notes = (await P["OP-HOD-B"].c.get("/api/me/notifications")).data;
  const list = Array.isArray(notes) ? notes : notes.items || notes.rows || [];
  assert.ok(list.some((n) => n.type === "orgperf.open"), "heads are notified");
  assert.equal((await admin.put(`/api/admin/orgperf/rounds/${RID}`, { action: "open" })).data.code, "not_draft");
  // 空的一级部门（没有在职人员）不进被评名单
  const empty = await admin.post("/api/admin/departments", { name: "OP Empty Dept" });
  assert.equal(empty.status, 200, JSON.stringify(empty.data));
  const r2 = (await admin.get(`/api/admin/orgperf/rounds/${RID}`)).data.round;
  assert.ok(!r2.summary.some((x) => x.dept1 === "OP Empty Dept"), "departments created after opening are not added");
  const c2 = await admin.post("/api/admin/orgperf/rounds", { quarter: "2026-Q2" });
  const o2 = (await admin.put(`/api/admin/orgperf/rounds/${c2.data.round.id}`, { action: "open" })).data.round;
  assert.ok(!o2.summary.some((x) => x.dept1 === "OP Empty Dept"), "an empty department is never a rated target");
  assert.ok(o2.summary.some((x) => x.dept1 === "OP Alpha Dept"));
  assert.equal((await admin.put(`/api/admin/orgperf/rounds/${c2.data.round.id}`, { action: "close" })).status, 200);
});

test("head: sees every other department (not their own); draft save; submit; cannot change after", async () => {
  const me = (await P["OP-HOD-A"].c.get("/api/me/reviews/orgperf")).data;
  assert.equal(me.dims.length, 3);
  const r = me.rounds.find((x) => x.id === RID);
  assert.ok(r, "the open round is listed");
  assert.equal(r.dept1Id, dept.A, "own department identified by the system");
  assert.ok(!r.targets.some((t) => t.dept1Id === dept.A), "own department is not in the list");
  for (const k of ["B", "C", "D"]) assert.ok(r.targets.some((t) => t.dept1Id === dept[k]));
  // 草稿：只填一个部门
  const one = await P["OP-HOD-A"].c.put(`/api/me/reviews/orgperf/rounds/${RID}`, { answers: { [dept.B]: { scores: { resp: 8, expert: 7, process: 6 }, issue: "slow approvals" } } });
  assert.equal(one.status, 200, JSON.stringify(one.data));
  assert.deepEqual((await P["OP-HOD-A"].c.get("/api/me/reviews/orgperf")).data.rounds.find((x) => x.id === RID).answers[dept.B].scores, { resp: 8, expert: 7, process: 6 });
  assert.equal((await P["OP-HOD-A"].c.put(`/api/me/reviews/orgperf/rounds/${RID}`, { answers: { [dept.A]: { scores: { resp: 9 } } } })).data.code, "bad_target", "cannot rate own department");
  assert.equal((await P["OP-HOD-A"].c.put(`/api/me/reviews/orgperf/rounds/${RID}`, { answers: { [dept.B]: { scores: { resp: 12 } } } })).data.code, "bad_score");
  // A：给 D 的 resp 打 0（不适用）
  const ok = await P["OP-HOD-A"].c.put(`/api/me/reviews/orgperf/rounds/${RID}`, { submit: true, answers: full(r.targets, (t) => (t.dept1Id === dept.D ? { resp: 0, expert: 6, process: 8 } : { resp: 8, expert: 7, process: 6 })) });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.equal((await P["OP-HOD-A"].c.put(`/api/me/reviews/orgperf/rounds/${RID}`, { answers: { [dept.B]: { scores: { resp: 1, expert: 1, process: 1 } } } })).data.code, "submitted");
  // B、C 提交；D 不提交
  for (const k of ["B", "C"]) {
    const t = (await P["OP-HOD-" + k].c.get("/api/me/reviews/orgperf")).data.rounds.find((x) => x.id === RID).targets;
    assert.equal((await P["OP-HOD-" + k].c.put(`/api/me/reviews/orgperf/rounds/${RID}`, { submit: true, answers: full(t, () => ({ resp: 4, expert: 8, process: 8 })) })).status, 200);
  }
});

test("admin: progress, anonymous summary (no rater per answer), remind the rest, return one, export", async () => {
  const d = (await admin.get(`/api/admin/orgperf/rounds/${RID}`)).data.round;
  assert.ok(d.submittedCount >= 3);
  const sD = d.summary.find((x) => x.dept1Id === dept.D);
  assert.deepEqual(sD.dims.resp, { avg: 4, n: 2 }, "A's 0 for D's responsiveness is left out");
  assert.deepEqual(sD.dims.expert, { avg: 7.3, n: 3 });
  assert.equal(sD.raters, 3);
  assert.equal(sD.issues.length, 3);
  const sA = d.summary.find((x) => x.dept1Id === dept.A);
  assert.equal(sA.raters, 2, "only B and C rated A");
  for (const x of d.summary) assert.ok(!("raterDept1Id" in x) && !("raterId" in x), "summary rows never name raters");
  const json = JSON.stringify(d.summary);
  for (const k of Object.keys(NAMES)) assert.ok(!json.includes(P["OP-HOD-" + k].id), "no rater id inside the summary");
  // CX-217：开放后 1 小时内催办全部跳过（开放时已通知）；把开放时间挪到 2 小时前再催办
  const early = await admin.post(`/api/admin/orgperf/rounds/${RID}/remind`, {});
  assert.deepEqual([early.status, early.data.reminded], [200, 0], "right after opening: everyone was just notified");
  assert.ok(early.data.skipped >= 1);
  { const w = new DatabaseSync(srv.dbPath); try { w.prepare("UPDATE orgperf_rounds SET openedAt = ? WHERE id = ?").run(new Date(Date.now() - 2 * 3600e3).toISOString(), RID); } finally { w.close(); } }
  const rem = await admin.post(`/api/admin/orgperf/rounds/${RID}/remind`, {});
  assert.equal(rem.status, 200);
  assert.ok(rem.data.reminded >= 1, "D (and any seeded department head) is reminded");
  const again = await admin.post(`/api/admin/orgperf/rounds/${RID}/remind`, {});
  assert.deepEqual([again.data.reminded, again.data.skipped >= 1], [0, true], "CX-178: reminded within the hour are skipped");
  assert.ok(((await P["OP-HOD-D"].c.get("/api/me/notifications")).data.items || (await P["OP-HOD-D"].c.get("/api/me/notifications")).data).some((n) => n.type === "orgperf.remind"));
  // 退回 C → C 可以再改
  assert.equal((await admin.post(`/api/admin/orgperf/rounds/${RID}/return`, { dept1Id: dept.D })).data.code, "not_submitted");
  assert.equal((await admin.post(`/api/admin/orgperf/rounds/${RID}/return`, { dept1Id: dept.C })).status, 200);
  const t = (await P["OP-HOD-C"].c.get("/api/me/reviews/orgperf")).data.rounds.find((x) => x.id === RID);
  assert.equal(t.submittedAt, null);
  assert.equal((await P["OP-HOD-C"].c.put(`/api/me/reviews/orgperf/rounds/${RID}`, { submit: true, answers: full(t.targets, () => ({ resp: 5, expert: 8, process: 8 })) })).status, 200);
  const csv = await admin.raw("GET", `/api/admin/orgperf/rounds/${RID}/export.csv`);
  assert.equal(csv.status, 200);
  const text = await csv.text();
  assert.match(text, /Quarter 季度,Department 部门,Raters 评价人数,Responsiveness & Agility 响应与敏捷度/);   // CX-180：双语表头
  assert.ok(!text.includes("Head A") && !text.includes("OP-HOD"), "the export names no rater");
});

test("close, then HR publishes; the rated head sees their department's scores only after publishing (no 3-department threshold), blockers anonymous", async () => {
  assert.equal((await admin.put(`/api/admin/orgperf/rounds/${RID}`, { action: "publish" })).data.code, "not_closed", "cannot publish an open round");
  assert.equal((await admin.put(`/api/admin/orgperf/rounds/${RID}`, { action: "close" })).data.round.status, "closed");
  assert.equal((await P["OP-HOD-A"].c.put(`/api/me/reviews/orgperf/rounds/${RID}`, { answers: {} })).data.code, "round_not_open");
  // 结束但未发布：负责人看不到分数，只有「待 HR 发布」
  const before = (await P["OP-HOD-D"].c.get("/api/me/reviews/orgperf")).data.mine.find((m) => m.dept1Id === dept.D);
  assert.equal(before.peer, null);
  assert.equal(before.pending.roundId, RID);
  const pub = await admin.put(`/api/admin/orgperf/rounds/${RID}`, { action: "publish" });
  assert.equal(pub.status, 200);
  assert.ok(pub.data.round.publishedAt);
  assert.equal((await admin.put(`/api/admin/orgperf/rounds/${RID}`, { action: "publish" })).data.code, "already_published");
  const nl = (await P["OP-HOD-D"].c.get("/api/me/notifications")).data;
  assert.ok((nl.items || nl).some((n) => n.type === "orgperf.publish"), "heads are notified on publish");
  const d = (await P["OP-HOD-D"].c.get("/api/me/reviews/orgperf")).data.mine.find((m) => m.dept1Id === dept.D);
  assert.equal(d.pending, null);
  assert.equal(d.peer.raters, 3);
  // 负责人 10/12：发布后只有 2 个部门打分的维度也给平均
  assert.equal(d.peer.dims.resp.n, 2);
  assert.ok(d.peer.dims.resp.avg != null);
  assert.ok(Array.isArray(d.peer.issues) && d.peer.issues.every((x) => typeof x === "string"), "blockers are plain text, no department");
  const a = (await P["OP-HOD-A"].c.get("/api/me/reviews/orgperf")).data.mine.find((m) => m.dept1Id === dept.A);
  assert.ok(!a.peer.hidden && a.peer.raters === 2 && a.peer.overall != null, "A was rated by two departments only, still shown after publishing");
});

test("quarterly results: preview flags bad rows; import writes the head's performance record; re-import updates the same record", async () => {
  const pv = await admin.post("/api/admin/orgperf/results/import", { quarter: "2026-Q3", dryRun: true, rows: [
    { dept: NAMES.A, rating: "A" }, { dept: "No Such Dept", rating: "B" }, { dept: NAMES.B, rating: "Z" }, { dept: NAMES.A, rating: "B" },
  ] });
  assert.equal(pv.status, 200);
  assert.deepEqual(pv.data.rows.map((r) => r.error), [null, "unknown_dept", "bad_rating", "duplicate"]);
  const bad = await admin.post("/api/admin/orgperf/results/import", { quarter: "2026-Q3", rows: [{ dept: "No Such Dept", rating: "B" }] });
  assert.equal(bad.status, 400);
  assert.equal(bad.data.code, "bad_rows");
  assert.deepEqual((await admin.get("/api/admin/orgperf/results?quarter=2026-Q3")).data.rows, [], "nothing written for bad rows");
  const ok = await admin.post("/api/admin/orgperf/results/import", { quarter: "2026-Q3", rows: [{ dept: NAMES.A.toLowerCase(), rating: "a", note: "good quarter" }, { dept: NAMES.B, rating: "B+" }] });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.deepEqual([ok.data.written, ok.data.records], [2, 2]);
  const recs = () => dbRead((d) => d.prepare("SELECT * FROM talent_records WHERE userId = ? AND type = 'performance'").all(P["OP-HOD-A"].id));
  let r = recs();
  assert.equal(r.length, 1);
  assert.equal(r[0].title, "组织绩效 2026-Q3");
  assert.equal(JSON.parse(r[0].detail).rating, "A");
  assert.equal(JSON.parse(r[0].detail).source, "orgperf");
  // 重导同一季度：改同一条记录
  assert.equal((await admin.post("/api/admin/orgperf/results/import", { quarter: "2026-Q3", rows: [{ dept: NAMES.A, rating: "B+" }] })).status, 200);
  r = recs();
  assert.equal(r.length, 1, "same record updated, not duplicated");
  assert.equal(JSON.parse(r[0].detail).rating, "B+");
  const res = (await admin.get("/api/admin/orgperf/results")).data;
  assert.equal(res.quarter, "2026-Q3");
  assert.equal(res.rows.find((x) => x.dept1Id === dept.A).rating, "B+");
  assert.equal(res.rows.find((x) => x.dept1Id === dept.A).hodName, "Head A");
  assert.equal(res.trend.find((x) => x.dept1Id === dept.B).byQuarter["2026-Q3"], "B+");
  // 负责人在员工端看到本部门近 4 季度
  const mine = (await P["OP-HOD-A"].c.get("/api/me/reviews/orgperf")).data.mine.find((m) => m.dept1Id === dept.A);
  assert.deepEqual(mine.results.map((x) => [x.quarter, x.rating]), [["2026-Q3", "B+"]]);
});

test("access: the view shows only for heads; a plain employee gets nothing; scoped roles read only; employees cannot reach admin routes", async () => {
  assert.equal((await P["OP-HOD-A"].c.get("/api/me/reviews")).data.orgView, true);
  assert.equal((await P["OP-EMP"].c.get("/api/me/reviews")).data.orgView, false);
  const e = (await P["OP-EMP"].c.get("/api/me/reviews/orgperf")).data;
  assert.deepEqual([e.rounds, e.mine], [[], []]);
  assert.ok([403, 404].includes((await P["OP-EMP"].c.get("/api/admin/orgperf/rounds")).status));
  const role = await admin.post("/api/admin/roles", { name: "OP Scoped", name_zh: "OP 受限", grants: { performance: "manage", people: "read" }, scope: { departments: [{ id: dept.A, includeChildren: true }] } });
  assert.equal(role.status, 200, JSON.stringify(role.data));
  await person("OP-SCOPED", "Scoped Perf", NAMES.A, { adminRoleId: role.data.role.id });
  const sc = P["OP-SCOPED"].c;
  assert.equal((await sc.get("/api/admin/orgperf/rounds")).status, 200, "scoped roles can view");
  const w = await sc.post("/api/admin/orgperf/rounds", { quarter: "2026-Q4" });
  assert.equal(w.status, 403);
  assert.equal(w.data.code, "scope_limited");
  assert.equal((await sc.post("/api/admin/orgperf/results/import", { quarter: "2026-Q3", rows: [{ dept: NAMES.A, rating: "A" }] })).data.code, "scope_limited");
});

test("QA 32: employee page does not overflow at 390 (rubric scrolls inside its card); submitted date uses the local-day helper", () => {
  const fs2 = require("fs"), path2 = require("path");
  const css = fs2.readFileSync(path2.join(__dirname, "..", "web", "src", "v2.css"), "utf8");
  assert.ok(css.includes(".op-round,.op-mine{overflow:hidden}") && css.includes(".op-rubric-row{min-width:750px}"), "rubric scrolls inside the card");
  const src = fs2.readFileSync(path2.join(__dirname, "..", "web", "src", "pages", "OrgPeerReview.jsx"), "utf8");
  assert.ok(src.includes("const localDay = (iso) => fmtDate(iso);") && !src.includes("String(iso).slice(0, 10)"), "no UTC slicing for dates");
});

// 负责人 10/10 拍板：逐部门一屏 —— 没打分 = 跳过（按不适用，不拦提交、不进平均、不算有效评分部门）；卡点题默认选填，轮次可设必填
test("skip and the blocker switch: unscored departments are skipped; with issueRequired a scored department needs its blocker; the switch only changes before opening", async () => {
  const c = await admin.post("/api/admin/orgperf/rounds", { quarter: "2026-Q1", issueRequired: true });
  assert.equal(c.status, 200, JSON.stringify(c.data));
  const id = c.data.round.id;
  assert.equal(c.data.round.issueRequired, true);
  assert.equal((await admin.put(`/api/admin/orgperf/rounds/${id}`, { issueRequired: false })).data.round.issueRequired, false, "editable in draft");
  assert.equal((await admin.put(`/api/admin/orgperf/rounds/${id}`, { issueRequired: true })).data.round.issueRequired, true);
  assert.equal((await admin.put(`/api/admin/orgperf/rounds/${id}`, { action: "open" })).status, 200);
  assert.equal((await admin.put(`/api/admin/orgperf/rounds/${id}`, { issueRequired: false })).data.code, "not_draft", "locked after opening");
  const me = (await P["OP-HOD-B"].c.get("/api/me/reviews/orgperf")).data.rounds.find((x) => x.id === id);
  assert.equal(me.issueRequired, true);
  // 只给 C 打分、没写卡点 → issue_required；其余部门跳过不拦
  const no = await P["OP-HOD-B"].c.put(`/api/me/reviews/orgperf/rounds/${id}`, { submit: true, answers: { [dept.C]: { scores: { resp: 7 } } } });
  assert.equal(no.status, 400);
  assert.equal(no.data.code, "issue_required");
  assert.deepEqual(no.data.missing.map((x) => x.dept1Id), [dept.C]);
  // 全 0 的部门（D）等同跳过，不要求卡点
  const ok = await P["OP-HOD-B"].c.put(`/api/me/reviews/orgperf/rounds/${id}`, { submit: true, answers: { [dept.C]: { scores: { resp: 7 }, issue: "handoffs" }, [dept.D]: { scores: { resp: 0, expert: 0, process: 0 } } } });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  // 选填的轮次：打了分不写卡点也能提交，没打分的部门全部跳过也能提交
  const c2 = await admin.post("/api/admin/orgperf/rounds", { quarter: "2025-Q4" });
  const id2 = c2.data.round.id;
  assert.equal(c2.data.round.issueRequired, false, "optional by default");
  assert.equal((await admin.put(`/api/admin/orgperf/rounds/${id2}`, { action: "open" })).status, 200);
  assert.equal((await P["OP-HOD-C"].c.put(`/api/me/reviews/orgperf/rounds/${id2}`, { submit: true, answers: { [dept.A]: { scores: { expert: 9 } } } })).status, 200);
  assert.equal((await P["OP-HOD-D"].c.put(`/api/me/reviews/orgperf/rounds/${id2}`, { submit: true })).status, 200, "everything skipped is still a valid submission");
  const sum = (await admin.get(`/api/admin/orgperf/rounds/${id2}`)).data.round.summary;
  const a = sum.find((x) => x.dept1Id === dept.A), b = sum.find((x) => x.dept1Id === dept.B);
  assert.deepEqual([a.raters, a.dims.expert, a.dims.resp], [1, { avg: 9, n: 1 }, { avg: null, n: 0 }], "unscored dimensions are left out");
  assert.equal(b.raters, 0, "skipped departments do not count as rating departments");
  for (const x of [id, id2]) assert.equal((await admin.put(`/api/admin/orgperf/rounds/${x}`, { action: "close" })).status, 200);
  const page = require("fs").readFileSync(require("path").join(__dirname, "..", "web", "src", "pages", "OrgPeerReview.jsx"), "utf8");
  assert.ok(page.includes("s.stepOf(") && page.includes("s.reviewTitle") && !page.includes("@douyinfe/semi"), "one department per screen with a review page, no Semi");
});

// ---------- 上线前代码审查（2026-10-11）回归 ----------
test("code review: score / blocker types are strict", () => {
  assert.equal(OP.checkAnswer({ scores: { resp: true } }).code, "bad_score", "true is not 1");
  assert.equal(OP.checkAnswer({ scores: { resp: [7] } }).code, "bad_score", "[7] is not 7");
  assert.equal(OP.checkAnswer({ scores: { resp: "7" } }).ok, true, "a digit string is fine");
  assert.equal(OP.checkAnswer({ scores: { resp: 7 }, issue: { a: 1 } }).code, "bad_issue", "an object blocker is refused, not stored as [object Object]");
});

test("code review: a head of two departments rates neither; a head with performance access sees their own department's live summary only after 3 rating departments; thin dimensions are hidden on the employee side; submit must be true", async () => {
  const E = "OP Epsilon Dept";
  await person("OP-E1", "Epsilon Member", E);
  dept.E = (await admin.get("/api/admin/departments")).data.find((x) => x.name === E).id;
  assert.equal((await admin.put(`/api/admin/departments/${dept.E}`, { ownerId: P["OP-HOD-A"].id })).status, 200, "Head A now also heads Epsilon");
  const c = await admin.post("/api/admin/orgperf/rounds", { quarter: "2027-Q1" });
  assert.equal(c.status, 200, JSON.stringify(c.data));
  const id = c.data.round.id;
  assert.equal((await admin.put(`/api/admin/orgperf/rounds/${id}`, { action: "open" })).status, 200);
  // 兼任两个部门：两条评分人行，都不含自己负责的两个部门
  const mineA = (await P["OP-HOD-A"].c.get("/api/me/reviews/orgperf")).data.rounds.filter((x) => x.id === id);
  assert.deepEqual(mineA.map((x) => x.dept1Id).sort(), [dept.A, dept.E].sort());
  for (const r of mineA) {
    const t = r.targets.map((x) => x.dept1Id);
    assert.ok(!t.includes(dept.A) && !t.includes(dept.E), "never their own departments");
    assert.ok(Array.isArray(r.dims) && r.dims.length === 3, "each round carries its own dimensions");
  }
  const self = await P["OP-HOD-A"].c.put(`/api/me/reviews/orgperf/rounds/${id}`, { dept1Id: dept.A, answers: { [dept.E]: { scores: { resp: 9 } } } });
  assert.equal(self.data.code, "bad_target", "cannot rate the other department they head");
  // submit 只认 true
  const notReally = await P["OP-HOD-C"].c.put(`/api/me/reviews/orgperf/rounds/${id}`, { submit: "false", answers: { [dept.B]: { scores: { resp: 6, expert: 6 } } } });
  assert.equal(notReally.status, 200);
  assert.equal(notReally.data.submitted, false, 'the string "false" does not submit');
  // B 的负责人有绩效读权限：后台详情里本部门那一行在评分部门不足 3 个时对他隐藏
  const roles = (await admin.get("/api/admin/roles")).data.roles;
  assert.equal((await admin.put(`/api/admin/employees/${P["OP-HOD-B"].id}`, { adminRoleId: roles.find((x) => x.key === "performance-talent-admin").id })).status, 200);
  assert.equal((await P["OP-HOD-A"].c.put(`/api/me/reviews/orgperf/rounds/${id}`, { dept1Id: dept.A, submit: true, answers: { [dept.B]: { scores: { resp: 7, expert: 7 } } } })).status, 200);
  const rowB = async (cl) => (await cl.get(`/api/admin/orgperf/rounds/${id}`)).data.round.summary.find((x) => x.dept1Id === dept.B);
  const early = await rowB(P["OP-HOD-B"].c);
  assert.equal(early.hidden, true, "own department, 1 rating department: hidden from its head");
  assert.deepEqual([early.overall, early.issues, early.dims.resp.avg], [null, [], null]);
  assert.equal((await rowB(admin)).dims.resp.avg, 7, "HR (not a head) still sees it");
  assert.equal((await P["OP-HOD-C"].c.put(`/api/me/reviews/orgperf/rounds/${id}`, { submit: true, answers: { [dept.B]: { scores: { resp: 6, expert: 6 } } } })).status, 200);
  assert.equal((await P["OP-HOD-D"].c.put(`/api/me/reviews/orgperf/rounds/${id}`, { submit: true, answers: { [dept.B]: { scores: { resp: 8, expert: 8, process: 9 } } } })).status, 200);
  const late = await rowB(P["OP-HOD-B"].c);
  assert.ok(!late.hidden && late.raters === 3, "3 rating departments: shown");
  // 员工端（负责人 10/12）：发布后「协作流程优化」只有 1 个部门打分也给平均，并进总平均
  assert.equal((await admin.put(`/api/admin/orgperf/rounds/${id}`, { action: "close" })).status, 200);
  assert.equal((await admin.put(`/api/admin/orgperf/rounds/${id}`, { action: "publish" })).status, 200);
  const peer = (await P["OP-HOD-B"].c.get("/api/me/reviews/orgperf")).data.mine.find((m) => m.dept1Id === dept.B).peer;
  assert.equal(peer.roundId, id);
  assert.deepEqual([peer.dims.resp.avg, peer.dims.process.avg, peer.dims.process.n], [7, 9, 1]);
  assert.equal(peer.overall, 7.7, "overall from all three dimensions");
});

test("code review: re-importing a quarter keeps the departments not in the batch (listed in the preview) and keeps writing to the first head's record", async () => {
  assert.equal((await admin.post("/api/admin/orgperf/results/import", { quarter: "2027-Q1", rows: [{ dept: NAMES.A, rating: "A" }, { dept: NAMES.C, rating: "b+" }] })).status, 200);
  const pv = await admin.post("/api/admin/orgperf/results/import", { quarter: "2027-Q1", dryRun: true, rows: [{ dept: NAMES.C, rating: "B" }] });
  assert.deepEqual(pv.data.kept.map((x) => [x.dept1Id, x.rating]), [[dept.A, "A"]], "A is kept and listed");
  assert.equal(pv.data.rows[0].rating, "B");
  const recOf = (uid) => dbRead((d) => d.prepare("SELECT id, detail FROM talent_records WHERE userId = ? AND type = 'performance' AND title = ?").all(uid, "组织绩效 2027-Q1"));
  assert.equal(JSON.parse(recOf(P["OP-HOD-C"].id)[0].detail).rating, "B+", "lower-case input stored as the option value");
  // C 换了负责人（D）之后重导：仍改写原来那位负责人的记录，不给新负责人另建
  assert.equal((await admin.put(`/api/admin/departments/${dept.C}`, { ownerId: P["OP-HOD-D"].id })).status, 200);
  assert.equal((await admin.post("/api/admin/orgperf/results/import", { quarter: "2027-Q1", rows: [{ dept: NAMES.C, rating: "B" }] })).status, 200);
  assert.equal(recOf(P["OP-HOD-C"].id).length, 1);
  assert.equal(JSON.parse(recOf(P["OP-HOD-C"].id)[0].detail).rating, "B", "the original record is updated");
  assert.equal(recOf(P["OP-HOD-D"].id).length, 0, "no second record for the new head");
  const res = (await admin.get("/api/admin/orgperf/results?quarter=2027-Q1")).data.rows;
  assert.equal(res.find((x) => x.dept1Id === dept.A).rating, "A", "A untouched by the second import");
});
