// 模块清单（manifest）—— 本模块的唯一事实源（ARCHITECTURE-MODULAR.md §4）。字段规则见 kernel/registry.js 文件头。
"use strict";

// ai：AI 辅助（可单独卖，默认关闭）。四项功能的调用点留在各自归属模块的路由里（learning：学习助手、AI 出题、
// 简答题初评；talent：人才画像），由 server.js aiFeatureState() 在 handler 内判定是否可用 —— M0 冻结规则不允许
// 改动这些路由的归属。本模块只拥有「会产生真实调用」的连接测试接口；调用记录表（ai_calls、ai_notice_acks）与只读
// 治理接口属于 core（审计），模块关闭后仍可查看；画像表（talent_portraits）属于 talent。
// 方案：NEXT-WORK/specs/03-ai-governance-spec.md（v1.1）第 2.1 节。
module.exports = {
  id: "ai",
  name: { zh: "AI 辅助", en: "AI Assist" },
  version: "1.0.0",
  sellable: true,
  defaultOn: false,                 // 数据会离开系统边界：IT 接入完成后，在 config.json 的 modules 中写 "ai": true（或在「功能模块」页开启）
  requires: ["core"],
  optional: ["learning", "talent"], // 功能依赖：assistant / questionGen / grading → learning；portrait → talent
  domains: [],                      // 不新增能力域：治理接口复用 audit
  // 注意不能写 "/api/admin/ai"：字符串 gate 匹配全部子路径，会吞掉 learning 的 /api/admin/ai/generate
  gate: ["/api/admin/ai-governance/test"],
  static: [],
  routes: [
    { method: "POST", path: "/api/admin/ai-governance/test", domain: "audit", order: 836 }, // handler 内再限超级管理员
  ],
  tables: [],                       // 本模块没有自己的表（见文件头）
  // provides 是注册表预留字段（只接受、不解释）：登记功能目录，server.js 与后台「功能模块」页读它
  provides: {
    aiFeatures: [
      { id: "assistant", name: { zh: "AI 学习助手", en: "AI study assistant" }, owner: "learning", humanReview: "none", employeeFacing: true, defaultOn: true },
      { id: "questionGen", name: { zh: "AI 出题", en: "AI question drafting" }, owner: "learning", humanReview: "adopt", employeeFacing: false, defaultOn: true },
      { id: "grading", name: { zh: "简答题 AI 初评", en: "AI pre-scoring of short answers" }, owner: "learning", humanReview: "decisive", employeeFacing: true, defaultOn: true },
      { id: "portrait", name: { zh: "AI 人才画像", en: "AI talent portrait" }, owner: "talent", humanReview: "confirm", employeeFacing: false, defaultOn: false },
      // 2026-10-06：培训内容中英互译（课程、小节、题目、考试）。只出草稿，HR 审阅后保存。
      { id: "translate", name: { zh: "AI 翻译", en: "AI translation" }, owner: "learning", humanReview: "adopt", employeeFacing: false, defaultOn: true },
      // 2026-10-08（第 5 批 §8）：人才筛选的一句话转条件。只发送 HR 输入的那句话（人名先脱敏）与字段目录，不发任何员工数据；
      // 生成的条件填进编辑器，HR 核对后才查询。负责人 10/8 确认：AI 模块开启时默认开启，可在「功能模块」页关闭。
      { id: "talentFilter", name: { zh: "AI 条件生成（人才筛选）", en: "AI filter drafting (talent search)" }, owner: "talent", humanReview: "confirm", employeeFacing: false, defaultOn: true },
    ],
  },
};
