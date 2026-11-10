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

// learning：培训管理整域（可单独卖）—— 课程库、培训项目（训战营）、考试、题库、成绩与申诉、
// 学习申请、签到/班次/班级、员工端学-考-成绩全链路、视频、逾期提醒。
module.exports = {
  id: "learning",
  name: { zh: "培训管理", en: "Learning" },
  version: "1.0.0",
  sellable: true,
  requires: ["core"],
  optional: [],

  // RBAC 能力域；order = 在 RBAC_DOMAINS 里的位置（决定 grants 对象的键序，前端角色页按此展示）。
  domains: [
    { id: "learning", name: { zh: "培训", en: "Learning" }, order: 20 },
  ],

  // 模块开关关门的路径空间（顺序即 MODULE_ROUTES 中的顺序）。
  gate: [
    "/api/catalog",
    "/api/programs",
    "/api/courses",
    "/api/exam",
    "/api/exam-attempts",
    "/api/ai/assistant",
    "/api/me/tprojects",
    "/api/me/enroll-requests",
    "/api/me/sessions",
    "/api/me/classes",
    "/api/me/team",
    "/api/me/attempts",
    "/api/me/learning-record",
    "/api/me/programs",
    "/api/admin/upload-video",
    "/api/admin/attachments",
    "/api/admin/programs",
    "/api/admin/exams",
    "/api/admin/questions",
    "/api/admin/content",
    "/api/admin/tprojects",
    "/api/admin/nominations",
    "/api/admin/enroll-requests",
    "/api/admin/attempts",
    "/api/admin/appeals",
    "/api/admin/assignments",
    "/api/admin/overview",
    "/api/admin/pending-counts",
    "/api/admin/catalog",
    "/api/admin/videos",
    "/api/admin/courses",
    "/api/admin/training",
    "/api/admin/ai/generate",
    "/api/admin/ai/translate",
    "/api/admin/export/completion.csv",
    "/api/admin/export/attempts.csv",
    /^\/api\/admin\/employees\/[^/]+\/detail$/,
  ],

  static: [
    { prefix: "/videos" }, // 课程视频直链：learning 关闭时 404（MODULES.md §6.3）；登录与指派校验另见 serveStatic
  ],

  routes: [
    { method: "POST", path: "/api/admin/upload-video", domain: "learning", order: 220 }, // 闸门前处理（流式上传），handler 内按本域自查
    { method: "GET", path: "/api/admin/attachments/office-status", domain: "learning", order: 225 }, // 课件转换组件状态与待转换清单（P0 1.4）
    { method: "POST", path: "/api/admin/attachments/office-convert", domain: "learning", order: 226 }, // 在线补转存量 Office 课件（P0 1.4）
    { method: "POST", path: "/api/admin/attachments/media-transcode", domain: "learning", order: 227 }, // 第三批 5.7：课件内视频手动转码 / 重试
    { method: "GET", path: /^\/api\/admin\/attachments\/([\w-]+)\/media$/, domain: "learning", order: 228 }, // 第三批 5.7：一份课件的内嵌视频
    { method: "POST", path: "/api/admin/attachments", domain: "learning", order: 230 }, // 闸门前处理（流式上传），handler 内按本域自查
    { method: "POST", path: /^\/api\/me\/attempts\/([\w-]+)\/appeal$/, domain: null },
    { method: "*", path: "/api/programs", domain: null },
    { method: "*", path: "/api/catalog", domain: null },
    // 第四批 7（2026-10-08）：课程目录（公开课程，全员自主学习）—— 列表（?count=1 给导航）、课程简介、加入 / 退出自主学习
    { method: "GET", path: "/api/catalog/courses", domain: null },
    { method: "GET", path: /^\/api\/catalog\/courses\/([\w-]+)$/, domain: null },
    { methods: ["POST", "DELETE"], path: /^\/api\/catalog\/courses\/([\w-]+)\/enroll$/, domain: null },
    { methods: ["POST", "GET"], path: "/api/me/enroll-requests", domain: null },
    { method: "GET", path: "/api/me/tprojects", domain: null },
    { method: "GET", path: /^\/api\/me\/tprojects\/([\w-]+)$/, domain: null },
    { method: "POST", path: /^\/api\/me\/tprojects\/([\w-]+)\/checkin$/, domain: null },
    { method: "POST", path: /^\/api\/me\/tprojects\/([\w-]+)\/complete$/, domain: null }, // 线上活动学员完成（2026-10-06 五类活动）
    { method: "POST", path: /^\/api\/me\/tprojects\/([\w-]+)\/apply$/, domain: null },
    { method: "GET", path: "/api/me/sessions", domain: null },
    { method: "GET", path: /^\/api\/me\/sessions\/([\w.-]+)\/checkin$/, domain: null },
    { method: "POST", path: /^\/api\/me\/sessions\/([\w.-]+)\/checkin\/mark$/, domain: null },
    { method: "GET", path: "/api/me/team", domain: null },
    { method: "GET", path: "/api/me/classes", domain: null },
    { method: "GET", path: /^\/api\/me\/classes\/([\w-]+)\/(?!checkin(?:\/|$))([\w-]+)\/([\w-]+)$/, domain: null },
    { method: "GET", path: /^\/api\/me\/classes\/([\w-]+)\/checkin\/([\w-]+)$/, domain: null },
    { method: "POST", path: /^\/api\/me\/classes\/([\w-]+)\/checkin\/([\w-]+)\/mark$/, domain: null },
    { method: "*", path: /^\/api\/programs\/([\w-]+)$/, domain: null },
    { method: "*", path: /^\/api\/courses\/([\w-]+)$/, domain: null },
    { method: "POST", path: /^\/api\/courses\/([\w-]+)\/checkin$/, domain: null },
    { method: "POST", path: /^\/api\/courses\/([\w-]+)\/modules\/([\w-]+)\/complete$/, domain: null },
    { method: "GET", path: "/api/me/learning-record", domain: null },
    { method: "GET", path: /^\/api\/me\/programs\/([\w-]+)\/record$/, domain: null },
    { method: "GET", path: /^\/api\/me\/attempts\/([\w-]+)$/, domain: null },
    { method: "POST", path: "/api/exam/start", domain: null },
    { method: "PUT", path: /^\/api\/exam-attempts\/([\w-]+)\/draft$/, domain: null },
    { method: "POST", path: /^\/api\/exam\/([\w-]+)\/submit$/, domain: null },
    { method: "POST", path: "/api/ai/assistant", domain: null },
    { methods: ["GET", "POST"], path: "/api/admin/programs", domain: "learning", order: 260 },
    { method: "PUT", path: /^\/api\/admin\/programs\/([\w-]+)$/, domain: "learning", order: 250 },
    { method: "POST", path: /^\/api\/admin\/programs\/([\w-]+)\/exam-required$/, domain: "learning", order: 245 }, // 课程「需要结业考试」开关（下线/重新发布该课考试）
    { methods: ["GET", "POST"], path: "/api/admin/exams", domain: "learning", order: 300 },
    { methods: ["GET", "PUT"], path: /^\/api\/admin\/exams\/([\w-]+)$/, domain: "learning", order: 290 },
    { method: "GET", path: /^\/api\/admin\/exams\/([\w-]+)\/questions$/, domain: "learning", order: 270 },
    { method: "GET", path: /^\/api\/admin\/programs\/([\w-]+)\/assignees$/, domain: "learning", order: 240 },
    { method: "GET", path: /^\/api\/admin\/employees\/([\w-]+)\/detail$/, domain: "learning", order: 70 }, // 培训抽屉明细（MODULES.md 裁定④）
    { method: "POST", path: "/api/admin/assignments/bulk", domain: "learning", order: 310 },
    { method: "POST", path: /^\/api\/admin\/exams\/([\w-]+)\/reset-attempts$/, domain: "learning", order: 280 },
    { method: "POST", path: /^\/api\/admin\/appeals\/([\w-]+)\/resolve$/, domain: "learning", order: 330 },
    { method: "POST", path: /^\/api\/admin\/attempts\/([\w-]+)\/regrade$/, domain: "learning", order: 340 },
    { method: "POST", path: /^\/api\/admin\/attempts\/([\w-]+)\/ai-retry$/, domain: "learning", order: 345 }, // AI 重新初评（2026-10-05）
    { method: "POST", path: "/api/admin/attempts/bulk-reset", domain: "learning", order: 335 }, // 考试成绩批量重置作答次数（2026-10-07 B7）
    { method: "POST", path: "/api/admin/assignments", domain: "learning", order: 320 },
    { method: "GET", path: "/api/admin/assignments/preview", domain: "learning", order: 315 }, // 第三批 8.6：按部门 × 职级圈人的人数预览
    { method: "GET", path: "/api/admin/catalog", domain: "learning", order: 360 },
    { method: "GET", path: "/api/admin/pending-counts", domain: null, shell: true, order: 2 },
    { method: "GET", path: "/api/admin/nominations", domain: "learning", order: 380 },
    { method: "GET", path: "/api/admin/enroll-requests", domain: "learning", order: 400 },
    { method: "POST", path: /^\/api\/admin\/enroll-requests\/([\w-]+)\/decide$/, domain: "learning", order: 390 },
    { method: "POST", path: "/api/admin/enroll-requests/bulk-decide", domain: "learning", order: 395 }, // 批量通过 / 驳回选修课程申请（2026-10-06 B1）
    { methods: ["GET", "POST"], path: "/api/admin/tprojects", domain: "learning", order: 480 },
    { methods: ["GET", "PUT", "DELETE"], path: /^\/api\/admin\/tprojects\/([\w-]+)$/, domain: "learning", order: 470 },
    { method: "POST", path: /^\/api\/admin\/tprojects\/([\w-]+)\/members$/, domain: "learning", order: 420 },
    { method: "POST", path: /^\/api\/admin\/tprojects\/([\w-]+)\/members\/update$/, domain: "learning", order: 410 },
    { method: "POST", path: /^\/api\/admin\/tprojects\/([\w-]+)\/members\/bulk-update$/, domain: "learning", order: 405 }, // 批量调整期次 / 班级、批量退训（2026-10-06 B2）
    { method: "GET", path: /^\/api\/admin\/tprojects\/([\w-]+)\/dashboard$/, domain: "learning", order: 430 },
    { method: "GET", path: /^\/api\/admin\/tprojects\/([\w-]+)\/checkin\/([\w-]+)$/, domain: "learning", order: 450 },
    { method: "POST", path: /^\/api\/admin\/tprojects\/([\w-]+)\/checkin\/([\w-]+)\/mark$/, domain: "learning", order: 440 },
    { method: "POST", path: /^\/api\/admin\/tprojects\/([\w-]+)\/checkin\/([\w-]+)\/bulk-mark$/, domain: "learning", order: 445 }, // 签到 / 完成登记名单批量登记与撤销（2026-10-06 B3）
    { method: "GET", path: /^\/api\/admin\/tprojects\/([\w-]+)\/nominations$/, domain: "learning", order: 460 },
    { method: "POST", path: /^\/api\/admin\/nominations\/([\w-]+)\/decide$/, domain: "learning", order: 370 },
    { method: "POST", path: "/api/admin/nominations/bulk-decide", domain: "learning", order: 375 }, // 批量通过 / 驳回培养项目申请（2026-10-06 B1）
    { method: "POST", path: "/api/admin/training/remind-overdue", domain: "learning", order: 490 },
    { method: "GET", path: "/api/admin/training/search", domain: "learning", order: 495 }, // 第三批 4.2：培训概览全局搜索
    { method: "GET", path: "/api/admin/overview", domain: "learning", order: 500 },
    { method: "GET", path: "/api/admin/overview/people", domain: "learning", order: 501 }, // 第三批 4.2：看板数字下钻名单（含 CSV）
    { method: "GET", path: "/api/admin/content", domain: "learning", order: 530 },
    { method: "PUT", path: /^\/api\/admin\/content\/programs\/([\w-]+)$/, domain: "learning", order: 510 },
    { method: "POST", path: "/api/admin/content/bulk-update", domain: "learning", order: 515 }, // 课程库批量发布 / 下线 / 改分类（2026-10-07 B5）
    { methods: ["PUT", "DELETE"], path: /^\/api\/admin\/content\/courses\/([\w-]+)$/, domain: "learning", order: 520 },
    { method: "GET", path: /^\/api\/admin\/content\/courses\/([\w-]+)\/export$/, domain: "learning", order: 518 }, // CX-032 课程包导出（2026-10-09 验收）
    { method: "POST", path: "/api/admin/content/courses/import", domain: "learning", order: 519 }, // CX-032 课程包导入
    { method: "GET", path: /^\/api\/admin\/courses\/([\w-]+)\/checkin$/, domain: "learning", order: 550 },
    { method: "POST", path: /^\/api\/admin\/courses\/([\w-]+)\/checkin\/mark$/, domain: "learning", order: 540 },
    { method: "GET", path: /^\/api\/admin\/courses\/([\w-]+)\/public-impact$/, domain: "learning", order: 545 }, // 第四批 9.2：取消公开前的影响人数（范围内）
    { method: "GET", path: "/api/admin/videos", domain: "learning", order: 560 },
    { method: "*", path: "/api/admin/export/completion.csv", domain: "learning", order: 570, readonly: true },
    { method: "*", path: "/api/admin/export/attempts.csv", domain: "learning", order: 580, readonly: true },
    { method: "*", path: "/api/admin/attempts", domain: "learning", order: 350, readonly: true, readonlyOrder: 585 }, // readonly（无方法限定）；readonlyOrder 只为复现 M0 前 RBAC_READONLY 的列表顺序，.some() 判定与顺序无关
    { methods: ["GET", "POST"], path: "/api/admin/questions", domain: "learning", order: 610 },
    { method: "POST", path: "/api/admin/questions/bulk", domain: "learning", order: 590 },
    { method: "POST", path: "/api/admin/questions/bulk-update", domain: "learning", order: 595 }, // 题库批量改分值、改所属课程与模块（2026-10-06 B4）
    { methods: ["PUT", "DELETE"], path: /^\/api\/admin\/questions\/([\w-]+)$/, domain: "learning", order: 600 }, // PUT = 原地修改题目（2026-10-06）
    { method: "POST", path: "/api/admin/ai/generate", domain: "learning", order: 620 },
    { method: "POST", path: "/api/admin/ai/translate", domain: "learning", order: 621 },
  ],

  tables: [
    "progress",
    "attempts",
    "questions",
    "assignments",
    "content",
    "exams",
    "exam_courses",
    "content_versions",
    "enrollment_requests", // 遗留归档表，运行时零读零写
    "project_members",
    "activity_state",
    "attempt_appeals",
  ],
};
