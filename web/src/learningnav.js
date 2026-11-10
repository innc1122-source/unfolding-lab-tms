// 员工端「培训」入口的唯一定义（IA 方案 1.2–1.4，批次 3 S5）：桌面顶栏「培训▾」下拉、手机底栏「培训」、
// 中转页 /learn（LearningHub.jsx）与页头模块路径共用同一张表，顺序、显示条件与名称只在这里写一次。
//   课程            on('learning')                         /learning
//   课程目录        on('learning') && hasCatalog            /catalog   （第四批 7：有公开课程时才显示）
//   培养项目        on('learning') && hasProjects           /projects
//   我的授课        on('learning') && roles.trainer         /sessions
//   我的班级        on('learning') && roles.classHead       /classes
//   团队学习        on('learning') && roles.manager         /team
// hasProjects、hasCatalog 与 roles 各自一次请求、组件之间共用（tprojects.js 已有 30 秒缓存；roles 与目录课程数在这里缓存 30 秒）。
import { modOn } from './rbac.js';
import { useEffect, useState } from 'react';
import { api } from './api.js';
import { fetchMyProjects } from './tprojects.js';

export const LEARNING_ITEMS = [
  { id: 'courses', to: '/learning',
    zh: '我的课程', en: 'My Courses',
    hubZh: '指派给你和你自主加入的课程', hubEn: 'Courses assigned to you or that you joined' },
  { id: 'catalog', to: '/catalog', need: 'catalog',
    zh: '公开课', en: 'Public Courses',
    hubZh: '全员可自主学习的公开课程，无需申请', hubEn: 'Open courses anyone can take, no application needed' },
  { id: 'programs', to: '/projects', need: 'projects',
    zh: '发展项目', en: 'Development Programs',
    hubZh: '你参加的发展项目与可申请的发展项目', hubEn: 'Development programs you are in and those open for application' },
  { id: 'sessions', to: '/sessions', need: 'trainer',
    zh: '我的授课', en: 'My Sessions',
    hubZh: '你负责讲授的场次、现场签到与出勤登记，以及线上活动的完成登记', hubEn: 'Sessions you deliver: check-in, attendance and online-activity completion' },
  { id: 'classes', to: '/classes', need: 'classHead',
    zh: '我的班级', en: 'My Classes',
    hubZh: '你担任班主任的班级、学员进度与本班出勤', hubEn: 'Classes you coordinate, learner progress and attendance' },
  { id: 'team', to: '/team', need: 'manager',
    zh: '团队学习', en: 'Team Learning',
    hubZh: '汇报线成员的学习情况', hubEn: 'Learning progress across your reporting line' },
];

// 属于「培训」的路由（顶栏「培训▾」与底栏「培训」的选中态）。/team/:userId 是下属档案，不算培训路由（IA 1.4 注 3）。
export function isLearningPath(pathname) {
  const p = String(pathname || '').toLowerCase().replace(/\/+$/, '') || '/';
  if (p === '/team') return true;
  if (p.startsWith('/team/')) return false;
  return ['/learn', '/learning', '/catalog', '/projects', '/sessions', '/classes', '/course', '/program', '/exam-prep', '/exam', '/result']
    .some((r) => p === r || p.startsWith(r + '/'));
}

/** 可见的培训入口（顺序固定，不可见的直接省略）。 */
export function visibleLearningItems(state) {
  if (!state || !state.learningOn) return [];
  return LEARNING_ITEMS.filter((it) => !it.need
    || (it.need === 'projects' ? state.hasProjects
      : it.need === 'catalog' ? !!state.hasCatalog
        : !!(state.roles && state.roles[it.need])));
}

let rolesCache = null, rolesAt = 0, rolesInflight = null;
function fetchRoles() {
  if (rolesCache && Date.now() - rolesAt < 30000) return Promise.resolve(rolesCache);
  if (rolesInflight) return rolesInflight;
  rolesInflight = api.get('/api/me/roles')
    .then((d) => { rolesCache = d || {}; rolesAt = Date.now(); rolesInflight = null; return rolesCache; })
    .catch(() => { rolesInflight = null; return {}; });
  return rolesInflight;
}

// 课程目录里的公开课程数（GET /api/catalog/courses?count=1，30 秒缓存）。旧服务端没有这个接口 → 0，入口不显示。
let catCount = null, catAt = 0, catInflight = null;
export function fetchCatalogCount() {
  if (catCount !== null && Date.now() - catAt < 30000) return Promise.resolve(catCount);
  if (catInflight) return catInflight;
  catInflight = api.get('/api/catalog/courses?count=1')
    .then((d) => { catCount = Math.max(0, Number(d && d.count) || 0); catAt = Date.now(); catInflight = null; return catCount; })
    .catch(() => { catInflight = null; return 0; });
  return catInflight;
}

/** 顶栏、底栏与中转页共用：{ learningOn, hasProjects, hasCatalog, roles, items }。 */
export function useLearningNav(user) {
  const mods = (user && user.modules) || {};
  const learningOn = modOn(mods, 'learning');
  const [hasProjects, setHasProjects] = useState(false);
  const [hasCatalog, setHasCatalog] = useState(false);
  const [roles, setRoles] = useState({});
  useEffect(() => {
    let alive = true;
    // /api/me/tprojects 是 learning 路由，模块关闭时 404：不发请求
    if (learningOn) fetchMyProjects().then((d) => { if (alive) setHasProjects(((d.mine || []).length + (d.open || []).length) > 0); }).catch(() => {});
    if (learningOn) fetchCatalogCount().then((n) => { if (alive) setHasCatalog(n > 0); });
    fetchRoles().then((r) => { if (alive) setRoles(r); });
    return () => { alive = false; };
  }, [learningOn]);
  const state = { learningOn, hasProjects, hasCatalog, roles };
  return { ...state, items: visibleLearningItems(state) };
}
