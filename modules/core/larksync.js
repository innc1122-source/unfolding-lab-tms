// modules/core/larksync.js —— 从 Masterlist Base 每日同步组织架构与员工（2026-09-30 起，Milan 定）。
//
// 数据源（Base LHuQbZnchaCNR8sdY24l1AGRgLb，表 id 可在 config.json 的 lark.sync 里改）：
//   Organizations       Lark 部门树（department_id / parent_department_id / name / pic_id / is_active）
//   Master list         BIPO 员工总表（视图 vewHOoW8PS）：EID、姓名、职位、Job Rank、入职日期、生日、邮箱、手机、部门路径。
//                       只取在职（Exit Date 为空或不早于今天，与表里 Status 公式同口径）且 Employment Type 不是 AGENCY 的人
//   Lark User Accounts  Lark 通讯录（EID、user_id、open_id、部门、上级、状态、国籍类型、邮箱）
//
// 规则（负责人 2026-09-30 拍板）：
//   部门      以 Organizations 为准，整棵树原样同步（与 digiplus org chart 一致，2026-10-01）。L0 = DigiPlus；
//             L0–L2（lark.sync.topLevel 之上）记为「集团层」（meta larksync.groupDepts），L3 起算 TMS 一级部门 ——
//             HoD 名单、3+3 部门排名按 L3 算；直接挂在集团层的人，其所在节点对他们算一级（modules/core/org.js）。
//             部门负责人（ownerId）= 该部门的 pic。
//   员工      Master list 在职、非 agency 的每个 EID = 一个在职员工。职级取 Job Rank（PD2、MB1……，空则留空）。部门优先取其 Lark 账号所在部门（多个时优先与 BIPO
//             末级部门同名的那个），没有 Lark 账号时按 BIPO 部门路径的末级名对应到 Organizations。
//             上级：有 Lark 账号取 Lark 的上级；没有（或 Lark 上级不在名单内）取所在部门负责人，负责人是本人时逐级往上找。
//   Lark 登录 只有同步登记过 Lark user_id 的账号能用 Lark 登录（server.js 回调按 users.larkUserId 匹配）：
//             · 有 EID 的：EID 在上述在职名单里，且 Lark 账号状态为 Active；
//             · 没有 EID 的：Lark 状态 Active、不是 Function ID、邮箱不以 csc / smb 开头 —— 同步为其建
//               「LK-<user_id>」账号（资料只来自 Lark 表，不在 BIPO）。
//   停用      名单里没有了的同步管理账号（纯数字工号或 LK- 开头、非管理员）停用并踢下线；超过 maxDeactivate
//             人时整批跳过停用并告警（防止数据源拉取异常时误停用全员）。只重新启用由同步停用的人。
//   其它字段  职级、职位、入职日期、试用/正式按 Base 更新（已离职 exited 的不改）；邮箱、手机只在 TMS 为空时补。
//             新建的有 EID 账号初始密码 = 生日 YYYYMMDD（与 9/28 建库同口径，首登强制改密），没有生日时随机。
//
// 零依赖（Node 22 全局 fetch）。计划（buildPlan）是纯函数，写库（applyPlan）在一个 store.transaction 里完成，
// 领域事件（调岗、离职……）照常经 store 的写函数发出。
"use strict";
const crypto = require("crypto");

const DEFAULTS = {
  baseToken: "LHuQbZnchaCNR8sdY24l1AGRgLb",
  orgTable: "tbllEK0velRUh0Uz",
  employeeTable: "tblWC5oqhhqj6Ewh",   // Master list
  employeeView: "vewHOoW8PS",
  accountTable: "tbllBDo22O949qV6",
  topLevel: 3,          // L0 = DigiPlus；L3 起为 TMS 一级部门
  hour: 3,              // 每天几点（服务器本地时间）自动同步
  maxDeactivate: 150,   // 单次停用超过这个人数时跳过停用
  minEmployees: 1000,   // 拉到的在职名单少于这个数视为拉取异常，整次放弃
};
const META_DEPTS = "larksync.depts";        // { larkDepartmentId: tmsDeptId }
const META_DEACT = "larksync.deactivated";  // [userId]：由同步停用的人（只有这些人会被同步重新启用）
const META_REPORT = "larksync.lastReport";
const META_GROUPS = "larksync.groupDepts";   // [tmsDeptId]：集团层（L0 到 topLevel-1），store.listDepartments 据此标 group
// { userId: Lark 显示名 }：在用 Lark 账号的名字。选人下拉优先显示它，没有的显示 BIPO 姓名（users.name）。
// 存 meta 而不是给 users 加列：不动表结构、不占迁移编号（避免和 TMS 主线后续的迁移编号撞车）。
const META_LARKNAMES = "larksync.larkNames";

function syncCfg(larkCfg) {
  if (!larkCfg || !larkCfg.sync || typeof larkCfg.sync !== "object" || larkCfg.sync.enabled === false) return null;
  const c = { ...DEFAULTS, ...larkCfg.sync };
  for (const k of ["topLevel", "hour", "maxDeactivate", "minEmployees"]) c[k] = Number(c[k]);
  return c;
}

// ---------- 单元格取值（兼容 OpenAPI 与 lark-cli 两种返回形状）----------
function text(x) {
  if (x == null) return "";
  if (typeof x === "string" || typeof x === "number" || typeof x === "boolean") return String(x).trim();
  if (Array.isArray(x)) return x.map((e) => (e && typeof e === "object" ? text(e.text != null ? e.text : e.name != null ? e.name : e.value) : text(e))).join("").trim();
  if (typeof x === "object") {
    if (x.value !== undefined) return text(x.value);
    if (Array.isArray(x.users)) return x.users.map((u) => u.name || "").join(",").trim();
    if (x.text !== undefined) return text(x.text);
    if (x.name !== undefined) return text(x.name);
  }
  return "";
}
function linkIds(x) {
  if (x == null) return [];
  if (Array.isArray(x)) return x.flatMap((e) => (typeof e === "string" ? [e] : e && typeof e === "object" ? (e.record_ids || e.link_record_ids || (e.id ? [e.id] : e.record_id ? [e.record_id] : [])) : []));
  if (typeof x === "object") return x.link_record_ids || x.record_ids || [];
  return [];
}
const eidOf = (x) => { const s = text(x).replace(/\.0+$/, ""); return /^\d+$/.test(s) ? s : ""; };
// Base 日期是毫秒时间戳（或带时区的字符串）；按 +08:00 取日历日期
const dateOf = (x) => {
  const v = Array.isArray(x) ? x[0] : x && typeof x === "object" && x.value !== undefined ? (Array.isArray(x.value) ? x.value[0] : x.value) : x;
  if (v == null || v === "") return "";
  if (typeof v === "number" || /^\d{10,}$/.test(String(v))) return new Date(Number(v) + 8 * 3600e3).toISOString().slice(0, 10);
  const m = String(v).match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : "";
};
const todayPh = (now) => new Date((now || Date.now()) + 8 * 3600e3).toISOString().slice(0, 10);
const normName = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");

// ---------- 拉取 ----------
async function fetchSource(larkCfg, cfg, host) {
  const tokRes = await fetch(host + "/open-apis/auth/v3/tenant_access_token/internal", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ app_id: larkCfg.appId, app_secret: larkCfg.appSecret }),
  });
  const tok = await tokRes.json();
  if (!tok || !tok.tenant_access_token) throw new Error("lark tenant token: " + JSON.stringify(tok).slice(0, 200));
  const auth = { authorization: "Bearer " + tok.tenant_access_token };
  async function table(tableId, viewId) {
    const rows = [];
    let pageToken = "", total = null;
    for (let page = 0; page < 200; page++) {
      const q = new URLSearchParams({ page_size: "500" });
      if (viewId) q.set("view_id", viewId);
      if (pageToken) q.set("page_token", pageToken);
      const url = `${host}/open-apis/bitable/v1/apps/${encodeURIComponent(cfg.baseToken)}/tables/${encodeURIComponent(tableId)}/records?${q}`;
      let j = null;
      for (let attempt = 1; attempt <= 4; attempt++) {
        const r = await fetch(url, { headers: auth });
        j = await r.json().catch(() => null);
        if (j && j.code === 0) break;
        if (attempt === 4) throw new Error(`bitable ${tableId}: ` + JSON.stringify(j).slice(0, 300));
        await new Promise((ok) => setTimeout(ok, 1500 * attempt));
      }
      const d = j.data || {};
      if (total == null && typeof d.total === "number") total = d.total;
      for (const it of d.items || []) rows.push({ _record_id: it.record_id || it.id, ...(it.fields || {}) });
      if (!d.has_more || !d.page_token) break;
      pageToken = d.page_token;
    }
    if (total != null && rows.length !== total) throw new Error(`bitable ${tableId}: got ${rows.length} of ${total} rows`);
    return rows;
  }
  return {
    orgs: await table(cfg.orgTable),
    employees: await table(cfg.employeeTable, cfg.employeeView),
    accounts: await table(cfg.accountTable),
  };
}

// ---------- 计划（纯函数）----------
// 输出人员 key：有 EID 的为 EID 本身，无 EID 的 Lark 账号为 "LK-<user_id>"（即 TMS 工号）。
function buildPlan(src, cfg) {
  cfg = { ...DEFAULTS, ...(cfg || {}) };
  const warnings = [];
  // 部门
  const orgs = new Map();
  for (const r of src.orgs) {
    const did = text(r.department_id);
    if (!did) continue;
    const act = text(r.is_active);
    if (act && act !== "Yes") continue;
    orgs.set(did, { did, rec: r._record_id, name: text(r.name), parent: text(r.parent_department_id), pic: text(r.pic_id) });
  }
  const byRec = new Map([...orgs.values()].map((o) => [o.rec, o]));
  const byNorm = new Map();
  for (const o of orgs.values()) { const k = normName(o.name); byNorm.set(k, byNorm.has(k) ? null : o); }   // 重名 → null（不按名对应）
  const level = new Map();
  const levelOf = (did) => {
    if (level.has(did)) return level.get(did);
    let n = 0, cur = orgs.get(did); const seen = new Set();
    while (cur && cur.parent && cur.parent !== "0" && !seen.has(cur.did)) { seen.add(cur.did); cur = orgs.get(cur.parent); n++; if (!cur) { n = -1; break; } }
    level.set(did, n);
    return n;
  };
  for (const o of orgs.values()) if (levelOf(o.did) < 0) warnings.push(`部门「${o.name}」的上级部门不存在或已停用，整棵子树不同步`);

  // Lark 账号
  const accounts = src.accounts.map((r) => ({
    eid: eidOf(r.EID), userId: text(r.user_id), openId: text(r.open_id), name: text(r.name), email: text(r.email).toLowerCase(),
    status: text(r.status), nat: text(r.nationality_status), type: text(r.employee_type), title: text(r.job_title),
    depts: linkIds(r.department_ids).map((id) => byRec.get(id)).filter(Boolean),
    leaderOpenId: text(r.leader_user_id), leaderEid: eidOf(r.leader_EID),
  }));
  // 同一 EID 多个 Lark 账号：在用的优先，其次个人账号优先于 Function ID（共用号）
  const acctRank = (a) => (a.status === "Active" ? 2 : 0) + (a.nat !== "Function ID" ? 1 : 0);
  const acctByEid = new Map();
  for (const a of accounts) {
    if (!a.eid) continue;
    const prev = acctByEid.get(a.eid);
    if (!prev || acctRank(a) > acctRank(prev)) acctByEid.set(a.eid, a);
    if (prev && acctRank(a) === acctRank(prev) && a.status === "Active") warnings.push(`EID ${a.eid} 有两个同类的在用 Lark 账号（${prev.name} / ${a.name}），取第一个`);
  }
  const acctByOpen = new Map(accounts.filter((a) => a.openId).map((a) => [a.openId, a]));

  // 人员集合
  const people = new Map();   // key -> person
  const today = todayPh(cfg.now);
  const skipped = { exited: 0, agency: 0 };
  for (const r of src.employees) {
    const eid = eidOf(r.EID);
    if (!eid || people.has(eid)) continue;
    const exit = dateOf(r["Exit Date"]);
    if (exit && exit < today) { skipped.exited++; continue; }
    if (/AGENCY/i.test(text(r["Employment Type"]))) { skipped.agency++; continue; }
    const bipoPath = text(r["Department Details"] !== undefined ? r["Department Details"] : r["Full Department Path"]);
    const rank = text(r["Job Rank (Original)"]).toUpperCase();
    people.set(eid, {
      key: eid, eid, name: text(r["Employee Name"]), position: text(r.Designation !== undefined ? r.Designation : r["Job Title"]),
      bipoLeaf: bipoPath.split("-").pop().trim(), bipoPath, acct: acctByEid.get(eid) || null, larkOnly: false,
      jobRank: /^[A-Z]{2}\d$/.test(rank) ? rank : "", hireDate: dateOf(r["Join Date"]), birthDate: dateOf(r["Birth Date"]),
      bipoEmail: (text(r["Work Email"]).split(/[,;\s]+/)[0] || text(r.Email)).toLowerCase(), phone: text(r["Mobile Phone"]),
      empStatus: /PROBATION/i.test(text(r["Employment Status"])) ? "probation" : "regular",
    });
  }
  if (!people.size && src.employees.length) warnings.push("员工表没有一行在职、非 agency 的记录");
  const larkOnlyExcluded = { inactive: 0, functionId: 0, cscSmb: 0 };
  for (const a of accounts) {
    if (a.eid || !a.userId) continue;
    if (a.status !== "Active") { larkOnlyExcluded.inactive++; continue; }
    if (a.nat === "Function ID") { larkOnlyExcluded.functionId++; continue; }
    if (/^(csc|smb)/i.test(a.email)) { larkOnlyExcluded.cscSmb++; continue; }
    const key = "LK-" + a.userId;
    people.set(key, { key, eid: null, name: a.name, position: a.title, bipoLeaf: "", bipoPath: "", acct: a, larkOnly: true });
  }
  const keyOfAcct = (a) => (!a ? null : a.eid ? (people.has(a.eid) ? a.eid : null) : people.has("LK-" + a.userId) ? "LK-" + a.userId : null);

  // 每个人的 Lark 部门节点
  const unmatched = [];
  for (const p of people.values()) {
    let node = null;
    const ds = p.acct ? p.acct.depts.filter((o) => levelOf(o.did) >= 0) : [];
    if (ds.length) node = ds.find((o) => normName(o.name) === normName(p.bipoLeaf)) || ds[0];
    if (!node && p.bipoLeaf) node = byNorm.get(normName(p.bipoLeaf)) || null;
    if (!node) unmatched.push(p.key);
    p.node = node;
  }
  // TMS 部门 = 全部在用的 Lark 部门，父级照搬；L0 到 topLevel-1 为集团层
  const depts = [];
  for (const o of orgs.values()) {
    const lv = levelOf(o.did);
    if (lv < 0) continue;
    depts.push({ did: o.did, name: o.name, level: lv, parentDid: lv === 0 ? null : o.parent, picKey: null, group: lv < cfg.topLevel });
  }
  depts.sort((a, b) => a.level - b.level || a.name.localeCompare(b.name));
  const nameCount = new Map();
  for (const d of depts) { const k = d.name.toLowerCase(); nameCount.set(k, (nameCount.get(k) || 0) + 1); }
  for (const d of depts) if (nameCount.get(d.name.toLowerCase()) > 1) warnings.push(`部门名「${d.name}」在 Lark 里重名，TMS 部门按名字唯一，重名的会合成一个`);
  const picKeyOf = (did) => { const o = orgs.get(did); return o && o.pic ? keyOfAcct(acctByOpen.get(o.pic)) : null; };
  for (const d of depts) d.picKey = picKeyOf(d.did);

  // 上级
  const deptPicChain = (did, selfKey) => {
    let cur = orgs.get(did); const seen = new Set();
    while (cur && !seen.has(cur.did)) {
      seen.add(cur.did);
      const k = picKeyOf(cur.did);
      if (k && k !== selfKey) return k;
      cur = cur.parent && cur.parent !== "0" ? orgs.get(cur.parent) : null;
    }
    return null;
  };
  for (const p of people.values()) {
    let m = null;
    if (p.acct) {
      const la = p.acct.leaderOpenId ? acctByOpen.get(p.acct.leaderOpenId) : null;
      m = keyOfAcct(la) || (p.acct.leaderEid && people.has(p.acct.leaderEid) ? p.acct.leaderEid : null);
    }
    if (!m || m === p.key) m = p.node ? deptPicChain(p.node.did, p.key) : null;
    p.managerKey = m && m !== p.key ? m : null;
  }
  // 断环：沿上级链走，走回自己就把链上最后一条边断开
  const cycles = [];
  for (const p of people.values()) {
    const seen = new Set([p.key]); let cur = p.managerKey ? people.get(p.managerKey) : null;
    while (cur) {
      if (seen.has(cur.key)) { cycles.push(`${cur.key}→${cur.managerKey}`); cur.managerKey = null; break; }
      seen.add(cur.key);
      cur = cur.managerKey ? people.get(cur.managerKey) : null;
    }
  }
  const out = [...people.values()].map((p) => ({
    key: p.key, eid: p.eid, larkOnly: p.larkOnly, name: p.name || (p.acct && p.acct.name) || p.key, position: p.position || (p.acct && p.acct.title) || "",
    email: p.bipoEmail || (p.acct ? p.acct.email : ""), phone: p.phone || "", jobRank: p.jobRank || "", hireDate: p.hireDate || "",
    birthDate: p.birthDate || "", empStatus: p.empStatus || (p.acct && p.acct.type === "Probationary" ? "probation" : "regular"), larkUserId: p.acct && p.acct.status === "Active" && p.acct.userId ? p.acct.userId : null,
    larkName: p.acct && p.acct.status === "Active" && p.acct.name ? p.acct.name : "",
    empType: p.acct ? p.acct.type : "", deptDid: p.node ? p.node.did : null,
    managerKey: p.managerKey,
  }));
  return {
    depts, people: out, warnings,
    stats: {
      orgs: orgs.size, depts: depts.length, employees: out.filter((p) => !p.larkOnly).length, sourceRows: src.employees.length, skipped, people: out.length,
      larkOnly: out.filter((p) => p.larkOnly).length, withLark: out.filter((p) => p.larkUserId).length,
      noDept: unmatched.length, cycles: cycles.length, larkOnlyExcluded,
    },
    unmatched, cycles,
  };
}

// ---------- 写库 ----------
// deps: { store, hashPassword, newToken }；opts: { dryRun, force, actor }
function applyPlan(plan, deps, opts = {}) {
  const { store } = deps;
  const cfg = { ...DEFAULTS, ...(opts.cfg || {}) };
  const rep = { at: new Date().toISOString(), dryRun: !!opts.dryRun, trigger: opts.trigger || null, stats: plan.stats, warnings: [...plan.warnings],
    deptsCreated: [], deptsRenamed: [], deptsMoved: 0, deptsDeactivated: [], ownersChanged: 0,
    usersCreated: [], usersUpdated: 0, transferred: 0, managerChanged: 0, deactivated: [], reactivated: [], larkLinked: 0, larkNames: 0,
    unmatched: plan.unmatched.slice(0, 200), cycles: plan.cycles.slice(0, 50) };
  if (plan.stats.employees < cfg.minEmployees) throw new Error(`员工表只拉到 ${plan.stats.employees} 行（少于 ${cfg.minEmployees}），视为拉取异常，本次不同步`);

  const run = () => {
    const map = JSON.parse(store.getMeta(META_DEPTS) || "{}");
    const tmsDept = new Map();   // did -> dept row
    const byId = (id) => store.listDepartments(true).find((d) => d.id === id) || null;
    // 1) 部门：先按映射或名字找到/建出，名字不同就改名
    for (const d of plan.depts) {
      let row = map[d.did] ? byId(map[d.did]) : null;
      if (!row) row = store.getDepartmentByName(d.name);
      if (!row) { row = store.ensureDepartment(d.name, null); rep.deptsCreated.push(d.name); }
      else if (row.name !== d.name) {
        const clash = store.getDepartmentByName(d.name);
        if (clash && clash.id !== row.id) rep.warnings.push(`部门「${row.name}」要改名为「${d.name}」，但已有同名部门，未改名`);
        else { rep.deptsRenamed.push(`${row.name} → ${d.name}`); row = store.updateDepartment(row.id, { name: d.name }); }
      }
      if (!row.active) row = store.updateDepartment(row.id, { active: true });
      map[d.did] = row.id;
      tmsDept.set(d.did, row);
    }
    // 集团层标记先写（后面改父级产生的 department.moved 事件按新口径算一级部门）
    store.setMeta(META_GROUPS, JSON.stringify(plan.depts.filter((d) => d.group).map((d) => tmsDept.get(d.did).id)));
    // 2) 父级：按层级自上而下改（上层已就位，不会成环）
    for (const d of plan.depts) {
      const row = tmsDept.get(d.did);
      const want = d.parentDid ? (tmsDept.get(d.parentDid) || {}).id || null : null;
      const cur = byId(row.id);
      if ((cur.parentId || null) !== want) {
        if (want && store.departmentWouldCycle(row.id, want)) { rep.warnings.push(`部门「${d.name}」挂到上级会成环，未改`); continue; }
        store.updateDepartment(row.id, { parentId: want }); rep.deptsMoved++;
      }
    }
    store.setMeta(META_DEPTS, JSON.stringify(map));

    // 3) 人员
    const deact = new Set(JSON.parse(store.getMeta(META_DEACT) || "[]"));
    const userOf = new Map();   // key -> user row
    const larkTaken = new Map(store.listUsers().filter((u) => u.larkUserId).map((u) => [u.larkUserId, u.id]));
    const larkNames = {};   // 本次名单里的 { userId: Lark 显示名 }，整张表替换 META_LARKNAMES（不在名单里的人自然去掉）
    // 用户主键沿用建库口径 u-<EID>；已被别的账号占用（例如演示账号）时加随机后缀
    const freeId = (id) => { let x = id; while (store.getUserById(x)) x = id + "-" + deps.newToken().slice(0, 4); return x; };
    for (const p of plan.people) {
      const deptName = p.deptDid && tmsDept.has(p.deptDid) ? tmsDept.get(p.deptDid).name : null;
      let u = store.getUserByEmployeeId(p.key);
      if (!u) {
        u = store.createUser({
          id: freeId(p.larkOnly ? "u-lk-" + p.key.slice(3).toLowerCase() : "u-" + p.key), employeeId: p.key, name: p.name.slice(0, 80), role: "employee",
          passwordHash: deps.hashPassword(!p.larkOnly && p.birthDate ? p.birthDate.replace(/-/g, "") : deps.newToken()), department: deptName,
          email: p.email || null, phone: p.phone || null, managerId: null, larkUserId: null, mustChangePassword: p.larkOnly ? 0 : 1,
          position: p.position || null, jobLevel: p.jobRank || null, hireDate: p.hireDate || null, empStatus: p.empStatus,
        });
        rep.usersCreated.push(`${p.key} ${p.name}`);
      } else {
        const patch = {};
        if (p.name && u.name !== p.name.slice(0, 80)) patch.name = p.name.slice(0, 80);
        if (deptName && (u.department || "") !== deptName) { patch.department = deptName; rep.transferred++; }
        if (p.position && (u.position || "") !== p.position) patch.position = p.position;
        if (!u.email && p.email) patch.email = p.email;
        if (!u.phone && p.phone) patch.phone = p.phone;
        if (!p.larkOnly) {
          if ((u.jobLevel || "") !== p.jobRank) patch.jobLevel = p.jobRank || null;
          if (p.hireDate && (u.hireDate || "") !== p.hireDate) patch.hireDate = p.hireDate;
          if (u.empStatus !== "exited" && p.empStatus && u.empStatus !== p.empStatus) patch.empStatus = p.empStatus;
        }
        if (!u.active && deact.has(u.id)) { patch.active = true; deact.delete(u.id); rep.reactivated.push(`${p.key} ${p.name}`); }
        if (Object.keys(patch).length) { u = store.updateUser(u.id, patch); rep.usersUpdated++; }
      }
      // Lark 显示名单独记数（不算进 usersUpdated）：加列后的第一次同步会给几乎所有人写一次，不该让「更新 N 人」看起来像大批改动
      if (p.larkName) larkNames[u.id] = p.larkName.slice(0, 80);
      if (p.larkUserId && u.larkUserId !== p.larkUserId) {
        const other = larkTaken.get(p.larkUserId);
        if (other && other !== u.id) rep.warnings.push(`Lark 账号 ${p.larkUserId} 已登记在另一个 TMS 账号上，${p.key} 未登记`);
        else { if (u.larkUserId) larkTaken.delete(u.larkUserId); store.setUserLarkId(u.id, p.larkUserId); larkTaken.set(p.larkUserId, u.id); rep.larkLinked++; }
      }
      userOf.set(p.key, u);
    }
    { // Lark 显示名单独记数（不算进 usersUpdated）：上线后的第一次同步会给几乎所有人写一次
      let prev = {}; try { prev = JSON.parse(store.getMeta(META_LARKNAMES) || "{}") || {}; } catch { prev = {}; }
      for (const id of new Set([...Object.keys(prev), ...Object.keys(larkNames)])) if ((prev[id] || "") !== (larkNames[id] || "")) rep.larkNames++;
      if (rep.larkNames) store.setMeta(META_LARKNAMES, JSON.stringify(larkNames));
    }
    // 4) 上级
    for (const p of plan.people) {
      const u = userOf.get(p.key);
      const want = p.managerKey && userOf.has(p.managerKey) ? userOf.get(p.managerKey).id : null;
      if ((store.getUserById(u.id).managerId || null) !== want) { store.updateUser(u.id, { managerId: want }); rep.managerChanged++; }
    }
    // 5) 部门负责人
    for (const d of plan.depts) {
      const row = tmsDept.get(d.did);
      const want = d.picKey && userOf.has(d.picKey) ? userOf.get(d.picKey).id : null;
      if ((byId(row.id).ownerId || null) !== want) { store.updateDepartment(row.id, { ownerId: want }); rep.ownersChanged++; }
    }
    // 6) 名单里没有了的同步管理账号：停用
    const keep = new Set(plan.people.map((p) => p.key.toLowerCase()));
    const gone = store.listUsers().filter((u) => u.active && u.role !== "admin" && (/^\d+$/.test(u.employeeId) || /^LK-/i.test(u.employeeId)) && !keep.has(String(u.employeeId).toLowerCase()));
    if (gone.length > cfg.maxDeactivate && !opts.force) {
      rep.warnings.push(`有 ${gone.length} 个账号不在名单里，超过单次停用上限 ${cfg.maxDeactivate}，本次未停用任何人（确认无误后用 force 重跑）`);
      rep.deactivateSkipped = gone.length;
    } else {
      for (const u of gone) {
        store.updateUser(u.id, { active: false });
        store.deleteUserSessions(u.id);
        deact.add(u.id);
        rep.deactivated.push(`${u.employeeId} ${u.name}`);
      }
    }
    store.setMeta(META_DEACT, JSON.stringify([...deact]));
    // 7) 旧部门：不在 Lark 里、已没有人、也没有启用中的下级 → 停用（自下而上，多轮）
    const managed = new Set(Object.values(map));
    // 只看启用中的人：部门里只剩已停用的人时照样停用部门（停用不删数据，历史记录里的部门名不受影响）
    const activeIn = (name) => { const k = String(name).trim().toLowerCase(); return store.listUsers().some((u) => u.active && String(u.department || "").trim().toLowerCase() === k); };
    for (let round = 0; round < 12; round++) {
      let changed = false;
      const all = store.listDepartments(true);
      for (const d of all) {
        if (!d.active || managed.has(d.id)) continue;
        if (all.some((c) => c.parentId === d.id && c.active)) continue;
        if (activeIn(d.name)) continue;
        store.updateDepartment(d.id, { active: false }); rep.deptsDeactivated.push(d.name); changed = true;
      }
      if (!changed) break;
    }
    const left = store.listDepartments(false).filter((d) => !managed.has(d.id));
    if (left.length) rep.warnings.push(`${left.length} 个不在 Lark 组织表里的旧部门仍有人或有下级，未停用：` + left.slice(0, 20).map((d) => d.name).join("、"));
    if (opts.dryRun) throw DRY;
  };
  const DRY = new Error("dry-run");
  try { store.transaction(run); } catch (e) { if (e !== DRY) throw e; }
  if (!opts.dryRun) store.setMeta(META_REPORT, JSON.stringify(rep));
  return rep;
}

// { userId: Lark 显示名 }（roster 接口用）；读不出来时返回空表 —— 选人下拉回落到 BIPO 姓名
function larkNames(store) {
  try { const m = JSON.parse(store.getMeta(META_LARKNAMES) || "{}"); return m && typeof m === "object" ? m : {}; } catch { return {}; }
}

function lastReport(store) {
  try { return JSON.parse(store.getMeta(META_REPORT) || "null"); } catch { return null; }
}

// 报告摘要（审计与日志用，不含名单）
function summary(rep) {
  return {
    dryRun: rep.dryRun, people: rep.stats.people, depts: rep.stats.depts, created: rep.usersCreated.length, updated: rep.usersUpdated,
    transferred: rep.transferred, managerChanged: rep.managerChanged, deactivated: rep.deactivated.length, reactivated: rep.reactivated.length,
    deptsCreated: rep.deptsCreated.length, deptsRenamed: rep.deptsRenamed.length, deptsMoved: rep.deptsMoved, deptsDeactivated: rep.deptsDeactivated.length,
    ownersChanged: rep.ownersChanged, larkLinked: rep.larkLinked, larkNames: rep.larkNames || 0, warnings: rep.warnings.length,
  };
}

module.exports = { DEFAULTS, syncCfg, text, linkIds, fetchSource, buildPlan, applyPlan, lastReport, larkNames, summary, newRunId: () => crypto.randomBytes(4).toString("hex") };
