# 公开试用站

官网 `unfolding-lab.com/tms/` 的「免费试用」按钮指向这里，托管在 **Render 免费版**：
`https://unfolding-lab-tms.onrender.com/`（名字被占用时 Render 会加后缀，以 Render 页面显示的为准）

这是**演示环境**，不是正式部署。正式部署见 `GO-LIVE-CHECKLIST.md`。

## 访客看到什么

- 官网公开的试用账号：**UL-1032 / Demo1234**（绩优员工，员工端数据最全）。
  所有员工 UL-1001～UL-1100 的密码都是 Demo1234。
- 员工账号**不能改密码**（共用账号，一人改了别人就进不来）。
- 所有带后台权限的账号（ADMIN、UL-TEST、UL-1077）的密码换成了环境变量
  `DEMO_ADMIN_PASSWORD`，交接文档里的默认密码在这里**无效**。
- Render 免费版没人访问 15 分钟会休眠，下一位访客打开要等 30～60 秒唤醒。
  每次唤醒都从一份干净的演示库开始，访客改乱的数据会自动复原。

## 在 Render 上第一次部署

1. Render 后台 → **New → Blueprint** → 连 GitHub，选 `innc1122-source/unfolding-lab-lms`。
   它会读仓库里的 `render.yaml`，自动建好服务 `unfolding-lab-tms`（免费版、新加坡）。
2. 页面会要求填 `DEMO_ADMIN_PASSWORD`：填你自己定的后台密码（至少 8 位，只有你知道）。
3. 点 **Apply / Deploy**，等 5 分钟左右（打包时要先造演示库）。
4. 打开服务页顶部显示的 `https://….onrender.com` 地址，用 UL-1032 / Demo1234 登录确认。

以后往 GitHub 的 `main` 推代码，Render 会自动重新部署。

演示数据里的日期（「近 30 天入职」「本季度」等）按打包那天算。超过 7 天没有重新部署，
启动时会改为现造（唤醒多等约 30 秒）。想让它重新变快，在 Render 服务页点
**Manual Deploy → Deploy latest commit** 即可。

## 怎么实现的

| 文件 | 作用 |
|---|---|
| `render.yaml` | Render 蓝图：Docker、免费版、新加坡、`DEMO_ADMIN_PASSWORD` 部署时填 |
| `Dockerfile` | `node:24-slim`，时区设北京时间（签到「当天」按本地日期算）；打包时先造好种子库；不装依赖（前端已预构建在 `public/dist/`） |
| `scripts/demo-start.js` | 复制种子库（太旧就现造）→ 换后台密码 → 启动 `server.js` → 一直在线时每天 04:00 换新库 |
| `modules/core/routes.js` | `LMS_DEMO_LOCK_PASSWORDS=1` 时员工不能改密（只有试用站设这个变量） |
| `railway.json` | 换回 Railway（付费 Hobby）时用，同一个 Dockerfile |

改了 `web/src/` 下的前端，要先 `npm --prefix web install && npm run build:web`
把 `public/dist/` 重新构建并一起提交，否则线上还是旧界面。
