# Unfolding Lab TMS · 其间

An open-source talent and learning management system for HR and L&D teams. Bilingual Chinese/English interface, built with Node.js, SQLite and React.

面向 HR 与学习发展团队的开源人才管理系统：连接员工档案、培训、考试、发展项目、绩效、人才盘点与继任。界面支持中文 / English。

## What is included / 功能

- Employee profiles, organization structure, scoped roles and audit trails / 员工档案、组织架构、分级权限与审计。
- Courses, question banks, exams, assignments and learning progress / 课程、题库、考试、指派与进度。
- Training cohorts, development projects and attendance / 培训期次、发展项目与签到。
- Performance cycles, calibration, appeals and organization performance / 绩效周期、校准、申诉与组织绩效。
- Nine-box reviews, key roles and succession / 九宫格、关键岗位与继任。
- Optional AI assistance, disabled until configured / 可选 AI 辅助，默认关闭。

## Quick start / 快速开始

Requires **Node.js 24 or later**. Prebuilt frontend files are included in `public/dist/`; the backend uses Node built-ins and needs no npm dependency installation.

### Local demo / 本机演示

```sh
node scripts/demo-start.js
```

Open the address printed in the terminal. Employee demo account: `UL-1032` / `Demo1234`. The demo administrator password is generated and printed in the terminal unless `DEMO_ADMIN_PASSWORD` is set. **The demo resets its synthetic data on restart and periodically; never use it for real records.**

演示启动器会生成虚构数据，重启和定时重置数据。只用于体验，不存放真实员工信息。Windows 也可运行 `start-demo.bat`（本地完整功能演示，与公开共享演示入口不同）。

### Persistent self-hosted instance / 正式自部署

```sh
cp config.json.example config.json
npm start
```

`config.json.example` sets `production: true`. First startup creates an administrator with a generated password printed in the terminal; sign in and change it. By default the server listens on `127.0.0.1:8765`. Set `PORT` to use another port. Use TLS through a reverse proxy for remote access. Read [deployment guide](docs/GO-LIVE-CHECKLIST.md) and [IT guide](docs/HANDOVER-IT.md) before operating a shared instance.

正式模式不会生成演示员工与课程。数据库、附件、配置与备份不提交 GitHub。不要用演示 Dockerfile 承载正式数据。

A persistent-data Docker entry point is provided as `Dockerfile.production`, with an example `compose.yaml`. The original `Dockerfile` remains **demo-only** so existing demo deployment instructions remain valid. See [self-hosting](docs/SELF-HOSTING.md).

## Development / 开发

```sh
npm --prefix web ci
npm run build:web
npm test
```

`web/package-lock.json` pins the frontend dependency tree. Source is in `web/src/`, backend in `server.js`, `store.js`, `kernel/` and `modules/`. Do not edit minified files in `public/dist/` directly.

See [contributing](CONTRIBUTING.md), [security](SECURITY.md) and [third-party notices](THIRD_PARTY_NOTICES.md).

## License and services / 许可证与服务

Project code is licensed under [Apache License 2.0](LICENSE). Third-party components and media retain their respective licenses. The Unfolding Lab name and logos identify the original project; the code license does not grant trademark rights.

Self-hosting is free. For implementation, data import, HR/L&D workflow configuration or maintenance inquiries: [hi@unfolding-lab.com](mailto:hi@unfolding-lab.com). Availability, scope and pricing are agreed separately; there is no hosted-service subscription or support SLA included with the code.

免费自部署；部署实施、培训流程配置、数据导入与维护可另行约定服务。开源代码不附带托管或服务承诺。
