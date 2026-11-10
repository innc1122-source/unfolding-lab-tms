// 2026-10-09 上线验收 第 3 批（P3 + 一致性整改基础层）+ 第 2 批复测未过项的修正。docs/HANDOFF-DEV-UAT-20261009.md 第三、四节。
//   CX-003（复测修正）成绩详情的 retake 按本次答卷的考试单独算，不再被课程整体 done 短路；
//   CX-018（复测修正）withPositions=1 也带 vacancies / keyRoleCount；CX-019 重名 409 带清单里已有的名字（existing）；
//   CX-041 反向代理 https 的会话 cookie 带 Secure；CX-042 课程编辑乐观锁（updatedAt 不一致 409 stale）；
//   其余（CX-011/015/020/021/022/030/031/037/040/044、一致性 1–3 基础层、CX-017 卡片）做源码静态核对。
"use strict";
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { ADMIN, EMPLOYEE, startServer, loginAs, completeAllModules } = require("./helpers.js");

const ROOT = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
let srv, admin, emp;

before(async () => {
  srv = await startServer();
  admin = await loginAs(srv.base, ADMIN);
  emp = await loginAs(srv.base, EMPLOYEE);
});
after(async () => { if (srv) await srv.stopAsync(); });

test("CX-003 (round 2): retake is computed for the attempt's own exam — present even when learnStatus is done / no retake pick", async () => {
  await completeAllModules(emp, "nho");
  const start = await emp.post("/api/exam/start", { examId: "exam-nho" });
  assert.equal(start.status, 200);
  assert.equal((await emp.post(`/api/exam/${start.data.attemptId}/submit`, { answers: {} })).status, 200);
  const a = (await emp.get(`/api/me/attempts/${start.data.attemptId}`)).data;
  assert.ok(a.retake && a.retake.examId === "exam-nho", JSON.stringify(a.retake));
  assert.equal(a.retake.state, "ready", "unlimited attempts, no cooldown → ready");
  assert.equal(a.retake.attemptsLeft, null);
  // 服务端：按考试单独算的 helper 存在；learnerExamState 的 done 短路不再影响成绩详情
  const src = require("./helpers.js").serverSource();   // server.js + modules/*/routes.js
  assert.ok(src.includes("function examRetakeState(userId, e)") && src.includes("retake: exam ? examRetakeState(user.id, exam)"), "attempt detail uses examRetakeState");
});

test("CX-018 (round 2): the succession tab payload (withPositions=1) carries vacancies and keyRoleCount; vacant positions are marked", async () => {
  const d = (await admin.get("/api/admin/succession?withPositions=1&vacancies=1")).data;
  assert.ok(Array.isArray(d.rows) && Array.isArray(d.positions), "object shape kept");
  assert.ok(Array.isArray(d.vacancies), "vacancies present");
  assert.equal(typeof d.keyRoleCount, "number");
  assert.ok(["keyPositions", "inferred"].includes(d.source));
  const tr = read("web/src/pages/admin/TalentReview.jsx");
  assert.ok(tr.includes("s.succVacant") && tr.includes("q.data.vacancies.some((v) => v.positionName === p)"), "vacant tag per group");
  assert.ok(tr.includes("if (!g.has(v.positionName)) g.set(v.positionName, [])"), "vacancies from the key-position list appear as empty groups");
});

test("CX-019: a duplicate key position reports the name already on the list (existing), not the typed one", async () => {
  const dep = await admin.post("/api/admin/departments", { name: "UAT KP Dept" });
  assert.equal(dep.status, 200, JSON.stringify(dep.data));
  const deptId = dep.data.department.id;
  const r1 = await admin.post("/api/admin/key-positions", { name: "UAT Treasury Lead", deptId, note: "p3" });
  assert.equal(r1.status, 200, JSON.stringify(r1.data));
  const r2 = await admin.post("/api/admin/key-positions", { name: "uat-treasury-lead", deptId });
  assert.equal(r2.status, 409);
  assert.equal(r2.data.code, "position_exists");
  assert.equal(r2.data.existing, "UAT Treasury Lead");
  assert.ok(read("web/src/pages/admin/KeyPositions.jsx").includes("s.existsBody(d.existing ||"), "the dialog quotes the existing name");
});

test("CX-041: the session cookie gets Secure behind an https reverse proxy (x-forwarded-proto), not on plain http", async () => {
  const login = (headers) => fetch(srv.base + "/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify({ employeeId: ADMIN.employeeId, password: ADMIN.password }) });
  const plain = await login({});
  assert.equal(plain.status, 200);
  assert.doesNotMatch(plain.headers.get("set-cookie") || "", /Secure/i, "plain http: no Secure (local dev)");
  const proxied = await login({ "x-forwarded-proto": "https" });
  assert.equal(proxied.status, 200);
  assert.match(proxied.headers.get("set-cookie") || "", /;\s*Secure/i, "https via proxy: Secure");
  assert.match(proxied.headers.get("set-cookie") || "", /HttpOnly/i);
});

test("CX-042: course edits carry updatedAt; a stale one is refused with 409 stale, a fresh one saves and returns the new updatedAt; legacy clients without it still save", async () => {
  const get = async () => (await admin.get("/api/admin/content")).data.courses.find((c) => c.id === "compliance");
  const c0 = await get();
  assert.ok(typeof c0.updatedAt === "string" && c0.updatedAt, "GET carries updatedAt");
  const stripDerived = (c) => { const x = { ...c }; delete x.usedInProjects; delete x.selfCount; delete x.media; return x; };
  // 正常保存：带回读到的 updatedAt → 200 且返回新的 updatedAt
  const r1 = await admin.put("/api/admin/content/courses/compliance", { ...stripDerived(c0), description: "p3 edit 1" });
  assert.equal(r1.status, 200, JSON.stringify(r1.data));
  assert.ok(r1.data.updatedAt && r1.data.updatedAt !== c0.updatedAt, "a new updatedAt comes back");
  // 用旧的 updatedAt 再存（模拟另一个人已改过）→ 409 stale，不覆盖
  const r2 = await admin.put("/api/admin/content/courses/compliance", { ...stripDerived(c0), description: "p3 edit 2 (stale)" });
  assert.equal(r2.status, 409);
  assert.equal(r2.data.code, "stale");
  assert.ok(r2.data.error_zh && r2.data.updatedAt === r1.data.updatedAt);
  assert.equal((await get()).description, "p3 edit 1", "the stale write changed nothing");
  // 带最新的 → 200；不带 updatedAt（旧客户端）→ 200
  const c1 = await get();
  assert.equal((await admin.put("/api/admin/content/courses/compliance", { ...stripDerived(c1), description: "p3 edit 3" })).status, 200);
  const legacy = stripDerived(await get()); delete legacy.updatedAt;
  assert.equal((await admin.put("/api/admin/content/courses/compliance", { ...legacy, description: "p3 edit 4" })).status, 200);
  assert.equal((await get()).description, "p3 edit 4");
  assert.ok(!("updatedAt" in JSON.parse(JSON.stringify((await get()))).modules), "sanity");
  const ed = read("web/src/pages/admin/Content.jsx");
  assert.ok(ed.includes("const REV = new Map()") && ed.includes("REV.set(course.id, r.updatedAt)"), "editor remembers the updatedAt from each save");
});

test("P3 / consistency: front-end changes are in place (static)", async () => {
  const au = read("web/src/pages/admin/Audit.jsx");
  assert.ok(au.includes("if (patchLike && !(k in after)) continue;"), "CX-011: patch payloads don't list before-only keys");
  assert.ok(read("web/src/App.jsx").includes("或你的角色没有访问它的权限"), "CX-015: no-access wording");
  assert.ok(read("web/src/pages/admin/People.jsx").includes("renderCreateItem={(v) => (reservedKeyOf(v)"), "CX-020: reserved tag words get no create option");
  const tfj = read("web/src/pages/admin/talentFilter.js");
  assert.ok(tfj.includes("任一期不低于") && !tfj.includes("至少一期不低于"), "CX-021: wording unified to 任一期");
  assert.ok(read("web/src/pages/admin/TalentFilter.jsx").includes("modeAny: '任一期满足'"), "CX-021: editor mode label");
  const fm = read("modules/talent/filter-model.js");
  assert.ok(fm.includes('kind + " ratings" : "Ratings"') && !fm.includes('${kind ? kind : ""}ratings'), "CX-021: English summary capitalised");
  assert.ok(read("web/src/pages/admin/Projects.jsx").includes("s.membersN(rows.filter((r) => r.state === 'active').length)"), "CX-030: collapsed cohort counts active learners");
  const ct = read("web/src/pages/admin/Content.jsx");
  assert.ok(ct.includes("onAcceptInvalid={() => Toast.error({ content: s.acceptInvalid"), "CX-037: rejected file types get a toast");
  const rt = read("web/src/pages/ReviewTeam.jsx");
  assert.ok(rt.includes("selfOutcomeNoPrev") && rt.includes("prev.length ? s.selfOutcome(i + 1) : s.selfOutcomeNoPrev"), "CX-040: no 'Goal 1' label without previous goals");
  const auth = read("web/src/auth.jsx");
  // 简化 10/11：auth.jsx 不再直接引 Semi；登录与退出各调一次 resetSession()，后台框架登记 Toast.destroyAll
  assert.equal((auth.match(/resetSession\(\);/g) || []).length, 2, "CX-044: toasts cleared on login and logout");
  assert.ok(!auth.includes("@douyinfe/semi"), "auth.jsx stays Semi-free (employee entry bundle)");
  assert.ok(read("web/src/components/AdminLayout.jsx").includes("onSessionReset(() => Toast.destroyAll());"), "CX-044: the console registers the toast cleanup");
  assert.ok(read("web/src/pages/admin/Results.jsx").includes("s.reviewCount(flatDetail.length)"), "review count by sub-question");
  const rc = read("web/src/pages/admin/ReviewCycles.jsx");
  assert.ok(rc.includes("dataIndex: 'name', width: 190") && rc.includes("dataIndex: 'total', width: 320"), "CX-012: wider cycle / progress columns");
  const css = read("web/src/v2.css") + "\n" + read("web/src/admin.css");   // 简化 10/11：后台专用规则拆到 admin.css
  for (const k of ["/* CX-022", "/* CX-031", "一致性整改 1", "一致性整改 2", "/* CX-017 第二轮"]) assert.ok(css.includes(k), k + " appended");
  assert.ok(css.includes(":root{--page-wide:none;--page-read:960px}"), "page width tiers as tokens");
  assert.ok(css.includes(".v2-layout .semi-table-thead>tr>th{word-break:normal"), "DataTable baseline: headers don't break mid-word");
  const fmt = await import(require("url").pathToFileURL(path.join(ROOT, "web", "src", "fmt.js")).href);
  assert.equal(fmt.date("2026-10-09T13:05:00.000Z").length, 10);
  assert.equal(fmt.date("2026-10-09"), "2026-10-09");
  assert.match(fmt.datetime("2026-10-09T13:05:00.000Z"), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  assert.equal(fmt.datetime(""), "");
  const tr = read("web/src/pages/admin/TalentReview.jsx");
  assert.ok(tr.includes("const phone = useMedia('(max-width: 640px)')") && tr.includes('className="trev-drill-cards"'), "CX-017 round 2: cards on phones");
});

// ---------- 验收后一轮（2026-10-10）：CX-039 / 045 / 046 / 014 与 DataTable 包装 ----------
test("post-UAT round: soft over-guide marker, confirm dialogs, save toast, unassigned-HRBP guard, DataTable wrapper (static)", () => {
  const dcal = read("web/src/components/DeptCalibration.jsx");
  assert.ok(dcal.includes("!dc.QUOTA_CAPPED.includes(t) && a !== null && a !== undefined && c > Number(a)") && dcal.includes("{soft && <em>{s.quotaRef}</em>}"), "CX-039: non-capped tiers over the guide get a soft marker, not a block");
  // 员工端包不引 Semi（deptcal-ui）：二次确认是组件内对话框，保存提示是页内 rv-msg
  assert.ok(dcal.includes("setAsking(true)") && dcal.includes("label={s.submitAsk}"), "CX-046: HoD submit asks first");
  assert.ok(dcal.includes("setMsg({ err: false, text: s.saved(n) })") && !dcal.includes("@douyinfe/semi"), "CX-045: save message, no Semi in the employee bundle");
  const rc = read("web/src/pages/admin/ReviewCycles.jsx");
  assert.ok(rc.includes("Modal.confirm({ title: s.confirmAsk(r.dept1 || s.noDept1)"), "CX-046: HR confirm asks first");
  assert.ok(read("web/src/rbac.js").includes("user.appealDesk.eligible) ? null : ADMIN_HOME"), "CX-014: eligible-but-unassigned HRBP is not bounced");
  assert.ok(read("web/src/pages/admin/ReviewAppeals.jsx").includes("listQ.error.status === 404 ? s.noDesk"), "CX-014: page shows the no-coverage banner");
  assert.ok(fs.existsSync(path.join(ROOT, "web", "src", "components", "DataTable.jsx")), "DataTable wrapper exists");
  const css = read("web/src/v2.css") + "\n" + read("web/src/admin.css");   // 简化 10/11：后台专用规则拆到 admin.css
  assert.ok(css.includes(".dcal-tier.over-soft") && css.includes(".dt-table .dt-title"), "styles appended");
});
