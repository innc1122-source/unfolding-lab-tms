// Daily reminder job: notify people whose assignments are due soon (<=3 days)
// or overdue and not yet done (programDone — same rule as the rest of the system; exited employees, pure service accounts and unpublished courses are skipped).
// Also skipped (2026-10-07): courses that cannot be completed (online, no modules and no exam), results
// still awaiting scoring or HR review, assignments a learner only has from a training project they withdrew
// from (退训后不再提醒), and the whole run when the learning module is switched off.
// Deduped so a daily cron won't stack
// duplicates. Run by cron on the server (see deploy). Delivers through the
// shared notify() (notify.js) — the same path the live server uses — so each
// reminder is in-app PLUS email once config.json has an "email" block; with no
// email config it is in-app only. (It used to call store.createNotification()
// directly, which skipped the email hook no matter what was configured.)
//
// 【护栏豁免】其它随包交付的写库脚本（convert-office-attachments / reset-for-uat）
// 在服务运行中会拒跑（各自内联的 refuseIfServerLive 检测 <db>.server.lock + pid 存活）。
// 本脚本**故意不设**这道护栏：它本来就设计为与服务并行运行（cron 每日触发，服务不停），
// 只往 notifications 一张表 INSERT —— 通知不进服务的常驻内存缓存（PROGRAMS/COURSES/
// TPROJECTS 才进），服务每次都是现查库，所以不存在「库变了服务看不见」的问题；
// WAL 模式下并发单表插入也是安全的。若未来让它写别的表，先把护栏加回来。
//   Usage:  node scripts/notify-due.js
const path = require("path");
const crypto = require("crypto");
const store = require(path.join(__dirname, "..", "store.js"));
const { notify, readConfig } = require(path.join(__dirname, "..", "notify.js"));
// 完成口径与提醒资格与服务端共用（modules/learning/completion.js）：有考试 = 通过且线下课程已出席 / 迟到；
// 无考试 = 学完（线下课程 = 出席 / 迟到）。原先这里只认考试通过，没有考试的课学完了也天天收「已逾期」。
const { createCompletion, isRemindableUser, isPublishedProgram, programsOfCourseFrom } = require(path.join(__dirname, "..", "modules", "learning", "completion.js"));
// store.init 只在**播种一个空库**时才会用到 hashPassword，所以这个脚本平时碰不到它。
// 但格式必须与 server.js 的一致（salt:scrypt）：早先这里写的是 sha256，一旦有人拿这个
// 脚本初始化空库，就会造出一批密码 hash 格式不对、永远登不进去的账号。
const hashPassword = (pw) => {
  const salt = crypto.randomBytes(16).toString("hex");
  return salt + ":" + crypto.scryptSync(pw, salt, 32).toString("hex");
};
// 培训模块关闭时不发培训提醒（2026-10-07）：员工打开提醒里的链接只会得到 404。与 server.js 的 modulesOn() 同口径：
// config.json 的 modules.learning 显式写 false，或环境变量 LMS_MODULES_OFF 含 learning。
const learningOff = (() => {
  const cfg = readConfig().modules || {};
  const off = String(process.env.LMS_MODULES_OFF || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  return cfg.learning === false || off.includes("learning");
})();
if (learningOff) {
  console.log("learning module is off — no training reminders sent");
  process.exit(0);
}
store.init({ hashPassword });
const courses = new Map(store.listContent("course").map((c) => [c.id, c]));
const programList = store.listContent("program");
// 退训后不再提醒（2026-10-07）：培养项目文档与「课程 → 程序」反查只读这一次，交给 completion.js 的 withdrawnOnly
const projects = store.listContent("tproject");
const { programDone, reminderEligible } = createCompletion({
  store, getCourse: (id) => courses.get(id) || null, memoExams: true,
  listProjects: () => projects, programsOfCourse: programsOfCourseFrom(programList),
});

const DAY = 86400000;
const now = Date.now();
const daysUntil = (d) => (d ? Math.ceil((new Date(d + "T00:00:00").getTime() - now) / DAY) : null);
const sinceIso = new Date(now - 20 * 3600 * 1000).toISOString(); // "already reminded today?" window

const programs = {};
for (const p of programList) programs[p.id] = p;

let dueSoon = 0, overdue = 0;
for (const u of store.listUsers()) {
  if (!isRemindableUser(u)) continue; // 纯服务账号、停用、已离职不提醒（也是员工的管理员照常提醒）
  const asg = store.getUserAssignments(u.id);
  for (const pid of Object.keys(asg)) {
    const p = programs[pid];
    if (!isPublishedProgram(p)) continue;
    const dueAt = asg[pid].dueAt;
    if (!dueAt) continue;
    // 先按截止日筛（3 天以后才截止的本来就不提醒），再做较贵的完成与资格判定
    const d = daysUntil(dueAt);
    if (d == null || d > 3) continue;
    if (programDone(u.id, p)) continue; // 已完成（与系统同一口径：有考试 = 通过且线下课程已出席；无考试 = 学完）
    if (!reminderEligible(u, p, asg[pid])) continue; // 课程无法完成（0 个模块又没有考试）、成绩待定（等 HR 复核）、仅因已退训项目而有的指派不催

    let type, title, title_zh, body, body_zh;
    if (d < 0) {
      type = "overdue";
      title = `Overdue: "${p.title}"`; title_zh = `已逾期：《${p.title_zh || p.title}》`;
      body = `Was due ${dueAt}. Please finish as soon as possible.`; body_zh = `截止 ${dueAt}，请尽快完成。`;
    } else if (d <= 3) {
      type = "due_soon";
      title = `Due soon: "${p.title}"`; title_zh = `即将截止：《${p.title_zh || p.title}》`;
      body = `Due in ${d} day(s) (${dueAt}).`; body_zh = `还有 ${d} 天截止（${dueAt}）。`;
    } else continue;

    const link = `#/program/${pid}`;
    if (store.hasNotificationSince(u.id, type, link, sinceIso)) continue; // don't repeat within the day
    notify(u.id, { type, title, title_zh, body, body_zh, link });
    if (type === "overdue") overdue++; else dueSoon++;
  }
}
console.log(`reminders created — due soon: ${dueSoon}, overdue: ${overdue}`);
