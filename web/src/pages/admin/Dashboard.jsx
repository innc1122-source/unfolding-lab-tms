// 工作台 Dashboard —— 12.2 改版（2026-10-09，b12-design §1、§7）：一页三层「需要处理 → 组织风险 → 人才结构与组织效能」，
// 实现在 pages/admin/workbench/（WorkbenchPage.jsx 为页面，纯函数在 web/src/workbench.js）。
// 原页面的深色 hero KPI、部门人数条形图、培训完成度、评估周期进度与最近入职卡整体移除；GET /api/admin/dashboard 不再调用
// （接口保留给老前端与既有测试）。原「评估周期进度」每个周期一行直达该周期的做法，移到组织风险层「评估按时完成率」卡上的
// 当期周期一行（workbench/RiskLayer.jsx 的 CycleRow）。名单不用抽屉，是 /admin?list=… 的整页（workbench/PeopleList.jsx）。
import WorkbenchPage from './workbench/WorkbenchPage.jsx';

export default function Dashboard() {
  return <WorkbenchPage />;
}
