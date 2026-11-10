// 团队评估（第二批 2.1，2026-10-08，W2-B）：/review?view=team 的下属名单与单人评估页。员工端页面，不 import Semi。
//
//   名单（TeamRoster）：数据来自 GET /api/me/reviews 的 teamRows / teamStats（W1-A，K1 起旧的 team[] 不再使用）。
//     · 指标卡（.tm-stats）：自评已交、面谈完成（双方都登记才算，D2；另列「仅上级 / 仅员工」）、已评级（含 HoD 代评）；
//       分母都去掉不计入的人（离职、HoD 本人）。评级分布只统计上级本人给出的评级。
//     · 状态筛选（.ml-filters / .ml-chip）：人数读 teamStats.byStatus，过滤用服务端算好的 row.tags；多个进行中周期时可切周期。
//     · 地址栏（设计 0.2）：cycle、status、q；点某人进单人页 = item（push，安卓返回键回到名单）。
//   单人页（TeamPerson）?view=team&item=<id>：GET /api/me/reviews/team/:id。
//     ① 自评只读 ② 1 对 1 面谈（上级一侧，POST /:id/one-on-one，带日期与要点；可补登记，与评级互不为前提）
//     ③ 评级、关键亮点、评语（POST /:id/manager，补丁语义）。锁定、HoD 已代评时只读；已离职的人可以评级但不计入（D4）。
//     员工未交自评且自评未逾期：评级区只给提示和「发送提醒」；自评已逾期：放开评级（D1）。
//     上一位 / 下一位按打开时的筛选结果排（保存后名单刷新，顺序不跳）；表单 key = 条目 id，换人时加载完成前不渲染上一位的
//     表单（审查 P1-7）。有未保存修改时启用离开守卫，返回、切人、切页签前先确认（审查 P1-6，confirmLeave）。
//   旧流程周期（flow 为空）沿用勾选面谈的评级表单（服务端仍要求先确认面谈）。
// 面包屑在本文件渲染（Review.jsx 那一行 ModuleTrail 保持原样，审查 P1-12）。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, useAsync } from '../api.js';
import { errText } from '../apierr.js';
import ModuleTrail from '../components/ModuleTrail.jsx';
import { useLeaveGuard, confirmLeave } from '../components/useLeaveGuard.js';
import { mergeParams } from '../urlstate.js';
import TeamDashboard from './ReviewTeamDashboard.jsx';   // 绩效看板第一期：经理「我的团队」（2026-10-10）

const T = {
  zh: {
    teamLead: '逐人完成评级。1 对 1 面谈可在评级前或评级后登记，不是评级的前提。',
    cycleLab: '评估周期',
    stSelf: '自评已交', stOne: '面谈完成', stRated: '已评级', distTitle: '评级分布（我给出的评级）',
    stOneHint: '双方都登记才算完成', oneSplit: (m, e) => `仅上级登记 ${m} · 仅员工登记 ${e}`, proxiedN: (n) => `含 HoD 代评 ${n} 人`,
    excludedN: (n) => `另有 ${n} 人不计入（已离职或为 HoD 本人）`, distEmpty: '你还没有给出评级。',
    statusLab: '按状态筛选',
    s_all: '全部', s_self: '待自评', s_one: '待面谈', s_rate: '待评级', s_rated: '已评级', s_locked: '已锁定', s_left: '已离职（不计入）',
    search: '搜索姓名或工号', noTeam: '这个周期没有需要你评估的下属。', noMatch: '没有符合筛选条件的人。',
    cName: '姓名', cSelf: '自评', cOne: '面谈', cRate: '评级',
    selfDone: (d) => `已交 · ${d}`, selfPending: '待自评', selfOverdue: '自评逾期',
    one_both: '双方已登记', one_mgr: '仅上级登记', one_emp: '仅员工登记', one_none: '未登记',
    rated: (r) => `已评 ${r}`, toRate: '待评级', rateOverdue: '评级逾期', waitSelf: '待员工自评',
    hodProxied: 'HoD 已代评', lockedTag: '已随部门提交', leftTag: '已离职 · 不计入', hodSelfTag: 'HoD 本人 · 不计入', overdue: '已逾期',
    openPerson: (n) => `打开 ${n} 的评估`,
    trailRoot: '绩效评估', trailTeam: '团队评估',
    back: '返回名单', prev: '上一位', next: '下一位', pos: (i, n) => `第 ${i} / ${n} 位`,
    notFound: '未找到该评估，或你已不是此人在本周期的直属上级。', loadErr: '加载失败，请刷新页面重试。', loading: '加载中…',
    s1: '① 自评', s2: '② 1 对 1 面谈', s3: '③ 评级与评语',
    selfOutcome: (n) => `目标 ${n} 关键成果`, selfOutcomeNoPrev: '本周期成果', selfChallenges: '遇到的挑战', selfFeedback: '对团队/公司的建议', selfGoals: '下一周期目标',
    noSelf: '员工尚未提交自评。', selfAt: (d) => `自评提交于 ${d}`,
    dueSelf: (d) => `自评截止 ${d}`, dueRate: (d) => `评级截止 ${d}`, profile: '查看档案',
    oneMgrDone: (d) => `你已登记 · ${d}`, oneMgrNot: '你尚未登记', oneEmpDone: (d) => `员工已登记 · ${d}`, oneEmpNot: '员工尚未登记',
    oneDate: '面谈日期', oneDateRange: (d) => `可选 ${d}（周期发起日）至今天`, oneLog: '登记 1 对 1 面谈', oneUndo: '撤销登记', oneLogged: '已登记 ✓', oneUndone: '已撤销登记',
    notesLab: '面谈要点（选填）', notesPh: '面谈要点：讨论了哪些成果、差距与下一步…', notesVis: '仅你与 HR 可见，不记入员工档案。', notesSave: '保存要点', notesSaved: '要点已保存 ✓',
    oneLegacy: '本周期的 1 对 1 面谈随评级一起确认，见下方评级表单。',
    oneLockedNote: '此人所在部门已提交校准：仍可补登记面谈，但不能撤销。',
    ratingLab: '上级评级', highlights: '关键亮点', highlightsReq: 'A+ / A 与 C / D 须填写关键亮点',
    highlightsPh: '具体事例：做成了什么、影响多大；或差距在哪里、需要什么支持…',
    mgrComment: '上级评语', mgrPh: '评语：整体表现、主要贡献、待发展领域…',
    mgrSave: '提交评级', mgrResave: '更新评级', saved: '已保存 ✓',
    selfMissing: '员工尚未提交自评', selfMissingLead: '自评截止前，请先请员工提交自评，再完成评级。',
    nudge: '发送提醒', nudged: '已发送提醒 ✓', selfOverdueRate: '自评已逾期，可直接评级',
    leftNote: '此人已离职，不计入配额；评级可选。', lockedRO: '此人已随部门提交校准，评级不能再修改。',
    oneLegacyCheck: '我已与该员工完成 1 对 1 绩效面谈', legacyNotesPh: '面谈要点（选填）…',
    visAll: '周期关闭后，最终评级与上级评语对员工本人可见。',
    visNoComment: '周期关闭后，员工本人只看到最终评级，上级评语不对员工显示。',
    visTbd: '周期关闭后，员工本人可以看到最终评级；上级评语是否对员工显示，按公司设置。',
    visHidden: '周期关闭后，最终评级与上级评语记入员工档案。',
    closeHint: 'HoD 校准、HR 确认后，周期关闭时公布最终评级。',
    closeHintLegacy: '此为上级评级。HR 校准后确定最终评级；周期关闭时，最终评级记入员工档案。',
    unsaved: '有未保存的修改，确定离开？',
    err: '提交失败：',
    eRating: '请选择上级评级', eHighlights: 'A+ / A 与 C / D 须填写关键亮点', eLocked: '此人所在部门已提交校准，不能再修改。',
    eNotFound: '未找到该评估记录', eCycleClosed: '该评估周期已关闭', eCooldown: '一小时内已发送过提醒，请稍后再试',
    eAlreadySubmitted: '该员工已提交自评，无需提醒', eOneOnOne: '请先完成 1 对 1 绩效面谈并勾选确认',
    eFlow: '本周期的 1 对 1 面谈随评级一起确认。',
    e_hod_proxied: 'HoD 已代你为此人评级；如需由你评级，请 HoD 先清除代评。',
    e_recipient_inactive: '此人已离职，不再发送提醒。', e_manager_inactive: '你的账号已不在职，不能操作。',
    e_date_invalid: '日期不能晚于今天，也不能早于周期发起日。',
  },
  en: {
    teamLead: 'Rate each team member. Log the 1-on-1 before or after the rating; it isn’t required for rating.',
    cycleLab: 'Review cycle',
    stSelf: 'Self-reviews in', stOne: '1-on-1s done', stRated: 'Rated', distTitle: 'Rating distribution (your ratings)',
    stOneHint: 'Done when both sides have logged it', oneSplit: (m, e) => `Manager only ${m} · Employee only ${e}`, proxiedN: (n) => `incl. ${n} rated by the HoD`,
    excludedN: (n) => `${n} more not counted (left, or the HoD)`, distEmpty: 'You haven’t given any ratings yet.',
    statusLab: 'Filter by status',
    s_all: 'All', s_self: 'Awaiting self-review', s_one: '1-on-1 pending', s_rate: 'To rate', s_rated: 'Rated', s_locked: 'Locked', s_left: 'Left (not counted)',
    search: 'Search name or employee ID', noTeam: 'No team members to review in this cycle.', noMatch: 'Nobody matches these filters.',
    cName: 'Name', cSelf: 'Self-review', cOne: '1-on-1', cRate: 'Rating',
    selfDone: (d) => `Submitted · ${d}`, selfPending: 'Not submitted', selfOverdue: 'Self-review overdue',
    one_both: 'Logged by both', one_mgr: 'Manager only', one_emp: 'Employee only', one_none: 'Not logged',
    rated: (r) => `Rated ${r}`, toRate: 'To rate', rateOverdue: 'Rating overdue', waitSelf: 'Awaiting self-review',
    hodProxied: 'Rated by HoD', lockedTag: 'Locked with department', leftTag: 'Left · not counted', hodSelfTag: 'HoD · not counted', overdue: 'Overdue',
    openPerson: (n) => `Open the review of ${n}`,
    trailRoot: 'Performance Reviews', trailTeam: 'Team reviews',
    back: 'Back to list', prev: 'Previous', next: 'Next', pos: (i, n) => `${i} of ${n}`,
    notFound: 'Review not found, or you are no longer this person’s manager for this cycle.', loadErr: 'Couldn’t load. Refresh the page to try again.', loading: 'Loading…',
    s1: '1 · Self-review', s2: '2 · 1-on-1', s3: '3 · Rating and comments',
    selfOutcome: (n) => `Goal ${n} key outcomes`, selfOutcomeNoPrev: 'Outcomes this cycle', selfChallenges: 'Challenges encountered', selfFeedback: 'Suggestions for the team/company', selfGoals: 'Goals for the next cycle',
    noSelf: 'The self-review hasn’t been submitted yet.', selfAt: (d) => `Self-review submitted ${d}`,
    dueSelf: (d) => `Self-review due ${d}`, dueRate: (d) => `Rating due ${d}`, profile: 'View profile',
    oneMgrDone: (d) => `You logged it · ${d}`, oneMgrNot: 'You haven’t logged it', oneEmpDone: (d) => `Employee logged it · ${d}`, oneEmpNot: 'Employee hasn’t logged it',
    oneDate: 'Meeting date', oneDateRange: (d) => `Pick a date from ${d} (cycle start) to today`, oneLog: 'Log 1-on-1', oneUndo: 'Undo', oneLogged: 'Logged ✓', oneUndone: 'Log removed',
    notesLab: 'Conversation notes (optional)', notesPh: 'Notes: results discussed, gaps and next steps…', notesVis: 'Visible only to you and HR; not saved to the employee profile.', notesSave: 'Save notes', notesSaved: 'Notes saved ✓',
    oneLegacy: 'In this cycle the 1-on-1 is confirmed together with the rating, in the form below.',
    oneLockedNote: 'This person’s department has been submitted: you can still log the 1-on-1, but not undo it.',
    ratingLab: 'Manager rating', highlights: 'Key highlights', highlightsReq: 'Required for A+, A, C and D',
    highlightsPh: 'Concrete examples: what was achieved and its impact, or where the gap is and what support is needed…',
    mgrComment: 'Manager comments', mgrPh: 'Comments: overall performance, key contributions, areas for development…',
    mgrSave: 'Submit rating', mgrResave: 'Update rating', saved: 'Saved ✓',
    selfMissing: 'Self-review not submitted yet', selfMissingLead: 'Before the self-review deadline, ask the employee to submit it first, then rate.',
    nudge: 'Send reminder', nudged: 'Reminder sent ✓', selfOverdueRate: 'The self-review is overdue; you can rate now',
    leftNote: 'This person has left and isn’t counted in the quota. Rating is optional.', lockedRO: 'This person’s department calibration has been submitted, so the rating can’t be changed.',
    oneLegacyCheck: 'I have held the 1-on-1 performance conversation with this employee', legacyNotesPh: 'Conversation notes (optional)…',
    visAll: 'After the cycle closes, the employee can see the final rating and your comments.',
    visNoComment: 'After the cycle closes, the employee sees only the final rating; your comments aren’t shown to them.',
    visTbd: 'After the cycle closes, the employee can see the final rating. Whether your comments are shown depends on the company setting.',
    visHidden: 'After the cycle closes, the final rating and your comments are saved to the employee profile.',
    closeHint: 'Final ratings are released when the cycle closes, after HoD calibration and HR confirmation.',
    closeHintLegacy: 'This is the manager rating. HR calibration sets the final rating; when the cycle closes, the final rating is saved to the employee profile.',
    unsaved: 'You have unsaved changes. Leave anyway?',
    err: 'Couldn’t save: ',
    eRating: 'Select a manager rating', eHighlights: 'Key highlights are required for A+, A, C and D', eLocked: 'This person’s department has been submitted and can no longer be changed.',
    eNotFound: 'Review record not found', eCycleClosed: 'This review cycle is closed', eCooldown: 'A reminder was already sent in the last hour. Please try again later.',
    eAlreadySubmitted: 'This employee has already submitted their self-review', eOneOnOne: 'Complete the 1-on-1 performance conversation and tick to confirm first',
    eFlow: 'In this cycle the 1-on-1 is confirmed together with the rating.',
    e_hod_proxied: 'Your HoD has rated this person on your behalf. Ask them to clear it first if you need to rate.',
    e_recipient_inactive: 'This person has left; reminders are no longer sent.', e_manager_inactive: 'Your account is no longer active.',
    e_date_invalid: 'The date can’t be in the future or before the cycle started.',
  },
};

// ---- 纯函数（test/review-ui-v2.test.js 截取本段求值：本段不写 JSX、不引用 import 进来的名字）----
export const TEAM_STATUS = ['all', 'self', 'one', 'rate', 'rated', 'locked', 'left'];
// 团队名单在地址栏里的键（切视图时由 Review.jsx 一并清掉）
export const TEAM_PARAM_KEYS = ['cycle', 'status', 'q', 'item'];

// 本地日历日（不能用 slice(0,10)：那是 UTC 日，马尼拉 08:00 前登记的会显示成前一天，审查 P2）
export function dayOf(v) {
  if (v === null || v === undefined || v === '') return '';
  const s = String(v);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return s.slice(0, 10);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// 上级这一侧还要做的事，与服务端 teamStats.todo 同一口径：计入、未锁定，且（可以评级却还没评，或 v2 上级一侧未登记面谈）
export function rowTodo(r) {
  if (!r || r.notCounted || r.locked) return { rate: false, one: false };
  return {
    rate: !r.managerRating && !r.hodProxied && !!(r.selfAt || r.selfOverdue),
    one: r.flow === 'v2' && !r.oneOnOneAt,
  };
}
// 「团队评估」页签上的待处理人数（同一人既待评级又待面谈只算一次）
export function teamPendingCount(rows) {
  return (Array.isArray(rows) ? rows : []).filter((r) => { const t = rowTodo(r); return t.rate || t.one; }).length;
}
// 当前周期：地址栏的 cycle 在 teamStats 里才用；没指定（或已不在）时取第一个有待办（待评级 / 待面谈）的周期，都没有再取第一个
// （默认进「团队评估」是因为有待办，落到一个没有待办的周期就对不上；波次 2 复核修正）
export function pickCycle(stats, want) {
  const list = Array.isArray(stats) ? stats : [];
  const ids = list.map((x) => x.cycleId);
  if (want && ids.includes(want)) return want;
  const todo = list.find((x) => x && x.todo && (Number(x.todo.rate) || 0) + (Number(x.todo.oneOnOne) || 0) > 0);
  return todo ? todo.cycleId : ids[0] || null;
}
export function filterTeamRows(rows, f) {
  const o = f || {};
  const needle = String(o.q || '').trim().toLowerCase();
  return (Array.isArray(rows) ? rows : []).filter((r) => (!o.cycle || r.cycleId === o.cycle)
    && (!o.status || o.status === 'all' || (Array.isArray(r.tags) && r.tags.includes(o.status)))
    && (!needle || String(r.name || '').toLowerCase().includes(needle) || String(r.employeeId || '').toLowerCase().includes(needle)));
}
// 排序：待评级 → 待面谈 → 待自评 → 其余 → 不计入；同档按姓名
function rank(r) {
  if (r.notCounted) return 4;
  const t = rowTodo(r);
  if (t.rate) return 0;
  if (t.one) return 1;
  if (!r.selfAt && !r.locked) return 2;
  return 3;
}
export function sortTeamRows(rows) {
  return [...(Array.isArray(rows) ? rows : [])].sort((a, b) => rank(a) - rank(b) || String(a.name || '').localeCompare(String(b.name || '')));
}
// 名单「评级」一栏：left | hod_self | locked | proxied | rated | overdue | waitSelf | todo
export function rateState(r) {
  if (!r) return 'todo';
  if (r.notCounted === 'departed') return 'left';
  if (r.notCounted === 'hod_self') return 'hod_self';
  if (r.locked) return 'locked';
  if (r.hodProxied) return 'proxied';
  if (r.managerRating) return 'rated';
  if (Array.isArray(r.overdue) && r.overdue.includes('rate')) return 'overdue';
  if (!r.selfAt && !r.selfOverdue) return 'waitSelf';
  return 'todo';
}
// 名单「自评」一栏：done | overdue | pending
export function selfState(r) {
  if (r && r.selfAt) return 'done';
  if (r && (r.selfOverdue || (Array.isArray(r.overdue) && r.overdue.includes('self')))) return 'overdue';
  return 'pending';
}
// 单人页评级区：locked（只读）| proxied（HoD 已代评，只读）| waitSelf（只给提示与提醒，D1）| open
export function rateGate(item) {
  if (!item) return 'locked';
  if (item.locked) return 'locked';
  if (item.hodProxied) return 'proxied';
  if (item.notCounted === 'departed') return 'open';
  if (!item.selfAt && !item.selfOverdue && !item.managerRating) return 'waitSelf';
  return 'open';
}
// 打开单人页时的名单顺序：当前筛选结果；当前这人不在其中（深链接、筛选条件已不包含他）时退回同一周期的全部人
export function personOrder(rows, f, itemId) {
  const filtered = sortTeamRows(filterTeamRows(rows, f)).map((r) => r.id);
  if (!itemId || filtered.includes(itemId)) return filtered;
  const cur = (Array.isArray(rows) ? rows : []).find((r) => r.id === itemId);
  return sortTeamRows(filterTeamRows(rows, { cycle: cur ? cur.cycleId : f && f.cycle })).map((r) => r.id);
}
// 上一位 / 下一位（跳过名单里已经没有的人）
export function neighbours(order, itemId, rows) {
  const alive = new Set((Array.isArray(rows) ? rows : []).map((r) => r.id));
  const ids = (Array.isArray(order) ? order : []).filter((id) => id === itemId || alive.has(id));
  const i = ids.indexOf(itemId);
  return { index: i, total: ids.length, prev: i > 0 ? ids[i - 1] : null, next: i >= 0 && i < ids.length - 1 ? ids[i + 1] : null };
}
// ---- 纯函数到此 ----

const HL_RATINGS = ['A+', 'A', 'C', 'D'];
const blank = (v) => !String(v || '').trim();

function labeller(options, optionsZh, lang) {
  return (v) => {
    if (!v) return '';
    const i = (options || []).indexOf(v);
    const zh = i >= 0 ? (optionsZh || [])[i] : null;
    return lang === 'zh' && zh ? zh : v;
  };
}
const todayStr = () => dayOf(new Date().toISOString());
// 评语是否对员工可见：服务端单一开关（L2，负责人待定）。下发了就按它说；没下发时说「按公司设置」
function visHint(s, resultVisible, commentVisible) {
  if (resultVisible === false) return s.visHidden;
  if (commentVisible === true) return s.visAll;
  if (commentVisible === false) return s.visNoComment;
  return s.visTbd;
}

export default function ReviewTeam({ lang, data, params, patch, onReload }) {
  const s = T[lang === 'zh' ? 'zh' : 'en'];
  const nav = useNavigate();
  // 从名单点进单人页时记一下：「返回名单」用浏览器后退回到原来那条记录（筛选与滚动都在），直接打开的单人页则改写地址
  const fromRoster = useRef(false);
  const rows = Array.isArray(data.teamRows) ? data.teamRows : [];
  const stats = Array.isArray(data.teamStats) ? data.teamStats : [];
  const label = useMemo(() => labeller(data.ratingOptions, data.ratingOptions_zh, lang), [data.ratingOptions, data.ratingOptions_zh, lang]);
  const commentVisible = typeof data.commentVisibleToEmployee === 'boolean' ? data.commentVisibleToEmployee : undefined;
  const back = useCallback(() => {
    if (!confirmLeave()) return;
    if (fromRoster.current) { fromRoster.current = false; nav(-1); return; }
    patch({ item: null }, { push: false });
  }, [nav, patch]);
  if (params.item) {
    return (
      <TeamPerson s={s} lang={lang} itemId={params.item} rows={rows} stats={stats} params={params} patch={patch}
        onBack={back} onReload={onReload} resultVisible={data.resultVisibleToEmployee} commentVisible={commentVisible} />
    );
  }
  return (
    <>
      <TeamDashboard lang={lang} label={label} />
      <TeamRoster s={s} rows={rows} stats={stats} params={params} patch={patch} label={label}
        ratingOptions={data.ratingOptions} onOpen={() => { fromRoster.current = true; }} />
    </>
  );
}

// ---------------- 名单 ----------------
function TeamRoster({ s, rows, stats, params, patch, label, ratingOptions, onOpen }) {
  const cycle = pickCycle(stats, params.cycle);
  const st = stats.find((x) => x.cycleId === cycle) || null;
  const v2 = st ? st.flow === 'v2' : rows.some((r) => r.cycleId === cycle && r.flow === 'v2');
  const status = TEAM_STATUS.includes(params.status) ? params.status : 'all';
  const inCycle = useMemo(() => rows.filter((r) => !cycle || r.cycleId === cycle), [rows, cycle]);
  const list = useMemo(() => sortTeamRows(filterTeamRows(rows, { cycle, status, q: params.q })), [rows, cycle, status, params.q]);
  const cycleKey = stats.map((x) => x.cycleId).join('|');
  // 地址栏里失效的 cycle / status：数据已在手（本组件只在数据到了以后渲染），改写掉，不垫历史
  useEffect(() => {
    const p = {};
    if (params.cycle && params.cycle !== cycle) p.cycle = null;
    if (params.status && !TEAM_STATUS.includes(params.status)) p.status = null;
    if (Object.keys(p).length) patch(p, { push: false });
  }, [params.cycle, params.status, cycle, cycleKey, patch]);

  const count = (k) => {
    if (st && st.byStatus && typeof st.byStatus[k] === 'number') return st.byStatus[k];
    return k === 'all' ? inCycle.length : inCycle.filter((r) => Array.isArray(r.tags) && r.tags.includes(k)).length;
  };
  const chips = TEAM_STATUS.filter((k) => (k === 'one' ? v2 : true) && (k === 'locked' || k === 'left' ? count(k) > 0 || status === k : true));
  const opts = (Array.isArray(ratingOptions) && ratingOptions.length ? ratingOptions : Object.keys((st && st.distribution) || {}));
  const dist = (st && st.distribution) || {};
  const distMax = Math.max(1, ...opts.map((o) => dist[o] || 0));
  const distTotal = opts.reduce((n, o) => n + (dist[o] || 0), 0);
  const pct = (a, b) => (b ? Math.round((a * 100) / b) : 0);
  const hrefOf = (r) => `/review?${mergeParams(params, { item: r.id }).toString()}`;

  return (
    <div className="rvt">
      <p className="rv-note rvt-lead">{s.teamLead}</p>
      {stats.length > 1 && (
        <div className="ml-filters rvt-cycles" role="group" aria-label={s.cycleLab}>
          {stats.map((x) => (
            <button key={x.cycleId} type="button" className={'ml-chip' + (x.cycleId === cycle ? ' active' : '')} aria-pressed={x.cycleId === cycle}
              onClick={() => patch({ cycle: x.cycleId, status: null, q: null })}>{x.cycle}</button>
          ))}
        </div>
      )}
      {st && (
        <>
          <div className={'tm-stats rvt-stats' + (v2 ? '' : ' rvt-stats-2')}>
            <div className="tm-stat">
              <div className="tm-stat-k">{s.stSelf}</div>
              <div className="tm-stat-v tnum">{st.selfDone}<span className="rvt-of">/{st.counted}</span></div>
              <div className="rvt-sub tnum">{pct(st.selfDone, st.counted)}%</div>
            </div>
            {v2 && (
              <div className="tm-stat" title={s.stOneHint}>
                <div className="tm-stat-k">{s.stOne}</div>
                <div className="tm-stat-v tnum">{st.oneOnOneDone}<span className="rvt-of">/{st.counted}</span></div>
                <div className="rvt-sub tnum">{pct(st.oneOnOneDone, st.counted)}%{(st.oneMgrOnly || st.oneEmpOnly) ? <span className="rvt-sub-x">{` · ${s.oneSplit(st.oneMgrOnly || 0, st.oneEmpOnly || 0)}`}</span> : null}</div>
              </div>
            )}
            <div className="tm-stat">
              <div className="tm-stat-k">{s.stRated}</div>
              <div className="tm-stat-v tnum">{st.rated}<span className="rvt-of">/{st.counted}</span></div>
              <div className="rvt-sub tnum">{pct(st.rated, st.counted)}%{st.proxied ? <span className="rvt-sub-x">{` · ${s.proxiedN(st.proxied)}`}</span> : null}</div>
            </div>
          </div>
          {st.excluded > 0 && <p className="rv-note rvt-excl">{s.excludedN(st.excluded)}</p>}
          <div className="card rvt-dist">
            <div className="rv-lab">{s.distTitle}</div>
            {distTotal === 0 ? <div className="rv-hint">{s.distEmpty}</div> : (
              <div className="rvt-bars">
                {opts.map((o) => (
                  <div key={o} className="rvt-bar">
                    <span className="rvt-bar-k">{label(o)}</span>
                    <span className="rvt-bar-track"><span className="rvt-bar-fill" style={{ width: `${Math.round(((dist[o] || 0) * 100) / distMax)}%` }} /></span>
                    <span className="rvt-bar-n tnum">{dist[o] || 0}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      )}
      <div className="rvt-tools">
        <div className="ml-filters rvt-filters" role="group" aria-label={s.statusLab}>
          {chips.map((k) => (
            <button key={k} type="button" className={'ml-chip' + (status === k ? ' active' : '')} aria-pressed={status === k}
              onClick={() => patch({ status: k === 'all' ? null : k })}>
              {s['s_' + k]}<span className="ml-chip-n tnum">{count(k)}</span>
            </button>
          ))}
        </div>
        <input type="search" className="rv-inp rvt-search" value={params.q || ''} placeholder={s.search} aria-label={s.search}
          onChange={(e) => patch({ q: e.target.value || null })} />
      </div>
      {list.length === 0 ? <div className="card rv-empty">{inCycle.length ? s.noMatch : s.noTeam}</div> : (
        <div className={'rvt-list' + (v2 ? '' : ' no-one')} role="list">
          <div className="rvt-headrow" aria-hidden="true">
            <span>{s.cName}</span><span>{s.cSelf}</span>{v2 && <span>{s.cOne}</span>}<span>{s.cRate}</span><span />
          </div>
          {list.map((r) => <TeamRow key={r.id} s={s} r={r} label={label} href={hrefOf(r)} onOpen={onOpen} />)}
        </div>
      )}
    </div>
  );
}

function TeamRow({ s, r, label, href, onOpen }) {
  const v2 = r.flow === 'v2';
  const ss = selfState(r);
  const rs = rateState(r);
  const t = rowTodo(r);
  // 9.1（第三批）：员工端不显示工号 —— 只给职位（无职位时给部门）与职级；搜索仍可按工号（filterTeamRows）
  const meta = [r.position || r.department, r.jobLevel].filter(Boolean).join(' · ');
  const selfPill = ss === 'done' ? ['ok', s.selfDone(dayOf(r.selfAt))] : ss === 'overdue' ? ['fail', s.selfOverdue] : ['muted', s.selfPending];
  const one = ['both', 'mgr', 'emp', 'none'].includes(r.oneState) ? r.oneState : 'none';
  const onePill = [one === 'both' ? 'ok' : one === 'none' ? 'muted' : 'warn', s['one_' + one]];
  const ratePill = {
    left: ['muted', r.managerRating ? `${s.leftTag} · ${s.rated(label(r.managerRating))}` : s.leftTag],
    hod_self: ['muted', s.hodSelfTag],
    locked: ['muted', r.managerRating ? `${s.lockedTag} · ${s.rated(label(r.managerRating))}` : s.lockedTag],
    proxied: ['warn', s.hodProxied],
    rated: ['ok', s.rated(label(r.managerRating))],
    overdue: ['fail', s.rateOverdue],
    waitSelf: ['muted', s.waitSelf],
    todo: ['pri', s.toRate],
  }[rs];
  return (
    <div role="listitem" className={'rvt-row' + (r.notCounted ? ' is-off' : '') + (t.rate || t.one ? ' is-todo' : '')}>
      <Link className="rvt-open" to={href} onClick={onOpen} aria-label={s.openPerson(r.name)}>
        <span className="rvt-who">
          <span className="rvt-name" title={r.name}>{r.name}</span>
          <span className="rvt-meta tnum" title={meta}>{meta}</span>
        </span>
        <span className="rvt-cell"><span className="rvt-k">{s.cSelf}</span><span className={'pill ' + selfPill[0]}>{selfPill[1]}</span></span>
        {v2 && <span className="rvt-cell"><span className="rvt-k">{s.cOne}</span><span className={'pill ' + onePill[0]}>{onePill[1]}</span></span>}
        <span className="rvt-cell"><span className="rvt-k">{s.cRate}</span><span className={'pill ' + ratePill[0]}>{ratePill[1]}</span></span>
        <span className="rvt-chev" aria-hidden="true">›</span>
      </Link>
    </div>
  );
}

// ---------------- 单人页 ----------------
function TeamPerson({ s, lang, itemId, rows, stats, params, patch, onBack, onReload, resultVisible, commentVisible }) {
  // ---- 所有 hook 在任何提前 return 之前（审查 P1-17）----
  const q = useAsync(() => api.get(`/api/me/reviews/team/${encodeURIComponent(itemId)}`), [itemId]);
  // 换人时 useAsync 会先留着上一位的数据：只认 id 对得上的（审查 P1-7）
  const data = q.data && q.data.item && q.data.item.id === itemId ? q.data : null;
  const [dirtyParts, setDirtyParts] = useState({});
  const onDirty = useCallback((k, v) => setDirtyParts((p) => (!!p[k] === !!v ? p : { ...p, [k]: !!v })), []);
  const dirty = Object.values(dirtyParts).some(Boolean);
  useLeaveGuard(dirty, s.unsaved);
  const cur = rows.find((r) => r.id === itemId) || null;
  const cycle = cur ? cur.cycleId : pickCycle(stats, params.cycle);
  const status = TEAM_STATUS.includes(params.status) ? params.status : 'all';
  const fKey = `${cycle}|${status}|${params.q || ''}`;
  const [order, setOrder] = useState({ key: null, ids: [] });
  useEffect(() => {
    if (order.key === fKey && order.ids.includes(itemId)) return;
    setOrder({ key: fKey, ids: personOrder(rows, { cycle, status, q: params.q }, itemId) });
    // 只在筛选或当前人变化时重排；保存后名单刷新不重排（顺序不跳）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fKey, itemId]);
  const nb = useMemo(() => neighbours(order.ids, itemId, rows), [order.ids, itemId, rows]);
  const label = useMemo(() => labeller(data && data.ratingOptions, data && data.ratingOptions_zh, lang), [data, lang]);
  const go = (id) => { if (!id || !confirmLeave()) return; patch({ item: id }, { push: false }); };
  const reloadAll = useCallback(() => { q.reload(); if (onReload) onReload(); }, [q, onReload]);

  const it = data ? data.item : null;
  const selfHref = `/review?${mergeParams(params, {}).toString()}`;
  const name = it ? it.name : cur ? cur.name : '';
  return (
    <div className="rvt-person">
      <ModuleTrail items={[{ label: s.trailRoot, to: '/review' }, { label: s.trailTeam, onClick: onBack }, { label: name || '…' }]} />
      <div className="rvt-pbar" role="navigation" aria-label={s.trailTeam}>
        <button type="button" className="btn ghost sm rvt-back" onClick={onBack}><span aria-hidden="true">‹</span>{s.back}</button>
        {nb.index >= 0 && <span className="rvt-pos tnum">{s.pos(nb.index + 1, nb.total)}</span>}
        <span className="rvt-nav">
          <button type="button" className="rv-nudge" disabled={!nb.prev} onClick={() => go(nb.prev)}>{s.prev}</button>
          <button type="button" className="rv-nudge" disabled={!nb.next} onClick={() => go(nb.next)}>{s.next}</button>
        </span>
      </div>
      {!data && q.error && (
        <div className="card rv-empty">{q.error.status === 404 ? s.notFound : s.loadErr}</div>
      )}
      {!data && !q.error && <div className="card rv-note">{s.loading}</div>}
      {it && (
        <>
          <div className="ml-head rvt-phead">
            <h1 className="ml-title">{it.name}</h1>
            <div className="rv-head rvt-pmeta">
              {/* 9.1：不显示工号；职位 · 职级 · 部门 */}
              {(it.position || it.jobLevel || it.department) && <span className="rv-eid">{[it.position, it.jobLevel, it.department].filter(Boolean).join(' · ')}</span>}
              <span className="rv-eid">{it.cycle}</span>
              {it.dueAt && <span className={'pill tnum ' + (!it.selfAt && it.selfOverdue ? 'fail' : 'muted')}>{s.dueSelf(dayOf(it.dueAt))}</span>}
              {it.dueRateAt && <span className={'pill tnum ' + ((it.overdue || []).includes('rate') ? 'fail' : 'muted')}>{s.dueRate(dayOf(it.dueRateAt))}</span>}
              {it.notCounted === 'departed' && <span className="pill muted">{s.leftTag}</span>}
              {it.notCounted === 'hod_self' && <span className="pill muted">{s.hodSelfTag}</span>}
              {it.locked && <span className="pill muted">{s.lockedTag}</span>}
              {it.hodProxied && <span className="pill warn">{s.hodProxied}</span>}
              {it.userId && <Link className="rv-name-link rvt-prof" to={`/team/${encodeURIComponent(it.userId)}`} state={{ from: 'review', back: selfHref }}>{s.profile}</Link>}
            </div>
          </div>
          <section className="card rv-card rvt-step">
            <h2 className="rvt-h">{s.s1}</h2>
            <SelfPack s={s} it={it} />
          </section>
          <section className="card rv-card rvt-step">
            <h2 className="rvt-h">{s.s2}</h2>
            {it.flow === 'v2'
              ? <MgrOneOnOne key={it.id} s={s} it={it} busyOuter={q.loading} onSaved={reloadAll} onDirty={onDirty} />
              : <div className="rv-note">{s.oneLegacy}</div>}
          </section>
          <section className="card rv-card rvt-step">
            <h2 className="rvt-h">{s.s3}</h2>
            <MgrRating key={it.id} s={s} lang={lang} it={it} data={data} label={label} busyOuter={q.loading} onSaved={reloadAll} onDirty={onDirty}
              resultVisible={resultVisible} commentVisible={typeof data.commentVisibleToEmployee === 'boolean' ? data.commentVisibleToEmployee : commentVisible} />
          </section>
        </>
      )}
    </div>
  );
}

function SelfPack({ s, it }) {
  const prev = Array.isArray(it.prevGoals) ? it.prevGoals : [];
  if (!it.selfAt) return <div className="rv-pack"><div className="rv-pack-none">{s.noSelf}</div></div>;
  const row = (k, v) => (blank(v) ? null : <div className="rv-pack-row" key={k}><b>{k}</b><br /><span>{v}</span></div>);
  return (
    <div className="rv-pack rvt-self">
      <div className="rv-hint tnum">{s.selfAt(dayOf(it.selfAt))}</div>
      {(Array.isArray(it.selfOutcomes) ? it.selfOutcomes : []).map((o, i) => row(`${prev.length ? s.selfOutcome(i + 1) : s.selfOutcomeNoPrev}${prev[i] ? ` · ${String(prev[i]).slice(0, 40)}${String(prev[i]).length > 40 ? '…' : ''}` : ''}`, o))}
      {row(s.selfChallenges, it.selfChallenges)}
      {row(s.selfFeedback, it.selfFeedback)}
      {Array.isArray(it.goalsNext) && it.goalsNext.length > 0 && row(s.selfGoals, it.goalsNext.map((g, i) => `${i + 1}. ${g}`).join('\n'))}
    </div>
  );
}

// 上级一侧登记 1 对 1 面谈（v2）：日期默认今天、可补登记（上限今天，下限周期发起日由服务端校验 → date_invalid）
function MgrOneOnOne({ s, it, busyOuter, onSaved, onDirty }) {
  const today = todayStr();
  const [date, setDate] = useState(today);
  const [notes, setNotes] = useState(it.oneOnOneNotes || '');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const logged = !!it.oneOnOneAt;
  // 未保存 = 要点与已存的不同（撤销登记后要点仍在服务端，不能因为「未登记 + 有要点」就算未保存）
  const notesDirty = notes.trim() !== String(it.oneOnOneNotes || '').trim();
  const dirty = notesDirty;
  useEffect(() => { onDirty('one', dirty); }, [dirty, onDirty]);
  useEffect(() => () => onDirty('one', false), [onDirty]);
  // 日期下限 = 周期发起日：条目里有 cycleStartedAt / cycleCreatedAt 就用，否则只靠服务端校验（400 date_invalid）
  const minDate = it.cycleStartedAt || it.cycleCreatedAt ? dayOf(it.cycleStartedAt || it.cycleCreatedAt) : undefined;
  // 日期范围（第二批波次 3）：上限今天、下限周期发起日。手动输入越界时按钮置灰、范围提示标红，不等 400 date_invalid
  const outOfRange = !!date && (date > today || (!!minDate && date < minDate));
  const send = async (body, okText) => {
    setBusy(true); setMsg(null);
    try { await api.post(`/api/me/reviews/${encodeURIComponent(it.id)}/one-on-one`, body); setMsg({ ok: true, text: okText }); onSaved(); }
    catch (err) {
      setMsg({ ok: false, text: s.err + errText(err, {
        date_invalid: () => s.e_date_invalid, dept_locked: () => s.eLocked, not_found: () => s.eNotFound, cycle_closed: () => s.eCycleClosed,
        manager_inactive: () => s.e_manager_inactive, flow_unsupported: () => s.eFlow,
      }) });
    }
    setBusy(false);
  };
  const off = busy || busyOuter;
  return (
    <div className="rvt-one">
      <div className="rvt-one-sides">
        <span className={'pill ' + (logged ? 'ok' : 'muted')}>{logged ? s.oneMgrDone(dayOf(it.oneOnOneAt)) : s.oneMgrNot}</span>
        <span className={'pill ' + (it.employeeOneOnOneAt ? 'ok' : 'muted')}>{it.employeeOneOnOneAt ? s.oneEmpDone(dayOf(it.employeeOneOnOneAt)) : s.oneEmpNot}</span>
      </div>
      {!logged && (
        <label className="rvt-date">
          <span>{s.oneDate}</span>
          <input type="date" className="rv-inp" value={date} max={today} min={minDate} onChange={(e) => setDate(e.target.value)} />
        </label>
      )}
      {!logged && minDate && <div className={outOfRange ? 'rv-msg err' : 'rv-hint'}>{s.oneDateRange(minDate)}</div>}
      <div className="rv-lab">{s.notesLab}</div>
      <textarea rows={2} className="rv-ta" value={notes} maxLength={2000} placeholder={s.notesPh} onChange={(e) => setNotes(e.target.value)} />
      <div className="rv-hint">{s.notesVis}</div>
      {logged && it.locked && <div className="rv-hint">{s.oneLockedNote}</div>}
      <div className="rv-foot">
        {!logged && <button type="button" className="btn sm" disabled={off || !date || outOfRange} onClick={() => send({ done: true, date, notes }, s.oneLogged)}>{s.oneLog}</button>}
        {logged && <button type="button" className="btn sm" disabled={off || !notesDirty} onClick={() => send({ done: true, notes }, s.notesSaved)}>{s.notesSave}</button>}
        {logged && !it.locked && <button type="button" className="rv-nudge" disabled={off} onClick={() => send({ done: false }, s.oneUndone)}>{s.oneUndo}</button>}
        {msg && <span className={'rv-msg' + (msg.ok ? '' : ' err')} role="status">{msg.text}</span>}
      </div>
    </div>
  );
}

// 评级、关键亮点、评语。补丁语义（服务端）：只发表单里有的字段
function MgrRating({ s, lang, it, data, label, busyOuter, onSaved, onDirty, resultVisible, commentVisible }) {
  const v2 = it.flow === 'v2';
  const gate = rateGate(it);
  const options = Array.isArray(data.ratingOptions) ? data.ratingOptions : [];
  const descOf = (v) => {
    const i = options.indexOf(v);
    if (i < 0) return '';
    const zh = (data.ratingOptions_desc_zh || [])[i] || '', en = (data.ratingOptions_desc || [])[i] || '';
    return lang === 'zh' ? (zh || en) : (en || zh);
  };
  const hlRatings = Array.isArray(data.highlightRatings) && data.highlightRatings.length ? data.highlightRatings : HL_RATINGS;
  const [rating, setRating] = useState(it.managerRating || '');
  const [text, setText] = useState(it.managerText || '');
  const [highlights, setHighlights] = useState(it.highlights || '');
  const [oneDone, setOneDone] = useState(!!it.oneOnOneAt);
  const [oneNotes, setOneNotes] = useState(it.oneOnOneNotes || '');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const [nudge, setNudge] = useState({ busy: false, done: false, err: '' });
  const needHl = v2 && hlRatings.includes(rating);
  const editable = gate === 'open';
  const dirty = editable && ((rating || '') !== (it.managerRating || '') || text.trim() !== String(it.managerText || '').trim()
    || (v2 && highlights.trim() !== String(it.highlights || '').trim())
    || (!v2 && !it.oneOnOneAt && (oneDone || !blank(oneNotes))));
  useEffect(() => { onDirty('rate', dirty); }, [dirty, onDirty]);
  useEffect(() => () => onDirty('rate', false), [onDirty]);

  const submit = async () => {
    setBusy(true); setMsg(null);
    const body = { rating, text };
    if (v2) body.highlights = highlights;
    else { body.oneOnOneDone = oneDone; if (!it.oneOnOneAt) body.oneOnOneNotes = oneNotes; }
    try { await api.post(`/api/me/reviews/${encodeURIComponent(it.id)}/manager`, body); setMsg({ ok: true, text: s.saved }); onSaved(); }
    catch (err) {
      setMsg({ ok: false, text: s.err + errText(err, {
        rating_required: () => s.eRating, highlights_required: () => s.eHighlights, dept_locked: () => s.eLocked,
        not_found: () => s.eNotFound, cycle_closed: () => s.eCycleClosed, hod_proxied: () => s.e_hod_proxied,
        manager_inactive: () => s.e_manager_inactive, oneonone_required: () => s.eOneOnOne,
      }) });
    }
    setBusy(false);
  };
  const sendNudge = async () => {
    setNudge({ busy: true, done: false, err: '' });
    try { await api.post(`/api/me/reviews/${encodeURIComponent(it.id)}/nudge`, {}); setNudge({ busy: false, done: true, err: '' }); }
    catch (err) {
      setNudge({ busy: false, done: false, err: errText(err, {
        cooldown: () => s.eCooldown, already_submitted: () => s.eAlreadySubmitted, not_found: () => s.eNotFound, cycle_closed: () => s.eCycleClosed,
        recipient_inactive: () => s.e_recipient_inactive, manager_inactive: () => s.e_manager_inactive,
      }) });
    }
  };

  if (gate === 'proxied') return <div className="rv-note rvt-ro">{s.e_hod_proxied}</div>;
  if (gate === 'waitSelf') {
    return (
      <div className="rv-waiting">
        <span className="pill muted">{s.selfMissing}</span>
        <span>{s.selfMissingLead}</span>
        <button type="button" className="rv-nudge" disabled={nudge.busy || nudge.done} onClick={sendNudge}>{nudge.done ? s.nudged : s.nudge}</button>
        {nudge.err && <span className="rv-msg err">{nudge.err}</span>}
      </div>
    );
  }
  if (gate === 'locked') {
    return (
      <div className="rvt-ro">
        <div className="rv-note">{s.lockedRO}</div>
        {it.managerRating && <div className="rv-lab">{s.ratingLab}</div>}
        {it.managerRating && <span className="pill pri">{label(it.managerRating)}</span>}
        {!blank(it.highlights) && <><div className="rv-lab">{s.highlights}</div><div className="rv-quote">{it.highlights}</div></>}
        {!blank(it.managerText) && <><div className="rv-lab">{s.mgrComment}</div><div className="rv-quote">{it.managerText}</div></>}
      </div>
    );
  }
  const off = busy || busyOuter;
  return (
    <div className="rvt-rate">
      {it.notCounted === 'departed' && <div className="rv-hint rvt-note">{s.leftNote}</div>}
      {!it.selfAt && it.selfOverdue && <div className="rv-hint rvt-note">{s.selfOverdueRate}</div>}
      {!v2 && !it.oneOnOneAt && (
        <>
          <label className="rv-check">
            <input type="checkbox" checked={oneDone} onChange={(e) => setOneDone(e.target.checked)} />
            <span>{s.oneLegacyCheck}<span className="req">*</span></span>
          </label>
          <textarea rows={2} className="rv-ta" value={oneNotes} placeholder={s.legacyNotesPh} onChange={(e) => setOneNotes(e.target.value)} />
        </>
      )}
      <div className="rv-lab">{s.ratingLab}<span className="req">*</span></div>
      <div className="rv-grades" role="group" aria-label={s.ratingLab}>
        {options.map((o) => (
          <button key={o} type="button" aria-pressed={rating === o} className={'rv-grade' + (rating === o ? ' on' : '')}
            title={descOf(o) || undefined} onClick={() => setRating(rating === o ? '' : o)}>{label(o)}</button>
        ))}
      </div>
      {v2 && (
        <>
          <div className="rv-lab">{s.highlights}{needHl && <span className="req">*</span>}<span className="rv-lab-note">{s.highlightsReq}</span></div>
          <textarea rows={3} className="rv-ta" value={highlights} maxLength={2000} placeholder={s.highlightsPh} onChange={(e) => setHighlights(e.target.value)} />
        </>
      )}
      <div className="rv-lab">{s.mgrComment}</div>
      <div className="rv-hint">{visHint(s, resultVisible, commentVisible)}</div>
      <textarea rows={3} className="rv-ta" value={text} maxLength={4000} placeholder={s.mgrPh} onChange={(e) => setText(e.target.value)} />
      <div className="rv-foot">
        <button type="button" className="btn sm" disabled={off || !rating || (needHl && blank(highlights)) || (!v2 && !oneDone && !it.oneOnOneAt)} onClick={submit}>
          {it.managerRating ? s.mgrResave : s.mgrSave}
        </button>
        {msg && <span className={'rv-msg' + (msg.ok ? '' : ' err')} role="status">{msg.text}</span>}
      </div>
      <div className="rv-hint">{v2 ? s.closeHint : s.closeHintLegacy}</div>
    </div>
  );
}
