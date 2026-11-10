// 12.2 工作台（2026-10-09，b12-design §1、§7）：一页三层 —— 需要处理 → 组织风险 → 人才结构与组织效能。
// 顺序与可见块由 workbenchLayout(user) 按 /api/me 的 grants 判定（不按角色名）；每块另过模块开关与能力域两道闸，
// 服务端对无权的块整块不下发。三层各自请求、各自报错，一层失败不影响其他层。各层可折叠，折叠状态存 localStorage。
// 每个数字都能点开名单：名单是整页（/admin?list=…，负责人规则「不用抽屉，长内容用整页」），见 PeopleList.jsx。
// 原工作台的 GET /api/admin/dashboard 不再调用（接口保留给老前端与既有测试）。
import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Empty, Spin } from '@douyinfe/semi-ui';
import { api, useAsync } from '../../../api.js';
import { useAuth } from '../../../auth.jsx';
import { useI18n } from '../../../i18n.jsx';
import { workbenchLayout, moduleOn, drillFromSearch, readFolded, writeFolded } from '../../../workbench.js';
import { canReadDomain } from '../../../rbac.js';
import { Layer, useNarrow, IcTodo, IcRisk, IcStructure } from './shared.jsx';
import TodoLayer, { todoRows } from './TodoLayer.jsx';
import RiskLayer, { riskMetrics } from './RiskLayer.jsx';
import StructureLayer from './StructureLayer.jsx';
import PeopleList from './PeopleList.jsx';
import { useCultureData, cultureTodoItems } from './CulturePanel.jsx';

const T = {
  zh: {
    title: '工作台', lead: '需要处理的事项、组织风险与人才结构。点击任一数字可查看名单。',
    view: { admin: '管理员视角', talent: '绩效与人才视角', learning: '培训视角', custom: '自定义角色视角' },
    layers: { todo: '需要处理', risk: '组织风险', structure: '人才结构与组织效能' },
    /* 只有没有任何业务域可读的角色（如只看审计日志）会走到这一条 */
    noCards: '你的角色没有可在工作台显示的内容，请从左侧菜单进入你负责的页面。',
  },
  en: {
    title: 'Dashboard', lead: 'Action items, organizational risk and talent structure. Select any number to see the list.',
    view: { admin: 'Administrator view', talent: 'Performance & talent view', learning: 'Learning view', custom: 'Custom role view' },
    layers: { todo: 'Action Items', risk: 'Organizational Risk', structure: 'Talent Structure & Organizational Effectiveness' },
    noCards: 'Your role has nothing to show on the dashboard. Use the menu on the left to open the pages you manage.',
  },
};

const ICON = { todo: IcTodo, risk: IcRisk, structure: IcStructure };
const loading = <div className="wb-loading"><Spin /></div>;

function Workbench() {
  const { lang } = useI18n();
  const s = T[lang] || T.en;
  const { user } = useAuth();
  const narrow = useNarrow();
  const layout = workbenchLayout(user);
  const want = (layer) => layout.order.includes(layer);
  const [folded, setFolded] = useState(readFolded);
  const toggle = (id) => setFolded((f) => { const next = { ...f, [id]: !f[id] }; writeFolded(next); return next; });

  const todo = useAsync(() => (want('todo') ? api.get('/api/admin/workbench/todo') : null), []);
  const risk = useAsync(() => (want('risk') ? api.get('/api/admin/workbench/risk') : null), []);
  const structure = useAsync(() => (want('structure') ? api.get('/api/admin/workbench/structure') : null), []);
  // 3+3 数据：第三层的 3+3 块，或第一层的两条 3+3 待办（培训视角不显示第三层，但 culture 可读时待办照常）
  const culture = useCultureData(layout.blocks.culture || (layout.blocks.todo && moduleOn(user, 'culture') && canReadDomain(user, 'culture')));

  const todoList = todoRows(todo.data && todo.data.items, cultureTodoItems(culture), layout);
  const cards = riskMetrics(risk.data, layout);
  const sd = structure.data || {};
  const structureHas = ['nineBox', 'perfQuota', 'pipeline', 'deptHealth'].some((k) => layout.blocks[k] && sd[k] !== undefined && sd[k] !== null) || layout.blocks.culture;

  /* 某层的块服务端都没下发（无权或模块关闭）时整层不显示；请求中与出错时照常显示该层。 */
  const layers = layout.order.filter((id) => {
    if (id === 'risk') return !!risk.error || risk.loading || cards.length > 0;
    if (id === 'structure') return !!structure.error || structure.loading || structureHas;
    return true;
  });
  const body = {
    todo: () => (todo.loading && !todo.data ? loading : <TodoLayer rows={todoList} error={todo.error} />),
    risk: () => (risk.loading && !risk.data ? loading : <RiskLayer cards={cards} error={risk.error} />),
    structure: () => (structure.loading && !structure.data ? loading : <StructureLayer data={sd} error={structure.error} layout={layout} culture={culture} />),
  };
  /* 层标题右侧的数量胶囊只给第一层（待办条数）；第二、三层是指标，不计数 */
  const count = { todo: todo.data ? todoList.length : undefined };

  return (
    <div className="wrap dash-wrap wb-wrap">
      <div className="v2-dashboard-hero wb-hero">
        <div className="tset-head">
          <div>
            <div className="u-title-line wb-title-line">
              <h1 className="tset-title">{s.title}</h1>
              <span className="pill wb-view">{s.view[layout.view]}</span>
            </div>
            {!narrow && <div className="tset-lead">{s.lead}</div>}
          </div>
        </div>
      </div>
      {layers.length === 0 && <Empty description={s.noCards} />}
      {layers.map((id) => {
        const Icon = ICON[id];
        return (
          <Layer key={id} id={id} icon={<Icon />} title={s.layers[id]} count={count[id]} folded={!!folded[id]} onToggle={() => toggle(id)}>
            {body[id]()}
          </Layer>
        );
      })}
    </div>
  );
}

export default function WorkbenchPage() {
  const [sp] = useSearchParams();
  const drill = drillFromSearch(sp);
  if (drill) return <div className="wrap dash-wrap wb-wrap"><PeopleList drill={drill} to={sp.get('to')} /></div>;
  return <Workbench />;
}
