// 模块清单（manifest）—— 本模块的唯一事实源（ARCHITECTURE-MODULAR.md §4，M0 起生效）。
//
// kernel/registry.js 加载并校验全部清单，由它生成 server.js 用的 MODULE_ROUTES（模块关门表）、
// RBAC_DOMAINS / RBAC_SHELL / RBAC_READONLY / RBAC_ROUTES 与静态门清单。不要再在 server.js 里手抄这些表。
//
// 字段速查（完整规则见 kernel/registry.js 文件头）：
//   routes[]  每条对应 server.js handleApi 里的一个分支（method/methods + path，path 为精确字符串或
//             与 handler 逐字相同的正则）。domain = /api/admin/* 的 RBAC 能力域，非后台路由为 null；
//             order = 在生成的 RBAC_ROUTES（或 shell:true 时的 RBAC_SHELL）里的首匹配位置，数字小者在前
//             —— 具体路径必须排在 :id 通配之前；readonly = 不论 HTTP 方法都按读算（RBAC_READONLY）；
//             rbac:"custom" = 由 rbacGate 里的手写规则判定；rbacPath = RBAC 闸门用的正则与 handler 不同时填。
//   gate[]    模块开关关门的路径空间（字符串 = 精确路径及其子路径；正则 = 整段匹配），按顺序进 MODULE_ROUTES。
//   static[]  handleApi 之外的静态门（按 normalize 后的小写路径前缀判定）。
//   tables[]  本模块拥有的表（照 MODULES.md §2.2 归属）。
"use strict";

// performance：绩效评估（可单独卖）—— 评估周期四步流程、HR 校准、员工端 Review 页；
// 关账产物写进 core 的 talent_records。
module.exports = {
  id: "performance",
  name: { zh: "绩效评估", en: "Performance" },
  version: "1.0.0",
  sellable: true,
  requires: ["core"],
  optional: [],

  // RBAC 能力域；order = 在 RBAC_DOMAINS 里的位置（决定 grants 对象的键序，前端角色页按此展示）。
  domains: [
    { id: "performance", name: { zh: "绩效", en: "Performance" }, order: 30 },
  ],

  // 模块开关关门的路径空间（顺序即 MODULE_ROUTES 中的顺序）。
  gate: [
    "/api/me/reviews",
    "/api/admin/review-cycles",
    "/api/admin/review-items",
    "/api/admin/review-reminders",
    "/api/admin/review-appeals",   // 第二批 2.8（2026-10-08）绩效申诉台与 HRBP 分工
    "/api/admin/orgperf",          // 组织绩效（2026-10-10）
  ],

  static: [
  ],

  routes: [
    { method: "GET", path: "/api/me/reviews", domain: null },
    { method: "POST", path: /^\/api\/me\/reviews\/([\w-]+)\/self$/, domain: null },
    { method: "POST", path: /^\/api\/me\/reviews\/([\w-]+)\/nudge$/, domain: null },
    { method: "POST", path: /^\/api\/me\/reviews\/([\w-]+)\/manager$/, domain: null },
    { method: "POST", path: /^\/api\/me\/reviews\/([\w-]+)\/one-on-one$/, domain: null },
    // 绩效流程 v2（迁移 65）：我的绩效、HoD 部门校准 —— 都挂在既有 gate「/api/me/reviews」之下
    { method: "GET", path: "/api/me/reviews/history", domain: null },
    { method: "GET", path: "/api/me/reviews/team-dashboard", domain: null }, // 绩效看板第一期：经理「我的团队」（2026-10-10）
    { method: "GET", path: "/api/me/reviews/hod", domain: null },
    { method: "PUT", path: /^\/api\/me\/reviews\/hod\/items\/([\w-]+)$/, domain: null },
    { method: "POST", path: "/api/me/reviews/hod/submit", domain: null },
    // 第二批 2.1 / 2.2（2026-10-08）：上级的单人评估页、HoD 一次保存多行、HoD 提醒上级 —— 都在既有 gate「/api/me/reviews」之下
    { method: "GET", path: /^\/api\/me\/reviews\/team\/([\w-]+)$/, domain: null },
    { method: "PUT", path: "/api/me/reviews/hod/items", domain: null },
    { method: "POST", path: "/api/me/reviews/hod/remind", domain: null },
    { methods: ["GET", "POST"], path: "/api/admin/review-cycles", domain: "performance", order: 670 },
    { methods: ["GET", "DELETE"], path: /^\/api\/admin\/review-cycles\/([\w-]+)$/, domain: "performance", order: 660 },
    { method: "POST", path: /^\/api\/admin\/review-cycles\/([\w-]+)\/participants$/, domain: "performance", order: 630 },
    { method: "PUT", path: /^\/api\/admin\/review-cycles\/([\w-]+)\/due$/, domain: "performance", order: 640 },
    // 第二批 2.2（2026-10-08）：HR 部门明细（只读），排在 :id 通配（660）之前
    { method: "GET", path: /^\/api\/admin\/review-cycles\/([\w-]+)\/depts\/([\w-]+)$/, domain: "performance", order: 643 },
    { method: "POST", path: /^\/api\/admin\/review-cycles\/([\w-]+)\/depts\/([\w-]+)\/confirm$/, domain: "performance", order: 644 },
    { method: "POST", path: /^\/api\/admin\/review-cycles\/([\w-]+)\/depts\/([\w-]+)\/return$/, domain: "performance", order: 645 },
    { method: "PUT", path: /^\/api\/admin\/review-items\/([\w-]+)$/, domain: "performance", order: 680 },
    { method: "POST", path: "/api/admin/review-reminders", domain: "performance", order: 675 }, // 评估按阶段批量提醒（2026-10-07 B6）
    { method: "POST", path: /^\/api\/admin\/review-cycles\/([\w-]+)\/close$/, domain: "performance", order: 650 },
    // 第二批 2.8（2026-10-08）绩效申诉 —— 员工端与征询人，都在既有 gate「/api/me/reviews」之下
    { methods: ["GET", "POST"], path: /^\/api\/me\/reviews\/([\w-]+)\/appeal$/, domain: null },
    { method: "POST", path: /^\/api\/me\/reviews\/([\w-]+)\/appeal\/withdraw$/, domain: null },
    { method: "POST", path: "/api/me/reviews/appeal-files", domain: null },             // 原始请求体上传，读体之前分发、自查 401 / 改密
    { method: "GET", path: "/api/me/reviews/appeal-consults", domain: null },
    { method: "GET", path: /^\/api\/me\/reviews\/appeal-consults\/([\w-]+)$/, domain: null },
    { method: "POST", path: /^\/api\/me\/reviews\/appeal-consults\/([\w-]+)\/opinion$/, domain: null },
    // 后台申诉台：rbac:"custom" = 后台闸门里先于 rbacGate 的手写规则 W2.8（生效中的 HRBP 分工或绩效可读，否则 404）；
    // 逐条可见性、可操作性在 handler 里按分工、数据范围与利益回避再判。rbac:"custom" 不带 order。
    { method: "GET", path: "/api/admin/review-appeals", domain: null, rbac: "custom" },
    { method: "GET", path: "/api/admin/review-appeals/summary", domain: null, rbac: "custom" },
    { method: "GET", path: "/api/admin/review-appeals/stats", domain: null, rbac: "custom" },
    { methods: ["GET", "PUT"], path: "/api/admin/review-appeals/coverage", domain: null, rbac: "custom" },  // 仅超级管理员（handler 内 403 super_admin_only）
    { method: "GET", path: /^\/api\/admin\/review-appeals\/([\w-]+)$/, domain: null, rbac: "custom" },
    // 动作（start / consult / decide / reassign）在 handler 里判定：注册表的 samplePath 不接受分组里的「|」择一写法
    { method: "POST", path: /^\/api\/admin\/review-appeals\/([\w-]+)\/([\w-]+)$/, domain: null, rbac: "custom" },
    // 已关闭周期补发结果通知、开放申诉期限（排在 :id 通配 660 之前）
    { method: "POST", path: /^\/api\/admin\/review-cycles\/([\w-]+)\/communicate$/, domain: "performance", order: 646 },
    // 组织绩效（负责人 2026-10-10，迁移 95）：一级部门负责人互评与季度组织绩效结果
    { method: "GET", path: "/api/me/reviews/orgperf", domain: null },   // 挂在既有 gate「/api/me/reviews」之下
    { method: "PUT", path: /^\/api\/me\/reviews\/orgperf\/rounds\/([\w-]+)$/, domain: null },
    { methods: ["GET", "POST"], path: "/api/admin/orgperf/rounds", domain: "performance", order: 681 },
    { method: "POST", path: /^\/api\/admin\/orgperf\/rounds\/([\w-]+)\/remind$/, domain: "performance", order: 682 },
    { method: "POST", path: /^\/api\/admin\/orgperf\/rounds\/([\w-]+)\/return$/, domain: "performance", order: 683 },
    { method: "GET", path: /^\/api\/admin\/orgperf\/rounds\/([\w-]+)\/export\.csv$/, domain: "performance", order: 684 },
    { methods: ["GET", "PUT", "DELETE"], path: /^\/api\/admin\/orgperf\/rounds\/([\w-]+)$/, domain: "performance", order: 685 },
    { method: "GET", path: "/api/admin/orgperf/results", domain: "performance", order: 686 },
    { method: "POST", path: "/api/admin/orgperf/results/import", domain: "performance", order: 687 },
  ],

  tables: [
    "review_cycles",
    "review_items",
    "review_dept_status",
    // 第二批 2.8（迁移 70）
    "review_appeals",
    "review_appeal_consults",
    "review_appeal_events",
    "hrbp_assignments",
    // 组织绩效（迁移 95，2026-10-10）
    "orgperf_rounds", "orgperf_targets", "orgperf_raters", "orgperf_answers", "orgperf_results",
  ],
};
