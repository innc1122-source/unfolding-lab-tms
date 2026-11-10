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

// talent：人才发展增值（可单独卖）—— 九宫格盘点、晋升答辩池、继任计划（含批量导入）、人才检索与人才筛选（第五批）、AI 画像。
// optional：晋升门槛读绩效评级与培训完成情况；对应模块关闭时门槛整条跳过（MODULES.md §4.1/P8）。
module.exports = {
  id: "talent",
  name: { zh: "人才发展", en: "Talent" },
  version: "1.0.0",
  sellable: true,
  requires: ["core"],
  optional: ["performance", "learning"],

  // RBAC 能力域；order = 在 RBAC_DOMAINS 里的位置（决定 grants 对象的键序，前端角色页按此展示）。
  domains: [
    { id: "talent", name: { zh: "人才发展", en: "Talent" }, order: 40 },
  ],

  // 模块开关关门的路径空间（顺序即 MODULE_ROUTES 中的顺序）。
  gate: [
    "/api/admin/succession",
    "/api/admin/talent-review",
    "/api/admin/talent-search",
    "/api/admin/promotion-config",
    "/api/admin/promotion-candidates",
    /^\/api\/admin\/employees\/[^/]+\/ai-portrait$/,
    "/api/admin/talent-portraits", // 画像草稿与已确认版本（迁移 58，AI 治理方案 2.5）
    "/api/admin/talent-filters", // 第五批 8.1 人才筛选（保存的筛选、运行、导出、AI 条件生成、晋升人工名单）
    "/api/admin/key-positions", // 12.2 关键岗位清单（增删改查、导入、从继任计划带入）
    /^\/api\/admin\/employees\/[^/]+\/controlled-tags$/, // 12.2 受控人才标签（高潜 / 关键人才 / 流失风险）的打标与取消
  ],

  static: [
  ],

  routes: [
    { method: "POST", path: /^\/api\/admin\/employees\/([\w-]+)\/ai-portrait$/, domain: "talent", order: 110 }, // AI 画像（按写）
    // 12.2 受控人才标签：talent 写（与档案页写标签同一闸）；排在 employees/:id（120）之前
    { method: "POST", path: /^\/api\/admin\/employees\/([\w-]+)\/controlled-tags$/, domain: "talent", order: 112 },
    { methods: ["GET", "PUT"], path: "/api/admin/promotion-config", domain: "talent", order: 690 },
    { method: "GET", path: "/api/admin/promotion-candidates", domain: "talent", order: 700 },
    // 第五批 8.2 继任导入与 7.1 批量加入（写权限）：handler 写在 succMatch 之前，order 排在 /succession/:id（710）之前
    { method: "POST", path: "/api/admin/succession/import/preview", domain: "talent", order: 705 },
    { method: "POST", path: "/api/admin/succession/import", domain: "talent", order: 706 },
    { method: "POST", path: "/api/admin/succession/bulk", domain: "talent", order: 707 },
    { methods: ["GET", "POST"], path: "/api/admin/succession", domain: "talent", order: 720 },
    { methods: ["PUT", "DELETE"], path: /^\/api\/admin\/succession\/([\w-]+)$/, domain: "talent", order: 710 },
    { method: "GET", path: "/api/admin/talent-review", domain: "talent", order: 730 },
    { method: "POST", path: "/api/admin/talent-search", domain: "talent", order: 740, readonly: true }, // readonly：POST 纯查询，不写库不落审计
    // 第五批 8.1 人才筛选：具体路径在前，/:id 在后
    { method: "GET", path: "/api/admin/talent-filters/catalog", domain: "talent", order: 741 },
    { method: "POST", path: "/api/admin/talent-filters/run", domain: "talent", order: 742, readonly: true }, // 纯查询（与 talent-search 同类）
    { method: "POST", path: "/api/admin/talent-filters/export", domain: "talent", order: 743, readonly: true }, // handler 内另判 canExportTalentRecords（people 读）
    { method: "POST", path: "/api/admin/talent-filters/ai-parse", domain: "talent", order: 744 }, // AI 调用按写算（与画像、翻译一致）
    // AI 人才画像的查看与处理：只按 talent 域权限与数据范围判定（负责人 2026-09-30 决定不再另要求员工档案 people 读权限），按「先取画像、再取员工、再判范围」的顺序判定
    { method: "GET", path: "/api/admin/talent-portraits", domain: "talent", order: 745 }, // 只按 talent 读 + 数据范围；负责人 2026-09-30 决定不再另要求员工档案（people）读权限
    { method: "POST", path: /^\/api\/admin\/talent-portraits\/([\w-]+)\/([\w-]+)$/, domain: "talent", order: 746 }, // confirm | discard | objection（handler 内判定，其余 404）
    { methods: ["GET", "POST"], path: "/api/admin/talent-filters", domain: "talent", order: 747 },
    { method: "POST", path: /^\/api\/admin\/talent-filters\/([\w-]+)\/members$/, domain: "talent", order: 748 }, // 晋升人工名单（include / exclude / remove）
    { methods: ["GET", "PUT", "DELETE"], path: /^\/api\/admin\/talent-filters\/([\w-]+)$/, domain: "talent", order: 749 },
    // 12.2 关键岗位清单（设计 b12-design 4.3）：读 talent 读、写 talent 写；具体路径（import/preview、import）在 /:id 之前
    { method: "POST", path: "/api/admin/key-positions/import/preview", domain: "talent", order: 711 },
    { method: "POST", path: "/api/admin/key-positions/import", domain: "talent", order: 712 },
    { methods: ["GET", "POST"], path: "/api/admin/key-positions", domain: "talent", order: 713 },
    { methods: ["PUT", "DELETE"], path: /^\/api\/admin\/key-positions\/([\w-]+)$/, domain: "talent", order: 714 },
  ],

  tables: [
    "succession",
    "talent_portraits", // AI 人才画像（迁移 58）：草稿、已确认、被替代、已丢弃（丢弃即清空正文）
    "talent_filters", // 第五批 8.1 保存的人才筛选（迁移 80；builtinKey = promotion 为内置「晋升评审候选」，迁移 81）
    "talent_filter_members", // 内置晋升筛选的人工名单（手动加入 / 排除，迁移 80）
    "key_positions", // 12.2 关键岗位清单（迁移 86）：nameKey 全局唯一，isKey = 1 计入继任覆盖率分母
    "talent_tag_events", // 12.2 受控人才标签的打标留痕（迁移 86，只追加；存量由数据迁移 87 补写）
  ],
};
