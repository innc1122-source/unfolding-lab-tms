# 其间 Unfolding Lab TMS — IT 运维交接

写给接手运维的人。假设你没参与开发，也不打算读 8000 行 JS。
每条命令都是在这套代码上实际跑过的；路径全部相对项目根目录
解压后的程序目录（下文写作 `<根目录>`）。

> **本篇为其间 Unfolding Lab 版（2026-10-12）。** 已去掉 Lark 接入与行为实践（3+3）模块；TMS 迁移到 **99**（下一个可用 100）。版本改动见 `docs/RELEASE-CHECKS.md`。

配套文档：
- `docs/HANDOVER-OVERVIEW.md` — 本次交接总览：包里有什么、10/01 以来的变化、上线当天要做的事（先读）
- `README.md` — 功能说明与 HR 侧操作（面向使用者）
- `docs/HANDOVER-SSC.md` — 给 SSC（HR 运营）的业务使用篇
- `docs/RELEASE-CHECKS.md` — API、数据表与状态口径的基线记录（改代码前读）
- `deploy/`（**不在这个交接包里**）— 源码仓库里另有一套 Linux 云部署脚本
  （systemd + Caddy + 每日备份，`install.sh` / `cloud-setup.sh` / `README-DEPLOY.md`）。
  没有随包交付，原因有两个：它写于旧 LMS 时期（端口 8765、服务名 `unfolding-lms`、
  密码 `unfolding888`、写死的域名与 Cloudflare 隧道 id 全是旧的），而且改名之后**没有再验证过**——
  交付一份没跑通的部署脚本比不交付更危险。本篇 §2 讲的 Windows 部署路径是**唯一经过验证**的方式。
  如果你们决定上 Linux，跟我要那份脚本当骨架参考（逻辑是对的，名字、地址和备份范围都要改）。

---

## 1. 这套东西是什么形状

三样东西，没有第四样：

| | 是什么 | 在哪 |
|---|---|---|
| 一个进程 | `node server.js`，纯 Node HTTP 服务（约 9,000 行；各模块的接口处理在 `modules\<模块>\routes.js`） | `<根目录>\server.js` |
| 一个文件 | SQLite 数据库，WAL 模式 | `<根目录>\lms.db`（+ `-wal` / `-shm`） |
| 一个静态目录 | React 构建产物 | `<根目录>\public\dist\` |

进程自带解释器：`<根目录>\runtime\node.exe` 是便携版 Node v22.23.1（83 MB，跟着项目走）。
**目标机器上不需要安装 Node、不需要 IIS、不需要 SQL Server、不需要 Docker。**
把整个文件夹拷过去，双击 `.bat` 就跑。

### 为什么没有 Docker / 数据库服务器

这是刻意的，不是没做完。存储层 `store.js`（2181 行）直接用 Node 22 内置的 `node:sqlite`，
运行时依赖数为零 —— 根目录的 `package.json` 里没有 `dependencies`，也没有 `node_modules`。
（`web\node_modules` 有 241 MB，但那是**只在构建前端时**才用到的，见第 6 节。）

这个决定对运维的直接影响：

- **备份 = 拷一个文件。** 没有 pg_dump、没有 mysqldump、没有数据库账号要管。
  但因为是 WAL 模式，"拷一个文件"要用对方法，见第 5 节。
- **迁移 = 拷整个文件夹。** 换服务器不需要重装环境、不需要对齐版本。
  唯一要小心的是 `lms.db` 的一致性快照，和 `config.json` 里的密钥。
- **没有连接池、没有独立 DB 进程要监控。** 进程活着 = 系统活着。
  健康检查一条 `GET /api/env` 就够。
- **单进程、单机。** 不能横向扩容，不能跑两个实例指同一个 `lms.db`
  （SQLite 支持多进程读写，但这套代码的会话清理、限流计数都在进程内存里，
  多实例会出怪事）。几千人规模以内不需要扩容。
- **升级会覆盖代码文件。** 数据（`lms.db`）、上传件（`data\`、`public\videos\`；品牌设置上传的 logo / favicon 自 2026-10-11 起在 `data\attachments\_brand\`，随每日备份）、
  密钥（`config.json`）都在同一个文件夹里，发布时必须显式排除，见第 6 节。

---

## 2. 部署与启动

### 2.1 Windows 上手动跑

```
双击 <根目录>\start-tms.bat
浏览器打开 http://localhost:8780
```

`start-tms.bat` 做的事就三行：

```bat
set PORT=8780
set LMS_NO_DEMO_USERS=1
"%~dp0runtime\node.exe" server.js
```

**Ctrl+C 是正确的停止方式** —— `server.js` 注册了 `SIGINT` / `SIGTERM` 处理，
会执行 `PRAGMA wal_checkpoint(TRUNCATE)` 把 WAL 合并回主库再退出。
直接在任务管理器里结束进程不会丢已提交的数据（SQLite 会在下次打开时自动恢复 WAL），
但会留下一个较大的 `lms.db-wal`。

### 2.2 只有一个启动入口

包里只有 `start-tms.bat`。源码仓库里还有一个 `start.bat`（旧 LMS 演示模式），
**故意没有随包交付**，原因是它不设任何环境变量，于是：

- `PORT` 走 `server.js` 的默认值 **8765** —— 而这份文档处处写 8767，照着做会打不开页面；
- `LMS_NO_DEMO_USERS` 没设，于是在 `isProduction()` 为假（没有 `config.json`，
  或里面 `"production"` 不是 true）时，**空库首启会创建一个演示管理员账号**
  `DEMO-ADMIN` / `manage2026` —— 这个密码写在 `store.js` 里，等于公开。

一个需要先读文档才知道不能双击的文件，不该出现在交接包里，所以直接不给。
如果你们后来从源码仓库拿到了它：认端口就行，**8767 = TMS 主系统，8765 = 旧演示**。

> 相关：`config.json` 里请保持 `"production": true`（模板里已经是了）。
> 它是唯一一个「不填就有安全后果」的字段 —— 见第 8 节。

### 2.3 环境变量全表

`server.js` / `store.js` 里读到的全部环境变量：

| 变量 | 默认 | 作用 |
|---|---|---|
| `PORT` | `8765` | 监听端口。`start-tms.bat` 设为 8767 |
| `LMS_HOST` | `127.0.0.1` | **监听地址。默认只绑回环** —— 局域网/外网访问不到 |
| `LMS_NO_DEMO_USERS` | 未设 | `=1` 时不创建任何演示**人员**（课程/题库演示内容仍在） |
| `LMS_PROD` | 未设 | `=1` 进入生产模式，见第 8 节 |
| `LMS_ADMIN_PASSWORD` | 未设 | 仅生产模式、仅全新空库首启时用作 ADMIN 初始密码 |
| `LMS_DB_PATH` | `<根目录>\lms.db` | 数据库文件位置 |
| `LMS_ATTACH_DIR` | `<根目录>\data\attachments` | 附件存放目录 |
| `LMS_AI_API_KEY` | 未设 | AI 网关密钥（`ai.provider.apiKeyEnv` 的默认值）。为空时回落到 `ai.provider.apiKey`，见 §10.3 |
| `NODE_OPTIONS=--use-system-ca` | 未设 | 让 Node 使用 Windows 系统证书库（企业 CA 已由组策略下发时，信任内部 AI 网关证书的首选做法），见 §10.3 |
| `NODE_EXTRA_CA_CERTS` | 未设 | 备选：内部 CA 证书（.pem）的路径 |
| `ANTHROPIC_API_KEY` | 未设 | **兼容保留**：没有 `ai.provider` 时等价于 `config.json` 的 `anthropicApiKey`；写了 `ai.provider` 后被忽略（§10） |
| `GEMINI_API_KEY` | 未设 | 同上，对应 `geminiApiKey` |
| `LMS_DISABLE_AI` | 未设 | `=1` 强制不调用任何 AI：任何环境下 AI 功能都按「未接入」处理，简答题转 HR 评分，**不会进入演示模式**（测试用） |
| **禁止** `NODE_TLS_REJECT_UNAUTHORIZED=0` | — | 会关闭整个进程的证书校验（含邮件）；检测到时 TMS 拒绝一切 AI 调用，见 §10.9 |
| `LMS_DISABLE_OFFICE_CONVERT` | 未设 | `=1` 视同没装 LibreOffice（状态显示「已停用」）：PPT / Word / Excel 上传一律被拒。只给测试用，生产不要设（见 2.6） |
| `LMS_SOFFICE` | 未设 | LibreOffice `soffice` 可执行文件路径，只有装在非默认位置时才要设（见 2.6） |
| `LMS_OFFICE_CONVERT_TIMEOUT_MS` | `120000` | 单个 Office 文件转 PDF 的超时（毫秒），限制在 1000–600000。超时按转换失败处理：上传被拒，补转记为失败（见 2.6） |
| `LMS_OFFICE_CONVERT_CONCURRENCY` | `1` | 同时进行的上传转换数，最大 2。后台批量补转另走一条通道，不占上传的名额（见 2.6） |
| `LMS_FFMPEG` | 未设 | ffmpeg 可执行文件路径，只有装在非默认位置时才要设；Windows 上必须是 `.exe`（见 2.7） |
| `LMS_DISABLE_VIDEO_TRANSCODE` | 未设 | `=1` 视同没装 ffmpeg（状态显示「已停用」）：PPT 内嵌视频只抽取、不转码。只给测试用，生产不要设（见 2.7） |
| `LMS_VIDEO_TRANSCODE_TIMEOUT_MS` | `1800000` | 单段视频的转码超时（毫秒，缺省 30 分钟），限制在 60000–10800000。超时按失败处理，可手动重试（见 2.7） |
| `LMS_VIDEO_TRANSCODE_CONCURRENCY` | `1` | 同时转码的视频数，最大 2（见 2.7） |
| `LMS_VIDEO_SRC_MAX_BYTES` | `21474836480`（20 GB） | 等待转码的源视频（附件目录里的 `*.src.*`）总量上限；超过后新抽取的视频不保存，显示「等待转码的视频已达存储上限」（见 2.7） |
| `LMS_VIDEO_SRC_SWEEP_HOUR` | `12` | 每天几点（服务器本地时间，0–23）删除已转码完成的源视频；缺省中午，避开 03:00 备份（见 2.7） |
| `LMS_FAKE_NOW` | 未设 | 伪造"现在"，**只在测试里设**，生产绝不要设 |
| `LMS_MODULES_OFF` | 未设 | 逗号分隔的模块 id（`learning,performance,talent,ai`），强制关闭，优先于 `config.json` 的 `modules` 与后台「功能模块」页（页面上显示为只读） |

> **`LMS_HOST` 是最容易踩的一个。** 默认 `127.0.0.1` 意味着别人在网络上访问不到。
> 两种正确做法：
> ① 同机装反向代理（推荐），代理走 localhost 连它 —— 保持默认即可；
> ② 确实要裸奔直连，才设 `LMS_HOST=0.0.0.0`，并自己在防火墙上把端口管好。

### 2.4 开机自启：两条路

**方案 A：任务计划程序（Task Scheduler）—— 零安装，代价是它不是真正的服务**

1. 任务计划程序 → 创建任务（不是"创建基本任务"）
2. 常规：勾"不管用户是否登录都要运行"、勾"使用最高权限运行"；
   配置为"Windows Server 2016 / Windows 10"
3. 触发器：新建 → 开始任务"启动时" → 勾"延迟任务时间 30 秒"
4. 操作：新建 → 程序或脚本 `C:\...\unfolding-lab-tms\runtime\node.exe`，
   参数 `server.js`，起始于 `C:\...\unfolding-lab-tms`
   （**"起始于"必填** —— `server.js` 用相对路径找 `lms.db`、`public`、`config.json`）
5. 环境变量任务计划程序不方便设，所以不要直接指 `node.exe`，
   更省心的做法是：程序填 `cmd.exe`，参数 `/c "C:\...\start-tms.bat"`，
   环境变量就由 bat 里那两行 `set` 负责。
6. 设置页：取消"如果任务运行时间超过…则停止任务"；
   勾"如果任务失败，按以下频率重新启动"（1 分钟，3 次）

代价：这是"计划任务"不是"服务"。进程崩了不会自动重启（只有任务本身失败才重试），
`services.msc` 里看不到它，日志只能靠自己重定向到文件。适合过渡期。

**方案 B：nssm（Non-Sucking Service Manager）—— 真正的 Windows 服务，推荐**

nssm 是单个 exe，不需要安装程序。下载解压后（管理员 CMD）：

```
nssm install UnfoldingLabTMS "C:\...\unfolding-lab-tms\runtime\node.exe" server.js
nssm set UnfoldingLabTMS AppDirectory "C:\...\unfolding-lab-tms"
nssm set UnfoldingLabTMS AppEnvironmentExtra PORT=8780 LMS_NO_DEMO_USERS=1
nssm set UnfoldingLabTMS AppStdout "C:\...\unfolding-lab-tms\logs\tms-out.log"
nssm set UnfoldingLabTMS AppStderr "C:\...\unfolding-lab-tms\logs\tms-err.log"
nssm set UnfoldingLabTMS AppRotateFiles 1
nssm set UnfoldingLabTMS AppRotateBytes 10485760
nssm set UnfoldingLabTMS Start SERVICE_AUTO_START
nssm start UnfoldingLabTMS
```

> ⚠ 以后再用 `nssm set UnfoldingLabTMS AppEnvironmentExtra …` 加变量（例如接入 AI 时的 `LMS_AI_API_KEY`、`NODE_OPTIONS=--use-system-ca`），
> 它会**整体替换**原有列表：必须先 `nssm get UnfoldingLabTMS AppEnvironmentExtra` 记下现有各项，再把新旧各项一起完整重设，
> 否则 `PORT=8780` 丢失、服务回到 8765，反向代理连不上。步骤见 §10.3。

（`logs\` 目录先手动建出来；`.gitignore` 已经把它排除了。）

nssm 会在进程退出时自动重启、把 stdout/stderr 落盘并轮转、
停止服务时先发正常的关闭信号（WAL 能干净合并）。
代价：多引入一个第三方 exe，需要走 IT 的软件准入。

> 生产模式下（`LMS_PROD=1`）**全新空库**首启会在标准输出里打印一次随机 ADMIN 密码，
> 且只打印一次。所以生产首启务必先把日志落盘（方案 B 天然满足），
> 或者干脆预先设好 `LMS_ADMIN_PASSWORD`，别去日志里捞。

### 2.5 反向代理

前面挂 Nginx / IIS ARR / Caddy 做 HTTPS 终止，应用继续只听 `127.0.0.1:8780`。
四件事必须做对：

**① 透传 `X-Forwarded-Proto` 和 `X-Forwarded-Host`。**
`config.json` 没写 `publicUrl` 时，邮件里的链接按这两个头拼出站点地址：
```
proto = X-Forwarded-Proto || (socket 加密 ? https : http)
host  = X-Forwarded-Host  || Host
```
代理不传这两个头，邮件里的链接就会变成 `http://127.0.0.1:8780/...`。

**② `Host` 头必须保持原样（不要改写成 127.0.0.1）。**
这条比上一条更容易翻车。所有 `POST` / `PUT` / `DELETE` 请求都过一道 CSRF 检查：

```js
if (["POST","PUT","DELETE"].includes(req.method) && req.headers.origin) {
  if (new URL(req.headers.origin).host !== req.headers.host)
    return send(res, 403, { error: "Cross-origin request rejected." });
}
```

浏览器发的 `Origin` 是用户看到的域名；如果代理把 `Host` 改成了 `localhost:8780`，
两者不相等 → **所有写操作全返回 403，读操作却完全正常**。
症状是"页面能打开、什么都保存不了"。Nginx 写法：

```nginx
location / {
    proxy_pass         http://127.0.0.1:8780;
    proxy_set_header   Host              $host;          # 不要写 $proxy_host
    proxy_set_header   X-Real-IP         $remote_addr;
    proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
    proxy_set_header   X-Forwarded-Proto $scheme;
    proxy_set_header   X-Forwarded-Host  $host;
    client_max_body_size 600m;                           # 见 ④
}
```

**③ WebSocket 不需要。** 这套系统没有任何长连接、没有 SSE、没有轮询以外的推送，
站内通知靠前端定时拉取。不用配 `Upgrade` / `Connection` 头。

**④ 上传体积上限要放开。** 视频上传上限是 500 MB（`MAX_VIDEO_BYTES`），
请求体就是文件字节本身（不走 multipart）。代理默认的 1 MB / 10 MB 上限会直接掐断。
Nginx 用 `client_max_body_size 600m`，IIS 要同时调 `maxAllowedContentLength`
和 `requestLimits`。同时把 `proxy_read_timeout` 放宽到 300s 以上；IIS 用 ARR 反向代理时，
ARR 的代理超时默认只有 120 秒（服务器场 → Proxy → Time-out），同样放宽到 300 秒以上 ——
PPT / Word / Excel 上传要等转换完成才返回，代理先超时的话 HR 只会看到 504。
客户端断开（代理超时、关页面）后服务端会立即停掉这次转换，不再占着转换通道。

**⑤ 静态资源缓存不用代理插手。** `serveStatic()` 已经按内容分好了：
`/assets/` 下的构建产物（文件名带内容 hash）发 `Cache-Control: public, max-age=31536000, immutable`；
HTML 和其他文件发 `no-cache`（必须回源校验，否则新版发布后老浏览器会拿着旧 HTML 引用已经不存在的 hash 资源）。
**不要在代理层再加一层缓存去覆盖它**，尤其不要缓存 HTML。

**⑥ 顺带一提 `X-Forwarded-For`。** 登录失败锁定（同一账号 + 同一 IP 连错 5 次锁 15 分钟）
用它来识别客户端 IP，但只在直连对端是回环地址时才信任，并且取**最右边**那一段
（左边的是客户端可伪造的）。代理按上面 Nginx 的写法用 `$proxy_add_x_forwarded_for` 即可。

### 2.6 必装：LibreOffice

服务器必装两个外部组件：本节的 **LibreOffice**（Office 课件转 PDF）和 2.7 的 **ffmpeg**（PPT 内嵌视频转 MP4，2026-10-08 第三批起）。
两者都不随交接包、都要 IT 在服务器上装；装好后都不用重启，后台「课程库 › 课件转换」页面同时显示两者的状态。

HR 上传 PPT / Word / Excel 课件时，服务端调 LibreOffice 无头模式把它转成 PDF，学员在线只读。
**Office 原文件在任何情况下都不提供下载**（2026-10-07 起，P0 1.3）。所以：

- **没装 LibreOffice，PPT / Word / Excel 上传会被拒绝**，HR 看到的提示是「服务器未安装课件转换组件，
  请先另存为 PDF 再上传，或请 IT 安装 LibreOffice」。PDF、视频、音频上传不受影响。
  服务启动时控制台也会打一行警告。
- **转换失败或超时**（文件损坏、加密、超过 2 分钟转不完）：上传同样被拒，不建附件记录、不留文件。
- **以前作为下载保存下来的存量 Office 附件**：学员端显示「待转换」，打不开、也下载不了，
  下载接口一律返回 409 `pending_conversion`，直到补转完成（见下文）。
- **Linux 部署脚本**：`deploy/install.sh` 第 3 步会装 LibreOffice 和 ffmpeg；`deploy/cloud-setup.sh`（Cloudflare 隧道方案）
  **不装，只检查并打印安装命令**（2026-10-08 起），用它部署的服务器须另外执行
  `sudo apt-get install -y --no-install-recommends libreoffice-impress libreoffice-writer libreoffice-calc`
  （ffmpeg 见 2.7），装好后在「课件转换」页点「重新检测」。

安装（在服务器上用管理员身份打开 PowerShell）：

```
winget install TheDocumentFoundation.LibreOffice
```

`findSoffice()` 会自己按 `ProgramFiles` 和 `ProgramFiles(x86)` 去找默认安装位置
（`…\LibreOffice\program\soffice.exe`），两个环境变量都没有时再退回 `C:\Program Files`
和 `C:\Program Files (x86)` 两条字面路径；Linux/macOS 的常见位置也在候选里。
**所以装在默认位置就不用配任何东西。**

只有装到了非默认位置（比如 D 盘）才需要显式指定：

```
LMS_SOFFICE=D:\Apps\LibreOffice\program\soffice.exe
```

**装好之后不用重启服务。** 后台「课程库」页头有「课件转换」按钮，打开的面板里点「重新检测」即可；
服务没找到转换器时也会每 60 秒自己重新找一次。面板里能看到：

- 状态（可用 / 未安装 / 已停用）、路径、版本号、最近一次转换的结果和耗时；
- 待转换清单：每个存量 Office 附件所在的「课程 › 模块 › 小节」（或「未被任何小节使用」）、大小、
  上传时间与上传人、文件是否缺失、上次失败的原因；
- 「全部转换」和每行的「转换」（需要培训写权限；只读角色只能看）：在服务运行中在线补转，不用停服，
  每一条都写审计（`attachment.convert` / `attachment.convert.fail`）。连续 3 个文件超时会自动中止整批，
  避免一个卡住的 LibreOffice 让每个文件都等满超时。

转换的几个细节（排查问题时用）：

- **上传和补转各走各的通道**：补转逐个进行，上传不会排在补转后面。上传的并发和单个文件的超时见
  第 1 节环境变量表的 `LMS_OFFICE_CONVERT_CONCURRENCY`、`LMS_OFFICE_CONVERT_TIMEOUT_MS`。
- **临时目录**：转换产物先写在附件目录旁边的 `<附件目录>.convert-tmp\`（缺省就是 `data\attachments.convert-tmp\`），
  转好并校验过（非空、以 `%PDF-` 开头）才移进附件目录。LibreOffice 每次用一个独立的临时配置目录，
  放在 `.convert-tmp\profiles\` 下。服务启动时会清掉这里超过 1 小时的残留（进程被强杀、断电留下的）。
  这个目录不在附件目录里面，所以备份脚本不会把它复制进备份。
- **超时**：超时的转换按进程号连同子进程一起结束（Windows 上 `soffice.exe` 只是启动器，真正干活的
  `soffice.bin` 是它的子进程，只杀启动器会留下占着文件的孤儿进程）。服务退出时也会这样结束正在进行的转换。
- **补转后的原文件**：先留在附件目录里，**下次服务启动时才删除**（连同 AI 出题时生成的 `<原文件>.txt`
  文字缓存）。原因是每天 03:00 的备份会先快照数据库、再复制附件目录，转换途中删文件会让当晚的附件备份失败，
  或者恢复出来的库指向一个不存在的文件。删除前会确认已没有任何附件记录再指向它；当时被占用删不掉的，
  留到再下一次启动。
- **离线补转**：服务停着、或者后台打不开时，可以用 `node scripts\convert-office-attachments.js`
  （服务运行中会拒绝执行）。它和服务端用的是同一套转换代码（`modules\learning\office-convert.js`），
  服务停着所以会直接删掉原文件，也会顺带清掉在线补转留下的原文件。
- `LMS_DISABLE_OFFICE_CONVERT=1` 等同于没装（状态显示「已停用」），只给测试用。

> **历史注意。** 2026-10-07 之前，没装 LibreOffice 或转换失败时，Office 文件会原样保留为**下载附件**；
> 现在一律拒绝上传，存量的原文件也不再提供下载（上文）。
> 2026-08-24 之前，候选路径里**只有** Linux/macOS ——
> 而部署目标是 Windows，于是 office→PDF 转换在 Windows 上是**静默失效**的：
> 上传不报错，附件只是退化成下载，没有任何提示。如果你们手上有那之前的版本，
> 那就必须显式设 `LMS_SOFFICE`。
> 现在 `server.js`、`scripts/convert-office-attachments.js`、`test/attachments.test.js`
> 三处用同一套探测顺序，`test/soffice-parity.test.js` 盯着它们不许漂移
> （漂移的症状很隐蔽：测试以为本机有转换器、服务端却找不到，于是报一个什么都没坏的红测试）。

### 2.7 必装：ffmpeg（课件视频转码，2026-10-08 第三批 5.7）

HR 上传 `.pptx` 课件时，服务端除了用 LibreOffice 转 PDF（2.6），还会把**嵌在 PPT 里的视频**取出来、记下它在哪一页，
再用 ffmpeg 转成浏览器都能播放的 MP4（H.264 + AAC）。学员翻到那一页时，视频在幻灯片下方自动播放。
任何格式的内嵌视频（.wmv、.avi、.mov、.mp4 …）都走 ffmpeg，上传方不用自己转。只认 `.pptx`；老格式 `.ppt` 照常转 PDF，
但不抽取视频（编辑器里有一句提示）。音频暂不处理（跳过并说明）。

**没装 ffmpeg 时的表现**（和 LibreOffice 不同，**不拒绝上传**）：
- 课件照常上传、PDF 照常可看；PPT 里的视频被取出来保存为「等待转码」；
- 学员翻到有视频的那页，看到「本页视频正在处理，稍后刷新即可观看」；
- 后台「课程库 › 课件转换」页的「视频转码（ffmpeg）」卡片显示「未安装」、安装说明和等待转码的视频清单，「全部转码」按钮不可用；
- 服务启动时控制台打一行 `[video] ffmpeg not found — PPT videos will wait for transcoding (HANDOVER-IT 2.7)`。

**装好之后不用重启**：服务每 60 秒自己重新检测一次，检测到可用后自动开始转码所有「等待转码」的视频；
也可以在「课件转换」页点「重新检测」立刻生效（重新检测至少间隔 10 秒）。重启服务同样会触发。

**Windows 安装**（服务器上用管理员身份打开 PowerShell，三选一）：

```
winget install --id Gyan.FFmpeg -e --scope machine
```

- ⚠ `--scope machine` 这个参数要在目标服务器上核对一次（winget 版本不同、包源不同时可能不支持，提示 scope 不可用就去掉它，
  但随后要确认装到了「所有用户」可见的位置，见下一条）。
- 或者下载官方静态构建，把 `ffmpeg.exe` 放到 `C:\Program Files\ffmpeg\bin\ffmpeg.exe`（这是默认候选位置之一）。
- 装在其他位置时设环境变量 `LMS_FFMPEG=D:\Apps\ffmpeg\bin\ffmpeg.exe`（Windows 上必须指向 `.exe`；`.cmd` / `.bat` 不接受，因为转码从不经过命令行外壳）。
- **服务以系统账户运行时**（nssm / LocalSystem，见 2.4），只为当前用户安装的 ffmpeg（`%LOCALAPPDATA%\Microsoft\WinGet\Links\`）
  对服务不可见 —— 要么按机器范围安装，要么设 `LMS_FFMPEG`。

探测顺序（唯一的一份实现是 `modules\learning\video-transcode.js` 的 `findFfmpeg()`，服务、离线脚本、测试都用它，
`test/ffmpeg-single-probe.test.js` 不许别处再写一份）：`LMS_FFMPEG` → `PATH` 里的 `ffmpeg.exe` →
`%ProgramFiles%\ffmpeg\bin\`、`%ProgramFiles%\WinGet\Links\`、`%ProgramData%\chocolatey\bin\`、`%LOCALAPPDATA%\Microsoft\WinGet\Links\` →
Linux / macOS 的 `/usr/bin/ffmpeg`、`/usr/local/bin/ffmpeg`、`/opt/homebrew/bin/ffmpeg`。

**Linux**：`deploy/install.sh` 第 3 步会装（`apt-get install -y --no-install-recommends ffmpeg`）并检查编码器；
`deploy/cloud-setup.sh` 只检查并打印这条命令。

**装好后的核对**（在服务器上执行）：

```
ffmpeg -hide_banner -version          第一行是 ffmpeg version …，「课件转换」页会显示这个版本号
ffmpeg -hide_banner -encoders         必须列出 libx264（或 h264_mf）和 aac；缺了状态显示「缺少编码器」
ffmpeg -hide_banner -demuxers         核对下面白名单里的格式名都在（mov,mp4,…,matroska,webm,…,flv）
```

转码时 ffmpeg 只允许读本地文件、只接受白名单里的容器格式（`-protocol_whitelist file`、
`-format_whitelist mov,mp4,m4a,3gp,3g2,mj2,avi,asf,matroska,webm,mpeg,mpegts,mpegvideo,flv`），不读标准输入、不经过命令行外壳。
白名单里的格式名在部署时要用 `-demuxers` 核对一次；某个名字不在列表里时，那一类视频会转码失败（显示「视频文件已损坏或格式无法识别」）。

**另外核对一次 LibreOffice 不导出隐藏幻灯片**：上传一份含隐藏页的 `.pptx`，PDF 页数应等于可见页数。
视频是按「第几张可见幻灯片 = PDF 第几页」对上的；页数对不上时编辑器里会提示页码可能错位。

**转码的几个细节（排查问题时用）：**

- **一次转一段**（`LMS_VIDEO_TRANSCODE_CONCURRENCY`，最大 2），进程优先级调低（低于正常），不会把服务器 CPU 吃满；
  单段超时 30 分钟（`LMS_VIDEO_TRANSCODE_TIMEOUT_MS`）。连续 3 段超时会停止本轮并在页面上提示「请检查服务器负载后重试」。
  已是 H.264 / AAC 的 MP4 / MOV 只重新封装（几秒），其余完整转码。
- **上限**：单段视频 500 MB、时长 4 小时、一份课件最多 50 段；等待转码的源视频总量 20 GB（`LMS_VIDEO_SRC_MAX_BYTES`）；
  抽取前要求磁盘剩余空间 ≥ 2 × 本次要抽取的量 + 5 GB，不够时那段视频不保存、显示「服务器磁盘空间不足」。
- **失败**：每段视频单独记失败原因，编辑器、「课件转换」页、通知（发给上传人）和审计里都写明是哪份课件第几页的哪段视频，
  例如「「产品培训.pptx」第 4 页「demo.wmv」：视频文件已损坏或格式无法识别」。能重试的在「课件转换」页逐行「重试」或「全部转码」
  （需要培训写权限）。审计动作：`attachment.media.extract`、`attachment.media.transcode`、`attachment.media.transcode.fail`、`attachment.media.retry`。
- **临时目录**：`<附件目录>.convert-tmp\v-*`（与 LibreOffice 共用 `.convert-tmp`），启动时清掉超过 1 小时的残留。
- **文件命名**（都平铺在附件目录里，03:00 备份会带上）：源视频 `<媒体 id>.src.<扩展名>`，产物 `<媒体 id>.mp4`。
- **源视频何时删除**：转码成功后源视频不再需要，**每天中午 12 点**（`LMS_VIDEO_SRC_SWEEP_HOUR`）和每次服务启动时删除，
  删除前确认已没有任何记录再引用它。⚠ 这**放宽**了 2.6 里「服务运行中不删附件目录里的文件」的做法：原规则的本意是不在 03:00 备份
  复制附件目录的时候删文件，中午与备份错开，所以仍然安全；**如果你们把备份改到中午附近，记得同时改 `LMS_VIDEO_SRC_SWEEP_HOUR`**。
- **遗留进程**：服务异常退出时可能留下正在转码的 ffmpeg。下次启动时按记下的进程号核对，**只有进程映像名确实是 `ffmpeg` / `ffmpeg.exe`**
  才结束它（进程号可能已被别的程序复用，映像名对不上的一律不碰）；超时的转码按进程号连同子进程一起结束（Windows 上 `taskkill /T /F`）。
  服务正常退出时也会结束正在进行的转码，下次启动把「转码中」的视频重新排队（显示「转码已取消（服务重启），会自动重新排队」）。
- **离线补转** `scripts\convert-office-attachments.js` 对存量 `.pptx` 也会抽取视频，但**只抽取、不转码**，视频留在「等待转码」，
  由服务启动后自动转。
- `LMS_DISABLE_VIDEO_TRANSCODE=1` 等同于没装（状态显示「已停用」），只给测试用。

**磁盘估算**：每段视频最终只留一份 MP4（通常不大于原视频；H.264 1080p 大约每分钟 5–15 MB），源视频在转码成功后的下一个中午删除。
但 03:00 的备份会把整个附件目录复制一份，**最近 14 天的备份都保留**（5.3），备份和活库在同一块盘上时，
一段 MP4 在这块盘上实际占 **1 + 14 = 15 份**。估算公式：

```
所需空间 ≈ 全部课件视频 MP4 总量 × 15  +  等待转码的源视频（≤ 20 GB）  +  转码过程中的临时文件（≈ 正在转的那段 × 2）  +  5 GB 余量
```

例：课件里一共 2 GB 视频 → 约 30 GB + 余量。视频多的话，建议把 `backups\` 放到另一块盘，或把附件备份改为增量（5.1 的说明不变）。

**安全**：只处理有培训写权限的管理员上传的 `.pptx` 里的视频；源格式按扩展名白名单；ffmpeg 只读工作目录里的本地文件；
产物校验 MP4 文件头（`ftyp`）后才进附件目录；PPT 里的外部视频链接（YouTube 等）只保存为链接、显示为「观看视频（外部网站 …）」，
服务端从不抓取或嵌入。学员取视频走附件同一套授权（8.5），并且不能在地址栏直接打开。

---

## 3. 配置文件 config.json

根目录下的 `config.json` 是**可选**的 —— 不存在也能完整跑起来（当前生产机上就没有这个文件，
`GET /api/env` 返回 `{"demo":false,…}`）。
模板见 **`config.json.example`**：把它复制成 `config.json` 再改。
（`.example` 里的 `_README` / `_brand` / `_ai` 这些下划线开头的键是注释，代码不读，可以留着。）

### 品牌

`config.json.example` 的 `brand` 段就是本产品的品牌：名字「其间 / Unfolding Lab」、logo（深底 / 浅底两版）、favicon、墨蓝 #23304a + 琥珀金 #eab048 配色，文件在 `public\assets\brand\`。
不配 `brand` 段时界面是通用品牌（Talent Platform / 人才管理平台）。也可以由超级管理员在后台「系统设置 › 品牌设置」修改。

### 字段表

| 字段 | 不填的后果 | 备注 |
|---|---|---|
| `publicUrl` | 按请求的 `X-Forwarded-Host` / `Host` 推导 | 邮件里的链接用它拼地址。填了就写全 `https://tms.xxx.com`，末尾斜杠会被去掉 |
| `ai` | AI 服务未接入（`modules.ai` 开启后各功能显示「未接入」，简答题由 HR 评分） | 服务商（协议、地址、密钥来源、模型）、功能开关、限流、预算、保留期，全部字段见 **§10.3** |
| `anthropicApiKey` | — | **兼容保留**：没有 `ai.provider` 时隐式生成 Anthropic 配置（默认模型 `claude-sonnet-5`）；写了 `ai.provider` 后被忽略。建议改为 `ai.provider`（§10） |
| `geminiApiKey` | — | 同上，对应 Gemini |
| `aiModel` | — | 同上：只在旧字段生效时覆盖默认模型名 |
| `email.provider` | **所有通知只在站内出现，不发邮件** | 目前只实现了 `"resend"`；填别的值会被当作未知 provider 跳过 |
| `email.apiKey` | 同上 | |
| `email.from` | 同上 | 形如 `Unfolding Lab <noreply@...>` |
| `production` | 开发模式 | `true` 等价于 `LMS_PROD=1`，见第 8 节 |
| `modules` | learning / performance / talent 开启，**ai 关闭** | 可售模块开关，如 `{ "learning": true, "performance": true, "talent": true, "ai": true }`。ai（AI 辅助）方向相反：**不写即关**，只有写 `true` 才开，见 §10。也可由超级管理员在后台「系统设置 › 功能模块」页开关（写回本文件并记审计） |
| `holidays` | 内置菲律宾公共假期清单（2026 年按 Proclamation No. 1006；2027 年只含法定固定日期与圣周） | 公共假期，`"YYYY-MM-DD"` 数组，写了就**整份替换**内置清单。用于成绩页「复核超期」提示：待复核答卷自交卷次日起扣除周末与这些日期后超过 3 个工作日即提示。**每年按总统府公告更新**（开斋节、宰牲节等由 NCMF 另行公告的日期要自己加上）。只影响提示，不影响成绩 |

**"AI 演示模式"具体是什么**（2026-09-29 起只能显式开启：`config.json` 写 `ai.demo: true`，未接入或出错**不会**自动进入）：
学习助手回复当前模块的小节标题并提示回到对应小节阅读；AI 出题按请求的题型与数量给标注「演示样题」的占位题；
简答题只显示关键词演示估分，**任何情况下都不计入成绩**（按决定性复核规则转 HR）；人才画像只列该员工真实的记录条数，
明确说明不做分析与判断。界面上统一显示「演示模式」横幅。生产数据的部署不要开启。

### 改完要不要重启

`readConfig()` 是**每次用到时重新读文件**的（`fs.readFileSync` + `try/catch`），
所以改 `config.json` 后 AI key、邮件配置在下一个请求就生效，理论上不必重启。

但有两个例外，实际上**建议一律重启**：
- `production` 字段被 `store.isProduction()` 在启动时用于播种逻辑，中途改没有意义；
- 启动日志里那行 `AI: ENABLED · provider=… · url=… · models: … · features: …` 是启动时打印的，不重启你没法从日志确认改对了。
  改完想验证，用后台「系统设置 › AI 治理」页（AI，含连接测试），或 `runtime\node.exe scripts\ai-check.js`（§10.5）。

### ⚠️ config.json 含密钥

`.gitignore` 已经把 `config.json` 排除了。请守住这条线：

- **不要**把 `config.json` 放进交接压缩包、邮件附件、共享盘、工单系统。
- **不要**提交到任何版本库。
- 交接时给的是 `config.json.example`；真实密钥单独通过密码管理器 / 密封信封传递。
- 顺带：`lms.db`、`backups\`、`data\`、`public\videos\`、`logs\` 也都在 `.gitignore` 里，
  它们是生产数据，同样不进版本库。

---

## 4. （本版本不含 Lark 接入）

本版本（其间 Unfolding Lab）不配置 Lark 登录与 Lark 人员同步：员工用工号 + 密码登录，人员由 HR 在后台新建或批量导入。

## 5. 备份与恢复

### 5.1 backup.bat 做了什么

```
双击 <根目录>\backup.bat
```

等价于 `runtime\node.exe scripts\backup.js`。它用只读方式打开数据库，执行

```sql
VACUUM INTO 'backups/lms-YYYYMMDD-HHMMSS.db'
```

然后打印文件路径、大小和恢复提示。

数据库快照成功之后，它还会把**库外的上传文件**一起备份（`lms.db` 里只存指针，
文件本体在磁盘上）——**有内容才拷**，目录为空或不存在时只打一行
`Files skipped: <路径> 为空或不存在，未拷贝。`，不会造出空目录：

| 源目录 | 备份落点 |
|---|---|
| `data\attachments\`（设过 `LMS_ATTACH_DIR` 的以它为准） | `backups\lms-<同时间戳>-files\attachments\` |
| `public\videos\` | `backups\lms-<同时间戳>-files\videos\` |

也就是说一次备份的产物是「`lms-<时间戳>.db` + （有上传文件时）`lms-<时间戳>-files\`」，
两者靠同一个时间戳配对。

拷贝中途出错时（磁盘满、文件正被占用）打的是
`Files FAILED: <路径> 拷贝出错，未产出副本（残留已清掉）—— <原因>`，
那半份副本会被**删掉**、退出码是 1。所以磁盘上出现的 `-files\<子目录>` 一定是完整的一份，
不会有「看着像备份、其实只拷了一半」的东西（半份被 5.4 的 `/MIR` 拷回原位会把原位删空）。
数据库快照在这之前就已经落盘，不受文件拷贝失败影响。

**为什么必须用 VACUUM INTO 而不是直接复制文件**：`lms.db` 跑在 WAL 模式下
（`PRAGMA journal_mode = WAL`），最近的写入可能还只在 `lms.db-wal` 里，没合并进主库。
直接 `copy lms.db backup.db` 会得到一个**缺最近数据**的库 ——
最坏情况是复制到一个正在被写的瞬间，拿到损坏文件。
`VACUUM INTO` 是 SQLite 提供的一致性快照，**服务运行中执行也安全**，不需要停服。

数据库产物是单个整理过的 `.db` 文件（无 `-wal` / `-shm`），比在线库小不少
（当前在线 `lms.db` 5.7 MB + `-wal` 1.9 MB，最近一个快照 2.1 MB）。

**如果你确实要用文件复制的方式**（比如整机快照、拷到别的机器），
那必须先停服（Ctrl+C 走正常关闭，触发 `wal_checkpoint(TRUNCATE)`），
然后连 `lms.db`、`lms.db-wal`、`lms.db-shm` **三个一起**拷。只拷一个就是数据丢失。

### 5.2 自动备份点：迁移前

除了手动备份，`store.js` 的 `backupBeforeMigration()` 会在**任何待执行的结构变更之前**
自动打一个快照，文件名形如 `lms-20260820-105130-pre-migration-v42.db`
（`v` 后面是这一批待执行的版本号，多个用 `-` 连）。
空库（`users` 表 0 行）跳过。备份失败只打 warning，不阻止启动。
启动日志里会有一行 `Pre-migration backup: <路径>`。

这意味着：**升级代码后第一次启动，自动就有了一个"升级前"的还原点。**

注意 TMS 的迁移分两批：结构迁移与数据迁移**各自**在有待执行项时备份一次。同一次启动两批都有待执行项时，会出现两份
`pre-migration-v<数字>` 快照：**时间最早、版本号最小的那份**是在任何迁移之前打的，才是升级前的状态；另一份是结构迁移已经执行
之后才打的。


### 5.3 保留策略与清理

```
runtime\node.exe scripts\backup.js --prune         只列出可清理的，不删
runtime\node.exe scripts\backup.js --prune --yes   真的删
```

⚠ `--prune` **不是只读检查**：它先照常做一次完整备份（`.db` + 有内容时的 `-files\`），
再列清单。也就是说「看一眼保留策略」会多出一份快照，视频多的时候还会多拷一整份视频目录。
想纯看规则，直接读下面几条即可。

规则（写在 `scripts/backup.js` 里）：

- 文件名含 `real-roster` / `pre-fake` / `premerge` / `pre-upstream` 的 → **永久保留**（里程碑）
- 最近 **14 天**内的 → 全部保留
- `pre-migration-vNN` 快照 → 只保留**版本号最高的 3 个**版本
- `pre-migration-vmodules-…` 快照（模块迁移前，没有 TMS 版本号）→ 单独归类，只保留**最新的 3 份**
- 其余（14 天前的普通备份、早期低版本 pre-migration、更早的模块迁移快照）→ 可清理
- `lms-<时间戳>-files\` 目录与同时间戳的 `.db` **配对处理**：`.db` 保留它就保留；
  `--prune --yes` 删掉 `.db` 时连带删掉它（清单里会标「连带 …-files\」），不留孤儿目录

设计意图：能回退到"最近两周的任意一天"和"最近三次结构变更之前"；
更早的快照对应的是已经迁移过去很多版的旧结构，留着只占地方。

> 数据库备份里同样有 AI 调用记录（`ai_calls`）与人才画像（`talent_portraits`）。它们在活库里按 §10.6 的保留期每天清理，
> **备份里的副本不随之删除**，按本节的备份保留策略另行管理；对外说明时不要写成「超过保留期即从所有位置删除」。

`backups\` 目录当前 30 个文件。**建议**：把 `backup.js` 挂到任务计划程序里每天跑一次
（例如凌晨 3 点），每月手动跑一次 `--prune` 看看列表再决定要不要 `--yes`。
不要把 `--prune --yes` 直接放进定时任务 —— 删除动作留给人。

`backups\` 不在版本库里，也**不在任何异地位置**。请另外安排把它同步到别的盘/共享/对象存储 ——
数据库和备份躺在同一块硬盘上，等于没有备份。

### 5.4 恢复（完整步骤）

任何恢复都是这四步，顺序不能变：

```
① 停服
     手动跑的：在窗口里 Ctrl+C
     nssm 服务：nssm stop UnfoldingLabTMS
     任务计划：结束任务，并确认 node.exe 进程真的没了
       tasklist | findstr node.exe

② 删掉当前库的三个文件（-wal / -shm 必须一起删！）
     del "<根目录>\lms.db"
     del "<根目录>\lms.db-wal"
     del "<根目录>\lms.db-shm"

     ↑ 只删 lms.db 而留着 -wal，SQLite 下次打开时会试图把旧 WAL 应用到
       新拷进来的库上，结果是要么报损坏、要么静默混入不属于它的数据。这是最容易犯的错。

③ 把备份复制成 lms.db
     copy "<根目录>\backups\lms-20260820-151933.db" "<根目录>\lms.db"

④ 起服，然后立刻验证
     start-tms.bat（或 nssm start UnfoldingLabTMS）
     用 ADMIN 登录，看人数、看某个人的培训记录对不对
```

**恢复前先给"当前这个坏库"也做一份备份**（`copy` 三个文件到别处，或 `backup.js`）。
恢复是破坏性操作，万一发现恢复错了版本，你还得回得来。

**附件和视频不在数据库里**：`data\attachments\` 和 `public\videos\` 是文件系统上的目录，
`lms.db` 里只存 `storageKey` 指向它们。`backup.js` 在数据库快照之后已经把它们
一起拷进 `backups\lms-<同时间戳>-files\`（见 5.1）。所以

- 只恢复 `lms.db`：附件记录还在、文件可能对不上（回退到旧库后，
  数据库里没有的新附件文件会变成孤儿；数据库里有而文件已删的会 404）
- 完整恢复要**同时**把文件回到对应时点：在第 ③ 步之后，把 `-files\` 下的两个子目录拷回原位

  ```
  robocopy "<根目录>\backups\lms-<同时间戳>-files\attachments" "<根目录>\data\attachments" /MIR
  robocopy "<根目录>\backups\lms-<同时间戳>-files\videos"      "<根目录>\public\videos"    /MIR
  ```

  原位就是：attachments → `<根目录>\data\attachments\`（设过 `LMS_ATTACH_DIR` 的以它为准）；
  videos → `<根目录>\public\videos\`。`/MIR` 是镜像覆盖，会把目录还原成备份时点的样子。
  `-files\` 下缺哪个子目录就跳过哪条（说明备份那一刻该目录是空的，
  或者那一份拷贝失败了 —— 那次运行的日志里会有 `Files FAILED`，见 5.1）。
- 这个 `.db` 旁边**没有** `lms-<同时间戳>-files\` 目录的：要么备份那一刻两个目录都是空的，
  要么是早于「连文件一起备」这个功能的旧备份 —— 后者的附件/视频只能停在当前状态，恢复前先自查

---

## 6. 升级与回滚

### 6.1 改了什么，决定了要做什么

| 改动范围 | 需要的动作 |
|---|---|
| 只改 `server.js` / `store.js` / `scripts\*` | 覆盖文件 → 重启服务。**不用** build |
| 改了 `web\src\**`（前端） | 必须在 `web\` 目录跑 `npm run build` → 产物落到 `public\dist\` → 重启 |
| 改了 `content.js` | 基本没影响 —— 它只是**首次建库**时的种子数据，库建好后改它不影响线上内容 |
| 改了 `store.js` 里的 `MIGRATIONS` / `DATA_MIGRATIONS` | 覆盖文件 → 重启，迁移自动执行（先自动备份） |

前端构建：

```
cd <根目录>\web
npm run build          （= vite build，输出到 ../public/dist，emptyOutDir）
```

这台机器上没有全局 `npm`，用仓库自带的 Node 直接调 vite，效果与 `npm run build` 完全一样：

```
cd <根目录>\web
..\runtime\node.exe node_modules/vite/bin/vite.js build
```

`web\node_modules`（241 MB）只在这一步用得到，**运行时不需要它**。
构建产物 `public\dist\` 也在 `.gitignore` 里 —— 意味着分发时要么带上构建好的 `dist`，
要么在目标机上具备构建能力。给 IT 的交接包**应该带上已构建好的 `public\dist\`**，
这样目标机完全不需要 npm。

Vite 的 `base` 是 `/next/`，所以构建产物的资源 URL 都以 `/next/` 开头；
服务端把 `/` 和 `/next/*` 都指向同一份 `public\dist`，两个入口是同一个应用。

### ⚠️ 改了前端没构建 = 最常见的"改了没生效"

浏览器拿到的永远是 `public\dist\` 里的**构建产物**，不是 `web\src\` 里的源码。
所以改完 `web\src\**` 不重新构建，改动一行也不会进 `public\dist\`：
这时候强刷（Ctrl+F5）、清缓存、换浏览器、重启服务、重启机器**全都没用**，界面还是旧的。
代价不在漏跑一条命令，而在接下来会有人花半小时去查后端、缓存、反向代理 —— 那三处都是好的。
覆盖发布时同理：发布包只带了新的 `server.js` 而 `public\dist\` 还是旧的，
就会出现"接口有新字段、界面没有新按钮"这种最难查的半新半旧状态。

构建完先确认两件事，再重启服务：

- 命令最后打印 `built in …` 且没有红色报错 —— 报错就是**没有产出**，旧 `dist` 原地不动；
- `public\dist\assets\` 里的文件时间戳是刚才 —— 时间戳没变就是没构建成功，别急着重启。

构建只重写 `public\dist\`（`emptyOutDir`：整目录先清空再重建），
不碰 `lms.db*` / `config.json` / `data\` / `public\videos\`，失败了重跑一次即可。

### 6.2 发布步骤（Windows，手动）

```
1. 备份           backup.bat（顺带记下产物文件名）
2. 停服           nssm stop UnfoldingLabTMS   ← 或 Ctrl+C
3. 覆盖代码       只覆盖 server.js / store.js / content.js / scripts\ / public\dist\
                  ⚠️ 绝对不要覆盖或删除：lms.db*  config.json  data\  public\videos\  backups\  logs\
                  （最省心的做法是把这几项从发布包里排除，参照 .gitignore 的清单）
4. 起服           nssm start UnfoldingLabTMS
5. 看日志         有没有 "Pre-migration backup: …" 和 "Migration NN failed"
6. 冒烟           smoke.bat --boot=backups\<第 1 步的备份>.db --accounts=<账号表.json> --lang=both
                  （用备份的副本起一次性服务，新代码 + 真实数据，不写正式库；见 7.2。
                    一次性服务的附件目录是空的，「课程学习」页上的课件会报 404，属预期，见 7.2）
7. 查正式服务     smoke.bat --base=http://127.0.0.1:8780 --live-ok --accounts=<账号表.json> --lang=both
                  （第 6 步查的是副本，不是重启后的 8767；这一步只登录和打开页面，会写登录会话与登录审计。
                    课件附件只有这一步查得到，这里应当 0 fail）
```

### 6.3 迁移机制

结构变更由 `store.js` 里两个数组管理，**共用同一个版本号命名空间**：

- `MIGRATIONS` —— 建表、加列、加索引，在播种之前跑
- `DATA_MIGRATIONS` —— 数据回填 / 清洗，在播种之后跑

（2026-10-12：两个数组合计 76 条，最高版本号 **99**，**下一个可用号 100**。版本号有历史空档，例如 75–79、82–84、88–89 没有使用，
**条数不等于最高版本号**，不用去找"丢掉"的版本号。旧库按版本号补跑缺的迁移，不要求号连续。）

已执行的版本记在 `schema_migrations` 表里，所以每条只跑一次。
每条包在自己的 `BEGIN` / `COMMIT` 里，失败即 `ROLLBACK` 并抛出
`Migration NN (name) failed and was rolled back: …` —— **进程会启动失败**，
这是刻意的：宁可起不来，也不要带着半迁移的库对外服务。

**怎么确认跑到第几版：**

```
runtime\node.exe -e "const{DatabaseSync}=require('node:sqlite');const d=new DatabaseSync('lms.db',{readOnly:true});console.log(d.prepare('SELECT version,name,appliedAt FROM schema_migrations ORDER BY version DESC LIMIT 5').all());d.close()"
```

（会打印一行 `ExperimentalWarning` 提到 SQLite，属正常。）

**在线库的版本可以低于代码，重启就会补上。** 例：写这一节时开发机上的在线库（8767）停在 96（10/10 下午重启时已补跑 94–96），
用它的只读副本按本版代码启动一次，执行了 97，并先落了 `…-pre-migration-v97.db`。

### ⚠️ 本版（2026-10-10）：从旧交接包升级时会跑哪些迁移

第一次用本版代码启动，会按 `schema_migrations` 里缺的版本号依次补跑，**执行前自动备份**（机制见 5.2，备份名里列出这一批的版本号）。
62 号以后各条的用途：

| 版本 | 名称 | 做什么 |
|---|---|---|
| 62 | question-points | 每题分值 |
| 63 | exam-fixed-questions | 考试固定题目组卷 |
| 64 | rbac-roles-consolidate | 内置角色收敛为 4 个：超级管理员 / 管理员 / 培训 / 绩效与人才 |
| 65 | review-flow-v2 | 绩效流程 v2：周期类型、三个截止日、配额、部门校准与确认 |
| 66 | project-member-cohort-log | 发展项目成员的期次轨迹 |
| 67 | users-potential-at | 潜力评定时间（人才盘点判断是否过期） |
| 68 | perf-talent-people-read | 已有库的「绩效与人才」角色补员工档案只读 |
| 69 | review-hod-proxy | HoD 代评标记 |
| 70 | review-appeals | 绩效申诉与 HRBP 分工 |
| 71 | record-type-manager-visible | 记录类型「经理可见」 |
| 72 | attachment-media | 课件附件的媒体信息（PPT 内嵌视频转码） |
| 73 | question-types-and-exam-options | 十种题型、考试选项顺序与按比例给分 |
| 74 | assignment-source | 区分指派与自主学习 |
| 80 | talent-filters | 人才筛选 |
| 81 | promotion-default-filter | 晋升评审默认筛选 |
| 85 | talent-tags-strip-emoji | 人才标签去掉表情符号 |
| 86 | workbench-key-positions-tag-events | 工作台关键岗位与标签事件 |
| 87 | talent-tags-controlled-map | 受控人才标签（高潜、关键人才、流失风险） |
| 90 | exam-pre-notice | 考前须知 |
| 91 | talent-filter-role-type-to-track | 人才筛选「岗位类型」改为「序列」 |
| 92 | promotion-threshold-f62 | 晋升评审候选按公司晋升门槛重设 |
| 93 | promotion-threshold-f62-missing-fail | 晋升门槛缺数据时按不满足处理 |
| 94 | deactivate-demo-admin | 停用演示管理员 `DEMO-ADMIN`（上线验收 CX-048） |
| 95 | org-performance | 组织绩效五张表：互评轮次、被评部门、评分人、答卷、季度结果 |
| 96 | orgperf-issue-required | 组织互评「卡点题必填」开关（轮次级，默认关） |
| 97 | review-appeal-category | 绩效申诉原因分类（旧申诉为空，统计记「未分类」） |
| 98 | review-appeal-category-submitted | 员工提交时选的申诉原因另存一列（员工端显示原选项；HRBP 改正只影响统计）；已有申诉按审计记录恢复原选项 |
| 99 | orgperf-publish | 组织互评轮次加 `publishedAt`：HR 结束互评后「发布结果」，被评部门负责人才看到本部门得分；旧轮次为未发布 |

要知道的几点：

- 启动日志里多出 `Pre-migration backup: …` 与 `[migration 94] DEMO-ADMIN deactivated (CX-048)` 属正常。
  启动完用上面的查询确认最高版本是 **99**，并确认 `DEMO-ADMIN` 为停用状态。
- 任何一条失败，进程起不来，库仍是那一批迁移之前的状态：别反复重启，按 6.4 换回旧代码对外服务，把日志原文交给开发。
- 每一条更早迁移的细节见 `docs/RELEASE-CHECKS.md` 对应批次（按版本号搜索）。

### 6.4 回滚

**回滚只改了代码、没跑过新迁移的版本**：把旧的 `server.js` / `store.js` / `public\dist\`
换回去，重启。数据库不用动。

**回滚跑过新迁移的版本**：`MIGRATIONS` 里**没有 `down()`** —— 迁移是单向的。
所以只能靠备份：

```
1. 停服
2. 代码回退到旧版本（旧的 server.js / store.js / public\dist\）
3. 按 5.4 的四步，把 lms.db 恢复成那个 …-pre-migration-vNN.db 快照
4. 起服，确认 schema_migrations 的最高版本回到了旧代码认识的那一版
```

**注意代码和库必须配套回退。** 旧代码 + 新库：多出来的列旧代码不认识，通常还能跑但会出怪数据；
新代码 + 旧库：会再跑一遍迁移（因为 `schema_migrations` 里没有那些版本），这个是安全的。
只有"代码退了、库没退"是危险组合。

**回滚窗口是有限的。** 迁移后产生的业务数据（新填的档案字段、新的考试记录）
在恢复旧快照时会一起丢掉。所以升级后要尽快验证，别拖到攒了三天数据才决定回滚。

**第 4 批（迁移 73、74，2026-10-09）的额外提示。** 两条迁移只加列（`questions.data`、
`exams.shuffleOptions / partialCredit / caseCount`、`assignments.source`）。若不得已"代码退了、库没退"：
回退**之前**必须先删除新题型（排序、匹配、分类、判断、多空填空、情境案例）的题目，或归档用到它们的考试 ——
旧代码把不认识的题型当简答题读，已出卷的考试会出现无法作答的题；自主学习的记录在旧代码里是没有截止日的普通指派，无害。
详见 HANDOVER-STATUS 1.49 (7)。

---

## 7. 日常检查

### 7.1 test.bat —— 逻辑回归

```
双击 <根目录>\test.bat          （调用 runtime\node.exe scripts\run-tests.js，分三步先后跑：
                                  [1/3] TMS 测试 test\*.test.js
                                  [2/3] 模块测试 modules\*\test\*.test.js（不含规模冒烟）
                                  [3/3] 串行：4,000 人规模冒烟与 Office 转换计时用例，单独运行）
```

分步跑是刻意的：TMS 测试会并行起很多服务进程；模块测试里的 4,000 人规模冒烟带计时上限，和其它测试文件并行跑时会因本机负载
超时（2026-09-29 负责人决定单独运行），所以放在最后一步，运行时没有别的测试进程。前一步失败也会接着跑后面各步；最后一行汇总
三步的退出码。当前数字见 `docs/RELEASE-CHECKS.md` 第 1 节最新一节。
`npm test`（`scripts/run-tests.js`）与 `test.bat` 是同一个脚本，供装了 Node 的机器使用。

- **跑在系统临时目录的一次性数据库上**（通过 `LMS_DB_PATH`），**不打开、不修改 `lms.db` 与 `config.json`**。
- 不调用真实 AI（`LMS_DISABLE_AI=1`）；Office 转换按「未安装」处理（`LMS_DISABLE_OFFICE_CONVERT=1`），
  需要转换的用例改用测试替身 `test\fixtures\fake-soffice.js`，所以本机装不装 LibreOffice 都不影响断言
- **不需要服务在跑**，它自己起自己的
- 最后一次完整运行（2026-10-10，交接打包前）的数字见 `docs/HANDOVER-OVERVIEW.md` 第一节；三步依次运行，第三步不能和别的测试同时跑
- 只想验证某一块时可以单独跑相关文件，例如 `runtime\node.exe --test test\orgperf.test.js`

**什么时候跑**：改任何 `.js` 之后、每次发布前、以及在新机器上第一次部署完之后
（它能证明这台机器上的 Node、SQLite、文件权限都正常）。

**退出码**：`0` = 全通过；`1` = 有失败（`test.bat` 在 `pause` 之后以 `exit /b` 返回；用脚本调用时写 `test.bat < nul`，
`pause` 就不会停住）。TAP 输出末尾的 `# fail N` 是关键行。
`--test` 模式下失败项会打印完整的断言 diff。

### 7.2 smoke.bat —— 逐页体检

**必须告诉它查哪个服务**（第二批起不再默认连 8767：体检会用账号登录，写登录会话和登录审计，
打开下属档案还会写一条 `manager.view_profile`）。不带参数双击只打印用法，退出码 `2`。

```
smoke.bat --boot=backups\lms-20261008-020000.db --accounts=D:\smoke-accounts.json --lang=both
    用这份库的「副本」起一次性服务来查（随机端口、系统临时目录，跑完即删），原文件只读不动。
    上线验收、发布后检查都用这种：新代码 + 真实数据，不写正式库。仓库根的 lms.db 会被拒绝，拿最近一份备份。
    一次性服务用的是系统临时目录里的空附件目录（不读 data\attachments），所以课件附件一律 404：账号被指派的课程
    有 PDF / PPT 附件时，「课程学习」每种语言（加 --layout 时每个视口）报 2 条 fail（控制台报错 + http-error 404
    /api/attachments/…）。这两条属预期，其余 fail 才要处理；附件要在下面 --base 查正式服务时看。

smoke.bat --base=http://127.0.0.1:8780 --live-ok --accounts=D:\smoke-accounts.json --lang=both
    直接查一个已经在跑的服务。端口是 8767 / 8812 / 5173 / 8797 / 8931 这几个常驻端口时必须加 --live-ok，
    否则拒绝（退出码 2）。发布后（6.2 第 7 步）用它查重启后的正式服务：附件读的是真实目录，这里应当 0 fail。

smoke.bat --boot
    全新空库 + 绩效 v2 夹具（一个 HoD、一个上级、三名员工、一个进行中的 v2 季度周期），开发机自检用，不需要账号表。
```

（`smoke.bat` 自己加了 `--json=smoke-report.json`；直接用 `runtime\node.exe scripts\smoke.js …` 时参数相同。）

- 用**系统自带的 Edge 无头模式**（`--headless=new`，临时 profile，跑完删）
  说 CDP 协议，走 Node 22 内置的 `WebSocket`。**不装 Playwright，零依赖。**
  找不到 Edge/Chrome 时用 `set SMOKE_BROWSER=D:\path\to\msedge.exe` 指过来
- 路由清单在 `scripts/smoke-routes.js`，现在 **60 条**（28 员工端 + 1 条只有部门负责人能进 + 29 管理端 + 登录 / 重置密码；2026-10-08 第三批后）。
  第三批新增培训概览的名单整页 `#/admin/training-overview?list=overdue` 与员工培训记录整页 `?person=<员工>`（库里取不到员工时跳过），
  课程库的就绪标记改为列表 `.co-ctable`（或无课程时的空状态）。
  绩效 v2 的地址栏直达也在里面：员工端 `#/review?view=team`、`?view=team&item=<评估条目>`、`?view=hod`，
  后台 `#/admin/reviews?cycle=<周期>&view=board`、`&view=depts`、`&view=depts&unit=<一级部门>`。
  带参数的路由由脚本先用管理员账号查出真实 id；库里没有对应数据（例如没有 v2 周期）就跳过并在开头列出原因。
  团队评估名单（`?view=team`）只在账号表的 `employee` 是进行中季度周期里的直属上级时跑，HoD 部门校准（`?view=hod`）
  只在有进行中的 v2 周期、且其中有 HoD 的部门时跑，否则都按「取不到参数」跳过（两个周期之间属正常）。
  库里有这样的周期、而账号表的 `hod` 不是任何部门的 HoD 时，HoD 那条仍会报没渲染出来 —— 那是账号表配错了。
- 一轮（单语言、单视口、两个账号）约 3–5 分钟。明细写进 `smoke-report.json`

**账号表**（`--accounts=<json 文件>`，或把同样的 JSON 放进环境变量 `SMOKE_ACCOUNTS`）。
文件放在程序目录以外，用完删掉；脚本只用它登录，不把密码写进报告。

```json
{
  "admin":    { "employeeId": "ADMIN",   "password": "…" },
  "employee": { "employeeId": "<有直属下属、且是进行中 v2 周期里上级的员工>", "password": "…" },
  "hod":      { "employeeId": "<某个一级部门的 HoD>", "password": "…" }
}
```

- 名字就是 `--as` 里用的名字。`admin` 和以 `-admin` 结尾的按后台账号处理，其余按员工端账号处理。
- 没写的沿用缺省值：`admin` = ADMIN / unfolding888，`employee` = T-00229 / Test1234（旧测试集账号；跑演示库时用 `--accounts` 指定，如 UL-1053 / Demo1234）。
  正式库的密码都不是这些，正式库体检**一定要给账号表**。`--boot`（不带库）用夹具账号，不需要账号表。
- `--as=admin,employee,hod` 逐个账号跑；缺省只跑 `admin,employee`。后台路由也给其他后台账号跑（没权限被转回
  工作台的记为「无权访问」跳过），不带参数的员工端路由也给其他员工端账号跑。

判定分两档：

| 档 | 检查项 |
|---|---|
| **fail** | 错误边界白屏、页面几乎空白、页面上出现字面的 `null` / `undefined`、整页横向滚动条、控制台报错、失败的请求、页面没渲染出来（ready 选择器等不到）；加 `--layout` 时手机宽度下文字跑出屏幕（`text-offscreen`） |
| **warn** | 中文界面里没翻译的英文、表格横向溢出、横滚条被 `max-height` 藏在长列表底部；加 `--layout` 时的其余版面项（文字溢出、省略号没有 title、日期 / 工号折行、按钮内容不居中、正文行宽过长或过短、分栏失衡、卡片不等高、卡片右侧大块空白、卡片套卡片）—— 这些需要人判断 |

常用参数：`--lang=both`（中英各跑一遍）· `--only=admin`（只跑 hash 或名称含 admin 的路由）·
`--headful`（亲眼看它点）· `--include-side-effects`（连"会真的开考"那类写数据的路由一起跑，默认跳过）·
`--timeout=12000`（单页超时毫秒）

版面检查（改过样式之后跑）：

```
smoke.bat --boot=<备份.db> --accounts=<账号表.json> --layout --lang=both ^
  --viewport=1440x900,390x844 --as=admin,employee,hod --shots=D:\smoke-shots
```

- `--viewport` 逐个视口跑，宽度小于 768 按手机模拟。`--shots` 每页截一张整页图，命中的元素加红框。
- `--baseline=<上次的 smoke-report.json>`：只报与上次相比**新增**的问题，有新增退出码就是 `1`。
  做法：样式改动前跑一次存下 json，改完再带 `--baseline` 跑一次。
- `--boot=<库>` 缺省不种夹具；想在库副本上也查 HoD 部门校准、团队评估，加 `--seed=v2`（只写进副本）。
  这时账号表里**只写 `admin`**：脚本先用夹具账号，再用账号表覆盖，账号表里写了 `employee` / `hod` 就会顶掉夹具的
  上级与 HoD，夹具帮不上这两条路由。
- 全新空库（`--boot` 不带库）没有培养项目和考试记录，「发展项目管理」「考试成绩」两条会报没渲染出来，属预期；
  要查这两页用一份有数据的库副本。

**退出码**：`0` = 没有 fail（可能有 warn）；`1` = 有 fail；带 `--baseline` 时只看新增，有新增为 `1`、否则 `0`；`2` = 脚本自身没跑起来
（没给目标、常驻端口没加 `--live-ok`、找不到浏览器、缺 `scripts/smoke-routes.js`、连不上服务、脚本异常）。
`2` 和 `1` 要分开看：`2` 不代表系统有问题。

**什么时候跑**：每次发布后、改过前端后、以及"用户说页面坏了但说不清哪一页"的时候。
**注意 `--include-side-effects` 会写数据**，只配 `--boot` 用，别对正在跑的正式服务加这个参数。
跑之前确认 `public\dist` 是当前源码构建出来的，否则验的是上一版前端。

### 7.3 smoke-selftest.js —— 体检脚本自己的体检

```
runtime\node.exe scripts\smoke-selftest.js --boot                              起一次性服务自检（推荐）
runtime\node.exe scripts\smoke-selftest.js --base=http://127.0.0.1:<端口>        对已在跑的服务自检
```

和 smoke.bat 一样必须指定服务，不带参数退出码 `2`；常驻端口同样要加 `--live-ok`（自检也会登录）。
管理员账号缺省 ADMIN / unfolding888，可用 `--accounts=<json>` 覆盖（只读其中的 `admin`）。

它在真实页面上逐个注入已知缺陷，确认每条检查真的会响（含每条版面检查，以及手机宽度下 `text-offscreen` 记 fail、桌面记 warn）。
存在的理由：smoke 报"干净"有两种可能 —— 系统真的干净，或者检查根本没在看，
**这两种在报告上长得一模一样**。

**改过 `scripts/smoke-checks.js` 之后先跑这个。** 平时不用跑。

### 7.4 手工健康检查

```
curl -s -o NUL -w "%{http_code}" http://localhost:8780/         期望 200
curl -s http://localhost:8780/api/env                            期望 {"demo":false,…}
```

`/api/env` 不需要登录、不返回任何秘密，适合做监控探针。
`demo:false` 说明 `LMS_NO_DEMO_USERS=1` 或生产模式生效了 —— 生产上这里出现 `true` 就该查启动参数。

日志方面：服务只往 stdout / stderr 写，没有内建日志文件。启动时打印两行
（监听地址、AI 状态），之后只在出错时打印（迁移失败、
`Pre-migration backup: …` 等）。**没有访问日志** —— 想要就在反向代理层记。
所以第 2.4 节里把 stdout 落盘不是可选项，是必须做的。

### 7.5 实例识别、完整性体检与写库护栏

排障三件套，都不用登服务器翻文件：

**「你连的是哪个库？」** —— `/api/env` 里有一个 `instance` 字段：数据库绝对路径的
sha256 前 8 位。不用登录就能看，不泄露路径；两套部署指纹不同就是库不同。
全量信息（真实库路径、schema 版本、启动时刻、Node 版本、内容缓存最后刷新时刻）
在 `GET /api/admin/instance`（要管理员登录）。用户报「数据不对」时先对指纹，
再谈别的 —— 一半的「数据丢了」其实是连错了库。

**完整性体检** —— 服务每次启动会自查一遍悬空引用（分配指向不存在的培训包、
考试指向不存在的课程等），有问题就在启动日志里每类打一行 `[integrity] …`，
并给所有管理员发一条站内信。随时可以 `GET /api/admin/integrity`（管理员）重查，
返回每类的数量和前 3 个样本 id。出现悬空引用的常见成因：有人在服务运行外
用脚本或 SQLite 工具直接改了库。

**写库护栏（锁文件）** —— 服务运行期间在库文件旁边放一个 `lms.db.server.lock`
（JSON，内容是 pid/端口/启动时刻），正常退出时自动删。随包的两个直写库脚本
（`convert-office-attachments.js`、`reset-for-uat.js`）启动时会看这个锁：
锁在、pid 还活着就**拒绝运行**，防止带着运行中的服务硬改库。要点：

- 正常流程：**先停服务，再跑脚本**。服务停了脚本直接放行，什么都不用设
- 服务被 `kill -9` / 断电会留下孤锁 —— 不用手删，脚本以 pid 存活为准，孤锁不拦人
- 明知风险仍要在服务运行中硬写：设 `LMS_ALLOW_LIVE_DB=1` 再跑（自负后果；
  跑完内容类改动会在服务的下一个请求生效，不用重启）
- `notify-due.js` 不受护栏限制 —— 它就是设计成与服务并行跑的（cron 每日提醒）

---

## 8. 安全

### 8.1 会话

- Cookie：`sid=<48 位十六进制随机>; HttpOnly; SameSite=Lax; Path=/; Max-Age=604800`
  生产模式（`isProduction()`）额外加 `Secure`
- token 来自 `crypto.randomBytes(24)`，不是可预测的自增/时间戳
- **服务端有状态**：`sessions` 表存 `token / userId / createdAt / expiresAt`，
  TTL 7 天，和 Cookie 的 Max-Age 一致。不是 JWT，所以**可以真正吊销**
- 过期会话在启动时清一次，之后每小时清一次（同时清理登录失败计数）
- 停用（离职）账号即时失效：每个请求都检查 `user.active`，`active=0` 直接当未登录处理，
  已经握着 cookie 的人立刻被踢下线
- 退出登录会删掉服务端那条会话记录
- 当前在线库里有 92 条会话记录（测试期间累积的）

### 8.2 密码

- `scrypt`：16 字节随机 salt（hex）+ 32 字节派生（hex），存成 `salt:hash` 一列
- 比较用 `crypto.timingSafeEqual`，不是 `===`
- 明文密码不落库、不进日志
- 工号形状在服务端也校验（`^[A-Za-z0-9][A-Za-z0-9-]{2,19}$`）——
  UI 和 API 两侧都拦，畸形工号写不进去
- 登录限流：同一 **账号 + 客户端 IP** 连错 **5** 次锁 **15 分钟**（进程内存，重启即清）。
  带上 IP 是为了让攻击者没法靠猛撞某个账号来把真正的主人锁在外面
- **新密码规则**（2026-09-29，修改密码与邮件重置密码同一校验，前后端都拦）：至少 8 位，须同时包含字母和数字，不能与工号相同，
  不能与原密码相同；拒绝时回 `{ error, code }`，code 为 `too_short`、`too_weak`、`same_as_employee_id`、`same_as_current`（修改密码
  另有 `current_password_incorrect`）。只在设定新密码时校验，已有密码照常登录。系统生成的临时密码至少含 1 个字母和 1 个数字
- HR 新建账号或重置密码后，该账号 `mustChangePassword=1`，
  **服务端强制**：除 `/api/me`、`/api/auth/change-password`、`/api/auth/logout` 外
  一律 403，不是靠前端藏按钮

### 8.3 生产模式 vs 开发模式

`isProduction()` = `LMS_PROD=1` **或** `config.json` 里 `"production": true`。

| | 开发/演示模式 | 生产模式 |
|---|---|---|
| 演示账号 | 建（`DP-1001` Juan、`DEMO-ADMIN`） | **不建** |
| 演示课程/题库/演示轨迹 | 建 | **不建** |
| 全新空库首启的 ADMIN 密码 | `unfolding888`（写在代码里） | `LMS_ADMIN_PASSWORD`，未设则随机生成并在日志里**只打印一次** |
| 登录页的演示凭据提示 | 显示 | 隐藏（`/api/env` 的 `demo:false`） |
| 会话 Cookie `Secure` | 不加 | **加**（所以必须 HTTPS，否则登不进去） |

**当前生产机跑的是"开发模式 + `LMS_NO_DEMO_USERS=1`"**，不是生产模式：
`/api/env` 返回 `demo:false` 是 `LMS_NO_DEMO_USERS` 的效果，不是 `LMS_PROD` 的。
差别在于 **Cookie 没有 `Secure` 标志**。
正式对外（有域名、有 HTTPS）之后应该切到 `LMS_PROD=1`。
注意切换时机：`LMS_PROD=1` 只影响**新库播种**和 Cookie/提示，
对已有的库不会做任何破坏性操作，所以中途切是安全的
（切完所有人需要重新登录一次，因为旧 cookie 没有 `Secure`）。

**跟模式无关、任何时候都开着的**：跨域写入拦截、安全响应头、附件鉴权、审计日志。

### 8.4 响应头与 CSRF

每个响应都带：

```
x-content-type-options: nosniff
x-frame-options: SAMEORIGIN
referrer-policy: strict-origin-when-cross-origin
```

（`referrer-policy` 刻意**不用** `same-origin` —— 内嵌的 YouTube 等播放器在 referrer
被完全剥掉时会拒播。`strict-origin-when-cross-origin` 只发 origin，不发完整 URL。）

**没有 CSP 头。** 如果贵司安全基线要求 CSP，得在反向代理层加，
并且要先测过内嵌视频和 `public/vendor/pdfjs` 还能不能用。

CSRF 防护是两层：`SameSite=Lax` 的 cookie，加上第 2.5 节那个
`Origin.host === Host` 的检查（只对 POST/PUT/DELETE、且只在浏览器发了 `Origin` 时生效）。
**再说一遍：反向代理改写 `Host` 会让所有写操作 403。**

### 8.5 附件与视频（2026-08-27 起保护级别拉平了，但落盘位置还是不一样）

**附件 —— 有鉴权：**
- 落盘在 `<根目录>\data\attachments\`（`LMS_ATTACH_DIR` 可改），文件名是不可猜的 `storageKey`
- **这个目录不在 Web 根下**，没有任何静态路由能直达
- 唯一出口是 `GET /api/attachments/:id`：必须登录；非 admin 还要满足
  "附件所属课程属于一个已发布、且已指派给这个员工的项目"。
  非 course 类型的附件（项目/活动/结项）目前**仅 admin** 可读
- 越权一律返回 **404**（不是 403）—— 不泄露"这个 id 存在"
- ppt/doc/xls 上传时转成 PDF（见 2.6），转不了就拒绝上传；PDF 走 `content-disposition: inline`（在线只读）。
  存量的 Office 原件一律返回 409 `pending_conversion`，**不提供下载**，只留作补转的源文件
- 支持 Range 请求（走 `serveVideo`），所以大 PDF 能拖动

**视频 —— 也有鉴权了（原来是没有的，2026-08-27 补上）：**
- HR 上传的视频落在 `<根目录>\public\videos\`，也就是**静态目录里面** ——
  这一点没变，所以它不像附件那样靠"目录不在 Web 根下"保护，而是靠 `serveStatic()`
  开头的一道显式闸门（`server.js` 的 `videoAccessAllowed()`）
- 规则和附件基本对齐：**必须登录**（会话有效，且账号没被停用）；
  持 `learning >= read` 的后台角色可以取全部（HR 建课时要预览）；
  员工只能取"被一个已发布、且已指派给他的项目所引用的课程"引用的视频
- 没有任何课程引用的视频（孤儿上传、或者章节被删掉了的）**只有后台能取**，员工一律不行
- 越权、文件不存在、learning 模块被关掉 —— **一律返回 404**，和附件同一个理由：
  静态 URL 是可以猜的，回 401 或 403 就等于告诉对方"这个文件存在"
- 前缀判定是在 `path.normalize()` 之后按小写做的，所以 `/VIDEOS/x.mp4`、
  `/videos\x.mp4` 这种写法绕不过去。判定过程里出任何异常都**按拒绝处理**
  （静态回调没有 try 兜底，宁可拒一个请求也不能让进程挂掉）
- 上限 500 MB，扩展名限 `.mp4` / `.webm` / `.m4v` / `.mov`，
  文件名会被清洗并去重（`name-2.mp4`）
- **仍然要提醒 HR 一句**：视频的授权粒度是"课程被指派给谁"，不是逐人授权；
  真正只给个别人看的东西，还是用附件通道
- 排障提示：员工反馈"视频打不开、页面报 404"，先看这三样 ——
  ① 课程所在项目是不是**已发布**，② 是不是**指派给他了**，
  ③ 章节里的视频文件名和 `public\videos\` 里的实际文件名**大小写是否完全一致**
  （生产是 Linux，大小写敏感；这里故意只认原样文件名）

**课件内视频（2026-10-08 第三批 5.7）：** PPT 内嵌视频转出来的 MP4 放在附件目录里（2.7），只经
`GET /api/attachments/:id/media/:mediaId` 取，授权与所属课件附件完全相同（越权 404），支持 Range。

**不能在地址栏 / 新标签直接打开（2026-10-08 第三批 5.6）：**
- 课程附件（`GET /api/attachments/:id` 的课程类）、`/videos/*`、课件内视频流三处：请求头 `Sec-Fetch-Dest` 是
  `document`、`iframe`、`frame`、`embed`、`object` 时一律返回 **404**（与「不存在」同形）。效果：把附件地址粘进地址栏，
  不会再打开浏览器自带的 PDF 查看器（那里有下载和打印按钮）。页面里的查看器（pdf.js 发 `empty`）和播放器（发 `video` / `audio`）不受影响；
  没有这个请求头的客户端（旧版 Safari、curl、测试脚本）放行。申诉附件等非课程附件不受影响。
- 这三处的响应都带 `cache-control: private, no-store`，浏览器不留缓存副本。Range / 206 行为不变。
- 直接用脚本取文件（例如在页面控制台里 `fetch`）**不会**逐次留审计记录。

**查看人水印（2026-10-08 第三批 5.6）：** 学员在线看课件（PDF、Office 转出的 PDF、PPT 内嵌视频）和小节视频时，画面上平铺
「姓名 · 工号 · 日期」水印（纯管理员账号没有工号时为「姓名 · 日期」）。PDF 的水印画进页面像素里（滚动、单页、全屏三种模式都有），
视频是一层不接收点击的覆盖层，并用自带的全屏按钮保证全屏时水印仍在；视频关闭了下载、画中画和右键菜单。
员工端其他地方一律不显示工号（第三批 9.1），**水印里显示的是查看人本人的工号，是负责人定的例外，用于追溯外泄**。

水印**防不住**的情况（对外说明时不要说成「防下载」或 DRM）：
- **用手机拍屏幕**：照片里有水印 —— 能起威慑和追溯作用，但挡不住；
- **会用开发者工具的人**：可以在页面控制台 `fetch('/api/attachments/<id>')`（请求头是 `empty`，会放行）、从网络面板复制响应、
  或改查看器的脚本 —— 服务器上的 PDF / MP4 原文件本身**没有**水印（不做服务端逐人加水印：那需要支持中文字体的 PDF 改写和逐人的视频重压，不在范围内）；
- **操作系统录屏**：录下来的画面带水印，只是不再匿名；
- **外部链接视频**（YouTube / Vimeo 等）和外部链接：没有水印；
- **iPhone 浏览器强制进入系统全屏时**：没有覆盖层（iPhone 上视频默认在页面内播放）；
- **课程正文文字**：不加水印，可以复制或截图；
- **打印**：不拦截，打印出来的 PDF 页面带水印。

### 8.6 审计日志

- 表：`audit_logs`（`actorId` / `actorName` / `action` / `target` /
  `beforeJson` / `afterJson` / `requestId` / `createdAt`）
- **只追加，管理员也只能读不能改** —— 没有任何写以外的 API 暴露出来
- `requestId` 把同一次请求产生的多条记录串起来（形如 `r-xxxxxxxx`）
- 看的地方：管理端 **系统 → 审计日志**（`#/admin/audit`），
  API 是 `GET /api/admin/audit`（默认给 2000 条窗口，上限 5000，同时返回真实总数）
- 搜索和筛选在浏览器端做，所以量大时页面会有点沉
- 用脚本直接写库（如演示库生成脚本）不经过 API，不留审计。**不要以为条数少就是没在记。**

### 8.7 其它值得知道的

- 数据库文件权限就是文件系统权限。`lms.db` 里有全员的部门、薪资相关档案字段、绩效评价。
  **服务运行账户之外的人不应该能读这个目录**（nssm 那种做法要给服务一个专用账户，
  并把整个项目目录的 ACL 收到"服务账户 + IT 管理员"）
- `backups\` 里的每一个 `.db` 都是一份完整的人事数据副本。同样的权限要求，
  同步到异地时要加密
- `scripts\` 下有一批一次性维护脚本（`clean-keep-admins.js`、`wipe-to-clean.js`、
  `reset-for-uat.js`、`demo-cleanup.js`、`seed-demo.js` 等）。
  **这些是破坏性的，会直接改 `lms.db`。** 不要在生产上手贱运行，
  跑之前先 `backup.bat`
- `scripts\notify-due.js` 是可以挂定时任务的（每天生成"即将到期/已逾期"的站内通知，
  同一天不会重复堆）。注意它会自己 `store.init()` —— 也就是**会触发迁移**。
  所以别和服务的启动挤在同一时刻，也别在服务停着的窗口期跑一个未升级的版本。
  2026-10-07 起，它判断「已完成」与服务端共用 `modules\learning\completion.js`（programDone：有考试 = 通过且线下课程已出席；
  无考试 = 学完），跳过已离职员工、纯服务账号（后台角色且无部门、职位、入职日）、未发布课程、无法完成的课程
  （线上课程 0 个模块且无考试）与成绩待定（评分中 / 待 HR 复核）的人；培训模块关闭时（config.json `modules.learning: false`
  或环境变量 `LMS_MODULES_OFF` 含 `learning`）打印一行说明后直接退出，不发提醒。交接包必须带上 `modules\learning\completion.js`。

---

## 9. （本版本不含行为实践模块）

行为实践（Action 3+3 挑战）模块已从本版本删除，没有相关的配置、定时任务与迁移。

## 10. 接入公司内部 AI

### 10.1 这一节解决什么

TMS 有四项 AI 辅助功能：

| 功能 | 使用者 | AI 的作用 | 人工把关 |
|---|---|---|---|
| AI 学习助手 | 员工 | 根据当前课程内容回答提问 | 不需要（学习参考） |
| AI 出题 | HR | 根据培训材料起草题目 | 逐题审阅后采纳 |
| 简答题 AI 初评 | 系统（员工交卷后排队评分） | 按评分标准给出初评分和评语 | 分数影响是否通过时，须 HR 复核 |
| AI 人才画像 | HR | 根据员工的结构化发展记录起草人才画像 | 须 HR 确认后生效 |

交接时请把这些功能**接到公司内部的 AI 网关或内部模型**，不要使用个人账号或外部免费额度。系统支持三种接口协议，只改配置，不改代码：

- `openai-chat`：OpenAI Chat Completions 兼容协议。多数内部网关都支持，例如 LiteLLM、Azure OpenAI、vLLM，以及自建网关。
- `anthropic-messages`：Anthropic Messages 兼容协议，用于直连 Anthropic 或 Anthropic 兼容网关。
- `gemini`：Google Gemini API。

> 本节依据 `NEXT-WORK/specs/03-ai-governance-spec.md`（v1.1）撰写，2026-09-29 随 AI 治理一并实施。代码在 `modules/ai/`（服务商、脱敏、提示词、限流、调用记录服务）与 `server.js`（四项功能的路由与评分队列）。

AI 功能整体属于「AI 辅助」模块，**默认关闭**。不做任何配置时，系统其余功能完全不受影响；考试简答题在这种情况下由 HR 人工评分。演示模式只能显式开启（`ai.demo: true`），不会因为未配置或出错而自动进入。

### 10.2 开始之前：需要准备的信息

请先与公司 AI 平台团队和网络团队确认以下事项，再动手配置：（负责人 2026-09-30 决定：系统目前只在公司内部使用，AI 功能不走法务评估。）

| 项目 | 例子 | 用在哪里 |
|---|---|---|
| 接口协议 | openai-chat | `ai.provider.protocol` |
| 接口地址 | `https://ai-gateway.internal.example/v1` | `ai.provider.baseUrl` |
| 路由前缀是否标准（APIM、Kong 等网关常有自定义前缀） | `/ai/llm/chat` | `ai.provider.path`（可选） |
| 认证方式与密钥 | Bearer 令牌 | 环境变量 `LMS_AI_API_KEY`，`ai.provider.auth` |
| 是否要求客户端证书（双向 TLS） | 是 / 否 | `ai.provider.tls` |
| 可用的模型名 | 网关上登记的名称，如 `claude-sonnet-5`、`claude-opus-5-5` | `ai.models` |
| 必须附带的请求头 | 租户或成本中心，如 `X-Client-App: tms` | `ai.provider.headers` |
| 是否要求按人归因（计费到人） | 否 | 是：`ai.provider.userAttribution: "pseudonym"`（只发送假名，不发送工号） |
| 网关是否支持结构化输出（JSON Schema），各模型是否一致 | 支持 / 只支持 JSON 模式 / 不支持 | `ai.provider.capabilities.structuredOutput` |
| 出网是否必须经过代理 | `http://proxy.corp:8080` | `ai.provider.proxy` |
| **出网代理是否做 TLS 检查（解密）、是否记录请求体** | 否 / 是 | 是：请网络团队对 AI 网关域名放行、不解密；做不到时告知负责人，把代理列入 10.8 的数据流向 |
| 网关证书是否由内部 CA 签发；该 CA 是否已由组策略下发到服务器的系统证书库 | 是 / 是 | 已下发：`--use-system-ca`（首选）；未下发：导出 PEM，设 `NODE_EXTRA_CA_CERTS` |
| 网关的调用限额与计费口径 | 每月 token 数、单价 | `ai.budget` |
| **服务商情况**：网关另一端的服务商、所在地区、数据保留期、是否用于模型训练（记录下来即可，不需要法务评估） | — | 10.8 数据流向表 |
| **负责人确认**：开启哪几项功能（人才画像默认关闭；**负责人 10/10 定首日全部开启，含人才画像**） | — | `ai.features` |

### 10.3 配置项

服务商、密钥、模型、限额、预算与保留期只写在 `<根目录>\config.json` 中（后台不提供编辑）。**模块与各项功能的开关**另可由超级管理员在后台「系统设置 › 功能模块」页修改：页面写回同一个 `config.json` 的 `modules` 与 `ai.features`（原子写、其它键原样保留），每次修改记审计 `module.config.change`。

以下内容写在 `<根目录>\config.json` 中。**在现有文件上合并，不要整份替换**：只在 `modules` 中加一项 `"ai": true`，再加一个顶层 `"ai"` 块；已有的 `modules` 其他各项，以及 `production`、`brand`、邮件等键保持原样。没有这个文件时，从 `config.json.example` 复制一份再改。

```json
{
  "modules": { "ai": true },
  "ai": {
    "provider": {
      "id": "internal-gateway",
      "protocol": "openai-chat",
      "baseUrl": "https://ai-gateway.internal.example/v1",
      "apiKeyEnv": "LMS_AI_API_KEY",
      "auth": "bearer",
      "headers": { "X-Client-App": "tms" },
      "timeoutMs": 150000,
      "maxRetries": 2,
      "proxy": "",
      "capabilities": { "structuredOutput": "json_schema", "thinking": false, "effort": false, "sampling": false }
    },
    "models": { "default": "claude-sonnet-5", "portrait": "claude-opus-5-5" },
    "features": { "assistant": true, "questionGen": true, "grading": true, "portrait": false },
    "limits": { "concurrency": 4, "gradingConcurrency": 8 },
    "budget": { "monthlyTokens": 50000000, "alertAtPercent": 80 },
    "audit": { "retentionDays": { "assistant": 180, "questionGen": 180, "test": 180, "grading": null, "portrait": null } }
  }
}
```

关于 `production`：本节样例不写 `production` 键，也不要求切换生产模式。AI 的演示模式已与生产模式脱钩，只由 `ai.demo` 决定；而 `"production": true` 会给会话 Cookie 加 `Secure`，未启用 HTTPS 时所有人都登不进去（§8.3）。是否切换生产模式按 §8.3 单独决定。

| 配置项 | 说明 |
|---|---|
| `modules.ai` | AI 模块总开关。**必须写 `true` 才开启**：该模块默认关闭，方向与 learning 等模块相反 |
| `ai.provider.id` | 自定义名称，出现在调用记录中 |
| `ai.provider.protocol` | `openai-chat` / `anthropic-messages` / `gemini` |
| `ai.provider.baseUrl` | 接口根地址，必须是 `https://`。系统按协议拼接路径：openai-chat 拼 `/chat/completions`（所以 baseUrl **要带** `/v1`）；anthropic-messages 拼 `/v1/messages`（所以 baseUrl **不要带** `/v1`）；gemini 拼 `/v1beta/models/<模型>:generateContent`。启动日志会打印解析后的完整地址 |
| `ai.provider.path` | 可选。网关路由前缀不标准时，用它覆盖系统拼接的路径 |
| `ai.provider.apiKeyEnv` | 从哪个环境变量读取密钥，默认 `LMS_AI_API_KEY`。**推荐把密钥放在服务的环境变量里**，不要写进文件 |
| `ai.provider.apiKey` | 也可以直接写在这里（与旧版 `anthropicApiKey` 的做法相同）。取值规则：`apiKeyEnv` 指向的环境变量非空时用它，否则用这里的值 |
| `ai.provider.auth` | `bearer`（`Authorization: Bearer <密钥>`）、`x-api-key`、`api-key`（Azure 风格）、`x-goog-api-key`、`none`（网关按来源 IP 放行，或用客户端证书做双向 TLS 时） |
| `ai.provider.headers` | 网关要求附带的请求头。值不会显示在任何页面和日志中 |
| `ai.provider.query` | 附加查询参数，例如 Azure OpenAI 的 `{"api-version": "…"}`。值同样不显示、不写日志。**不要把密钥放在查询参数里**，改用 `auth` 或 `headers`；参数名含 key、token、secret、code 时启动日志会警告 |
| `ai.provider.timeoutMs` / `maxRetries` | 单次请求超时的全局上限（毫秒，默认 150000）和重试次数。各功能另有更短的单次超时；系统只重试临时性错误（429、5xx、529、网络中断），出题和画像超时后不重试 |
| `ai.provider.proxy` | 只对 AI 请求生效的 HTTP 代理。代理地址中的账号密码不会写入日志 |
| `ai.provider.tls` | 双向 TLS 的客户端证书：`{"certFile": "…", "keyFile": "…"}` 或 `{"pfxFile": "…", "passphraseEnv": "LMS_AI_TLS_PASS"}`。证书与私钥文件只放在服务器本地，口令放在环境变量里 |
| `ai.provider.userAttribution` | `none`（默认）或 `pseudonym`。任何情况下都不发送姓名、工号、邮箱 |
| `ai.provider.capabilities` | 网关不支持某个参数时在这里关掉。`structuredOutput`：`json_schema` / `json_object` / `none`；`thinking`、`effort`：仅 Anthropic 协议直连 Claude 5 系列时设为 `true`；`sampling`：网关是否接受 temperature 等采样参数，Claude 5 系列不接受 |
| `ai.provider.maxTokensField` | 个别 OpenAI 兼容模型要求 `max_completion_tokens`，在这里改 |
| `ai.models.default` | 默认模型。openai-chat 协议**必须填写**网关上登记的模型名 |
| `ai.models.<功能>` | 按功能指定模型，功能名为 `assistant` / `questionGen` / `grading` / `portrait`。建议：前三项用 `claude-sonnet-5`，画像用 `claude-opus-5-5` |
| `ai.features.<功能>` | 单项功能开关，写 `false` 即关闭 |
| `ai.limits` | 限流与并发，默认值：助手每人每 10 分钟 20 次、每天 100 次；出题每人每小时 20 次；画像每人每小时 30 次；交互功能并发 4；简答题评分并发 8（`gradingConcurrency`，按网关配额和单场考试人数调整） |
| `ai.budget.monthlyTokens` | 每月 token 上限（输入加输出）。达到 `alertAtPercent` 时通知后台管理员；达到 100% 时暂停学习助手、出题、画像，简答题转人工评分 |
| `ai.budget.pricePerMTok` | 可选，`{input, output}` 为每百万 token 的单价。配置后治理页显示预估费用 |
| `ai.audit.retentionDays` | 调用记录的保留天数，按功能设置：学习助手、出题、连接测试默认 180 天；简答题初评与画像写 `null`，表示随答卷或画像一起保留和删除。范围 90–1095 |
| `ai.portraitRetentionMonthsAfterExit` | 人才画像（已确认版本与历史版本）在员工离职满多少个月后删除。默认 12，范围 1–120；具体值由负责人按人事档案留存政策确定 |
| `ai.demo` | 演示模式，只有写 `true` 才开启（销售演示或本地体验用）。生产数据的部署不要开启 |
| `ai.debugLogUntil` | 临时排查用：写一个 ISO 时间（最多 24 小时后），期间把上游错误正文（已脱敏、截断到 200 字）写入服务器日志，到期自动失效 |

**关于旧字段**：`anthropicApiKey`、`geminiApiKey`、`aiModel` 以及环境变量 `ANTHROPIC_API_KEY`、`GEMINI_API_KEY` 在没有 `ai.provider` 时继续有效。写了 `ai.provider` 之后，这些旧字段和旧环境变量一律被忽略，启动日志会提示。

**相关环境变量**

| 变量 | 作用 |
|---|---|
| `LMS_AI_API_KEY` | AI 网关密钥（`apiKeyEnv` 的默认值）。为空时回落到 `ai.provider.apiKey` |
| `NODE_OPTIONS=--use-system-ca` | 让 Node 使用 Windows 系统证书库。企业 CA 已由组策略下发时，这是信任内部网关证书的首选做法（也可以写进 nssm 的 `AppParameters`：`--use-system-ca server.js`） |
| `NODE_EXTRA_CA_CERTS` | 备选：内部 CA 证书（.pem）的路径 |
| `LMS_MODULES_OFF=ai` | 强制关闭 AI 模块，优先于 `config.json`。改后需重启 |
| `LMS_DISABLE_AI=1` | 强制不调用任何 AI：任何环境下 AI 功能都按「未接入」处理，简答题转人工，不会进入演示模式。改后需重启 |
| **禁止使用** `NODE_TLS_REJECT_UNAUTHORIZED=0` | 这个变量会关闭整个进程的证书校验（包括邮件）。TMS 检测到它时拒绝发起任何 AI 调用，治理页显示「证书校验已关闭」 |
| 不需要 `NODE_USE_ENV_PROXY` | AI 请求只认 `ai.provider.proxy`。全局代理变量是 Node 的实验特性，启动时会打印警告，代理异常时会高频重连，而且会同时影响邮件 |

**设置服务的环境变量**

方案 B（nssm 服务，§2.4）：`nssm set … AppEnvironmentExtra` 会**整体替换**原有列表。§2.4 已经设过 `PORT=8780 LMS_NO_DEMO_USERS=1`，如果只写新变量，服务会回到默认端口 8765，反向代理仍指向 8767，站点不可用，演示人员设置也会丢失。步骤：

1. 管理员 CMD：`nssm get UnfoldingLabTMS AppEnvironmentExtra`，记下现有的每一项；
2. 完整重设，把第 1 步看到的各项一并写上，例如：
   `nssm set UnfoldingLabTMS AppEnvironmentExtra PORT=8780 LMS_NO_DEMO_USERS=1 LMS_AI_API_KEY=<密钥> NODE_OPTIONS=--use-system-ca`
3. `nssm restart UnfoldingLabTMS`，然后按 10.5 第 3 步确认端口；
4. 密钥出现在了命令行中：执行完即关闭该 CMD 窗口（CMD 的命令历史只保存在窗口内）；如果在 PowerShell 中执行，运行 `Clear-History`，并从 `(Get-PSReadLineOption).HistorySavePath` 指向的历史文件中删除这一行。

方案 A（任务计划程序 + `start-tms.bat`，§2.4）：

- **不要把密钥写进 `start-tms.bat`**：这个文件会进交接包，也常被复制。
- 把密钥写进 `config.json` 的 `ai.provider.apiKey`（`config.json` 不入交接包），并收紧该文件的权限，只允许运行 TMS 的账号和管理员读取，例如：
  `icacls config.json /inheritance:r /grant:r "<运行 TMS 的账号>:R" "Administrators:F"`
- `NODE_OPTIONS=--use-system-ca` 不是机密，可以在 `start-tms.bat` 中加一行 `set NODE_OPTIONS=--use-system-ca`。

密钥的传递方式与 §3「config.json 含密钥」相同：通过密码管理器或密封信封，不经过邮件和工单。

### 10.4 配置样例

**A. 公司内部网关（OpenAI 兼容）**：见 10.3 的样例。

**B. Azure OpenAI 风格的网关**

```json
"provider": { "id": "azure-apim", "protocol": "openai-chat",
  "baseUrl": "https://<资源名>.openai.azure.com/openai/deployments/<部署名>",
  "auth": "api-key", "query": { "api-version": "<网关给定的版本>" },
  "capabilities": { "structuredOutput": "json_schema", "sampling": true } },
"models": { "default": "<部署名>" }
```

**C. Anthropic 兼容网关，或直连 Anthropic**（baseUrl 不要带 `/v1`，系统会拼 `/v1/messages`）

```json
"provider": { "id": "anthropic-gw", "protocol": "anthropic-messages",
  "baseUrl": "https://ai-gateway.internal.example/anthropic", "auth": "bearer",
  "capabilities": { "structuredOutput": "json_schema", "thinking": true, "effort": true } },
"models": { "default": "claude-sonnet-5", "portrait": "claude-opus-5-5" }
```

直连 Anthropic 时，`baseUrl` 写 `https://api.anthropic.com`，`auth` 写 `x-api-key`。

**D. Gemini**

```json
"provider": { "id": "gemini", "protocol": "gemini",
  "baseUrl": "https://generativelanguage.googleapis.com", "auth": "x-goog-api-key" },
"models": { "default": "gemini-flash-latest" }
```

`gemini-flash-latest` 是滚动别名，模型会随官方更新而变化。正式使用时建议固定为具体版本，便于追溯。

**E. 路由前缀不标准的网关**

```json
"provider": { "id": "corp-kong", "protocol": "openai-chat",
  "baseUrl": "https://api.corp.example", "path": "/ai/llm/chat", "auth": "bearer" }
```

**F. 要求客户端证书的网关（双向 TLS）**

```json
"provider": { "id": "corp-mtls", "protocol": "openai-chat",
  "baseUrl": "https://ai-gateway.internal.example/v1", "auth": "none",
  "tls": { "pfxFile": "C:\\TMS-secrets\\tms-client.pfx", "passphraseEnv": "LMS_AI_TLS_PASS" } }
```

### 10.5 验证步骤

1. **备份**：运行 `backup.bat`，并单独备份当前的 `config.json`。
2. **配置**：按 10.3 设置环境变量，并在现有 `config.json` 上合并 `modules.ai` 与 `ai` 两个键。
3. **重启服务**，确认两件事：
   - 服务仍在原端口监听：浏览器打开站点正常，`GET /api/env` 正常返回（方案 B 下尤其要确认 `PORT=8780` 没有因为重设环境变量而丢失）；
   - 启动日志中出现一行：
     `AI: ENABLED · provider=internal-gateway · protocol=openai-chat · url=https://ai-gateway.internal.example/v1/chat/completions · models: default=claude-sonnet-5, portrait=claude-opus-5-5 · features: assistant, questionGen, grading`
     日志中不会出现密钥。如果看到 `AI: module off`，检查 `modules.ai`；看到 `AI: not configured`，检查密钥是否读到；看到 `TLS verification disabled`，删除 `NODE_TLS_REJECT_UNAUTHORIZED` 变量。
4. **命令行连通性检查**（不需要登录，也不写数据库）：
   `runtime\node.exe scripts\ai-check.js --service UnfoldingLabTMS`
   - `--service <服务名>` 让脚本通过 `nssm get <服务名> AppEnvironmentExtra` 读取服务的环境变量（只在内存中使用，不打印），这样检查的是服务实际使用的密钥、证书与代理设置。不带该参数时使用当前命令行的环境；缺少所需变量时，脚本提示「当前命令行环境与服务不同，以后台连接测试为准」，不要据此修改配置。方案 A 部署的密钥在 `config.json` 中，不需要该参数。
   - 脚本对 `ai.models` 中每个不同的模型各调用一次（例如 claude-sonnet-5 与 claude-opus-5-5 各一次），每次都测试结构化输出。网关可能只登记了其中一个模型，不同模型对结构化输出的支持也可能不同。
   - 输出协议、解析后的地址、请求的模型与实际返回的模型、延迟、token 用量、结构化输出是否可用；全部成功时退出码为 0。它**会产生真实调用**，按网关计费。输出中不包含密钥、请求头和查询参数的值。
5. **后台连接测试（以此为准）**：用超级管理员登录，进入「系统设置 → AI 治理」，点击「连接测试」。它在服务进程内执行，环境与实际运行完全一致，同样对每个模型各测一次。
6. **逐项功能验证**（用测试账号，不要用真实员工的数据）。四项功能的数据最小化与人工确认已于 2026-09-29 实施并通过测试，均已列入代码中的「已就绪」清单（`modules/ai/readiness.js`）；以后新增的 AI 功能在其最小化与人工确认落地之前不会列入，届时只有连接测试能调用真实网关。
   - 学习助手：用测试员工账号打开一门课程，提一个与课程内容相关的问题，应当得到回答，并能看到 AI 告知文案；
   - AI 出题：在「培训管理 → 题库 → AI 生成题目」中选一门课程，用「从课程内容生成」出 2 道单选题，应返回题目草稿；
   - 简答题初评：用测试员工完成一场含简答题的考试，成绩页先显示「评分中」，几分钟内显示 AI 评语（初评）；
   - 人才画像（仅在已开启时）：用具备人才发展写权限的账号（2026-09-30 起不再另要求员工档案读权限），在测试员工的档案中点击「生成」，应得到一份标注为「AI 草稿」的画像。
7. **检查调用记录**：在「AI 治理 → 调用记录」中应看到上述每次调用，状态为 ok，并有模型名和 token 数。

### 10.6 查看审计

- **每次 AI 调用**：进入「系统设置 → AI 治理 → 调用记录」，可按时间、功能、状态、调用人筛选并导出 CSV；对应接口为 `GET /api/admin/ai-governance/calls`。每条记录包含时间、调用人、功能、所涉员工（画像和评分）、服务商、协议、网关主机名、配置指纹、请求模型、实际模型、提示词版本、结果、错误码、重试次数、耗时、字符数、token 数、脱敏次数。**不保存提问、作答、材料和 AI 回复的原文。** 保留期：学习助手、出题、连接测试 180 天；简答题初评与画像随答卷或画像一起保留和删除（`ai.audit.retentionDays`），每天自动清理一次。**AI 模块关闭后，这一页仍可只读查看。**
- **画像本身的留存**：草稿 30 天未处理自动清空正文；每名员工保留最近 5 个已确认或历史版本；员工离职满 `ai.portraitRetentionMonthsAfterExit` 个月（默认 12）后由每日任务删除，审计记 `talent.portrait.purge`。
- **可见范围**：有数据范围限制的账号只能看到范围内员工的记录；出题与连接测试的记录只对超级管理员和没有范围限制的账号可见。
- **关键的人工决定**：在「系统设置 → 审计日志」中查看，与其他管理操作在一起，永久保留，只增不删（见 §8.6）。相关动作包括：`talent.portrait`（生成画像）、`talent.portrait.confirm` / `.discard` / `.objection` / `.purge`、`attempt.ai.confirm`（确认简答题初评）、`attempt.regrade`（改分）、`question.ai.adopt`（采纳 AI 题目）、`ai.budget.alert`（用量预警）、`ai.config.change`（检测到 AI 配置变更：记录服务商、地址、模型、功能开关，以及请求头和查询参数名称的前后差异，不含密钥和值；`config.json` 改完后的下一次调用即记录）、`ai.datashare.change`（字段外发范围变更）。
- **用量**：在「AI 治理 → 本月用量」查看按功能统计的 token 数、调用次数、失败率和预算百分比。
- **服务器日志**（`logs\tms-out.log`、`logs\tms-err.log`）：AI 相关的行只含请求编号、功能、HTTP 状态、上游错误类型和耗时，不含原文和上游错误正文（`ai.debugLogUntil` 生效期间除外）。nssm 只按 10 MB 轮转、不限份数（§2.4），建议加一个每日计划任务清理 30 天前的日志，例如 `forfiles /p "C:\...\unfolding-lab-tms\logs" /m *.log /d -30 /c "cmd /c del @path"`（保留天数由 IT 按公司日志政策定）。

### 10.7 关闭方法

按影响范围从小到大排列：

| 目的 | 做法 | 生效时间 |
|---|---|---|
| 关闭某一项功能 | 后台「系统设置 › 功能模块」关闭该功能（超级管理员），或 `config.json` 中 `ai.features.<功能>` 改为 `false` | 下一次请求即生效（`config.json` 每次调用都会重新读取） |
| **关闭全部 AI 功能（应急关闭首选）** | 后台「功能模块」页关闭「AI 辅助」，或 `config.json` 中 `modules.ai` 改为 `false` | 下一次请求即生效。所有 AI 调用入口隐藏、调用接口返回 404；简答题转人工评分；调用记录、用量和已确认的画像仍可只读查看；数据保留不删 |
| 不依赖 `config.json` 的关闭 | 在服务环境变量中设 `LMS_MODULES_OFF=ai`（优先于 `config.json`）或 `LMS_DISABLE_AI=1`，然后重启 | 重启后生效。方案 B 下 `AppEnvironmentExtra` 要整体重设（10.3） |
| 在网关侧切断 | 在网关上吊销 TMS 使用的密钥 | **唯一立即生效、且不依赖 TMS 任何配置的方法**；TMS 侧报 `ai_auth_failed`，简答题转人工评分 |

注意：把 `LMS_AI_API_KEY` 设为空**不能**关闭 AI。环境变量为空时，系统会改用 `config.json` 中的 `ai.provider.apiKey`；没有 `ai.provider` 时还会回落到旧的 `ANTHROPIC_API_KEY` 或 `anthropicApiKey`。

### 10.8 数据流向说明

**总体说明**
- TMS 只在四项功能被调用时向 `ai.provider.baseUrl` 发送 HTTPS 请求，不做后台批量上传（简答题评分队列只处理员工已提交的答卷）。
- 数据经过的环节：TMS 服务器 →（公司出网代理，如有）→ 公司 AI 网关 → 网关背后的模型服务商。出网代理如果做 TLS 检查，代理能看到明文，是处理环节之一。
- 发送前按规则去除或替换直接标识：姓名、工号、邮箱、电话、证件号、长数字串，以及花名册中出现的姓名，替换为占位符。人事记录中的自由文本（评语、评价、评委意见、处理说明、原因等）默认不发送。
- **去标识化后的数据仍属于个人信息**（RA 10173）。例如画像仍会发送职位、职级、司龄月数，唯一岗位的人可能被认出；规则库也识别不了单词名、昵称和花名册以外的人名（如客户或玩家的姓名）。因此网关及其背后的模型服务商都是个人信息处理者，应按处理者管理（签数据处理协议等）。
- 协议字段和请求头不携带员工姓名、工号、邮箱；网关要求按人归因时，只发送不可逆的假名（按月轮换）。
- 占位符与真实信息的对应关系只保存在本次请求的内存中，不落库。
- TMS 不保存发送给 AI 的原文和 AI 回复的原文，服务器日志也不记录（临时排查开关除外：最多 24 小时，写入前脱敏并截断）。需要人工确认的结果（画像、简答题初评）作为业务数据保存在 TMS 数据库中，权限与其他人事数据相同。
- 调用记录的保留期见 10.6；数据库备份另按 §5.3 的备份保留策略管理，备份中的调用记录与画像不随保留期自动删除。
- 治理页的「数据流向说明」按当前实际配置生成；字段外发范围与下表的上线基线不同时，会逐项标出。

| 功能 | 数据主体 | 发送的数据 | 不发送的数据 | TMS 内保存 | 谁能看到结果 | 人工参与 |
|---|---|---|---|---|---|---|
| 学习助手 | 员工（提问人） | 课程标题与当前模块正文（公司内容）；员工提问（已去标识，最近 12 轮） | 员工身份、学习记录 | 仅调用记录（时间、课程、用量，无原文），180 天 | 提问员工本人 | 不需要（回答标注为学习参考） |
| AI 出题 | 无个人数据（材料中偶有联系人信息，已去标识） | 培训材料或课程正文（公司内容） | — | 调用记录 180 天；被采纳的题目及其来源 | 有培训管理权限的后台账号 | 逐题审阅后采纳 |
| 简答题初评 | 员工（作答人） | 题目、评分标准、作答内容（已去标识） | 员工姓名、工号、部门、其他成绩 | 调用记录（随答卷保留）；答卷中的初评分、评语、模型信息 | 员工本人；有培训管理权限的后台账号 | 分数决定是否通过时，须 HR 复核后生效；疑似注入或低置信度时 AI 分数不采用；员工可以申诉 |
| 人才画像（默认关闭） | 员工（被分析人） | 职位、职级、在职状态、司龄月数；按字段配置发送的结构化发展记录（绩效评级、培训成绩与排名、荣誉名称、晋升结果、违规严重程度等），日期精确到月；部门名以占位符发送 | 姓名、工号、精确日期、潜力评级、人才标签、全部自由文本评语与说明（默认）、违规描述、离职记录、HR 备注、切屏记录、自定义档案字段 | 调用记录（随画像保留）；画像草稿与已确认版本（含模型信息、确认人）；丢弃和过期的草稿只留元数据、不留正文 | 具备人才发展权限的后台账号（受部门数据范围限制；2026-09-30 起不再另要求员工档案读权限）；员工本人经查阅请求可获得已确认版本；直线经理看不到 | 须 HR 确认后生效；员工可提出更正或异议；离职满 N 个月后删除 |

**需要确认的事项**（负责人 2026-09-30 决定：系统目前只在公司内部使用，AI 功能不走法务评估。第 1、2、7 条由 IT 接入时确认并记录；第 3、4、6 条不作为上线前提，留作日后需要时参考；第 8 条由负责人确定）
1. 网关另一端实际的模型服务商与处理地区，是否涉及跨境传输。如果涉及，需要按菲律宾《数据隐私法》（RA 10173）及国家隐私委员会的要求评估。
2. 服务商和网关对请求内容的保留期，以及是否用于模型训练，以合同或数据处理协议为准。建议选择不保留、不用于训练的方案。
3. 员工隐私告知是否已补充 AI 处理条款（建议条款见方案第 2.6 节）。
4. 是否需要在上线前完成数据保护影响评估（DPIA），建议完成。任何字段放宽外发（`aiShare` 从「不发」改为「脱敏」或「原样」）之前，先在 DPIA 中逐项确认。
5. 个人信息查询请求：`ai_calls.subjectUserId` 可以列出某名员工的数据在何时、被哪项功能、经哪个服务商处理过；已确认的画像连同生成时间、模型和确认人一并提供给员工。
6. 人才画像属于对员工的画像分析（profiling）：隐私告知中须单独列明目的、数据类别和人工复核安排；员工提出更正或异议的受理流程与时限。
7. 出网代理是否做 TLS 检查、是否记录请求体（10.2）。
8. 离职员工画像的删除期限 N（方案建议 12 个月）。

### 10.9 常见故障

| 现象（错误码 / 日志） | 常见原因 | 处理 |
|---|---|---|
| 重启后站点打不开，或端口变成 8765 | 用 `nssm set … AppEnvironmentExtra` 只写了新变量，原有的 `PORT=8780` 被覆盖 | 按 10.3 先 `nssm get` 再完整重设，重启 |
| `ai_auth_failed`（上游 401/403） | 密钥错误，或认证头方式不对 | 核对 `LMS_AI_API_KEY` 是否设在服务的环境中（改完要重启），以及 `auth` 是否与网关要求一致 |
| `ai_model_not_found`（上游 404） | 模型名与网关登记的不一致；或 `baseUrl` 多写或少写了路径：openai-chat 的 baseUrl 要带 `/v1`，anthropic-messages 的不要带 | 对照启动日志中解析后的完整地址；路由前缀不标准时用 `ai.provider.path`；用 `scripts\ai-check.js --service <服务名>` 验证 |
| `ai_upstream_error`，原因 `redirect` | 接口地址发生了跳转（负载均衡、HTTP 跳 HTTPS、网关迁移） | 系统不跟随跳转（防止密钥被带到另一台主机）；把 `baseUrl` 改为跳转后的最终地址 |
| `ai_bad_request`（上游 400） | 网关不支持结构化输出、思考或采样参数；或者网关自行加了 temperature，而模型不接受 | 在 `capabilities` 中关掉对应项：`structuredOutput` 改为 `json_object` 或 `none`，`thinking`/`effort` 设为 `false`；请网关团队停止注入采样参数 |
| `ai_timeout` | 网关延迟高；代理未配置；画像这类长任务超过了时限 | 检查代理配置；确认反向代理的超时不小于 3 分钟（画像最长 150 秒）。出题和画像超时后不会自动重试，以免重复计费 |
| 证书错误（`UNABLE_TO_VERIFY_LEAF_SIGNATURE`、`SELF_SIGNED_CERT_IN_CHAIN`） | 网关使用内部 CA 证书 | 首选 `NODE_OPTIONS=--use-system-ca`（企业 CA 已在系统证书库中）；否则设 `NODE_EXTRA_CA_CERTS`；重启。**禁止设置 `NODE_TLS_REJECT_UNAUTHORIZED=0`**：它会关闭整个进程的证书校验，TMS 检测到后会拒绝所有 AI 调用 |
| 治理页显示「证书校验已关闭」 | 服务环境中有 `NODE_TLS_REJECT_UNAUTHORIZED=0` | 删除该变量，按上一行处理证书，重启 |
| `ai-check.js` 报「未配置」或证书错误，但后台连接测试正常 | 命令行环境与服务环境不同 | 加 `--service <服务名>` 重跑，或以后台连接测试为准；不要为此修改配置 |
| `ai_output_invalid` / `ai_output_truncated` | 网关不支持 JSON Schema，模型输出不符合结构；或输出长度受网关限制 | 把 `structuredOutput` 改为 `json_object`；请网关团队放宽输出长度上限 |
| 简答题长时间显示「评分中」 | 评分队列积压（集中交卷），或网关不可用 | 查看治理页的失败率；适当调大 `ai.limits.gradingConcurrency`（不超过网关配额）；排队超过 30 分钟的答卷会自动转人工评分 |
| `ai_budget_exhausted` | 本月用量达到上限 | 确认用量是否合理（查看治理页）；调整 `ai.budget.monthlyTokens`；否则下月 1 日（+08:00）自动恢复 |
| 启动日志提示「检测到 AI 密钥但 AI 模块未开启」 | 升级后没有写 `modules.ai: true` | 按 10.3 开启 |

### 10.10 升级注意

- 本版本起 AI 属于「AI 辅助」模块，**默认关闭**。升级前已配置 AI 密钥的部署，升级后需要在 `modules` 中写上 `"ai": true` 才能恢复。
- Anthropic 的默认模型由 `claude-opus-4-8` 改为 `claude-sonnet-5`。如果需要沿用旧模型，在 `ai.models.default` 中显式填写。
- 演示模式只能显式开启（`ai.demo: true`）；未接入时不再显示演示内容，考试简答题由 HR 人工评分，关键词估分不再计入成绩。
- 含简答题的考试改为交卷后排队评分，成绩页会先显示「评分中」。
- AI 画像只按人才发展权限与数据范围判定：负责人 2026-09-30 决定不再另要求员工档案读权限，具备人才发展权限的内置或自定义角色均可使用（原「需同时具备员工档案读权限」的限制已取消）。

---

## 附：文件清单速查

| 路径 | 是什么 | 发布时 |
|---|---|---|
| `server.js` | HTTP 服务：启动、登录与会话、权限门、公共函数，约 9,000 行；接口处理按模块在 `modules\core`、`learning`、`performance`、`talent` 下的 `routes.js`（2026-10-11 从 server.js 原样拆出） | 覆盖 |
| `store.js` | SQLite 存储层 + 迁移定义，2181 行 | 覆盖 |
| `content.js` | 首次建库的课程种子数据 | 覆盖（改它不影响已建库） |
| `kernel\` | 模块内核：注册表、事件总线、定时任务调度、模块宿主（server.js 启动时加载，缺一个就起不来） | 覆盖 |
| `modules\` | 模块清单与模块代码（core / learning / performance / talent / ai） | 覆盖 |
| `runtime\node.exe` | 便携版 Node v22.23.1 | 保留 |
| `public\dist\` | 前端构建产物（vite base `/next/`） | 覆盖 |
| `public\vendor\pdfjs\` | 内嵌的 PDF 阅读器 | 覆盖 |
| `public\videos\` | HR 上传的视频（在静态目录里，但 `/videos/*` 已加鉴权，见 §8.5） | **保留** |
| `web\src\` | 前端源码（React 18 + Vite + Semi Design） | 可不带 |
| `web\node_modules\` | 241 MB，**仅构建时需要** | 可不带 |
| `lms.db` `-wal` `-shm` | 数据库 | **保留** |
| `config.json` | 密钥配置（可选） | **保留，不入包** |
| `config.json.example` | 配置模板 | 覆盖 |
| `config.demo.json` | 演示专用配置（`start-demo.bat` 用 `LMS_CONFIG_PATH` 指向它；非正式模式、不含密钥），正式环境不要用 | 覆盖 |
| `data\attachments\` | 课件附件（有鉴权） | **保留** |
| `backups\` | 数据库快照 | **保留** |
| `logs\` | nssm 落的日志（要自己建） | **保留** |
| `test\` | 自动化测试（约 1,600 项，200 多个文件），`test.bat` 分两步跑（并行一组、计时用例单独一步） | 覆盖 |
| `scripts\` | 备份 / 逾期提醒 / 冒烟 / 附件转换 / UAT 重置 / 样例文件 | 覆盖 |
| `start-tms.bat` | 启动正式系统（8780，空库） | 覆盖 |
| `start-demo.bat` | 启动演示（8790；第一次运行自动生成演示库 `data\demo-unfolding.db`） | 覆盖 |
| `backup.bat` `test.bat` `smoke.bat` | 运维入口 | 覆盖 |
| `deploy\` | Linux 云部署脚本（**不在交接包里**，见 §1 说明） | — |

**`scripts\` 里随包交付的是这几个**（其余的留在源码仓库，没给）：

| 脚本 | 用途 |
|---|---|
| `backup.js` | 备份（`VACUUM INTO` 一致性快照；`--prune` 按保留策略列出可清理的旧备份） |
| `notify-due.js` | 逾期提醒定时任务（建议每天跑一次） |
| `convert-office-attachments.js` | 离线把**存量** office 附件批量转 PDF（需服务停机 + LibreOffice）。服务运行中改用后台课程库的「课件转换」（见 2.6） |
| `run-tests.js` | `test.bat` 与 `npm test` 的入口：TMS 测试、模块测试、串行用例三步先后跑 |
| `make-demo-db.js` | 生成演示库（100 名虚构员工、课程、绩效周期；`start-demo.bat` 第一次运行时调用；目标文件已存在就拒绝） |
| `ai-check.js` | 公司内部 AI 连通性检查（§10.5） |
| `reset-for-uat.js` | ⚠ **破坏性**：UAT 前把库重置成干净起点。跑之前先 `backup.bat`，看清它会删什么 |
| `smoke*.js` | 冒烟体检（`smoke.bat` 调它们） |
| `package-handover.js` | 重新打一个交接包（你们以后自己要打包时用） |
| `samples\` | 附件上传的样例文件，`test\` 依赖它们 |

没给的是三类，都是「跟着走会出事」而不是体积问题：

- `go-online.sh` / `stop-online.sh` —— 一键把服务发布到 `lms.unfolding-lab.com` 这类公网域名的开发用脚本。
  跑一次就等于把装着员工档案的系统挂到了公网上。
- `wipe-to-clean.js` / `clean-keep-admins.js` / `archive-junk.js` —— 破坏性清库脚本。
- `seed-demo.js` / `seed-media.js` / `seed-catalog.js` —— 旧版造演示数据脚本（演示请用随包的 `start-demo.bat`）；
  其中 `seed-demo.js` 会用固定弱口令 `learn1234` 批量建号。

需要其中任何一个（比如做压测想灌演示数据），跟我要，不要从别处翻旧副本。
