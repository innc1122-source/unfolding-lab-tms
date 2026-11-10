// make-demo-db.js — 演示库生成器（Unfolding Lab 版随包交付：start-demo.bat 第一次运行时调用）
//
// 用途：为销售演示生成一个 100 人、看起来「活着」的 TMS 演示数据库。客户会当着
// 销售的面点开细看，所以每个模块都有经得起检查的数据：
//   · 工作台 KPI / 最近入职卡（近 30 天 3 名新人）
//   · 组织架构：1 名总经理 → 9 名部门总监 → 90 名员工（3 层，每经理 8-12 直属；
//     100 人 / 9 个部门 / 3 层，平均跨度就是 10，组织诊断里会按它自己的 ≥8 阈值
//     提示「跨度偏宽」，属预期 —— 要消掉就得加第四层，那才不像 100 人的公司）
//   · 培训：4 门中性课（种子 nho + 本脚本再造 3 门），全员指派 ≥2 门，
//     进度铺 0-100%，30 人有已通过的考试成绩，另有 8 人未通过、3 人逾期；
//     其中 15 人「已指派课程全部通过」—— 训练总览的部门「完成」列只统计这种人，
//     不铺就是十行全 0（server.js 的 /api/admin/overview byDept.done）
//   · 审批流：3 条待审学习申请 + 历史已批/已驳回各若干；1 条待处理成绩申诉
//   · 绩效：上季度周期已关账（评级 A+~D 铺满 → 九宫格有分布）+ 本季度周期进行中
//     （自评过半、上级评一部分，可演示校准视角）
//   · 人才记录：晋升 / 转正 / 调动 / 荣誉 / 违规若干；继任计划 3 个关键岗位有候选人
//   · 通知铃铛：管理员与若干员工都有未读
//
// 用法（必须显式指定输出路径；目标文件已存在则直接报错退出，绝不覆盖）：
//   PowerShell:  $env:LMS_DB_PATH="D:\demo\lms-demo.db"; .\runtime\node.exe scripts\make-demo-db.js
//   cmd:         set LMS_DB_PATH=D:\demo\lms-demo.db&& runtime\node.exe scripts\make-demo-db.js
//
// 演示账号：
//   管理员  ADMIN / unfolding888（种子默认）
//   员工    全部 100 人密码 Demo1234（不强制改密）
//   主角三人（按角色讲故事线）：
//     UL-1053 Bea Salvador     新人（客服部，入职 13 天，学习中）
//     UL-1032 Katrina Villanueva 绩优（市场部品牌经理，A+/High，继任候选，有晋升与荣誉记录）
//     UL-1065 Ramil Dizon      待改进（运营部，D/Low，考试未通过并提交了申诉，自评未交）
//
// 产物：只有 OUT 一个 .db 文件需要交给销售（收尾做了 wal_checkpoint，不留 -wal/-shm）。
// store.js 首次打开时会在 OUT 同级建一个 backups/ 放「pre-migration」快照（那是它自己
// 的迁移保护机制，快照内容是刚建的空库），对演示无用，可以直接删掉。
//
// 说明：脚本经 ../store.js 写库（它认 LMS_DB_PATH，首次打开自动建库、跑迁移并种
// 中性课程）。生成期间设 LMS_NO_DEMO_USERS=1，所以库里没有 Juan/DEMO-ADMIN；
// 用 start-tms.bat（它也设该开关）启动则始终如此，用 start.bat 启动会按老规矩自动
// 补种 DEMO-ADMIN（manage2026），属预期行为。

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

// ---------- 目标路径检查（先于 require store，store 在 require 时就解析 LMS_DB_PATH） ----------
if (!process.env.LMS_DB_PATH) {
  console.error("用法: LMS_DB_PATH=<输出 .db 路径> runtime\\node.exe scripts/make-demo-db.js");
  console.error("必须显式指定输出路径，避免误写到项目根的 lms.db。");
  process.exit(1);
}
const OUT = path.resolve(process.env.LMS_DB_PATH);
if (fs.existsSync(OUT)) {
  console.error(`目标文件已存在，拒绝覆盖: ${OUT}`);
  console.error("请换一个输出路径，或自行删除旧文件后重跑。");
  process.exit(1);
}
// Unfolding Lab 版随包交付本脚本（start-demo.bat 调用），所以加一道防护：正式模式下拒绝运行 ——
// 演示库给 100 个账号用固定密码 Demo1234，绝不能出现在正式环境（交接包自检原本因此禁止它进包）。
const prodCfg = (() => {
  if (process.env.LMS_PROD === "1") return true;
  try { return !!JSON.parse(fs.readFileSync(process.env.LMS_CONFIG_PATH || path.join(__dirname, "..", "config.json"), "utf8")).production; } catch { return false; }
})();
if (prodCfg) {
  console.error("当前是正式模式（config.json 的 production: true 或 LMS_PROD=1），拒绝生成演示库。");
  console.error("演示请在没有正式配置的目录里运行 start-demo.bat。");
  process.exit(1);
}
fs.mkdirSync(path.dirname(OUT), { recursive: true });

// 生成期间不种演示人物（Juan/DEMO-ADMIN）；ADMIN/unfolding888 照 seedFresh 默认。
process.env.LMS_NO_DEMO_USERS = "1";
const store = require(path.join(__dirname, "..", "store.js"));

function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(pw, salt, 32).toString("hex");
  return salt + ":" + hash;
}

// ---------- 确定性随机（同一天生成的库可复现；日期随运行日滚动） ----------
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(20260826);
const rint = (a, b) => a + Math.floor(rand() * (b - a + 1));
const pick = (arr) => arr[Math.floor(rand() * arr.length)];
const chance = (p) => rand() < p;
function shuffled(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

const DAY = 86400000;
const now = Date.now();
const iso = (msAgo) => new Date(now - msAgo).toISOString();
// 本地日历日（hireDate/dueAt 都按本地日期比较，见 server.js dateLocalOffset）
function localDate(offsetDays = 0) {
  const d = new Date(now + offsetDays * DAY);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// ---------- 主流程（失败时删掉半成品，让重跑不会被幂等检查卡住） ----------
try {
  main();
} catch (e) {
  try { store.close(); } catch {}
  for (const f of [OUT, OUT + "-wal", OUT + "-shm"]) { try { fs.rmSync(f, { force: true }); } catch {} }
  console.error("生成失败，已清理半成品: " + e.stack);
  process.exit(1);
}

function main() {
  store.init({ hashPassword });
  // 模块自带迁移（modules/<id>/migrations/）：服务启动时同样会执行；这里先执行，演示库拿到手就是当前的完整结构。Unfolding Lab 版目前没有模块自带迁移。
  const REGISTRY = require(path.join(__dirname, "..", "kernel", "registry.js")).load();
  store.runModuleMigrations(REGISTRY.MIGRATIONS);

  // ======================================================================
  // 1) 课程内容：种子已带 nho（新员工入职指南，3 门课）；再造 3 门中性课
  // ======================================================================
  const mcq = (courseId, question, question_zh, correct, correct_zh, wrong) => ({
    courseId, moduleId: null, type: "mcq", question, question_zh,
    options: [{ text: correct, text_zh: correct_zh, ok: true }, ...wrong.map(([text, text_zh]) => ({ text, text_zh }))],
    explanation: correct, explanation_zh: correct_zh,
  });
  const sec = (heading, heading_zh, html, html_zh) => ({ heading, heading_zh, html, html_zh, video: null, videoEmbed: null, attachments: [] });

  const EXTRA_PROGRAMS = [
    // Unfolding Lab 版（2026-10-12）：当前种子已不带入职项目 nho，演示库自己造一个中性的新员工入职项目（下文的指派、逾期、完成都依赖它）
    {
      id: "nho",
      title: "New Hire Orientation", title_zh: "新员工入职",
      description: "How we work, who to ask, and the first-month essentials.",
      description_zh: "我们怎样工作、遇到问题找谁，以及入职第一个月要做的事。",
      enrollType: "mandatory",
      exam: { title: "Orientation Check", title_zh: "入职小测", passingScore: 80, mcqCount: 5, openCount: 0, timeLimitMinutes: 15 },
      courses: [
        {
          id: "nho-welcome", title: "Welcome Aboard", title_zh: "欢迎加入",
          description: "Our purpose, values and ways of working.", description_zh: "我们的使命、价值观与工作方式。",
          modules: [
            { id: "nho-w-m1", title: "Purpose & Values", title_zh: "使命与价值观", minutes: 8, sections: [
              sec("Why we exist", "我们为什么存在",
                "<p>We help people and organisations see what is unfolding between them — and act on it. Every role contributes to that.</p>",
                "<p>我们帮助个人与组织看见彼此之间正在展开的东西，并据此行动。每个岗位都为此出力。</p>"),
              sec("How we work", "我们怎样工作",
                "<p>Say what you see, ask before assuming, and close the loop: a request is finished when the person who asked knows it is.</p>",
                "<p>说出你看到的，先问再假设，事情要闭环：只有提出请求的人知道已完成，才算完成。</p>"),
            ] },
            { id: "nho-w-m2", title: "Your First Month", title_zh: "你的第一个月", minutes: 10, sections: [
              sec("Who to ask", "遇到问题找谁",
                "<p>Your manager for priorities, your buddy for day-to-day questions, HR for contracts and leave, IT for accounts and devices.</p>",
                "<p>优先级问直属上级，日常问题问入职伙伴，合同与请假找 HR，账号与设备找 IT。</p>"),
              sec("First-month checklist", "第一个月清单",
                "<p>Finish your assigned courses, agree three goals with your manager, and book a 1-on-1 at the end of week four.</p>",
                "<p>完成指派课程，与上级商定三个目标，并在第四周末约一次 1 对 1 面谈。</p>"),
            ] },
          ],
        },
      ],
      questions: [
        ["nho-welcome", "A request is finished when…", "一项请求什么时候算完成？",
          "The person who asked knows it is done.", "提出请求的人知道它已完成。",
          [["You have started working on it.", "你已经开始做了。"], ["You believe it is good enough.", "你觉得差不多了。"], ["The deadline has passed.", "截止日期已过。"]]],
        ["nho-welcome", "Who should you ask about your priorities?", "关于工作优先级，应该问谁？",
          "Your direct manager.", "你的直属上级。",
          [["IT support.", "IT 支持。"], ["Any colleague nearby.", "随便一位附近的同事。"], ["Nobody — decide alone.", "不问，自己决定。"]]],
        ["nho-welcome", "Your laptop account is locked. Who do you contact?", "电脑账号被锁了，应该联系谁？",
          "IT.", "IT。",
          [["HR.", "HR。"], ["Your buddy.", "入职伙伴。"], ["Your manager's manager.", "上级的上级。"]]],
        ["nho-welcome", "What should you agree with your manager in the first month?", "第一个月应该与上级商定什么？",
          "Three goals for the coming period.", "接下来一段时间的三个目标。",
          [["Your next promotion date.", "下一次晋升的日期。"], ["Your annual leave plan only.", "只商定年假安排。"], ["Nothing — wait for the first review.", "什么都不用，等第一次评估。"]]],
        ["nho-welcome", "\"Ask before assuming\" means…", "「先问再假设」的意思是……",
          "Check what the other person means before acting on a guess.", "按猜测行动之前，先确认对方的意思。",
          [["Never make decisions.", "永远不做决定。"], ["Ask HR for every task.", "每件事都问 HR。"], ["Assume first, ask later if it fails.", "先假设，出问题再问。"]]],
        ["nho-welcome", "When should your first 1-on-1 with your manager happen?", "第一次与上级的 1 对 1 面谈在什么时候？",
          "At the end of week four.", "第四周周末。",
          [["After one year.", "满一年后。"], ["Only if something goes wrong.", "出了问题才约。"], ["On the first morning.", "入职第一天早上。"]]],
      ],
    },
    {
      id: "p-infosec",
      title: "Information Security Basics", title_zh: "信息安全基础",
      description: "Everyday habits that keep accounts, devices and company information safe.",
      description_zh: "保护账号、设备与公司信息安全的日常习惯。",
      enrollType: "mandatory",
      exam: { title: "Information Security Check", title_zh: "信息安全测验", passingScore: 80, mcqCount: 6, openCount: 0, timeLimitMinutes: 20 },
      courses: [
        {
          id: "is-accounts", title: "Accounts & Passwords", title_zh: "账号与密码安全",
          description: "Strong authentication habits for every system you use.", description_zh: "在每一个系统上都保持良好的认证习惯。",
          modules: [
            { id: "is-a-m1", title: "Passwords & MFA", title_zh: "密码与多因素认证", minutes: 10, sections: [
              sec("Strong and unique", "强且唯一",
                "<p>Use a different strong password for every system, and turn on multi-factor authentication wherever it is offered. A password manager makes both practical.</p>",
                "<p>每个系统使用不同的强密码，并在支持的地方开启多因素认证。使用密码管理器可以让两者都变得可行。</p>"),
              sec("Never share credentials", "绝不共享凭据",
                "<p>Accounts identify people. Never lend your account, and never type your password into a page reached from an unexpected link.</p>",
                "<p>账号用于识别个人身份。绝不外借账号，也绝不在来路不明的链接页面里输入密码。</p>"),
            ] },
            { id: "is-a-m2", title: "Phishing Awareness", title_zh: "识别钓鱼攻击", minutes: 12, sections: [
              sec("Spot the hook", "识破诱饵",
                "<p>Urgency, unusual senders and requests for credentials or payment are the classic signs. Verify through a second channel before acting.</p>",
                "<p>制造紧迫感、发件人异常、索要凭据或付款是典型特征。行动前先通过第二渠道核实。</p>"),
              sec("Report, don't test", "报告而不是试探",
                "<p>If a message looks suspicious, report it to IT security immediately — do not click the link 'just to check'.</p>",
                "<p>发现可疑消息立即报告 IT 安全团队 —— 不要「点开看看」来验证。</p>"),
            ] },
          ],
        },
        {
          id: "is-devices", title: "Devices & Data Handling", title_zh: "设备与数据处理",
          description: "Keeping laptops, phones and files out of the wrong hands.", description_zh: "让电脑、手机与文件远离错误的人。",
          modules: [
            { id: "is-d-m1", title: "Device Hygiene", title_zh: "设备安全习惯", minutes: 10, sections: [
              sec("Lock and update", "锁屏与更新",
                "<p>Lock your screen whenever you step away, keep systems patched, and only install software from approved sources.</p>",
                "<p>离开座位随手锁屏，及时安装系统更新，只从批准的来源安装软件。</p>"),
              sec("Files in the right place", "文件放对地方",
                "<p>Company files belong in company systems. Personal USB drives, private mailboxes and personal chat accounts are not storage or transfer channels.</p>",
                "<p>公司文件只放在公司系统里。个人 U 盘、私人邮箱和个人聊天账号都不是存储或传输渠道。</p>"),
            ] },
          ],
        },
      ],
      questions: [
        ["is-accounts", "What is the safest password practice?", "最安全的密码做法是什么？",
          "A unique strong password per system, kept in a password manager.", "每个系统一个独立强密码，用密码管理器保存。",
          [["One memorable password reused everywhere.", "一个好记的密码到处复用。"], ["Your name plus birth year.", "姓名加出生年份。"], ["Writing passwords on a desk note.", "把密码写在桌上的便签。"]]],
        ["is-accounts", "A login page asks for your password after you clicked a link in an unexpected email. You should…", "点开一封意外邮件里的链接后出现登录页要你输密码。你应该……",
          "Close it and report the message to IT security.", "关闭页面并向 IT 安全团队报告。",
          [["Enter the password quickly before the session expires.", "趁会话没过期赶紧输入密码。"], ["Try an old password first to be safe.", "先输一个旧密码试试以防万一。"], ["Forward the email to colleagues to warn them.", "把邮件转发给同事提醒大家。"]]],
        ["is-accounts", "Which is a classic phishing sign?", "以下哪项是典型的钓鱼特征？",
          "Urgent pressure to act plus a request for credentials.", "制造紧迫感并索要账号凭据。",
          [["A meeting invite from your own manager.", "来自你直属经理的会议邀请。"], ["A newsletter you subscribed to.", "你自己订阅的资讯邮件。"], ["A system update notice from IT with no links.", "IT 发的不带链接的系统更新通知。"]]],
        ["is-accounts", "Multi-factor authentication helps because…", "多因素认证有用，是因为……",
          "A stolen password alone is no longer enough to log in.", "仅凭被盗的密码已无法完成登录。",
          [["It makes passwords unnecessary.", "有了它就不需要密码了。"], ["It hides your account from attackers.", "它能把你的账号对攻击者隐藏起来。"], ["It speeds up the login process.", "它能加快登录速度。"]]],
        ["is-devices", "You need to work on a file at home tonight. The right way is…", "今晚需要在家处理一份文件。正确做法是……",
          "Use the company VPN / approved remote access to the file.", "通过公司 VPN 或批准的远程方式访问文件。",
          [["Email it to your personal mailbox.", "把文件发到私人邮箱。"], ["Copy it to a personal USB drive.", "拷到个人 U 盘带回家。"], ["Send it to yourself on a personal chat app.", "用个人聊天软件发给自己。"]]],
        ["is-devices", "Stepping away from your desk, you should…", "离开工位时，你应该……",
          "Lock the screen, even for a short break.", "即使短暂离开也要锁屏。",
          [["Leave the screen on to save time.", "为省时间让屏幕开着。"], ["Ask a neighbour to watch it.", "请邻座帮忙看着。"], ["Turn the monitor brightness down.", "把显示器亮度调低。"]]],
        ["is-devices", "Which software installation is acceptable on a work laptop?", "工作电脑上哪种软件安装是可接受的？",
          "Tools from the company's approved software catalogue.", "公司批准软件目录里的工具。",
          [["A cracked copy of a paid tool.", "付费工具的破解版。"], ["Any free tool from a download site.", "下载站上的任意免费工具。"], ["A game during the lunch break.", "午休时装个游戏。"]]],
      ],
    },
    {
      id: "p-comms",
      title: "Effective Workplace Communication", title_zh: "高效职场沟通",
      description: "Clear writing, productive meetings and feedback that lands.",
      description_zh: "清晰的书面表达、高效的会议与有效的反馈。",
      enrollType: "mandatory",
      exam: { title: "Workplace Communication Check", title_zh: "职场沟通测验", passingScore: 75, mcqCount: 5, openCount: 0, timeLimitMinutes: 15 },
      courses: [
        {
          id: "wc-core", title: "Communicating with Clarity", title_zh: "清晰沟通",
          description: "Say what matters, once, to the right audience.", description_zh: "把重要的话，一次说清，说给对的人。",
          modules: [
            { id: "wc-m1", title: "Writing that Works", title_zh: "有效的书面沟通", minutes: 10, sections: [
              sec("Lead with the point", "先说结论",
                "<p>Start with the decision or ask, then the context. Busy readers should learn what you need from them in the first two lines.</p>",
                "<p>先写结论或请求，再补充背景。忙碌的读者应该在前两行就知道你需要他们做什么。</p>"),
              sec("One message, one purpose", "一条消息一个目的",
                "<p>Mixing three asks into one long message means none of them gets answered. Split them, and make deadlines explicit.</p>",
                "<p>把三件事混在一条长消息里，结果往往一件都没有回音。拆开来发，并把截止时间写明确。</p>"),
            ] },
            { id: "wc-m2", title: "Meetings & Feedback", title_zh: "会议与反馈", minutes: 12, sections: [
              sec("Meetings with outcomes", "有产出的会议",
                "<p>Every meeting needs an owner, an agenda and written decisions. If none of the three exists, it could have been a message.</p>",
                "<p>每个会议都需要负责人、议程和书面结论。三者都没有的会，本可以用一条消息代替。</p>"),
              sec("Feedback on behaviour, not person", "对事不对人",
                "<p>Describe the specific behaviour and its impact, then agree the next step. Vague labels help nobody improve.</p>",
                "<p>描述具体行为及其影响，然后约定下一步。模糊的标签帮不了任何人改进。</p>"),
            ] },
          ],
        },
      ],
      questions: [
        ["wc-core", "The best first line of a request email is…", "请求类邮件最好的第一句是……",
          "The specific ask and its deadline.", "明确的请求内容和截止时间。",
          [["A long recap of the project history.", "把项目历史长篇回顾一遍。"], ["An apology for writing.", "先为打扰对方道歉。"], ["A list of everyone involved.", "列出所有相关人员。"]]],
        ["wc-core", "A meeting is worth holding when…", "什么时候值得开一个会？",
          "A decision needs live discussion among the people present.", "需要相关人员当场讨论才能做出决定时。",
          [["Information just needs to be broadcast.", "只是需要单向广播信息时。"], ["The organiser wants visibility.", "组织者想刷存在感时。"], ["It repeats every week by habit.", "只是习惯性的每周例会时。"]]],
        ["wc-core", "Good feedback focuses on…", "好的反馈聚焦于……",
          "Specific behaviour and its impact, with a next step.", "具体行为及其影响，并给出下一步。",
          [["The person's character.", "对方的性格。"], ["Comparing them with a colleague.", "拿对方和同事比较。"], ["Listing every past mistake.", "罗列过去所有错误。"]]],
        ["wc-core", "When a discussion thread goes back and forth five times with no progress…", "一个话题来回拉扯五轮还没有进展时……",
          "Switch to a short call and write down the conclusion afterwards.", "改为简短通话，事后把结论写下来。",
          [["Keep replying until someone gives up.", "继续回复直到有人放弃。"], ["Add more people to the thread.", "把更多人拉进讨论。"], ["Drop the topic silently.", "悄悄放弃这个话题。"]]],
        ["wc-core", "Written decisions after a meeting matter because…", "会后书面结论重要，是因为……",
          "They make the outcome checkable and actionable for everyone.", "让结论对所有人可查可执行。",
          [["They prove the meeting happened.", "能证明会议开过了。"], ["They replace doing the work.", "可以代替实际执行。"], ["They make minutes longer.", "能让会议纪要更长。"]]],
      ],
    },
    {
      id: "p-leadership",
      title: "Leadership Foundations", title_zh: "领导力基础",
      description: "First-time manager skills: delegation, coaching and running a healthy team. Elective — apply to enrol.",
      description_zh: "新任管理者技能：授权、辅导与团队健康运转。选修课，需申请报名。",
      enrollType: "elective",
      exam: { title: "Leadership Foundations Check", title_zh: "领导力基础测验", passingScore: 70, mcqCount: 5, openCount: 0, timeLimitMinutes: 20 },
      courses: [
        {
          id: "lf-delegation", title: "Delegation & Ownership", title_zh: "授权与责任",
          description: "Handing over outcomes, not just tasks.", description_zh: "交出去的是结果责任，而不只是任务。",
          modules: [
            { id: "lf-d-m1", title: "Delegate Outcomes", title_zh: "按结果授权", minutes: 10, sections: [
              sec("Define done, not steps", "定义「完成」而非步骤",
                "<p>Describe the outcome, constraints and deadline, then let the owner choose the path. Prescribing every step trains dependence.</p>",
                "<p>说明目标结果、约束条件与截止时间，路径交给负责人自己选择。事事规定步骤只会训练出依赖。</p>"),
              sec("Check in, don't take over", "跟进而不是接管",
                "<p>Agree checkpoints in advance. When a checkpoint slips, coach through questions before offering answers.</p>",
                "<p>事先约定检查点。检查点出现偏差时，先用提问辅导，再考虑给答案。</p>"),
            ] },
          ],
        },
        {
          id: "lf-coaching", title: "Coaching Conversations", title_zh: "辅导式对话",
          description: "Questions that grow people.", description_zh: "用提问让人成长。",
          modules: [
            { id: "lf-c-m1", title: "Ask Before Tell", title_zh: "先问后说", minutes: 12, sections: [
              sec("The coaching stance", "辅导的姿态",
                "<p>Start from what the person has tried and what they think. Your solution delivered too early ends their thinking.</p>",
                "<p>从对方尝试过什么、怎么看开始。过早给出你的方案，会终结对方的思考。</p>"),
              sec("Commitment at the end", "以承诺收尾",
                "<p>Every coaching conversation ends with one concrete next action, an owner and a date.</p>",
                "<p>每次辅导对话都以一个具体的下一步行动、负责人和日期收尾。</p>"),
            ] },
          ],
        },
      ],
      questions: [
        ["lf-delegation", "Good delegation hands over…", "好的授权交出去的是……",
          "An outcome with constraints and a deadline.", "带约束条件和截止时间的结果责任。",
          [["A list of steps to follow exactly.", "一份必须照做的步骤清单。"], ["Only the tasks nobody wants.", "只有没人想做的杂活。"], ["The blame if things go wrong.", "出了问题时的责任推卸。"]]],
        ["lf-delegation", "A checkpoint shows the work is off track. First move?", "检查点发现工作偏离了方向。第一步是？",
          "Ask questions to understand, then coach toward a correction.", "先提问了解情况，再辅导对方纠偏。",
          [["Take the work back immediately.", "立刻把活收回来自己干。"], ["Wait until the deadline to judge.", "等到截止日再作评判。"], ["Escalate to your own manager.", "直接上报你自己的上级。"]]],
        ["lf-coaching", "In a coaching conversation, you should first…", "辅导式对话中，你应该先……",
          "Ask what the person has tried and what they think.", "询问对方尝试过什么、自己怎么看。",
          [["Present your solution.", "先讲你的解决方案。"], ["List their recent mistakes.", "列举对方最近的错误。"], ["Set a performance warning.", "先给一个绩效警告。"]]],
        ["lf-coaching", "Every coaching conversation should end with…", "每次辅导对话都应该以什么收尾？",
          "One concrete next action with an owner and a date.", "一个有负责人和日期的具体行动。",
          [["A motivational quote.", "一句励志名言。"], ["A promise to talk again sometime.", "一句「改天再聊」。"], ["A summary of company policy.", "一段公司政策摘要。"]]],
        ["lf-delegation", "Prescribing every step of delegated work mainly…", "对授权工作事事规定步骤，主要后果是……",
          "Trains dependence and blocks ownership.", "训练出依赖，扼杀责任感。",
          [["Guarantees the best quality.", "能保证最好的质量。"], ["Saves the manager time.", "为管理者节省时间。"], ["Motivates senior team members.", "能激励资深成员。"]]],
      ],
    },
  ];

  console.log("① 造 3 门新课（连同题库与考试）…");
  for (const p of EXTRA_PROGRAMS) {
    // 种子已带同名项目（非正式模式的种子自带 nho「新员工入职指南」）就用种子的，不重复造
    if (store.listContent("program").some((x) => x.id === p.id)) { console.log(`   = ${p.id}（种子已有，沿用）`); continue; }
    const courseIds = p.courses.map((c) => c.id);
    store.putContent("program", p.id, {
      id: p.id, title: p.title, title_zh: p.title_zh,
      description: p.description, description_zh: p.description_zh,
      status: "published", enrollType: p.enrollType, defaultDueDays: 30, courseIds,
      passingScore: p.exam.passingScore, examMcqCount: p.exam.mcqCount, examOpenCount: p.exam.openCount,
      examTimeLimitMinutes: p.exam.timeLimitMinutes, maxAttempts: 0, retakeCooldownHours: 0, showAnswersAfterExam: true,
    });
    for (const c of p.courses) store.putContent("course", c.id, { ...c, programId: p.id });
    for (const [courseId, q, qzh, ok, okzh, wrong] of p.questions) store.addQuestion(mcq(courseId, q, qzh, ok, okzh, wrong));
    const examId = "exam-" + p.id;
    store.createExam({
      id: examId, programId: p.id, title: p.exam.title, title_zh: p.exam.title_zh, status: "published",
      passingScore: p.exam.passingScore, mcqCount: p.exam.mcqCount, openCount: p.exam.openCount,
      timeLimitMinutes: p.exam.timeLimitMinutes, maxAttempts: 0, retakeCooldownHours: 0, showAnswersAfterExam: true,
    });
    store.setExamCourses(examId, courseIds);
    console.log(`   + ${p.id}（${courseIds.length} 门课，考试 ${examId}）`);
  }

  // ======================================================================
  // 2) 组织：10 个部门、1 总经理 → 9 总监 → 90 员工（每经理 5-12 直属）
  // ======================================================================
  console.log("② 造组织与 100 名员工…");
  const DEPTS = [
    // [部门, 总监职位, 总监职级, 员工数, 员工职位池]
    ["技术部", "技术总监", "M5", 12, ["后端工程师", "前端工程师", "测试工程师", "运维工程师", "数据工程师"]],
    ["产品部", "产品总监", "M4", 9, ["产品经理", "产品专员", "UI 设计师", "交互设计师"]],
    ["市场部", "市场总监", "M4", 10, ["市场专员", "品牌经理", "内容运营", "活动策划"]],
    ["销售部", "销售总监", "M5", 11, ["销售经理", "大客户经理", "销售代表", "渠道专员"]],
    ["客服部", "客服总监", "M4", 12, ["客服组长", "客服专员", "质检专员"]],
    ["运营部", "运营总监", "M4", 10, ["运营专员", "数据分析师", "项目协调员"]],
    ["人力资源部", "人力资源总监", "M4", 8, ["招聘专员", "培训主管", "薪酬绩效专员", "HRBP"]],
    ["财务部", "财务总监", "M4", 9, ["会计", "出纳", "财务分析师"]],
    ["法务与合规部", "法务总监", "M4", 9, ["法务专员", "合规专员", "风控专员"]],
  ];
  // 只铺 P（专业）序列：M 是管理序列，只给带团队的总监与总经理（M4–M7）；不带团队的员工配 P1–P7（通用职级，2026-10-12）。
  const STAFF_LEVELS = ["P1", "P2", "P3", "P3", "P3", "P3", "P4", "P4", "P5", "P5", "P5", "P6", "P7", "P5", "P7"];

  const deptRows = { 总经办: store.ensureDepartment("总经办") };
  for (const [name] of DEPTS) deptRows[name] = store.ensureDepartment(name);

  const FIRST = ["Maria", "Jose", "Juan", "Ana", "Miguel", "Paolo", "Carlo", "Marco", "Rafael", "Gabriel", "Andrea", "Bianca", "Camille", "Danica", "Erika", "Francesca", "Isabel", "Jasmine", "Liza", "Nicole", "Patricia", "Regine", "Samantha", "Trisha", "Kevin", "Mark", "John", "Christian", "Joshua", "Daniel", "Adrian", "Bryan", "Charles", "Dennis", "Eric", "Francis", "Grace", "Hannah", "Ivan", "Jerome", "Kristine", "Lorenzo", "Melissa", "Nathan", "Olivia", "Patrick", "Sofia", "Tomas", "Vince", "Wendy", "Mei", "Hiro", "Anya", "Diego", "Lucas", "Nadia", "Omar", "Priya", "Thea", "Elena"];
  const LAST = ["Santos", "Reyes", "Cruz", "Bautista", "Ocampo", "Garcia", "Mendoza", "Dela Cruz", "Aquino", "Ramos", "Domingo", "Navarro", "Salazar", "Torres", "Castillo", "Flores", "Morales", "Rivera", "Aguilar", "Fernandez", "Lim", "Tan", "Uy", "Ong", "Sy", "Chua", "Yap", "Go", "Pascual", "Soriano", "Velasco", "Robles", "Kim", "Nguyen", "Sato", "Tanaka", "Chen", "Park", "Lee", "Silva", "Costa", "Novak", "Petrov", "Patel"];
  const usedNames = new Set(["Ramon Villegas", "Katrina Villanueva", "Ramil Dizon", "Bea Salvador", "Alex Rivera"]);
  function nextName() {
    for (let i = 0; i < 200; i++) {
      const n = `${pick(FIRST)} ${pick(LAST)}`;
      if (!usedNames.has(n)) { usedNames.add(n); return n; }
    }
    throw new Error("姓名池耗尽");
  }
  const pwHash = hashPassword("Demo1234");
  const emailOf = (name) => name.toLowerCase().replace(/[^a-z ]/g, "").trim().replace(/ +/g, ".") + "@dpdemo.example";
  const phone = () => `09${rint(15, 99)} ${rint(100, 999)} ${String(rint(0, 9999)).padStart(4, "0")}`;

  let empNo = 1001;
  const people = []; // {id, employeeId, name, dept, position, jobLevel, hireDate, managerId, isHead, isGM}
  function addPerson({ name, dept, position, jobLevel, hireDaysAgo, managerId, isHead = false, isGM = false, employeeIdWanted = null }) {
    const employeeId = employeeIdWanted || `UL-${empNo++}`;
    const id = "u-dp" + employeeId.slice(3);
    const hireDate = localDate(-hireDaysAgo);
    const probation = hireDaysAgo < 183;
    store.createUser({
      id, employeeId, name, role: "employee", passwordHash: pwHash,
      department: dept, position, jobLevel, hireDate,
      email: emailOf(name), phone: phone(), managerId: managerId || null,
      mustChangePassword: 0, empStatus: probation ? "probation" : "regular",
    });
    const p = { id, employeeId, name, dept, position, jobLevel, hireDate, hireDaysAgo, managerId: managerId || null, isHead, isGM };
    people.push(p);
    return p;
  }

  // 总经理（UL-1001）
  const gm = addPerson({ name: "Ramon Villegas", dept: "总经办", position: "总经理", jobLevel: "M7", hireDaysAgo: 365 * 4 + 250, isGM: true });
  // 9 名总监（UL-1002 ~ UL-1010）
  const heads = [];
  for (const [dept, headPos, headLevel] of DEPTS) {
    // 全功能测试账号（2026-10-12）：人力资源总监 = UL-TEST / Alex Rivera（超级管理员、人力资源部 HoD、HR 团队上级、发展项目班主任与讲师，权限与数据在 demo-enrich.js 里补齐）。
    // 跳过 UL-1008 这个号，保证后面员工与三位主角的工号不变。
    if (dept === "人力资源部") { heads.push(addPerson({ name: "Alex Rivera", dept, position: headPos, jobLevel: headLevel, hireDaysAgo: 1460, managerId: gm.id, isHead: true, employeeIdWanted: "UL-TEST" })); empNo++; continue; }
    heads.push(addPerson({ name: nextName(), dept, position: headPos, jobLevel: headLevel, hireDaysAgo: rint(900, 1650), managerId: gm.id, isHead: true }));
  }
  // 90 名员工（UL-1011 ~ UL-1100），先记 3 个新人与 3 位主角的落位
  const PROTA = { newbie: null, star: null, improver: null };
  const newHireSlots = []; // 近 30 天入职
  DEPTS.forEach(([dept, , , staffN, posPool], di) => {
    const head = heads[di];
    for (let i = 0; i < staffN; i++) {
      let name = null, hireDaysAgo = rint(40, 365 * 5), position = pick(posPool), jobLevel = pick(STAFF_LEVELS);
      // 主角与新人的固定落位（工号可预告给销售）
      if (dept === "市场部" && i === 0) { name = "Katrina Villanueva"; position = "品牌经理"; jobLevel = "P6"; hireDaysAgo = 365 * 3 + 40; }
      if (dept === "运营部" && i === 0) { name = "Ramil Dizon"; position = "运营专员"; jobLevel = "P3"; hireDaysAgo = 365 * 2 + 10; }
      if (dept === "客服部" && i === 0) { name = "Bea Salvador"; position = "客服专员"; jobLevel = "P2"; hireDaysAgo = 13; }
      if (dept === "人力资源部" && i === 1) { position = "HRBP"; jobLevel = "P5"; hireDaysAgo = Math.max(hireDaysAgo, 400); }   // 申诉处理人（demo-enrich.js 按岗位找她）
      if (dept === "技术部" && i === staffN - 1) hireDaysAgo = 6;   // 新人 2
      if (dept === "法务与合规部" && i === staffN - 1) hireDaysAgo = 26; // 新人 3
      const p = addPerson({ name: name || nextName(), dept, position, jobLevel, hireDaysAgo, managerId: head.id });
      if (p.name === "Katrina Villanueva") PROTA.star = p;
      if (p.name === "Ramil Dizon") PROTA.improver = p;
      if (p.name === "Bea Salvador") PROTA.newbie = p;
      if (hireDaysAgo <= 30) newHireSlots.push(p);
    }
  });
  const staff = people.filter((p) => !p.isHead && !p.isGM);
  // 部门负责人 & 组织小抽查
  DEPTS.forEach(([dept], di) => store.updateDepartment(deptRows[dept].id, { ownerId: heads[di].id }));
  const directs = new Map();
  for (const p of people) if (p.managerId) directs.set(p.managerId, (directs.get(p.managerId) || 0) + 1);
  for (const [mid, n] of directs) {
    if (n < 5 || n > 12) throw new Error(`汇报树越界: ${mid} 有 ${n} 个直属（要求 5-12）`);
  }
  if (people.length !== 100) throw new Error(`员工数 ${people.length} ≠ 100`);
  if (newHireSlots.length < 2 || newHireSlots.length > 3) throw new Error(`近 30 天新人 ${newHireSlots.length} 个（要求 2-3）`);
  console.log(`   + ${people.length} 人 / ${Object.keys(deptRows).length} 个部门 / 近 30 天新人 ${newHireSlots.length} 名`);

  // 最近登录时间（约七成登录过；最新的新人还没登录过）
  for (const p of people) {
    if (p === newHireSlots.find((x) => x.hireDaysAgo <= 7)) continue;
    // 上限压在入职之后：近 30 天入职的新人抽到「27 天前登录」，花名册的「最近登录」
    // 就早于「入职日期」—— 销售一点开员工列表就露馅。
    if (chance(0.72)) store.setLastLogin(p.id, iso(Math.min(rint(1, 45) * 0.6, Math.max(0.5, p.hireDaysAgo - 1)) * DAY));
  }
  // 两条矩阵关系，让组织架构图的虚线层也有内容
  const analyst = staff.find((p) => p.position === "数据分析师");
  if (analyst) store.addSecondaryLine({ userId: analyst.id, managerId: heads[0].id, kind: "dotted", position: "数据口径对接", department: "技术部", note: "数据指标口径双线汇报", createdBy: "u-admin" });
  store.addSecondaryLine({ userId: PROTA.star.id, managerId: heads[4].id, kind: "dotted", position: "客户之声项目", department: "客服部", note: "跨部门项目虚线汇报", createdBy: "u-admin" });

  // ======================================================================
  // 3) 培训：全员指派 ≥2 门；进度 0-100%；30 人通过考试 + 8 人未通过
  // ======================================================================
  console.log("③ 指派培训、铺进度、造考试成绩…");
  const programs = store.listContent("program");
  const courseById = new Map(store.listContent("course").map((c) => [c.id, c]));
  const modulesOf = (pid) => {
    const p = programs.find((x) => x.id === pid);
    return (p.courseIds || []).flatMap((cid) => (courseById.get(cid) ? courseById.get(cid).modules.map((m) => ({ courseId: cid, moduleId: m.id })) : []));
  };
  const assigned = new Map(); // userId -> Set(programId)
  function assign(uid, pid, dueOffsetDays) {
    store.setAssignment(uid, pid, localDate(dueOffsetDays));
    if (!assigned.has(uid)) assigned.set(uid, new Set());
    assigned.get(uid).add(pid);
  }
  const leadershipUsers = new Set([PROTA.star.id, heads[0].id, heads[3].id, heads[6].id]); // 选修：主角绩优 + 3 位总监
  for (const p of people) {
    assign(p.id, "nho", p.hireDaysAgo <= 35 ? 35 - p.hireDaysAgo + 5 : rint(15, 45));
    assign(p.id, chance(0.6) ? "p-infosec" : "p-comms", rint(10, 40));
    if (chance(0.25)) assign(p.id, assigned.get(p.id).has("p-infosec") ? "p-comms" : "p-infosec", rint(10, 40));
    if (leadershipUsers.has(p.id)) assign(p.id, "p-leadership", rint(20, 50));
  }

  // 考试成绩（快照/判分形状与 server.js 的 start/submit 一致）
  let attemptSeq = 1;
  // nearMiss：差一题及格。演示成绩申诉时要用 —— 申诉理由说的是「第 3 题判分有误」，
  // 卷面却只有 17 分（随机低分）的话，客户一眼就看出这数据是假的。
  function makeAttempt(uid, programId, wantPass, daysAgo, blur = 0, nearMiss = false) {
    const examId = "exam-" + programId;
    const exam = store.getExam(examId);
    const courseIds = new Set(store.getExamCourseIds(examId));
    const pool = store.listQuestions().filter((q) => courseIds.has(q.courseId) && ["mcq", "multi", "fill"].includes(q.type));
    const qs = shuffled(pool).slice(0, Math.min(exam.mcqCount || 5, pool.length));
    const total = qs.length;
    const minPass = Math.ceil((exam.passingScore / 100) * total);
    const right = wantPass ? rint(minPass, total)
      : nearMiss ? Math.max(1, minPass - 1)
      : rint(Math.max(1, Math.floor(total * 0.3)), Math.max(1, minPass - 1));
    const rightSet = new Set(shuffled(qs.map((_, i) => i)).slice(0, right));
    const questions = qs.map((q) => q.type === "fill"
      ? { id: q.id, type: "fill", question: q.question, question_zh: q.question_zh || null, answers: q.answers, explanation: q.explanation, explanation_zh: q.explanation_zh || null }
      : { id: q.id, type: q.type, question: q.question, question_zh: q.question_zh || null, explanation: q.explanation, explanation_zh: q.explanation_zh || null, options: shuffled(q.options.map((o) => ({ text: o.text, text_zh: o.text_zh || null, ok: !!o.ok }))) });
    const answers = {}; const detail = []; let earned = 0;
    questions.forEach((s, i) => {
      const isRight = rightSet.has(i);
      if (s.type === "fill") {
        const raw = isRight ? s.answers[0] : "integrity";
        const ok = s.answers.some((a) => a.toLowerCase().trim() === raw.toLowerCase().trim());
        if (ok) earned += 1;
        answers[s.id] = raw;
        detail.push({ id: s.id, type: "fill", question: s.question, question_zh: s.question_zh, answer: raw, accepted: s.answers, isRight: ok, explanation: s.explanation, explanation_zh: s.explanation_zh });
      } else if (s.type === "multi") {
        const correct = s.options.map((o, j) => (o.ok ? j : -1)).filter((j) => j >= 0);
        const wrongIdx = s.options.findIndex((o) => !o.ok);
        const picked = isRight ? correct : [correct[0], wrongIdx].filter((j) => j >= 0);
        if (isRight) earned += 1;
        answers[s.id] = picked;
        detail.push({ id: s.id, type: "multi", question: s.question, question_zh: s.question_zh, options: s.options.map((o) => ({ text: o.text, text_zh: o.text_zh })), picked, correct, isRight, partial: false, explanation: s.explanation, explanation_zh: s.explanation_zh });
      } else {
        const correctIdx = s.options.findIndex((o) => o.ok);
        const picked = isRight ? correctIdx : (correctIdx + 1) % s.options.length;
        if (isRight) earned += 1;
        answers[s.id] = picked;
        detail.push({ id: s.id, type: "mcq", question: s.question, question_zh: s.question_zh, options: s.options.map((o) => ({ text: o.text, text_zh: o.text_zh })), picked, correct: correctIdx, isRight, explanation: s.explanation, explanation_zh: s.explanation_zh });
      }
    });
    const percent = Math.round((earned / total) * 100);
    const passed = require(path.join(__dirname, "..", "modules", "learning", "qtypes", "index.js")).passedOf(earned, total, exam.passingScore);   // F57：与交卷同一口径（未四舍五入）
    const submittedAt = iso(daysAgo * DAY + rint(0, 8) * 3600000);
    const id = "a-demo-" + attemptSeq++;
    store.createAttempt({ id, userId: uid, programId, examId, startedAt: new Date(new Date(submittedAt).getTime() - rint(12, 24) * 60000).toISOString(), questions });
    store.submitAttempt(id, { submittedAt, answers, percent, passed, detail, blurCount: blur });
    // wrongs：成绩申诉要指向卷面上真正判错的那道题（见 ④），题号随机卷是变的，
    // 所以从判分结果里回读，别在申诉理由里写死题号。
    const wrongs = detail.map((d, i) => ({ no: i + 1, qid: d.id, question: d.question_zh || d.question, isRight: d.isRight })).filter((d) => !d.isRight);
    return { id, percent, passed, wrongs };
  }
  const completeAll = (uid, pid, daysAgo) => modulesOf(pid).forEach((m, i) => store.setModuleComplete(uid, m.courseId, m.moduleId, iso(daysAgo * DAY + i * 3600000)));

  // 30 名通过者（主角绩优在内，其中 6 人有一次先挂后过），8 名未通过者（主角待改进在内）
  const nonNew = staff.filter((p) => p.hireDaysAgo > 35 && p !== PROTA.improver && p !== PROTA.star);
  const passers = [PROTA.star, ...shuffled(nonNew).slice(0, 29)];
  const failers = [PROTA.improver, ...shuffled(nonNew.filter((p) => !passers.includes(p))).slice(0, 7)];
  const passedOf = new Map(); // userId -> Set(已通过的 programId)
  const markPassed = (uid, pid) => { if (!passedOf.has(uid)) passedOf.set(uid, new Set()); passedOf.get(uid).add(pid); };
  passers.forEach((p, i) => {
    const pids = [...assigned.get(p.id)].filter((pid) => pid !== "p-leadership");
    const pid = pids.includes("nho") && chance(0.5) ? "nho" : pick(pids);
    const daysAgo = rint(5, 80);
    completeAll(p.id, pid, daysAgo + 2);
    if (i < 6 && p !== PROTA.star) makeAttempt(p.id, pid, false, daysAgo + 1, rint(0, 2)); // 先挂一次
    makeAttempt(p.id, pid, true, daysAgo);
    markPassed(p.id, pid);
  });
  // 测试账号 UL-TEST：入职课程学完并通过考试，领导力课程学了一半（员工端「课程」「成长档案」都有数据）
  {
    const T = heads[6];
    completeAll(T.id, "nho", 40);
    makeAttempt(T.id, "nho", true, 39);
    markPassed(T.id, "nho");
    const lmods = modulesOf("p-leadership");
    lmods.slice(0, Math.ceil(lmods.length / 2)).forEach((m, i) => store.setModuleComplete(T.id, m.courseId, m.moduleId, iso((6 - i) * DAY)));
  }
  // 主角绩优再过一门（履历更漂亮）
  completeAll(PROTA.star.id, "p-infosec", 30);
  makeAttempt(PROTA.star.id, "p-infosec", true, 28);
  markPassed(PROTA.star.id, "p-infosec");
  let improverAttempt = null;
  failers.forEach((p) => {
    const pids = [...assigned.get(p.id)].filter((pid) => pid !== "p-leadership");
    const pid = p === PROTA.improver ? (pids.includes("p-infosec") ? "p-infosec" : pids[0]) : pick(pids);
    const daysAgo = rint(3, 40);
    completeAll(p.id, pid, daysAgo + 2);
    const a = makeAttempt(p.id, pid, false, daysAgo, rint(0, 3), p === PROTA.improver);
    if (p === PROTA.improver) improverAttempt = { ...a, programId: pid };
  });
  // 其余 (人, 课) 进度随机铺 0-100%
  const touched = new Set([...passers, ...failers].map((p) => p.id));
  for (const p of people) {
    if (p === PROTA.newbie) continue; // 新人的进度在下面单独铺（学到一半）
    for (const pid of assigned.get(p.id)) {
      if (touched.has(p.id) && pid !== "p-leadership") continue;
      const mods = modulesOf(pid);
      const frac = p.hireDaysAgo <= 7 ? 0 : chance(0.15) ? 0 : chance(0.4) ? 1 : rand();
      const k = Math.round(frac * mods.length);
      mods.slice(0, k).forEach((m, i) => store.setModuleComplete(p.id, m.courseId, m.moduleId, iso(rint(2, Math.max(3, Math.min(60, p.hireDaysAgo))) * DAY + i * 3600000)));
    }
  }
  // 主角新人：入职培训学到一半
  {
    const mods = modulesOf("nho");
    mods.slice(0, Math.ceil(mods.length / 2)).forEach((m, i) => store.setModuleComplete(PROTA.newbie.id, m.courseId, m.moduleId, iso((6 - i) * DAY)));
  }
  // 3 人培训逾期（含主角待改进）。只从「nho 还没通过」的人里挑 —— server.js 的
  // statusOf 先判 passed 再判 dueAt，已通过的人即使 dueAt 过期也算 done，挑到他们
  // 逾期数就白设了。
  const nhoNotPassed = nonNew.filter((p) => !(passedOf.get(p.id) || new Set()).has("nho"));
  const overdue = [PROTA.improver, ...shuffled(nhoNotPassed).slice(0, 2)];
  for (const p of new Set(overdue)) store.setAssignment(p.id, "nho", localDate(-rint(4, 12)));

  // 15 人「所有已指派课程全部通过」。overview.byDept.done 只统计「已指派项目全部
  // passed」的人（server.js:5698），而上面每个通过者只考了一门 —— 不补这一步，
  // 训练总览的部门表十行全是「完成 0」，销售当场就被问住。逾期演示用的那几人排除
  // 在外（passed 会盖掉 overdue）。
  const overdueIds = new Set([...new Set(overdue)].map((p) => p.id));
  const fullCompleters = passers.filter((p) => !assigned.get(p.id).has("p-leadership") && !overdueIds.has(p.id)).slice(0, 15);
  const fullCompleterIds = new Set(fullCompleters.map((p) => p.id));
  for (const p of fullCompleters) {
    for (const pid of assigned.get(p.id)) {
      if ((passedOf.get(p.id) || new Set()).has(pid)) continue;
      const daysAgo = rint(4, 60);
      completeAll(p.id, pid, daysAgo + 2);
      makeAttempt(p.id, pid, true, daysAgo);
      markPassed(p.id, pid);
    }
  }
  console.log(`   + 指派 ${[...assigned.values()].reduce((s, x) => s + x.size, 0)} 条 / 通过者 ${passers.length} 人（全科通过 ${fullCompleters.length} 人）/ 未通过 ${failers.length} 人`);

  // ======================================================================
  // 4) 审批流：3 条待审学习申请（选修课）+ 2 已批 1 已驳回；1 条待处理成绩申诉
  // ======================================================================
  console.log("④ 造学习申请与成绩申诉…");
  const leadership = programs.find((x) => x.id === "p-leadership");
  // 全科通过的 15 人排除在外：批准报名会给他们加一门没通过的课，把 byDept.done 抵掉。
  const notAssignedLeadership = staff.filter((p) => !assigned.get(p.id).has("p-leadership") && p.hireDaysAgo > 120 && !fullCompleterIds.has(p.id));
  // 申请理由两条纪律：① 不提具体岗位名 —— 原来那句「准备竞聘客服组长」随机落到
  // 法务、财务的人头上就是穿帮；② 一人一条不重复 —— 六条申请里四条同一句话，
  // 客户点开「学习申请」一眼就看出是脚本刷的。
  const reqNotes = [
    "下一步想带小组，先把管理基础补上。",
    "明年计划带 2 名新人，希望提前补上辅导技能。",
    "个人发展计划里写了转管理岗，这门课是第一步。",
    "部门轮岗后要带小项目，想学授权与跟进。",
    "已经在代管一部分小组事务，想把方法论学系统些。",
    "希望把目标拆解和跟进做扎实，减少来回返工。",
  ];
  // 六个申请人来自六个不同部门：同一个部门连开三条待审，列表看着就像批量伪造。
  const poolByDept = new Map();
  for (const p of shuffled(notAssignedLeadership)) {
    if (!poolByDept.has(p.dept)) poolByDept.set(p.dept, []);
    poolByDept.get(p.dept).push(p);
  }
  const deptOrder = shuffled([...poolByDept.keys()]);
  if (deptOrder.length < 6) throw new Error(`选修申请候选只覆盖 ${deptOrder.length} 个部门（需要 6 个）`);
  const pendingReqUsers = deptOrder.slice(0, 3).map((d) => poolByDept.get(d)[0]);
  const decidedReqUsers = deptOrder.slice(3, 6).map((d) => poolByDept.get(d)[0]);
  const notes = shuffled(reqNotes);
  const reqAges = {}; // 申请单 id → 提交距今天数（收尾回填，避免三条挤在同一毫秒）
  let reqSeq = 1;
  pendingReqUsers.forEach((p, i) => {
    const id = "er-demo-" + reqSeq++;
    reqAges[id] = [6, 3, 1][i];
    store.createEnrollmentRequest({ id, userId: p.id, programId: "p-leadership", note: notes[i] });
    store.createNotification({
      id: "n-demo-er" + (i + 1) + "-adm", userId: "u-admin", type: "enroll.request",
      title: `${p.name} applied for "${leadership.title}"`,
      title_zh: `${p.name} 申请学习《${leadership.title_zh || leadership.title}》`,
      body: "Pending your approval under Requests.", body_zh: "待你在「学习申请」中审批。",
      link: "#/admin/requests",
    });
  });
  decidedReqUsers.forEach((p, i) => {
    const id = "er-demo-" + reqSeq++;
    reqAges[id] = [24, 20, 16][i];
    const r = store.createEnrollmentRequest({ id, userId: p.id, programId: "p-leadership", note: notes[3 + i] });
    if (i < 2) {
      store.decideApproval(r.id, "approved", "u-admin", "结合发展计划，同意报名。");
      assign(p.id, "p-leadership", rint(25, 50));
    } else {
      store.decideApproval(r.id, "rejected", "u-admin", "本季度名额已满，请下季度再申请。");
    }
  });
  // 成绩申诉：主角待改进对未通过的卷子提出申诉（待处理 —— 演示审批与铃铛）
  const improverProgram = programs.find((x) => x.id === improverAttempt.programId);
  // 申诉必须指向卷面上真正判错的那道题。写死「第 3 题」时，随机卷的第 3 题判的是
  // 「对」—— 销售点一下「查看卷面」，申诉本身就自相矛盾，客户当场知道是假数据。
  const appealQ = (improverAttempt.wrongs || [])[0];
  if (!appealQ) throw new Error("主角待改进的卷面没有判错的题，申诉无从指向");
  const appealCourse = courseById.get((store.listQuestions().find((q) => q.id === appealQ.qid) || {}).courseId);
  const appealCourseName = (appealCourse && (appealCourse.title_zh || appealCourse.title)) || improverProgram.title_zh || improverProgram.title;
  store.addAppeal({
    attemptId: improverAttempt.id, userId: PROTA.improver.id,
    reason: `第 ${appealQ.no} 题「${appealQ.question}」我选的答案与《${appealCourseName}》课程里的说明一致，判分与解析相互矛盾，请复核这道题的得分。`,
  });
  store.createNotification({
    id: "n-demo-appeal-adm", userId: "u-admin", type: "appeal",
    title: "New grade appeal", title_zh: "新的成绩申诉",
    body: `${PROTA.improver.name} appealed their result for ${improverProgram.title}.`,
    body_zh: `${PROTA.improver.name} 对「${improverProgram.title_zh || improverProgram.title}」的成绩提出了申诉。`,
    link: "/admin/results",
  });

  // ======================================================================
  // 5) 绩效：上季度周期已关账（九宫格数据源）+ 本季度周期进行中（校准视角）
  // ======================================================================
  console.log("⑤ 造绩效周期（已关账 + 进行中）…");
  const RATING_W = [["A+", 6], ["A", 18], ["B+", 34], ["B", 26], ["C", 11], ["D", 5]];
  const ratingPool = RATING_W.flatMap(([r, w]) => Array(w).fill(r));
  const POTENTIAL_W = [["High", 22], ["Medium", 53], ["Low", 25]];
  const potentialPool = POTENTIAL_W.flatMap(([r, w]) => Array(w).fill(r));
  const ratingOf = new Map(); // userId -> 已关账周期评级
  for (const p of people) ratingOf.set(p.id, p.isHead || p.isGM ? pick(["A+", "A", "A", "B+"]) : pick(ratingPool));
  ratingOf.set(PROTA.star.id, "A+");
  ratingOf.set(PROTA.improver.id, "D");
  for (const p of people) {
    if (p.hireDaysAgo <= 30) continue; // 新人还没有潜力评估
    const pot = p === PROTA.star ? "High" : p === PROTA.improver ? "Low" : pick(potentialPool);
    store.updateUser(p.id, { potential: pot });
  }
  store.updateUser(PROTA.star.id, { talentTags: ["高潜", "关键人才"] });
  for (const p of shuffled(staff.filter((x) => ratingOf.get(x.id) === "A+" || ratingOf.get(x.id) === "A")).slice(0, 6))
    store.updateUser(p.id, { talentTags: chance(0.5) ? ["高潜"] : ["关键人才"] });

  const qtr = (d) => `${d.getFullYear()}-Q${Math.floor(d.getMonth() / 3) + 1}`;
  const openQDate = new Date(now);
  // 旧流程周期只作历史与管理层评估（2026-10-12）：员工季度评估改由 demo-enrich.js 经接口跑 v2 流程（Q2、Q3 已关闭，Q4 进行中）
  const closedQDate = new Date(now - 270 * DAY);
  const closedName = `${qtr(closedQDate)} 绩效评估（旧流程）`;
  const openName = `${qtr(openQDate)} 管理层评估（旧流程）`;

  const OUTCOMES = ["季度关键指标达成 105%，核心项目按期交付。", "完成两个跨部门专项，风险问题闭环处理。", "主要目标基本达成，其中一项因外部依赖顺延。", "支撑了三个新流程上线，缺陷率低于目标。"];
  const CHALLENGES = ["跨部门排期冲突较多，沟通成本高。", "人手紧张，部分事项只能降级处理。", "新系统切换期间数据口径需要反复核对。"];
  const FEEDBACK = ["希望获得更多跨部门项目机会。", "希望在职业发展路径上得到更明确的指引。", "资源支持基本到位，希望保持双周同步节奏。"];
  const GOALS = ["提升跨部门协作效率，关键接口沉淀成文档", "完成一次完整的业务复盘并输出改进清单", "把日常事务自动化，释放 20% 时间投入重点项目", "带教 1 名新人独立上手核心流程", "客户满意度提升 3 个百分点"];
  const MGR_TEXT = { "A+": "全面超出预期，能主动补位并带动他人，是团队的标杆。", A: "目标完成扎实，质量稳定，协作意识强。", "B+": "达成符合预期，个别环节的主动性还可以再进一步。", B: "基本达成目标，细节质量与节奏管理有提升空间。", C: "部分目标未达成，需要制定明确的改进计划并跟进。", D: "结果明显低于预期，已沟通改进计划，下季度重点跟进。" };
  const pickGoals = () => shuffled(GOALS).slice(0, rint(2, 3));

  // —— 已关账周期：近 30 天入职的新人不参加
  const closedCycle = store.createReviewCycle(closedName, localDate(-255));
  const closedTargets = people.filter((p) => p.hireDaysAgo > 300);
  store.addReviewItemsBulk(closedCycle.id, closedTargets.map((p) => ({ id: p.id, managerId: p.managerId })));
  const closeDate = localDate(-245);
  let calibrated = 0;
  for (const item of store.listCycleItems(closedCycle.id)) {
    const r = ratingOf.get(item.userId);
    const selfDay = rint(260, 270), mgrDay = rint(248, 258);
    const fields = {
      selfOutcomes: JSON.stringify(shuffled(OUTCOMES).slice(0, 2)),
      selfChallenges: pick(CHALLENGES), selfFeedback: pick(FEEDBACK), goalsNext: JSON.stringify(pickGoals()),
      selfAt: iso(selfDay * DAY),
      oneOnOneAt: iso((mgrDay + 1) * DAY), oneOnOneNotes: "已完成 1对1 绩效沟通，对齐了下季度目标与支持需求。",
    };
    if (item.managerId) {
      fields.managerRating = r; fields.managerText = MGR_TEXT[r]; fields.managerAt = iso(mgrDay * DAY);
      if (calibrated < 5 && chance(0.08)) { fields.finalRating = r === "B" ? "B+" : r === "B+" ? "B" : r; calibrated++; }
    } else {
      fields.finalRating = r; // 总经理由 HR 在校准中直接定级
    }
    store.updateReviewItem(item.id, fields);
    const rec = store.createTalentRecord({
      id: "tr-demo-" + item.id, userId: item.userId, type: "performance", date: closeDate,
      title: closedName, detail: { period: closedName, rating: fields.finalRating || fields.managerRating, summary: MGR_TEXT[fields.finalRating || fields.managerRating] || "" },
      programId: null, createdBy: "u-admin",
    });
    store.updateReviewItem(item.id, { recordId: rec.id });
  }
  store.closeReviewCycle(closedCycle.id);

  // —— 进行中周期：自评过半、上级评一部分
  const openCycle = store.createReviewCycle(openName, localDate(14));
  const openTargets = heads;   // 管理层（9 位总监，上级 = 总经理）；测试账号 UL-TEST 的自评留空，演示时自己填
  store.addReviewItemsBulk(openCycle.id, openTargets.map((p) => ({ id: p.id, managerId: p.managerId })));
  let selfDone = 0, mgrDone = 0;
  for (const item of store.listCycleItems(openCycle.id)) {
    if (item.userId === PROTA.improver.id) continue; // 主角待改进还没交自评（演示催办）
    if (item.userId === heads[6].id) continue;        // 测试账号 UL-TEST 的自评留给演示时填写
    const doSelf = item.userId === PROTA.star.id || chance(0.58);
    if (!doSelf) continue;
    selfDone++;
    const fields = {
      selfOutcomes: JSON.stringify(shuffled(OUTCOMES).slice(0, 2)),
      selfChallenges: pick(CHALLENGES), selfFeedback: pick(FEEDBACK), goalsNext: JSON.stringify(pickGoals()),
      selfAt: iso(rint(1, 9) * DAY),
    };
    const doMgr = item.managerId && (item.userId === PROTA.star.id || chance(0.45));
    if (doMgr) {
      mgrDone++;
      const base = ratingOf.get(item.userId) || "B";
      const r = item.userId === PROTA.star.id ? "A+" : chance(0.8) ? base : pick(["A", "B+", "B"]);
      fields.oneOnOneAt = iso(rint(0, 3) * DAY);
      fields.oneOnOneNotes = "已完成本季度 1对1 沟通。";
      fields.managerRating = r; fields.managerText = MGR_TEXT[r]; fields.managerAt = iso(rint(0, 2) * DAY);
    }
    store.updateReviewItem(item.id, fields);
  }
  console.log(`   + 已关账「${closedName}」${closedTargets.length} 人（校准改评 ${calibrated} 人）/ 进行中「${openName}」${openTargets.length} 人（自评 ${selfDone}、上级评 ${mgrDone}）`);

  // ======================================================================
  // 6) 人才记录（晋升/转正/调动/荣誉/违规）与继任计划
  // ======================================================================
  console.log("⑥ 造人才记录与继任计划…");
  let trSeq = 1;
  const tr = (userId, type, date, title, detail) =>
    store.createTalentRecord({ id: "tr-life-" + trSeq++, userId, type, date, title, detail, programId: null, createdBy: "u-admin" });
  // 晋升（主角绩优 + 2 人；toLevel 与当前职级一致）
  tr(PROTA.star.id, "promotion", localDate(-120), "P5 → P6", { fromLevel: "P5", toLevel: "P6", method: "Defense", result: "Passed", score: 88, comments: "对品牌线有清晰的 ownership，答辩表现突出。", synced: true });
  const promoted2 = staff.find((p) => p.jobLevel === "P5" && p !== PROTA.star);
  if (promoted2) tr(promoted2.id, "promotion", localDate(-200), "P4 → P5", { fromLevel: "P4", toLevel: "P5", method: "Defense", result: "Passed", score: 82, comments: "答辩通过，跨团队影响力待加强。", synced: true });
  const promotedFail = staff.find((p) => p.jobLevel === "P4");
  if (promotedFail) tr(promotedFail.id, "promotion", localDate(-90), "P4 → P5（未通过）", { fromLevel: "P4", toLevel: "P5", method: "Defense", result: "Failed", score: 61, comments: "方案深度不足，建议半年后再答辩。" });
  // 转正（两名 7~8 个月前入职、已转正的员工）
  const regulars = staff.filter((p) => p.hireDaysAgo >= 210 && p.hireDaysAgo <= 260).slice(0, 2);
  for (const p of regulars) tr(p.id, "regularization", localDate(-(p.hireDaysAgo - 182)), "转正评估", { result: "On time", review: "试用期目标全部达成，融入团队顺利。", synced: true });
  // 调动（2 人：跨部门调动，记录与现部门一致）
  const mover1 = staff.find((p) => p.dept === "运营部" && p !== PROTA.improver);
  if (mover1) tr(mover1.id, "transfer", localDate(-150), "客服部 → 运营部", { fromDept: "客服部", toDept: "运营部", fromPosition: "客服专员", toPosition: mover1.position, reason: "业务需要 + 个人发展意愿。", synced: true });
  const mover2 = staff.find((p) => p.dept === "产品部");
  if (mover2) tr(mover2.id, "transfer", localDate(-280), "技术部 → 产品部", { fromDept: "技术部", toDept: "产品部", fromPosition: "前端工程师", toPosition: mover2.position, reason: "转岗产品序列。", synced: true });
  // 荣誉与违规
  const STAR_AWARD_DAYS = 100; // 收尾要把荣誉通知的时间对到同一天，见 ⑧
  tr(PROTA.star.id, "award", localDate(-STAR_AWARD_DAYS), "季度优秀员工", { awardName: "Top learner", programName: "信息安全基础", issuer: "HR & Training Committee" });
  tr(PROTA.improver.id, "violation", localDate(-60), "季度合规确认迟交", { severity: "Minor", description: "季度合规确认迟交 5 天。", action: "口头提醒，纳入季度改进计划。" });

  // 继任计划：3 个关键岗位都有候选人
  const csLead = staff.find((p) => p.dept === "客服部" && p.position === "客服组长");
  const techSenior = staff.filter((p) => p.dept === "技术部" && ["P6", "P5", "P7", "M1"].includes(p.jobLevel));
  store.addSuccession({ positionName: "市场总监", userId: PROTA.star.id, readiness: "ready", note: "连续两个周期 A/A+，已牵头跨部门项目，可随时接任。" });
  if (csLead) store.addSuccession({ positionName: "客服总监", userId: csLead.id, readiness: "oneYear", note: "一线管理经验扎实，需补齐预算与排班管理。" });
  const csBackup = staff.find((p) => p.dept === "客服部" && p.position === "质检专员");
  if (csBackup) store.addSuccession({ positionName: "客服总监", userId: csBackup.id, readiness: "twoYears", note: "质量体系专家，管理幅度需逐步扩大。" });
  if (techSenior[0]) store.addSuccession({ positionName: "技术总监", userId: techSenior[0].id, readiness: "oneYear", note: "架构能力强，正在补管理与协作短板。" });
  if (techSenior[1]) store.addSuccession({ positionName: "技术总监", userId: techSenior[1].id, readiness: "twoYears", note: "潜力候选，建议先轮岗带 5 人小组。" });

  // ======================================================================
  // 7) 员工侧铃铛：培训指派 / 逾期提醒 / 自评催办
  // ======================================================================
  console.log("⑦ 造员工侧通知…");
  const nhoProg = programs.find((x) => x.id === "nho");
  store.createNotification({
    id: "n-demo-newbie-1", userId: PROTA.newbie.id, type: "assigned",
    title: `New course assigned: "${nhoProg.title}"`, title_zh: `你被指派了新课程《${nhoProg.title_zh || nhoProg.title}》`,
    body: "Find it under My Learning.", body_zh: "可在「我的学习」中查看。", link: "#/program/nho",
  });
  const improverMgr = store.getUserById(PROTA.improver.managerId);
  store.createNotification({
    id: "n-demo-imp-1", userId: PROTA.improver.id, type: "review",
    title: "Reminder: your self-review is due", title_zh: "提醒：请提交本期自评",
    body: `${improverMgr.name} is waiting on your self-review for ${openName}.`,
    body_zh: `${improverMgr.name} 在等你提交「${openName}」的自评。`, link: "/review",
  });
  // 主角绩优：销售最常登录的「好故事」账号，铃铛空着会显得系统没在运转。
  store.createNotification({
    id: "n-demo-star-1", userId: PROTA.star.id, type: "record",
    title: "Award added to your profile: Employee of the Quarter",
    title_zh: "你的档案新增荣誉记录：季度优秀员工",
    body: "Recognised as Top learner for Information Security Basics.",
    body_zh: "因《信息安全基础》学习表现优异获评 Top learner。",
    // 成长记录页的路由是 /record（server.js 的 record 类通知也用它）。写 /growth
    // 会被 App.jsx 的 path="*" 兜到 404 —— 而这正是销售最常点开的那个账号。
    link: "/record",
  });
  store.createNotification({
    id: "n-demo-star-2", userId: PROTA.star.id, type: "review",
    title: `Your manager completed the review for ${openName}`,
    title_zh: `上级已完成「${openName}」的评价`,
    body: "Open your review to see the rating and comments.",
    body_zh: "打开绩效页面查看评级与评语。", link: "/review",
  });
  for (const p of new Set(overdue)) {
    store.createNotification({
      id: "n-demo-ovd-" + p.employeeId, userId: p.id, type: "training",
      title: `Training overdue: ${nhoProg.title}`, title_zh: `培训已逾期：${nhoProg.title_zh || nhoProg.title}`,
      body: `Due ${store.getUserAssignments(p.id).nho.dueAt}. Please finish it as soon as you can.`,
      body_zh: `截止日期 ${store.getUserAssignments(p.id).nho.dueAt}，请尽快完成。`, link: "#/program/nho",
    });
  }

  // ======================================================================
  // 8) 收尾：回填历史时间戳（周期创建/关账时间、员工创建时间、已决审批时间）
  // ======================================================================
  const adminUnread = store.countUnreadNotifications("u-admin");
  if (adminUnread < 4) throw new Error(`管理员未读通知只有 ${adminUnread} 条（预期 ≥4）`);
  // 训练总览部门表的「完成」列：只统计已指派项目全部通过的人，少于 10 人就说明
  // 上面的全科通过环节被改坏了（十行全 0 的死数据）。
  const fullyDone = people.filter((p) => {
    const done = passedOf.get(p.id) || new Set();
    const asg = assigned.get(p.id) || new Set();
    return asg.size > 0 && [...asg].every((pid) => done.has(pid));
  });
  if (fullyDone.length < 10) throw new Error(`全科通过只有 ${fullyDone.length} 人（预期 ≥10，否则部门完成数全 0）`);
  const doneDepts = new Set(fullyDone.map((p) => p.dept));
  if (doneDepts.size < 5) throw new Error(`全科通过只覆盖 ${doneDepts.size} 个部门（预期 ≥5）`);
  if (store.countOpenAppeals() !== 1) throw new Error("待处理申诉不是 1 条");
  if (store.countPendingRequests() !== 3) throw new Error("待审学习申请不是 3 条");
  store.close();

  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(OUT);
  db.prepare("UPDATE review_cycles SET createdAt = ?, closedAt = ? WHERE id = ?")
    .run(iso(280 * DAY), iso(245 * DAY), closedCycle.id);
  db.prepare("UPDATE review_cycles SET createdAt = ? WHERE id = ?").run(iso(12 * DAY), openCycle.id);
  db.prepare("UPDATE users SET createdAt = hireDate || 'T01:00:00.000Z' WHERE employeeId LIKE 'UL-%' AND hireDate IS NOT NULL").run();
  // 六条选修申请错开提交时间：原来三条待审共用同一毫秒，「学习申请」列表里三行
  // 时间一模一样，客户扫一眼就知道是脚本刷进去的。
  const upReq = db.prepare("UPDATE approvals SET requestedAt = ? WHERE id = ?");
  const upDec = db.prepare("UPDATE approvals SET decidedAt = ? WHERE id = ? AND decidedAt IS NOT NULL");
  for (const [id, age] of Object.entries(reqAges)) {
    upReq.run(iso(age * DAY + rint(2, 8) * 3600000), id);
    upDec.run(iso((age - 3) * DAY), id); // 待审的 decidedAt 是 NULL，被 WHERE 挡住
  }
  // 铃铛的时间要对得上它指向的事实，否则点开就矛盾：
  //   · 三条选修申请通知跟着申请单的提交时间走（原来通知「刚刚」、申请单 6 天前）
  //   · 新人的「已指派入职培训」落在入职当天（她的进度时间戳是几天前的）
  //   · 荣誉通知落在荣誉记录当天并标成已读（100 天前的荣誉不该「刚刚」提醒；
  //     绩优的未读留给本期「上级已完成评价」那一条）
  const upNotif = db.prepare("UPDATE notifications SET createdAt = ? WHERE id = ?");
  for (const i of [1, 2, 3]) upNotif.run(iso(reqAges["er-demo-" + i] * DAY), "n-demo-er" + i + "-adm");
  upNotif.run(iso((PROTA.newbie.hireDaysAgo - 0.7) * DAY), "n-demo-newbie-1");
  db.prepare("UPDATE notifications SET createdAt = ?, readAt = ? WHERE id = 'n-demo-star-1'")
    .run(iso(STAR_AWARD_DAYS * DAY), iso((STAR_AWARD_DAYS - 1) * DAY));

  // 行数统计（自测报告贴这一段）
  const tables = ["users", "departments", "content", "questions", "exams", "assignments", "progress", "attempts", "attempt_appeals", "approvals", "notifications", "review_cycles", "review_items", "talent_records", "succession", "secondary_lines", "module_migrations", "p33_programs"];
  // 第二批 2.8 绩效申诉与 HRBP 分工（迁移 70；演示库不造申诉数据，行数为 0 属正常）
  tables.push("review_appeals", "review_appeal_consults", "review_appeal_events", "hrbp_assignments");
  const hasTable = db.prepare("SELECT 1 x FROM sqlite_master WHERE type = 'table' AND name = ?");
  console.log("\n各表行数：");
  for (const t of tables) console.log(`   ${t.padEnd(16)} ${hasTable.get(t) ? db.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n : "—（无此表）"}`);
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  db.close();

  // ⑧ 经真实接口补齐新功能数据（v2 绩效、申诉、组织绩效、发展项目、关键岗位；测试账号 UL-TEST 的权限）：scripts/demo-enrich.js
  const en = require("child_process").spawnSync(process.execPath, [path.join(__dirname, "demo-enrich.js"), OUT], { stdio: "inherit", env: process.env });
  if (en.status !== 0) throw new Error("demo-enrich.js 失败（退出码 " + en.status + "）");

  console.log(`\n完成 → ${OUT}`);
  console.log("演示登录：全功能测试账号 UL-TEST / Demo1234（前台全部功能 + 后台超级管理员）；管理员 ADMIN / unfolding888；全部员工 Demo1234");
  console.log(`主角：${PROTA.newbie.employeeId} ${PROTA.newbie.name}（新人） · ${PROTA.star.employeeId} ${PROTA.star.name}（绩优） · ${PROTA.improver.employeeId} ${PROTA.improver.name}（待改进）`);
  console.log("启动：双击 start-demo.bat（端口 8790）");
}
