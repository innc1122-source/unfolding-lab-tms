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

// core：永远开着的 HR 底座 —— 认证/SSO、员工档案与名册、部门、组织架构（含矩阵）、
// 字段设置、职级体系、入转调离记录、审计、通知、后台角色与授权（RBAC）、附件机制、/api/env。
// sellable:false = 永开，没有开关、没有关门清单（gate 为空）。
// M0 起 core 的路由也逐条登记：「没列出的都算 core」的旧口径作废，
// 未登记的路由由 test/m0-route-guard.test.js 拦下。
module.exports = {
  id: "core",
  name: { zh: "核心人事", en: "Core HR" },
  version: "1.0.0",
  sellable: false,
  requires: [],
  // culture 装了才有它的事件；没装时注册表放行 core 对 culture.* 事件的订阅（事件不会来，处理函数照常校验登记）。
  optional: ["culture"],

  // RBAC 能力域；order = 在 RBAC_DOMAINS 里的位置（决定 grants 对象的键序，前端角色页按此展示）。
  domains: [
    { id: "people", name: { zh: "员工与组织", en: "People & org" }, order: 10 },
    { id: "fields", name: { zh: "字段与配置", en: "Fields & config" }, order: 50 },
    { id: "brand", name: { zh: "品牌设置", en: "Brand" }, order: 60 },
    { id: "audit", name: { zh: "审计日志", en: "Audit log" }, order: 70 },
    { id: "accounts", name: { zh: "员工账号", en: "Employee accounts" }, order: 80 },
    { id: "roles", name: { zh: "角色与授权", en: "Roles & access" }, order: 90 },
  ],

  // core 永开：不进关门表。
  gate: [
  ],

  static: [
  ],

  routes: [
    { method: "POST", path: "/api/admin/brand-assets", domain: "brand", order: 810 }, // 闸门前处理（流式上传），handler 内按本域自查
    { method: "GET", path: "/api/env", domain: null },
    { method: "POST", path: "/api/auth/login", domain: null },
    { method: "POST", path: "/api/auth/logout", domain: null },
    { method: "POST", path: "/api/auth/forgot", domain: null },
    { method: "POST", path: "/api/auth/reset", domain: null },
    { method: "GET", path: "/api/auth/lark/start", domain: null },
    { method: "GET", path: "/api/auth/lark/callback", domain: null },
    { method: "*", path: "/api/me", domain: null },
    { method: "POST", path: "/api/auth/change-password", domain: null },
    { method: "POST", path: "/api/me/ai-notice-ack", domain: null }, // 员工确认 AI 告知（方案 2.6）
    { method: "GET", path: "/api/me/growth", domain: null }, // MODULES.md §5 待定第 1 条：端点随 core 常驻，lms 片段在 handler 内按模块裁剪
    { method: "GET", path: "/api/me/notifications", domain: null },
    { method: "POST", path: "/api/me/notifications/read", domain: null },
    { method: "GET", path: "/api/me/roles", domain: null }, // MODULES.md §5 待定第 2 条：端点留在 core
    { method: "GET", path: /^\/api\/me\/reports\/([\w-]+)$/, domain: null }, // P3/D8 跨域聚合：故意不进关门清单，handler 内按模块逐片段裁剪
    { method: "GET", path: /^\/api\/attachments\/([\w-]+)$/, domain: null },
    { method: "GET", path: /^\/api\/attachments\/([\w-]+)\/media\/([\w-]+)$/, domain: null }, // 第三批 5.7：课件内视频播放流（同附件访问规则，handler 内校验）
    { method: "GET", path: "/api/admin/instance", domain: null, shell: true, order: 3 },
    { method: "GET", path: "/api/admin/integrity", domain: null, shell: true, order: 4 },
    { methods: ["GET", "PUT"], path: "/api/admin/brand-config", domain: "brand", order: 820 },
    { method: "GET", path: "/api/admin/audit", domain: "audit", order: 830 },
    // AI 治理（NEXT-WORK/specs/03-ai-governance-spec.md 2.1.1）：状态、用量、调用记录属于审计，归 core，ai 模块关闭后仍可只读查看。
    // 会产生真实调用的连接测试（/api/admin/ai-governance/test）归 ai 模块。
    { method: "GET", path: "/api/admin/ai-governance/status", domain: "audit", order: 831 },
    { method: "GET", path: "/api/admin/ai-governance/usage", domain: "audit", order: 832 },
    { method: "GET", path: "/api/admin/ai-governance/calls.csv", domain: "audit", order: 833 },
    { method: "GET", path: "/api/admin/ai-governance/calls", domain: "audit", order: 834 },
    // 功能模块开关页（负责人 9/28 决定）：roles 域 = 恒超级管理员（不可授予），handler 内再判一次
    { methods: ["GET", "PUT"], path: "/api/admin/modules-config", domain: "roles", order: 845 },
    // Masterlist Base 组织与员工同步（modules/core/larksync.js，2026-09-30）：roles 域 = 恒超级管理员，handler 内再判一次
    { methods: ["GET", "POST"], path: "/api/admin/lark-sync", domain: "roles", order: 846 },
    { method: "GET", path: "/api/admin/roster", domain: null, rbac: "custom" }, // rbac:"custom" = rbacGate 里的手写规则 W1：people/learning/performance/talent 任一 >= read 即放行
    { method: "GET", path: "/api/admin/dept-tree", domain: null, rbac: "custom" }, // 第二批 3.1 全站部门筛选的部门树；后台闸门里先于 rbacGate 的手写规则 W1c：同 roster 四域任一可读，否则 404
    { method: "POST", path: "/api/admin/employees/bulk-update", domain: "people", order: 50 },
    { method: "GET", path: "/api/admin/employees", domain: "learning", order: 10 }, // 裁定①：GET 载荷是培训报表 → learning 域；路由本身不随模块关门（归 core）
    { method: "POST", path: "/api/admin/employees", domain: "accounts", order: 20 }, // 建号
    { method: "PUT", path: /^\/api\/admin\/employees\/([\w-]+)$/, domain: "people", order: 120 },
    { method: "GET", path: /^\/api\/admin\/employees\/([\w-]+)\/profile$/, domain: "people", order: 60 },
    { methods: ["GET", "POST"], path: /^\/api\/admin\/employees\/([\w-]+)\/secondary-lines$/, domain: "people", order: 80 },
    { method: "DELETE", path: /^\/api\/admin\/secondary-lines\/([\w-]+)$/, domain: "people", order: 140 },
    { method: "POST", path: "/api/admin/secondary-lines/bulk", domain: "people", order: 130 },
    { method: "POST", path: /^\/api\/admin\/employees\/([\w-]+)\/records$/, domain: "people", order: 90 },
    { method: "POST", path: "/api/admin/records/bulk", domain: "people", order: 150 },
    { methods: ["PUT", "DELETE"], path: /^\/api\/admin\/records\/([\w-]+)$/, domain: "people", order: 160 },
    { method: "GET", path: "/api/admin/config/records", domain: "fields", order: 750 }, // GET 另有 rbacGate 手写规则 W1b（参考目录对五个域开放读）
    { method: "POST", path: "/api/admin/config/record-types", domain: "fields", order: 770 },
    { method: "DELETE", path: /^\/api\/admin\/config\/record-types\/([\w-]+)$/, domain: "fields", order: 760 },
    { method: "POST", path: "/api/admin/config/record-fields", domain: "fields", order: 790 },
    { methods: ["PUT", "DELETE"], path: /^\/api\/admin\/config\/record-fields\/([\w-]+)$/, domain: "fields", order: 780 },
    { methods: ["GET", "POST"], path: "/api/admin/departments", domain: "people", order: 170 },
    { method: "GET", path: "/api/admin/departments/hods", domain: "people", order: 172 }, // HoD 名单（3+3 前置）；具体路径排在 departments/:id 通配（180）之前
    { method: "GET", path: "/api/admin/departments/hods.csv", domain: "people", order: 174 }, // HoD 名单 CSV 导出（GET = 读）
    { methods: ["PUT", "DELETE"], path: /^\/api\/admin\/departments\/([\w-]+)$/, domain: "people", order: 180 },
    { method: "GET", path: "/api/admin/dashboard", domain: null, shell: true, order: 1 },
    // 12.2 工作台三层与名单（设计 b12-design 6.4 / 6.5；设计写的 order 2–5 已被 pending-counts / instance / integrity 占用，改用 6–9）：外壳路由，handler 内按模块开关 + 能力域逐块裁剪，名单接口对无权 metric 回 404
    { method: "GET", path: "/api/admin/workbench/todo", domain: null, shell: true, order: 6 },
    { method: "GET", path: "/api/admin/workbench/risk", domain: null, shell: true, order: 7 },
    { method: "GET", path: "/api/admin/workbench/structure", domain: null, shell: true, order: 8 },
    { method: "GET", path: "/api/admin/workbench/people", domain: null, shell: true, order: 9 },
    { method: "GET", path: "/api/admin/org-chart", domain: "people", order: 190 },
    { method: "GET", path: "/api/admin/org-diagnostics", domain: "people", order: 200 },
    { methods: ["GET", "PUT"], path: "/api/admin/job-grades", domain: "fields", order: 800 }, // GET 另有 rbacGate 手写规则 W1b（参考目录对五个域开放读）；写仍走 fields
    { method: "*", path: "/api/admin/export/records.csv", domain: "people", order: 210, readonly: true }, // 裁定② readonly：导出按读算
    { method: "POST", path: "/api/admin/employees/bulk", domain: "accounts", order: 30 },
    { method: "POST", path: /^\/api\/admin\/employees\/([\w-]+)\/reset$/, domain: "accounts", order: 100 },
    { method: "POST", path: "/api/admin/employees/bulk-reset", domain: "accounts", order: 40 },
    { methods: ["GET", "POST"], path: "/api/admin/roles", domain: "roles", order: 850 },
    { methods: ["PUT", "DELETE"], path: /^\/api\/admin\/roles\/(\d+)$/, domain: "roles", order: 840, rbacPath: /^\/api\/admin\/roles\/([\w-]+)$/ }, // handler 只认数字 id；RBAC 表历来用 [\w-]+，rbacPath 保留原闸门形状
  ],

  // 领域事件（ARCHITECTURE-MODULAR.md §5.3）：core 发布的首批人事事件。捕获点集中在 store.js 的
  // 写函数（createUser / updateUser / 部门写函数），信封、发件箱与分发机制见 kernel/events.js。
  // test/events-registry.test.js 核对这张清单与 store.js 实际发出的事件类型逐一相等。
  publishes: [
    "employee.hired",           // 新建员工（单个建号、批量建号、Lark 首次登录自动建号）
    "employee.transferred",     // 部门变化（data.from / data.to 含部门、一级、二级、三级部门）
    "employee.manager_changed", // 直属上级变化
    "employee.terminated",      // 在职→停用，或 empStatus 变为 exited（data.reason: deactivated | exited）
    "employee.reactivated",     // 不在职→在职（停用的账号重新启用，或 exited 改回在职状态）
    "department.renamed",       // 部门改名
    "department.moved",         // 上级部门变化（改挂靠、认领孤儿部门、上级被删除后变成一级）
    "department.deactivated",   // 部门停用或删除（data.deleted 区分）
  ],
  // core 订阅的事件（处理函数在 modules/core/hooks.js）：行为实践项目计分冻结时，为每名参与者写一条正式人才记录
  // （talent_records，类型 culture-program 由 store.js 数据迁移 51 种入；日期取 data.endDate；同一 programId + userId 只写一次）。
  subscribes: ["culture.program.completed"],

  tables: [
    "users",
    "sessions",
    "meta", // KV 基础设施，四域按 key 前缀读写（MODULES.md §4.1）
    "attachments", // 机制归 core（裁定⑤），现阶段读写者都在 learning
    "attachment_media", // 第三批 5.7 课件内视频（迁移 72），随 attachments 归 core
    "audit_logs",
    "notifications", // 站内信基础设施，写者跨域但全经 notify()
    "record_types",
    "record_fields",
    "talent_records", // 入转调离/员工历史；performance 关账会写入（MODULES.md §4.1 双模块写）
    "departments",
    "secondary_lines",
    "roles",
    "password_resets", // 自助重置密码令牌（MODULES.md §2.2 之后新增）
    "schema_migrations",
    "approvals", // MODULES.md §5 待定第 4 条：按清点建议，引擎（表）归 core，两个 kind 的路由随 learning
    "event_outbox", // 领域事件发件箱（迁移 49）：机制属内核，表随永开的 core 登记；各模块只经 publishes 写入
    "module_migrations", // 模块迁移记录（迁移 50）：store.runModuleMigrations 写入，每个已执行的 <module>-NNNN.sql 一行
    "ai_calls", // AI 调用记录（迁移 58）：只有元数据与用量、不存原文；归 core（审计），ai 模块关闭后仍可查看
    "ai_notice_acks", // 员工对 AI 告知的确认（迁移 58）
    "workbench_snapshots", // 12.2 工作台没有历史数据的指标（继任覆盖、管理幅度、流失风险）的每日快照（迁移 86）；无对外接口
  ],
};
