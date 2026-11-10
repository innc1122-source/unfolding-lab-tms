// M0 等价性证明的冻结夹具 —— 2026-09-25 M0 动手之前，从 server.js 逐字复制的手写表。
//
// 这些是 M0 之前 server.js 里散落的手抄清单（MODULE_ROUTES / RBAC_DOMAINS / RBAC_SHELL /
// RBAC_READONLY / RBAC_ROUTES）以及读它们的三个函数（modulesOn / moduleOfPath / rbacGate）。
// 由脚本逐字截取（不是手抄），正则的 source/flags、methods、domain、顺序与当时源码一字不差。
// test/m0-registry-equivalence.test.js 断言 kernel/registry.js 从 manifest 生成的表与这里
// 逐条相等（顺序也相等），并用两套判定逻辑对全部已知路由逐一比对结果。
//
// ⚠ 本文件是历史快照，永远不要「顺手更新」它：它存在的意义就是 M0 之前的行为基线。
// 以后若有意改变路由归属或能力域，应当改 manifest，并在等价性测试里显式登记那一处差异。
"use strict";

// modulesOn 依赖 readConfig()；这里包成工厂，调用方注入 readConfig 与 env。
function makeLegacyModulesOn(readConfig, env) {
  const process = { env };
  function modulesOn() {
    const cfg = readConfig().modules || {};
    const off = new Set(String(process.env.LMS_MODULES_OFF || "")
      .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean));
    const on = (k) => cfg[k] !== false && !off.has(k);
    return { learning: on("learning"), performance: on("performance"), talent: on("talent") };
  }
  return modulesOn;
}

const MODULE_ROUTES = [
  // learning — employee side
  ["/api/catalog", "learning"],
  ["/api/programs", "learning"],
  ["/api/courses", "learning"],
  ["/api/exam", "learning"],
  ["/api/exam-attempts", "learning"],
  ["/api/ai/assistant", "learning"],
  ["/api/me/tprojects", "learning"],
  ["/api/me/enroll-requests", "learning"],
  ["/api/me/sessions", "learning"],
  ["/api/me/classes", "learning"],
  ["/api/me/team", "learning"],
  ["/api/me/attempts", "learning"],
  ["/api/me/learning-record", "learning"],
  ["/api/me/programs", "learning"],
  // learning — admin side（/api/admin/export/records.csv 归 core，所以两条
  // 培训 CSV 用精确路径，不能用 /api/admin/export/ 前缀一把抓）
  ["/api/admin/upload-video", "learning"],
  ["/api/admin/attachments", "learning"],
  ["/api/admin/programs", "learning"],
  ["/api/admin/exams", "learning"],
  ["/api/admin/questions", "learning"],
  ["/api/admin/content", "learning"],
  ["/api/admin/tprojects", "learning"],
  ["/api/admin/nominations", "learning"],
  ["/api/admin/enroll-requests", "learning"],
  ["/api/admin/attempts", "learning"],
  ["/api/admin/appeals", "learning"],
  ["/api/admin/assignments", "learning"],
  ["/api/admin/overview", "learning"],
  ["/api/admin/pending-counts", "learning"],
  ["/api/admin/catalog", "learning"],
  ["/api/admin/videos", "learning"],
  ["/api/admin/courses", "learning"],
  ["/api/admin/training", "learning"],
  ["/api/admin/ai/generate", "learning"],
  ["/api/admin/export/completion.csv", "learning"],
  ["/api/admin/export/attempts.csv", "learning"],
  [/^\/api\/admin\/employees\/[^/]+\/detail$/, "learning"], // 培训抽屉明细（MODULES.md 裁定④）
  // performance
  ["/api/me/reviews", "performance"],
  ["/api/admin/review-cycles", "performance"],
  ["/api/admin/review-items", "performance"],
  // talent
  ["/api/admin/succession", "talent"],
  ["/api/admin/talent-review", "talent"],
  ["/api/admin/talent-search", "talent"],
  ["/api/admin/promotion-config", "talent"],
  ["/api/admin/promotion-candidates", "talent"],
  [/^\/api\/admin\/employees\/[^/]+\/ai-portrait$/, "talent"],
];
function moduleOfPath(pathname) {
  for (const [pat, mod] of MODULE_ROUTES) {
    if (typeof pat === "string") {
      if (pathname === pat || pathname.startsWith(pat + "/")) return mod;
    } else if (pat.test(pathname)) return mod;
  }
  return null;
}

const RBAC_DOMAINS = ["people", "learning", "performance", "talent", "fields", "brand", "audit", "accounts", "roles"];

const RBAC_SHELL = [
  /^\/api\/admin\/dashboard$/,
  /^\/api\/admin\/pending-counts$/,
  /^\/api\/admin\/instance$/,
  /^\/api\/admin\/integrity$/,
];
const RBAC_READONLY = [
  /^\/api\/admin\/export\/records\.csv$/,
  /^\/api\/admin\/export\/completion\.csv$/,
  /^\/api\/admin\/export\/attempts\.csv$/,
  /^\/api\/admin\/attempts$/,
  /^\/api\/admin\/talent-search$/,
];
const RBAC_ROUTES = [
  // --- employees family: domain depends on method/subpath ---
  { re: /^\/api\/admin\/employees$/, methods: ["GET"], domain: "learning" },   // 裁定① 载荷是培训报表
  { re: /^\/api\/admin\/employees$/, methods: ["POST"], domain: "accounts" },  // 建号
  { re: /^\/api\/admin\/employees\/bulk$/, domain: "accounts" },               // 批量建号
  { re: /^\/api\/admin\/employees\/bulk-reset$/, domain: "accounts" },         // 批量发临时密码
  { re: /^\/api\/admin\/employees\/bulk-update$/, domain: "people" },          // 批量改人员字段
  { re: /^\/api\/admin\/employees\/([\w-]+)\/profile$/, domain: "people" },
  { re: /^\/api\/admin\/employees\/([\w-]+)\/detail$/, domain: "learning" },   // 培训抽屉明细
  { re: /^\/api\/admin\/employees\/([\w-]+)\/secondary-lines$/, domain: "people" },
  { re: /^\/api\/admin\/employees\/([\w-]+)\/records$/, domain: "people" },
  { re: /^\/api\/admin\/employees\/([\w-]+)\/reset$/, domain: "accounts" },    // 重置单人密码
  { re: /^\/api\/admin\/employees\/([\w-]+)\/ai-portrait$/, domain: "talent" }, // AI 画像（按写）
  { re: /^\/api\/admin\/employees\/([\w-]+)$/, domain: "people" },             // PUT 主数据（generic, last）
  // --- 员工与组织 people ---
  { re: /^\/api\/admin\/secondary-lines\/bulk$/, domain: "people" },
  { re: /^\/api\/admin\/secondary-lines\/([\w-]+)$/, domain: "people" },
  { re: /^\/api\/admin\/records\/bulk$/, domain: "people" },
  { re: /^\/api\/admin\/records\/([\w-]+)$/, domain: "people" },
  { re: /^\/api\/admin\/departments$/, domain: "people" },
  { re: /^\/api\/admin\/departments\/([\w-]+)$/, domain: "people" },
  { re: /^\/api\/admin\/org-chart$/, domain: "people" },
  { re: /^\/api\/admin\/org-diagnostics$/, domain: "people" },
  { re: /^\/api\/admin\/export\/records\.csv$/, domain: "people" },            // 裁定② readonly
  // --- 培训 learning ---
  { re: /^\/api\/admin\/upload-video$/, domain: "learning" },                  // pre-gate 自查亦查此域
  { re: /^\/api\/admin\/attachments$/, domain: "learning" },                   // pre-gate 自查亦查此域
  { re: /^\/api\/admin\/programs\/([\w-]+)\/assignees$/, domain: "learning" },
  { re: /^\/api\/admin\/programs\/([\w-]+)$/, domain: "learning" },
  { re: /^\/api\/admin\/programs$/, domain: "learning" },
  { re: /^\/api\/admin\/exams\/([\w-]+)\/questions$/, domain: "learning" },
  { re: /^\/api\/admin\/exams\/([\w-]+)\/reset-attempts$/, domain: "learning" },
  { re: /^\/api\/admin\/exams\/([\w-]+)$/, domain: "learning" },
  { re: /^\/api\/admin\/exams$/, domain: "learning" },
  { re: /^\/api\/admin\/assignments\/bulk$/, domain: "learning" },
  { re: /^\/api\/admin\/assignments$/, domain: "learning" },
  { re: /^\/api\/admin\/appeals\/([\w-]+)\/resolve$/, domain: "learning" },
  { re: /^\/api\/admin\/attempts\/([\w-]+)\/regrade$/, domain: "learning" },
  { re: /^\/api\/admin\/attempts$/, domain: "learning" },                      // readonly (no-method)
  { re: /^\/api\/admin\/catalog$/, domain: "learning" },
  { re: /^\/api\/admin\/nominations\/([\w-]+)\/decide$/, domain: "learning" },
  { re: /^\/api\/admin\/nominations$/, domain: "learning" },
  { re: /^\/api\/admin\/enroll-requests\/([\w-]+)\/decide$/, domain: "learning" },
  { re: /^\/api\/admin\/enroll-requests$/, domain: "learning" },
  { re: /^\/api\/admin\/tprojects\/([\w-]+)\/members\/update$/, domain: "learning" },
  { re: /^\/api\/admin\/tprojects\/([\w-]+)\/members$/, domain: "learning" },
  { re: /^\/api\/admin\/tprojects\/([\w-]+)\/dashboard$/, domain: "learning" },
  { re: /^\/api\/admin\/tprojects\/([\w-]+)\/checkin\/([\w-]+)\/mark$/, domain: "learning" },
  { re: /^\/api\/admin\/tprojects\/([\w-]+)\/checkin\/([\w-]+)$/, domain: "learning" },
  { re: /^\/api\/admin\/tprojects\/([\w-]+)\/nominations$/, domain: "learning" },
  { re: /^\/api\/admin\/tprojects\/([\w-]+)$/, domain: "learning" },
  { re: /^\/api\/admin\/tprojects$/, domain: "learning" },
  { re: /^\/api\/admin\/training\/remind-overdue$/, domain: "learning" },
  { re: /^\/api\/admin\/overview$/, domain: "learning" },
  { re: /^\/api\/admin\/content\/programs\/([\w-]+)$/, domain: "learning" },
  { re: /^\/api\/admin\/content\/courses\/([\w-]+)$/, domain: "learning" },
  { re: /^\/api\/admin\/content$/, domain: "learning" },
  { re: /^\/api\/admin\/courses\/([\w-]+)\/checkin\/mark$/, domain: "learning" },
  { re: /^\/api\/admin\/courses\/([\w-]+)\/checkin$/, domain: "learning" },
  { re: /^\/api\/admin\/videos$/, domain: "learning" },
  { re: /^\/api\/admin\/export\/completion\.csv$/, domain: "learning" },       // readonly
  { re: /^\/api\/admin\/export\/attempts\.csv$/, domain: "learning" },         // readonly
  { re: /^\/api\/admin\/questions\/bulk$/, domain: "learning" },
  { re: /^\/api\/admin\/questions\/([\w-]+)$/, domain: "learning" },
  { re: /^\/api\/admin\/questions$/, domain: "learning" },
  { re: /^\/api\/admin\/ai\/generate$/, domain: "learning" },                  // AI 出题（按写）
  // --- 绩效 performance ---
  { re: /^\/api\/admin\/review-cycles\/([\w-]+)\/participants$/, domain: "performance" },
  { re: /^\/api\/admin\/review-cycles\/([\w-]+)\/due$/, domain: "performance" },
  { re: /^\/api\/admin\/review-cycles\/([\w-]+)\/close$/, domain: "performance" },
  { re: /^\/api\/admin\/review-cycles\/([\w-]+)$/, domain: "performance" },
  { re: /^\/api\/admin\/review-cycles$/, domain: "performance" },
  { re: /^\/api\/admin\/review-items\/([\w-]+)$/, domain: "performance" },
  // --- 人才发展 talent (ai-portrait handled in employees family) ---
  { re: /^\/api\/admin\/promotion-config$/, domain: "talent" },
  { re: /^\/api\/admin\/promotion-candidates$/, domain: "talent" },
  { re: /^\/api\/admin\/succession\/([\w-]+)$/, domain: "talent" },
  { re: /^\/api\/admin\/succession$/, domain: "talent" },
  { re: /^\/api\/admin\/talent-review$/, domain: "talent" },
  { re: /^\/api\/admin\/talent-search$/, domain: "talent" },                   // readonly（POST 纯查询）
  // --- 字段与配置 fields ---
  { re: /^\/api\/admin\/config\/records$/, domain: "fields" },
  { re: /^\/api\/admin\/config\/record-types\/([\w-]+)$/, domain: "fields" },
  { re: /^\/api\/admin\/config\/record-types$/, domain: "fields" },
  { re: /^\/api\/admin\/config\/record-fields\/([\w-]+)$/, domain: "fields" },
  { re: /^\/api\/admin\/config\/record-fields$/, domain: "fields" },
  { re: /^\/api\/admin\/job-grades$/, domain: "fields" },
  // --- 品牌 brand (brand-assets is pre-gate; self-check also reads this domain) ---
  { re: /^\/api\/admin\/brand-assets$/, domain: "brand" },
  { re: /^\/api\/admin\/brand-config$/, domain: "brand" },
  // --- 审计 audit ---
  { re: /^\/api\/admin\/audit$/, domain: "audit" },
  // --- 员工账号 accounts (D6: 可授予 + 受范围约束；建号/重置在 employees family 上面) ---
  //     其余 accounts 端点（POST /employees、/employees/bulk、/employees/bulk-reset、
  //     /employees/:id/reset）在 employees family 段已标 accounts，此处不重复。
  // --- 角色与授权 roles (D6: 恒超管、不可授予；接管原 accounts 的锁定) ---
  { re: /^\/api\/admin\/roles\/([\w-]+)$/, domain: "roles" },
  { re: /^\/api\/admin\/roles$/, domain: "roles" },
];

// rbacGate 依赖 canRead / resolveGrants（读库）；包成工厂，调用方注入按 grants 求值的桩。
function makeLegacyRbacGate({ canRead, resolveGrants }) {
  function rbacGate(user, pathname, method) {
    if (RBAC_SHELL.some((re) => re.test(pathname))) return null;
    // roster is the data source for every "pick people" UI (design W1): any of
    // people/learning/performance/talent at >= read is enough.
    if (pathname === "/api/admin/roster" && method === "GET") {
      if (["people", "learning", "performance", "talent"].some((d) => canRead(user, d))) return null;
      return { status: 403, error: "You don't have access to this. 你没有此项操作的权限。" };
    }
    // W1b — same rationale as roster, for the two REFERENCE catalogs: job-grades
    // (rank/grade/level names) and config/records (record types + their field
    // option lists). They carry no person's data, and every page that shows a job
    // level or a performance rating needs them to LABEL what it is already allowed
    // to show: 员工档案 (people) reads job-grades, 人才盘点 (talent) reads
    // config/records. Without this, HRBP's own roster page and talent-admin's own
    // 9-box each fired a 404 on mount. GET only — every WRITE stays in the fields
    // domain through RBAC_ROUTES below.
    if ((pathname === "/api/admin/job-grades" || pathname === "/api/admin/config/records") && method === "GET") {
      if (["people", "learning", "performance", "talent", "fields"].some((d) => canRead(user, d))) return null;
      return { status: 404, error: "Not found" }; // 与 none 域一致，不暴露端点存在
    }
    const route = RBAC_ROUTES.find((r) => r.re.test(pathname) && (!r.methods || r.methods.includes(method)));
    if (!route) return { status: 403, error: "You don't have access to this. 你没有此项操作的权限。" }; // fail closed
    // D6: roles domain (build/edit/delete roles + assign adminRoleId) is the real
    // privilege-escalation face — super-admin only, never grantable. accounts is
    // no longer walled here: it flows through the level check below (a role holding
    // accounts=manage may create/reset/deactivate, subject to per-target scope
    // checked inside each accounts handler).
    if (route.domain === "roles") return { status: 403, error: "Super-admin only. 仅超级管理员可操作。" };
    const write = RBAC_READONLY.some((re) => re.test(pathname)) ? false : method !== "GET";
    const level = resolveGrants(user)[route.domain];
    if (level === "manage") return null;
    if (level === "read") return write ? { status: 403, error: "You don't have access to this. 你没有此项操作的权限。" } : null;
    return { status: 404, error: "Not found" }; // none → indistinguishable from an unknown route
  }
  return rbacGate;
}

// 逐字原文（供「server.js 里的函数体未被改动」断言使用）。
const LEGACY_SOURCE = {
  moduleOfPath: "function moduleOfPath(pathname) {\n  for (const [pat, mod] of MODULE_ROUTES) {\n    if (typeof pat === \"string\") {\n      if (pathname === pat || pathname.startsWith(pat + \"/\")) return mod;\n    } else if (pat.test(pathname)) return mod;\n  }\n  return null;\n}",
  rbacGate: "function rbacGate(user, pathname, method) {\n  if (RBAC_SHELL.some((re) => re.test(pathname))) return null;\n  // roster is the data source for every \"pick people\" UI (design W1): any of\n  // people/learning/performance/talent at >= read is enough.\n  if (pathname === \"/api/admin/roster\" && method === \"GET\") {\n    if ([\"people\", \"learning\", \"performance\", \"talent\"].some((d) => canRead(user, d))) return null;\n    return { status: 403, error: \"You don't have access to this. 你没有此项操作的权限。\" };\n  }\n  // W1b — same rationale as roster, for the two REFERENCE catalogs: job-grades\n  // (rank/grade/level names) and config/records (record types + their field\n  // option lists). They carry no person's data, and every page that shows a job\n  // level or a performance rating needs them to LABEL what it is already allowed\n  // to show: 员工档案 (people) reads job-grades, 人才盘点 (talent) reads\n  // config/records. Without this, HRBP's own roster page and talent-admin's own\n  // 9-box each fired a 404 on mount. GET only — every WRITE stays in the fields\n  // domain through RBAC_ROUTES below.\n  if ((pathname === \"/api/admin/job-grades\" || pathname === \"/api/admin/config/records\") && method === \"GET\") {\n    if ([\"people\", \"learning\", \"performance\", \"talent\", \"fields\"].some((d) => canRead(user, d))) return null;\n    return { status: 404, error: \"Not found\" }; // 与 none 域一致，不暴露端点存在\n  }\n  const route = RBAC_ROUTES.find((r) => r.re.test(pathname) && (!r.methods || r.methods.includes(method)));\n  if (!route) return { status: 403, error: \"You don't have access to this. 你没有此项操作的权限。\" }; // fail closed\n  // D6: roles domain (build/edit/delete roles + assign adminRoleId) is the real\n  // privilege-escalation face — super-admin only, never grantable. accounts is\n  // no longer walled here: it flows through the level check below (a role holding\n  // accounts=manage may create/reset/deactivate, subject to per-target scope\n  // checked inside each accounts handler).\n  if (route.domain === \"roles\") return { status: 403, error: \"Super-admin only. 仅超级管理员可操作。\" };\n  const write = RBAC_READONLY.some((re) => re.test(pathname)) ? false : method !== \"GET\";\n  const level = resolveGrants(user)[route.domain];\n  if (level === \"manage\") return null;\n  if (level === \"read\") return write ? { status: 403, error: \"You don't have access to this. 你没有此项操作的权限。\" } : null;\n  return { status: 404, error: \"Not found\" }; // none → indistinguishable from an unknown route\n}",
};

module.exports = {
  MODULE_ROUTES, moduleOfPath, RBAC_DOMAINS, RBAC_SHELL, RBAC_READONLY, RBAC_ROUTES,
  makeLegacyModulesOn, makeLegacyRbacGate, LEGACY_SOURCE,
};
