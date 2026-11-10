// 已安装模块的启用列表（ARCHITECTURE-MODULAR.md §1：加一个新模块 = 新建 modules/<id>/ + 在这里登记）。
//
// 顺序有意义：kernel/registry.js 按这个顺序拼接各模块的 gate，生成 MODULE_ROUTES。
// core 必须排第一（其余模块都 requires core）。这里登记的是「装了哪些模块」，
// 不是「开了哪些模块」—— 可售模块的运行时开关仍由 config.json 的 modules 块与
// LMS_MODULES_OFF 决定（server.js modulesOn()）。
// culture（行为实践，2026-09-26 登记）的 manifest 写了 defaultOn: false：config.json 的 modules 块没写
// "culture" 时它是关着的，DigiPlus 部署在 config.json 里写 "culture": true 打开（见 config.json.example）。
// 装上即执行它的模块迁移（modules/culture/migrations/，关闭时也执行），关闭只关入口、不删数据。
// ai（AI 辅助，2026-09-29 登记）同样 defaultOn: false：IT 接入公司内部 AI 并经法务确认后，在 config.json 写 "ai": true
// （或由超级管理员在后台「系统设置 › 功能模块」页开启）。它没有自己的表与迁移（见 modules/ai/manifest.js）。
// ai（AI 辅助，2026-09-29 登记）同样 defaultOn: false：IT 接入公司内部 AI 并经法务确认后，在 config.json 写 "ai": true
// （或在后台「系统设置 › 功能模块」页由超级管理员开启）。它没有自己的表与迁移（见 modules/ai/manifest.js）。
"use strict";
// Unfolding Lab 版（2026-10-12）：行为实践（culture / 3+3）模块已删除，不再登记。
module.exports = ["core", "learning", "performance", "talent", "ai"];
