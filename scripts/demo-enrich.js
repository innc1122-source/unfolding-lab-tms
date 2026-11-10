// demo-enrich.js — 演示库补数据（Unfolding Lab 版，2026-10-12）
//
// make-demo-db.js 直接写库造出组织、课程、旧流程周期与人才记录之后调用本脚本：在演示库上临时起服务，
// 经**真实接口**把新功能的数据跑出来（审计日志、通知随之产生），让测试账号 UL-TEST 的前后台每个页面都有数据。
// 日期都相对生成当天计算，分三个时间点（LMS_FAKE_NOW，非正式模式才生效）：
//   A  约 100 天前：UL-TEST 设为超级管理员；HRBP 角色与分工；前前季度 v2 周期跑到「结果告知」；组织互评一轮（结束 + 发布）；两季度组织绩效结果
//   B  3 天前：上季度 v2 周期跑到「结果告知」（申诉期还剩几个工作日，可以自己测提交申诉）；三条申诉（已答复 / 正在征询 UL-TEST / 待受理）；受控标签；关键岗位与继任人
//   B2 2 天前：发起本季度 v2 周期（自评截止日 = 昨天），多数人按时提交自评（工作台「评估按时完成率」有数）
//   C  现在：本季度上级评级与部门校准进行中（UL-TEST 有待评下属、待提交的部门校准）；公开课 3 门与自主学习；发展项目报名 2 条；两位试用期员工转正；组织互评进行中（UL-TEST 未填）；两个发展项目
//          （UL-TEST 是 A 班班主任、两项活动的讲师，也是另一个项目的学员）
//
// 用法：runtime\node.exe scripts\demo-enrich.js <演示库路径>   （make-demo-db.js 自动调用；正式模式下拒绝运行）
"use strict";
const { spawn } = require("child_process");
const fs = require("fs");
const net = require("net");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const DB = path.resolve(process.argv[2] || process.env.LMS_DB_PATH || "");
const CONFIG = process.env.LMS_CONFIG_PATH || path.join(ROOT, "config.demo.json");
const PW = "Demo1234";
const ADMIN = { employeeId: "ADMIN", password: "unfolding888" };
const TEST_ID = "UL-TEST";
const QUOTA = { "A+": 5, A: 15, "B+": 30, B: 40, "C/D": 10 };   // 演示周期的名额（发起周期时可改；默认值偏紧，10 人部门给不出 A）

if (!DB || !fs.existsSync(DB)) { console.error("用法: runtime\\node.exe scripts\\demo-enrich.js <演示库路径>"); process.exit(1); }
try { if (process.env.LMS_PROD === "1" || JSON.parse(fs.readFileSync(CONFIG, "utf8")).production) { console.error("正式模式，拒绝补演示数据。"); process.exit(1); } } catch {}

// ---------- 时间 ----------
const DAY = 86400000;
const NOW = Date.now();
const pad = (n) => String(n).padStart(2, "0");
const ymd = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const qtr = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-Q${Math.floor(d.getMonth() / 3) + 1}`; };
const fakeAt = (ms) => `${ymd(ms)}T10:00:00+08:00`;
const T_A = NOW - 100 * DAY, T_B = NOW - 3 * DAY, T_B2 = NOW - 2 * DAY;
const Q_PREV2 = qtr(NOW - 182 * DAY), Q_PREV = qtr(NOW - 91 * DAY), Q_NOW = qtr(NOW), Q_PREV3 = qtr(NOW - 273 * DAY);

// ---------- 可复现的随机数 ----------
let seed = 20261012;
const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const pick = (a) => a[Math.floor(rand() * a.length)];
const shuffled = (a) => { const b = a.slice(); for (let i = b.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [b[i], b[j]] = [b[j], b[i]]; } return b; };

// ---------- 服务与客户端 ----------
function freePort() { return new Promise((res) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); }); }); }
async function boot(fakeNow) {
  const port = await freePort();
  const env = { ...process.env, PORT: String(port), LMS_DB_PATH: DB, LMS_CONFIG_PATH: CONFIG, LMS_DISABLE_AI: "1", LMS_DISABLE_OFFICE_CONVERT: "1", LMS_DISABLE_VIDEO_TRANSCODE: "1", LMS_NO_DEMO_USERS: "1" };
  if (fakeNow) env.LMS_FAKE_NOW = fakeNow; else delete env.LMS_FAKE_NOW;
  const child = spawn(process.execPath, [path.join(ROOT, "server.js")], { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  child.stdout.on("data", (b) => { log += b; }); child.stderr.on("data", (b) => { log += b; });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 150; i++) {
    if (child.exitCode !== null) throw new Error("服务启动失败:\n" + log.slice(-2000));
    try { const r = await fetch(base + "/api/env"); if (r.ok) return { base, stop: () => new Promise((res) => { child.once("exit", res); child.kill(); }) }; } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  child.kill();
  throw new Error("服务启动超时:\n" + log.slice(-2000));
}
function client(base) {
  let sid = null;
  async function call(method, p, body) {
    const res = await fetch(base + p, { method, headers: { "content-type": "application/json", ...(sid ? { cookie: "sid=" + sid } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    for (const c of res.headers.getSetCookie()) { const m = c.match(/^sid=([^;]*)/); if (m) sid = m[1] || null; }
    let data = null; try { data = await res.json(); } catch {}
    return { status: res.status, data };
  }
  return { get: (p) => call("GET", p), post: (p, b) => call("POST", p, b ?? {}), put: (p, b) => call("PUT", p, b ?? {}) };
}
function ok(r, what, codes = [200, 201]) {
  if (!codes.includes(r.status)) throw new Error(`${what} → HTTP ${r.status} ${JSON.stringify(r.data).slice(0, 400)}`);
  return r.data;
}

// ---------- 一次服务上的会话 ----------
class Session {
  constructor(srv) { this.srv = srv; this.cache = new Map(); }
  async as(employeeId) {
    if (this.cache.has(employeeId)) return this.cache.get(employeeId);
    const c = client(this.srv.base);
    ok(await c.post("/api/auth/login", employeeId === "ADMIN" ? ADMIN : { employeeId, password: PW }), "登录 " + employeeId);
    this.cache.set(employeeId, c);
    return c;
  }
}

// ---------- 业务数据 ----------
const SELF_OUTCOMES = ["季度关键指标达成 105%，核心项目按期交付。", "完成两个跨部门专项，风险问题闭环处理。", "主要目标基本达成，其中一项因外部依赖顺延。", "支撑三个新流程上线，缺陷率低于目标。"];
const SELF_CHALLENGES = ["跨部门排期冲突较多，沟通成本高。", "人手紧张，部分事项只能降级处理。", "新系统切换期间数据口径需要反复核对。"];
const SELF_FEEDBACK = ["希望获得更多跨部门项目机会。", "希望在职业发展路径上得到更明确的指引。", "资源支持基本到位，希望保持双周同步节奏。"];
const GOALS = ["提升跨部门协作效率，关键接口沉淀成文档", "完成一次完整的业务复盘并输出改进清单", "把日常事务自动化，释放 20% 时间投入重点项目", "带教 1 名新人独立上手核心流程", "客户满意度提升 3 个百分点"];
const MGR_TEXT = { A: "目标完成扎实，质量稳定，主动补位带动团队。", "B+": "达成符合预期，个别环节的主动性还可以再进一步。", B: "基本达成目标，细节质量与节奏管理有提升空间。", C: "部分目标未达成，已约定改进计划并按月跟进。" };
const selfBody = () => ({ outcomes: shuffled(SELF_OUTCOMES).slice(0, 2), challenges: pick(SELF_CHALLENGES), feedback: pick(SELF_FEEDBACK), goalsNext: shuffled(GOALS).slice(0, 2) });
// 按演示名额给一个部门分评级：1 个 A、最多 2 个 B+、1 个 C，其余 B（都在上限档之内）
function ratingsFor(people, fixed) {
  const n = people.length, out = {};
  const capA = Math.floor((n * QUOTA.A) / 100), capBp = Math.floor((n * QUOTA["B+"]) / 100);
  let a = 0, bp = 0, c = 0;
  for (const p of people) if (fixed && fixed[p.employeeId]) { out[p.employeeId] = fixed[p.employeeId]; if (fixed[p.employeeId] === "A") a++; if (fixed[p.employeeId] === "B+") bp++; if (fixed[p.employeeId] === "C") c++; }
  for (const p of shuffled(people.filter((x) => !out[x.employeeId]))) {
    if (a < Math.min(1, capA)) { out[p.employeeId] = "A"; a++; }
    else if (bp < Math.min(2, capBp)) { out[p.employeeId] = "B+"; bp++; }
    else if (c < 1 && n >= 5) { out[p.employeeId] = "C"; c++; }
    else out[p.employeeId] = "B";
  }
  return out;
}
const highlightsFor = (r) => (["A+", "A", "C", "D"].includes(r) ? (r === "C" || r === "D" ? "两项关键目标未达成，已约定改进计划与月度检查点。" : "牵头完成跨部门专项，提前两周交付并沉淀了可复用的流程。") : "");

async function main() {
  console.log("⑧ 经接口补齐新功能数据（v2 绩效、申诉、组织绩效、发展项目、关键岗位）…");
  // ===== A：约 100 天前 =====
  let srv = await boot(fakeAt(T_A));
  let S = new Session(srv);
  let admin = await S.as("ADMIN");
  const roster = ok(await admin.get("/api/admin/roster"), "花名册");
  const depts = ok(await admin.get("/api/admin/departments"), "部门");
  const deptByName = new Map(depts.map((d) => [d.name, d]));
  const byEid = new Map(roster.map((u) => [u.employeeId, u]));
  const TEST = byEid.get(TEST_ID);
  if (!TEST) throw new Error("找不到测试账号 " + TEST_ID);
  const owners = depts.filter((d) => d.ownerId);   // 9 个一级部门，负责人 = 总监
  const headOfDept = new Map(owners.map((d) => [d.name, roster.find((u) => u.id === d.ownerId)]));
  const headIds = new Set(owners.map((d) => d.ownerId));
  const gm = roster.find((u) => u.department === "总经办");
  const staff = roster.filter((u) => u.role !== "admin" && !headIds.has(u.id) && (!gm || u.id !== gm.id) && u.employeeId !== "ADMIN");
  const hrbp = staff.find((u) => u.department === "人力资源部" && u.position === "HRBP");
  if (!hrbp) throw new Error("人力资源部没有岗位为 HRBP 的员工");
  const deptOf = (u) => u.department;
  const hiredBefore = (u, ms) => !u.hireDate || u.hireDate <= ymd(ms);

  // 权限：UL-TEST = 超级管理员；HRBP 角色（人员管理）给 HRBP 员工，并负责全部一级部门的申诉
  const roles = ok(await admin.get("/api/admin/roles"), "角色").roles;
  const superRole = roles.find((r) => r.key === "super-admin");
  ok(await admin.put(`/api/admin/employees/${TEST.id}`, { adminRoleId: superRole.id }), "UL-TEST 设为超级管理员");
  const hrbpRole = ok(await admin.post("/api/admin/roles", { name: "HRBP", name_zh: "HRBP", grants: { people: "manage" } }), "新建 HRBP 角色").role;
  ok(await admin.put(`/api/admin/employees/${hrbp.id}`, { adminRoleId: hrbpRole.id }), "HRBP 角色");
  for (const d of [...owners, deptByName.get("总经办")].filter(Boolean)) ok(await admin.put("/api/admin/review-appeals/coverage", { deptId: d.id, userIds: [hrbp.id] }), "HRBP 分工 " + d.name);

  // v2 周期：自评 → 上级评级 → HoD 提交 → HR 确认 → 关闭 → 结果告知
  async function runClosedCycle(label, at, fixed) {
    const people = staff.filter((u) => hiredBefore(u, at - 30 * DAY));
    const c = ok(await admin.post("/api/admin/review-cycles", { name: label, flow: "v2", kind: "quarter", dueAt: ymd(at + 7 * DAY), dueRateAt: ymd(at + 14 * DAY), dueCalibAt: ymd(at + 21 * DAY), userIds: people.map((u) => u.id), quota: QUOTA }), "发起 " + label);
    const id = c.cycle.id;
    const items = new Map(ok(await admin.get(`/api/admin/review-cycles/${id}`), "周期详情").items.map((i) => [i.employeeId, i.id]));
    for (const [dName, head] of headOfDept) {
      const team = people.filter((u) => deptOf(u) === dName && items.has(u.employeeId));
      const ratings = ratingsFor(team, fixed);
      for (const u of team) {
        ok(await (await S.as(u.employeeId)).post(`/api/me/reviews/${items.get(u.employeeId)}/self`, selfBody()), "自评 " + u.employeeId);
        const r = ratings[u.employeeId];
        ok(await (await S.as(head.employeeId)).post(`/api/me/reviews/${items.get(u.employeeId)}/manager`, { rating: r, text: MGR_TEXT[r] || MGR_TEXT.B, highlights: highlightsFor(r) }), "评级 " + u.employeeId);
        if (rand() < 0.8) {   // 1 对 1 面谈：员工与上级各自登记
          ok(await (await S.as(u.employeeId)).post(`/api/me/reviews/${items.get(u.employeeId)}/one-on-one`, { done: true }), "面谈登记 " + u.employeeId);
          ok(await (await S.as(head.employeeId)).post(`/api/me/reviews/${items.get(u.employeeId)}/one-on-one`, { done: true }), "上级面谈登记 " + u.employeeId);
        }
      }
      if (!team.length) continue;
      const dept = deptByName.get(dName);
      ok(await (await S.as(head.employeeId)).post("/api/me/reviews/hod/submit", { cycleId: id, dept1Id: dept.id }), "HoD 提交 " + dName);
      ok(await admin.post(`/api/admin/review-cycles/${id}/depts/${dept.id}/confirm`, {}), "HR 确认 " + dName);
    }
    ok(await admin.post(`/api/admin/review-cycles/${id}/close`, {}), "关闭 " + label);
    const cm = await admin.post(`/api/admin/review-cycles/${id}/communicate`, {});   // 关闭时已自动告知的会回 409 results_communicated
    if (!(cm.status === 200 || (cm.status === 409 && cm.data && cm.data.code === "results_communicated"))) ok(cm, "结果告知 " + label);
    console.log(`   + ${label}：${people.length} 人，已关闭并告知结果`);
    return { id, items };
  }
  // UL-TEST 团队里一位员工连续两期 C（团队评估的看板「需要关注」有人）
  const hrWatch = staff.find((u) => u.department === "人力资源部" && u.id !== hrbp.id && hiredBefore(u, T_A - 30 * DAY));
  await runClosedCycle(`${Q_PREV2} 季度绩效评估`, T_A, hrWatch ? { [hrWatch.employeeId]: "C" } : null);

  // 组织互评：开轮 → 9 位负责人作答提交 → 结束 → 发布
  async function orgRound(quarter, dueMs, submitters, close) {
    const r = ok(await admin.post("/api/admin/orgperf/rounds", { quarter, dueOn: ymd(dueMs) }), "建互评 " + quarter);
    const rid = (r.round || r).id;
    ok(await admin.put(`/api/admin/orgperf/rounds/${rid}`, { action: "open" }), "开放互评 " + quarter);
    for (const head of submitters) {
      const c = await S.as(head.employeeId);
      const mine = ok(await c.get("/api/me/reviews/orgperf"), "互评数据").rounds.filter((x) => x.id === rid);
      for (const rd of mine) {
        const keys = (rd.dims || []).map((d) => d.key);
        const answers = {};
        for (const t of rd.targets) {
          if (rand() < 0.15) continue;   // 不熟悉的部门跳过（不适用）
          const scores = {};
          for (const k of keys) scores[k] = rand() < 0.08 ? 0 : 5 + Math.floor(rand() * 5);
          answers[t.dept1Id] = { scores, issue: rand() < 0.4 ? pick(["需求变更后同步不及时，常在临近交付才知道。", "审批节点多，跨部门事项平均要等 3 天。", "接口人变动频繁，交接信息不完整。", "数据口径与我方不一致，每月要人工对账。"]) : "" };
        }
        ok(await c.put(`/api/me/reviews/orgperf/rounds/${rid}`, { dept1Id: rd.dept1Id, answers, submit: true }), "互评提交 " + head.employeeId);
      }
    }
    if (close) {
      ok(await admin.put(`/api/admin/orgperf/rounds/${rid}`, { action: "close" }), "结束互评 " + quarter);
      ok(await admin.put(`/api/admin/orgperf/rounds/${rid}`, { action: "publish" }), "发布互评结果 " + quarter);
    }
    return rid;
  }
  await orgRound(Q_PREV2, T_A + 10 * DAY, [...headOfDept.values()], true);
  console.log(`   + 组织互评 ${Q_PREV2}：9 位负责人提交，已结束并发布`);
  for (const [q, scale] of [[Q_PREV3, ["A", "B+", "B", "B+", "B", "C", "B", "B+", "B"]], [Q_PREV2, ["B+", "A", "B", "B", "B+", "B", "B+", "B", "C"]]]) {
    const rows = owners.map((d, i) => ({ dept: d.name, rating: scale[i % scale.length], note: "季度组织绩效评定" }));
    ok(await admin.post("/api/admin/orgperf/results/import", { quarter: q, rows }), "导入组织绩效结果 " + q);
  }
  console.log(`   + 组织绩效季度结果：${Q_PREV3}、${Q_PREV2}`);
  await srv.stop();

  // ===== B：3 天前 =====
  srv = await boot(fakeAt(T_B));
  S = new Session(srv);
  admin = await S.as("ADMIN");
  const improver = staff.find((u) => u.name === "Ramil Dizon");
  const hrAppellant = staff.find((u) => u.department === "人力资源部" && u.id !== hrbp.id && u !== hrWatch && hiredBefore(u, T_B - 30 * DAY));
  const techAppellant = staff.find((u) => u.department === "技术部" && hiredBefore(u, T_B - 30 * DAY));
  const fixed = {};
  if (improver) fixed[improver.employeeId] = "C";
  if (hrAppellant) fixed[hrAppellant.employeeId] = "B";
  if (hrWatch) fixed[hrWatch.employeeId] = "C";
  const prev = await runClosedCycle(`${Q_PREV} 季度绩效评估`, T_B, fixed);

  // 申诉：已答复 / 正在征询 UL-TEST / 待受理
  const REASONS = {
    rating_mismatch: "本季度我负责的两项流程优化都已上线并带来可量化的效率提升，评级没有体现这部分工作。我整理了上线前后的处理时长对比数据，作为附件说明，希望重新评估本季度评级。",
    process: "本季度没有进行 1 对 1 面谈，评级结果出来之前我不知道上级对哪些方面不满意，希望补充说明评估依据，并在下季度开始前约一次面谈，明确改进方向与衡量标准。",
    calibration: "上级沟通时给出的是 B+，部门校准后调整为 B，想了解校准的依据、名额对我评级的影响，以及下季度要达到 B+ 需要在哪些方面改进。",
  };
  const hb = await S.as(hrbp.employeeId);
  async function appeal(u, category) {
    const r = ok(await (await S.as(u.employeeId)).post(`/api/me/reviews/${prev.items.get(u.employeeId)}/appeal`, { reason: REASONS[category], category }), "申诉 " + u.employeeId);
    return r.appeal.id;
  }
  if (improver) {
    const id = await appeal(improver, "rating_mismatch");
    ok(await hb.post(`/api/admin/review-appeals/${id}/start`, {}), "受理申诉");
    ok(await hb.post(`/api/admin/review-appeals/${id}/decide`, { outcome: "maintain", reply: "经核对季度目标与交付记录，两项流程优化已计入评估，但核心指标未达成，维持原评级 C；下季度按改进计划每月跟进。", expectRating: "C" }), "答复申诉");
  }
  if (hrAppellant) {
    const id = await appeal(hrAppellant, "process");
    ok(await hb.post(`/api/admin/review-appeals/${id}/start`, {}), "受理申诉");
    ok(await hb.post(`/api/admin/review-appeals/${id}/consult`, { consulteeId: TEST.id, question: "员工反映本季度未进行 1 对 1 面谈，请说明面谈安排与评级依据。" }), "征询 UL-TEST");
  }
  if (techAppellant) await appeal(techAppellant, "calibration");
  console.log("   + 申诉 3 条：已答复 1、正在征询 UL-TEST 1、待受理 1");

  // 受控标签（高潜 / 关键人才 / 流失风险）
  const tagged = shuffled(staff.filter((u) => hiredBefore(u, T_B - 200 * DAY)));
  const tagPlan = [["hipo", 4], ["key", 3], ["flight", 2]];
  let ti = 0;
  for (const [tag, n] of tagPlan) for (let k = 0; k < n; k++) {
    const u = tagged[ti++];
    ok(await admin.post(`/api/admin/employees/${u.id}/controlled-tags`, { tag, action: "add", reason: tag === "flight" ? "近期外部机会较多，1 对 1 中表达了对发展路径的担忧。" : "连续两期表现稳定，承担关键职责。" }), "标签 " + tag);
  }
  // 关键岗位与继任人
  const KP = [["技术部", "后端技术负责人"], ["销售部", "大客户销售总监"], ["人力资源部", "HRBP 负责人"], ["财务部", "财务经理"]];
  const READY = ["ready", "oneYear", "twoYears"];
  for (const [dName, pos] of KP) {
    ok(await admin.post("/api/admin/key-positions", { name: pos, deptId: deptByName.get(dName).id, note: "业务连续性关键岗位" }), "关键岗位 " + pos);
    const cands = shuffled(staff.filter((u) => u.department === dName)).slice(0, dName === "财务部" ? 1 : 2);
    for (const [i, u] of cands.entries()) ok(await admin.post("/api/admin/succession", { positionName: pos, userId: u.id, readiness: READY[i % 3] }), "继任人 " + pos);
  }
  console.log("   + 受控标签 9 个、关键岗位 4 个（含继任人）");
  await srv.stop();

  // ===== B2：2 天前（发起本季度周期，自评截止日 = 昨天，多数人按时交） =====
  srv = await boot(fakeAt(T_B2));
  S = new Session(srv);
  admin = await S.as("ADMIN");
  const people = staff.filter((u) => hiredBefore(u, NOW - 7 * DAY));
  const cur = ok(await admin.post("/api/admin/review-cycles", { name: `${Q_NOW} 季度绩效评估`, flow: "v2", kind: "quarter", dueAt: ymd(NOW - 1 * DAY), dueRateAt: ymd(NOW + 7 * DAY), dueCalibAt: ymd(NOW + 14 * DAY), userIds: people.map((u) => u.id), quota: QUOTA }), "发起本季度周期").cycle.id;
  const curItems = new Map(ok(await admin.get(`/api/admin/review-cycles/${cur}`), "周期详情").items.map((i) => [i.employeeId, i.id]));
  const fullDepts = new Set(["产品部", "财务部"]);   // 这两个部门全员自评、评级并由 HoD 提交（产品部再由 HR 确认）
  const selfDone = new Set();
  for (const u of people) {
    if (!curItems.has(u.employeeId)) continue;
    if (!(fullDepts.has(deptOf(u)) || (u !== improver && rand() < 0.75))) continue;
    ok(await (await S.as(u.employeeId)).post(`/api/me/reviews/${curItems.get(u.employeeId)}/self`, selfBody()), "自评 " + u.employeeId);
    selfDone.add(u.employeeId);
  }
  await srv.stop();

  // ===== C：现在 =====
  srv = await boot(null);
  S = new Session(srv);
  admin = await S.as("ADMIN");
  let rateN = 0;
  for (const [dName, head] of headOfDept) {
    const team = people.filter((u) => deptOf(u) === dName && curItems.has(u.employeeId));
    const full = fullDepts.has(dName);
    const ratings = ratingsFor(team);
    let hrRated = 0;
    for (const u of team) {
      if (!selfDone.has(u.employeeId)) continue;
      // 人力资源部：UL-TEST 只评了 3 人，其余留给演示（团队评估有待办）
      const doRate = full || (dName === "人力资源部" ? hrRated++ < 3 : rand() < 0.6);
      if (!doRate) continue;
      const r = ratings[u.employeeId];
      ok(await (await S.as(head.employeeId)).post(`/api/me/reviews/${curItems.get(u.employeeId)}/manager`, { rating: r, text: MGR_TEXT[r] || MGR_TEXT.B, highlights: highlightsFor(r) }), "评级 " + u.employeeId); rateN++;
      // 面谈：多数员工已登记；其他部门的上级也登记了，人力资源部留给 UL-TEST 确认
      if (rand() < 0.7) {
        ok(await (await S.as(u.employeeId)).post(`/api/me/reviews/${curItems.get(u.employeeId)}/one-on-one`, { done: true }), "面谈登记 " + u.employeeId);
        if (dName !== "人力资源部") ok(await (await S.as(head.employeeId)).post(`/api/me/reviews/${curItems.get(u.employeeId)}/one-on-one`, { done: true }), "上级面谈登记 " + u.employeeId);
      }
    }
    if (full && team.length) {
      const dept = deptByName.get(dName);
      ok(await (await S.as(head.employeeId)).post("/api/me/reviews/hod/submit", { cycleId: cur, dept1Id: dept.id }), "HoD 提交 " + dName);
      if (dName === "产品部") ok(await admin.post(`/api/admin/review-cycles/${cur}/depts/${dept.id}/confirm`, {}), "HR 确认 " + dName);
    }
  }
  const selfN = selfDone.size;  console.log(`   + ${Q_NOW} 季度绩效评估（进行中）：${people.length} 人，自评 ${selfN}、上级评级 ${rateN}；产品部已确认、财务部待 HR 确认`);

  // 本季度组织互评：开放中，5 位负责人已提交，UL-TEST 未填
  const otherHeads = [...headOfDept.values()].filter((h) => h.id !== TEST.id);
  await orgRound(Q_PREV, NOW + 10 * DAY, otherHeads.slice(0, 5), false);
  console.log(`   + 组织互评 ${Q_PREV}（进行中）：5 位负责人已提交，UL-TEST 待填写`);

  // 发展项目
  const D = (off) => ymd(NOW + off * DAY);
  const p1 = ok(await admin.post("/api/admin/tprojects", { title: "New Manager Development Program", title_zh: "新任管理者发展项目" }), "建发展项目").id;
  const headB = headOfDept.get("技术部");
  const cohorts1 = [{
    id: "nm-co1", name: "第一期", startAt: D(-30), endAt: D(60), capacity: 24,
    classes: [{ id: "nm-cla", name: "A 班", headId: TEST.id }, { id: "nm-clb", name: "B 班", headId: headB.id }],
    phases: [
      { id: "nm-ph1", name: "阶段一 · 角色转变", gateMode: "completion", activities: [
        { id: "nm-kick", type: "offline", title: "Kickoff Workshop", title_zh: "开营工作坊", startAt: D(-20) + "T09:30", location: "总部 3F 培训室", trainerId: TEST.id },
        { id: "nm-live", type: "online", title: "Live: From Expert to Manager", title_zh: "直播：从专家到管理者", url: "https://example.com/live", completion: "click", startAt: D(-15) + "T19:00", durationMin: 60 },
        { id: "nm-case", type: "online", title: "Case Clinic", title_zh: "管理案例研讨", completion: "trainer", trainerId: TEST.id, required: true },
      ] },
      { id: "nm-ph2", name: "阶段二 · 带团队", gateMode: "time", activities: [
        { id: "nm-course", type: "course", refId: "lf-coaching" },
        { id: "nm-exam", type: "exam", refId: "exam-p-leadership" },
        { id: "nm-salon", type: "offline", title: "Peer Salon", title_zh: "同伴沙龙", startAt: D(10) + "T14:00", location: "总部 5F 会议室", trainerId: TEST.id },
      ] },
    ],
  }, {
    // 第二期开放报名（员工可在「发展项目」申请加入，进「申请审批 › 发展项目报名」）
    id: "nm-co2", name: "第二期", startAt: D(40), endAt: D(130), capacity: 24, open: true, classes: [],
    phases: [{ id: "nm2-ph1", name: "阶段一 · 角色转变", gateMode: "completion", activities: [
      { id: "nm2-kick", type: "offline", title: "Kickoff Workshop", title_zh: "开营工作坊", startAt: D(40) + "T09:30", location: "总部 3F 培训室", trainerId: TEST.id },
      { id: "nm2-course", type: "course", refId: "lf-coaching" },
    ] }],
  }];
  ok(await admin.put(`/api/admin/tprojects/${p1}`, { cohorts: cohorts1, status: "running" }), "发展项目期次");
  const pool = shuffled(staff.filter((u) => hiredBefore(u, NOW - 60 * DAY) && u.id !== hrbp.id));
  const hrMembers = staff.filter((u) => u.department === "人力资源部" && u.id !== hrbp.id).slice(0, 3);
  const classA = [...hrMembers, ...pool.filter((u) => !hrMembers.includes(u)).slice(0, 4)];
  const classB = pool.filter((u) => !classA.includes(u)).slice(0, 6);
  ok(await admin.post(`/api/admin/tprojects/${p1}/members`, { cohortId: "nm-co1", userIds: classA.map((u) => u.id), classId: "nm-cla" }), "A 班学员");
  ok(await admin.post(`/api/admin/tprojects/${p1}/members`, { cohortId: "nm-co1", userIds: classB.map((u) => u.id), classId: "nm-clb" }), "B 班学员");
  for (const [i, u] of [...classA, ...classB].entries()) {
    ok(await admin.post(`/api/admin/tprojects/${p1}/checkin/nm-kick/mark`, { userId: u.id, status: i === 2 ? "excused" : i === 5 ? "clear" : "attended" }), "签到");
    if (i % 3 !== 0) ok(await (await S.as(u.employeeId)).post(`/api/me/tprojects/${p1}/complete`, { activityId: "nm-live", via: "click" }), "直播完成");
  }
  const p2 = ok(await admin.post("/api/admin/tprojects", { title: "Digital Leadership Lab", title_zh: "数字化领导力研修" }), "建发展项目 2").id;
  ok(await admin.put(`/api/admin/tprojects/${p2}`, { status: "running", cohorts: [{
    id: "dl-co1", name: "第一期", startAt: D(-10), endAt: D(45), capacity: 20, classes: [],
    phases: [{ id: "dl-ph1", name: "数据驱动决策", gateMode: "completion", activities: [
      { id: "dl-read", type: "online", title: "Pre-reading", title_zh: "课前阅读", url: "https://example.com/reading", completion: "self", dueAt: D(5) },
      { id: "dl-ws", type: "offline", title: "Workshop: Dashboards for Managers", title_zh: "工作坊：管理者看板", startAt: D(7) + "T09:30", location: "总部 3F 培训室", trainerId: headOfDept.get("运营部").id },
      { id: "dl-course", type: "course", refId: "is-accounts" },
    ] }],
  }] }), "发展项目 2 期次");
  const dlMembers = [TEST, ...[...headOfDept.values()].filter((h) => h.id !== TEST.id).slice(0, 4)];
  ok(await admin.post(`/api/admin/tprojects/${p2}/members`, { cohortId: "dl-co1", userIds: dlMembers.map((u) => u.id) }), "发展项目 2 学员");
  console.log("   + 发展项目 2 个：新任管理者发展项目（A 班班主任与两项活动讲师 = UL-TEST）、数字化领导力研修（UL-TEST 为学员）");
  // 发展项目报名（申请审批 › 发展项目报名）：两位不在名单里的员工申请加入
  const enrolled = new Set([...classA, ...classB].map((u) => u.id));
  let applied = 0;
  for (const u of pool.filter((x) => !enrolled.has(x.id)).slice(0, 2)) {
    const r = await (await S.as(u.employeeId)).post(`/api/me/tprojects/${p1}/apply`, { note: "希望参加下一期，目前在带 3 人的小组，想系统学习带团队的方法。" });
    if (r.status === 200 || r.status === 201) applied++;
  }

  // 公开课 3 门（员工端「公开课」）：课程设为公开并发布，几位员工自主加入
  const sec = (heading, heading_zh, html, html_zh) => ({ heading, heading_zh, html, html_zh, video: null, videoEmbed: null, attachments: [] });
  const PUBLIC = [
    { id: "pc-feedback", title: "Giving Feedback That Lands", title_zh: "给出有效反馈", description: "A simple structure for specific, timely, actionable feedback.", description_zh: "具体、及时、可执行的反馈结构，附对话示例。",
      modules: [{ id: "pc-fb-m1", title: "The SBI Model", title_zh: "情境—行为—影响", minutes: 12, sections: [sec("Situation, behaviour, impact", "情境、行为、影响", "<p>Describe the situation, the observable behaviour and its impact; then ask before you advise.</p>", "<p>先描述情境、可观察的行为与它带来的影响，再询问对方的看法，最后才给建议。</p>")] }] },
    { id: "pc-energy", title: "Managing Time and Energy", title_zh: "时间与精力管理", description: "Plan the week around your energy, not just your calendar.", description_zh: "按精力而不只是日程来安排一周的工作。",
      modules: [{ id: "pc-en-m1", title: "Weekly Planning", title_zh: "周计划", minutes: 10, sections: [sec("Three outcomes a week", "每周三个成果", "<p>Pick three outcomes for the week and protect a focus block for each.</p>", "<p>每周选定三个成果，并为每个成果预留一段不被打扰的专注时间。</p>")] }] },
    { id: "pc-data", title: "Data Thinking Basics", title_zh: "数据思维入门", description: "Ask better questions of the numbers you already have.", description_zh: "用手上已有的数据，问出更好的问题。",
      modules: [{ id: "pc-da-m1", title: "From Question to Metric", title_zh: "从问题到指标", minutes: 15, sections: [sec("Start with the decision", "从决策出发", "<p>Name the decision first, then the metric that would change it.</p>", "<p>先说清楚要做什么决策，再找出能改变这个决策的指标。</p>")] }] },
  ];
  for (const c of PUBLIC) ok(await admin.put(`/api/admin/content/courses/${c.id}`, { ...c, status: "published", mode: "online", public: true, enrollType: "elective" }), "公开课 " + c.title_zh);
  let selfEnrolled = 0;
  for (const [i, u] of [TEST, ...shuffled(staff).slice(0, 8)].entries()) {
    const c = PUBLIC[i % PUBLIC.length];
    const r = await (await S.as(u.employeeId)).post(`/api/catalog/courses/pw-${c.id}/enroll`, {});
    if (r.status === 200 || r.status === 201) selfEnrolled++;
  }

  // 试用期员工转正 2 人（档案「添加记录 › 转正」+ 同步员工状态 → 正式；工作台「试用期转正通过率」有数）
  const probation = roster.filter((u) => u.empStatus === "probation" && hiredBefore(u, NOW - 60 * DAY)).slice(0, 2);
  for (const u of probation) ok(await admin.post(`/api/admin/employees/${u.id}/records`, { type: "regularization", date: ymd(NOW - 2 * DAY), fields: { result: "On time", review: "试用期目标全部达成，融入团队快，按期转正。", syncStatus: true } }), "转正 " + u.employeeId);
  console.log(`   + 公开课 3 门（自主学习 ${selfEnrolled} 人）、发展项目报名 ${applied} 条、试用期转正 ${probation.length} 人`);
  await srv.stop();
}

main().then(() => process.exit(0)).catch((e) => { console.error("补演示数据失败: " + (e && e.stack || e)); process.exit(1); });
