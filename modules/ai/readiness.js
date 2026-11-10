// 「已就绪」清单（方案第 7 节「顺序与接入联调」）：只有列在这里的功能才可能对真实网关发起调用；
// 未列入的功能不论 config.json 怎么写，aiFeatureState 一律返回 off_feature（原因 not_ready）。
// 测试环境（LMS_TEST_AI_LOCAL_ONLY=1，只能连回环地址）不受这张清单限制。
//
// 2026-09-29：数据最小化（S3）、审计限流预算（S4）、人工确认与告知（S5）全部完成并通过测试，
// 四项功能与连接测试一并列入。以后新增 AI 功能时，先不要列入，等它的最小化与人工确认落地后再加。
"use strict";
// 2026-10-06：AI 翻译列入 —— 数据最小化（人名脱敏、只发要译的字段）与人工确认（只出草稿，HR 审阅后保存）随功能一起落地。
// 2026-10-08：人才筛选 AI 条件生成（talentFilter）列入 —— 脱敏（只发 HR 那句话，花名册姓名替换）、输出校验（字段枚举 +
// 与手工条件同一个 validateFilter）、人工确认（不自动执行，HR 核对后点「查询」）随第 5 批一起落地。
module.exports = Object.freeze(["test", "assistant", "questionGen", "grading", "portrait", "translate", "talentFilter"]);
