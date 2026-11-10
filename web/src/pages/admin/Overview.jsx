import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button, Toast, Spin, Banner } from '@douyinfe/semi-ui';
import { IconDownload, IconHelpCircle } from '@douyinfe/semi-icons';
import { api, useAsync } from '../../api.js';
import { useAuth } from '../../auth.jsx';
import { useI18n } from '../../i18n.jsx';
import { canUseAction } from '../../rbac.js';
import { deptFilterInvalidText } from '../../components/DeptFilter.jsx';
import { useDeptTree } from '../../deptfilter.js';
import { useUrlState } from '../../urlstate.js';
import { T } from './overview/ovtext.js';
import { FILTER_KEYS, LIST_KEYS, filtersFromParams, queryOf } from './overview/ovquery.js';
import OverviewFilters from './overview/OverviewFilters.jsx';
import OverviewSearch from './overview/OverviewSearch.jsx';
import KpiCards from './overview/KpiCards.jsx';
import AttentionPanels from './overview/AttentionPanels.jsx';
import CategoryTable from './overview/CategoryTable.jsx';
import HeatTable from './overview/HeatTable.jsx';
import ProjectCards from './overview/ProjectCards.jsx';
import TrendChart from './overview/TrendChart.jsx';
import PeopleListPage from './overview/PeopleListPage.jsx';
import PersonPage from './overview/PersonPage.jsx';
import MetricHelpModal from './overview/MetricHelpModal.jsx';
import RemindModal from './overview/RemindModal.jsx';

// 培训概览（第三批 4.1 / 4.2，2026-10-08 重做为「风险优先」）：
//   地址栏保存全部筛选（period / from / to / dept / cat / enroll / mode / tp / programs / cohort / src），刷新、分享、返回都能还原；
//   第四批 7：src = 来源（指派 / 自主学习），随查询串发给看板、名单、导出与提醒（ovquery.queryOf）。
//   页面切换：?list=<metric> → 名单整页，?person=<userId> → 员工培训记录整页，否则看板。进出整页用 push（安卓返回键回到看板）。
//   看板：指标卡（环比）→ 需要关注（风险课程 / 风险部门 / 7 天内到期 / 待处理）→ 按类别汇总 → 部门 × 类别完成率 → 培养项目与近 12 周趋势。
//   数据：GET /api/admin/overview?v=2&<筛选>（设计 §4.1）；默认视图 = 登录者的数据范围（服务端 scopePredicate 已过滤）。
//   组件在 ./overview/ 目录，文案在 overview/ovtext.js，纯函数在 overview/ovquery.js（test/overview-ui-b3.test.js）。

const NO_OPTS = [];   // 部门选项未加载时的稳定空数组（DeptFilter 按引用记忆分列）
const FRESH_MS = 60000;
let dashCache = { key: '', at: 0, data: null };   // 从名单 / 员工页返回看板时不必再等一次整页统计

export default function Overview() {
  const { lang, loc } = useI18n();
  const s = T[lang];
  const nav = useNavigate();
  // 写操作只有「提醒」（POST /api/admin/training/remind-overdue，培训域写）；只读档不显示提醒按钮，待处理行显示「查看」。
  const { user } = useAuth();
  const canWrite = canUseAction(user, { domain: 'learning', module: 'learning', write: true });

  // ---- 地址栏状态 ----
  // 部门（第二批 3.1）：全站统一的 DeptFilter，值写进 ?dept=<部门 id | name:… | __none>，服务端 deptFilterFor 按「含全部下级」过滤。
  const [urlp, patchUrl] = useUrlState();
  const dept = urlp.dept || null;
  const setDept = (v) => patchUrl({ dept: v || null });
  const tree = useDeptTree();                       // undefined = 加载中；null = 不可用（DeptFilter 置灰）
  const deptOpts = tree && Array.isArray(tree.options) ? tree.options : NO_OPTS;
  const deptOptIds = useMemo(() => new Set(deptOpts.map((o) => String(o.id))), [deptOpts]);
  const optById = useMemo(() => new Map(deptOpts.map((o) => [String(o.id), o])), [deptOpts]);
  const onDeptInvalid = () => { Toast.warning(deptFilterInvalidText(lang)); patchUrl({ dept: null }); };
  const filters = useMemo(() => filtersFromParams(urlp), [urlp]);
  const patch = (set) => patchUrl(set);                     // 筛选：合并写回，replace
  // 清除筛选：部门与其余全部看板筛选键（名单 / 员工页键不动）
  const resetFilters = () => { setDept(null); patchUrl(Object.fromEntries(FILTER_KEYS.map((k) => [k, null]))); };

  // 点「只看此部门」/ 热力表部门名 → 部门筛选设成那个部门。部门筛选只列到三级、没人的部门不成选项，
  // 所以点到更深或没人的部门时沿部门树往上找第一个在选项里的祖先。
  const focusDept = (id) => {
    if (id === '__none') { setDept('__none'); return; }
    let cur = optById.get(String(id)) || (id ? { id, parentId: null } : null); let guard = 0;
    while (cur && guard++ < 64) {
      if (deptOptIds.has(String(cur.id))) { setDept(String(cur.id)); return; }
      cur = cur.parentId ? optById.get(String(cur.parentId)) : null;
    }
    // 部门筛选还没加载好（或不可用）时按原 id 过滤，服务端照样认（含下级）
    if (!tree && id) setDept(String(id));
  };

  // ---- 页面切换 ----
  const listOn = !!urlp.list;
  const personId = urlp.person || null;
  const onDash = !listOn && !personId;
  const openList = (metric, o) => patchUrl({
    ...Object.fromEntries(LIST_KEYS.map((k) => [k, null])), list: metric, ...(o || {}),
  }, { push: true });
  const openPerson = (userId) => patchUrl({ person: String(userId) }, { push: true });
  const closePerson = () => patchUrl({ person: null }, { push: true });

  // ---- 数据 ----
  const qs = queryOf(filters);
  const key = onDash ? 'v=2' + (qs ? '&' + qs : '') : '';
  const dq = useAsync(() => {
    if (!key) return null;
    if (dashCache.key === key && Date.now() - dashCache.at < FRESH_MS) return dashCache.data;
    return api.get('/api/admin/overview?' + key).then((r) => { dashCache = { key, at: Date.now(), data: r }; return r; });
  }, [key]);
  const tpQ = useAsync(() => api.get('/api/admin/tprojects').catch(() => []), []);
  const ov = dq.data || (dashCache.data && !onDash ? dashCache.data : null) || {};
  const programsMeta = Array.isArray(ov.programsMeta) ? ov.programsMeta : [];
  const metaById = useMemo(() => new Map(programsMeta.map((p) => [p.id, p])), [programsMeta]);
  const catInUse = useMemo(() => {
    const set = new Set();
    for (const p of programsMeta) if (p.category) set.add(p.category);
    for (const c of Array.isArray(ov.categories) ? ov.categories : []) if (c.key) set.add(c.key);
    return [...set];
  }, [programsMeta, ov.categories]);
  const win = ov.filters ? { from: ov.filters.from, to: ov.filters.to, prevFrom: ov.filters.prevFrom, prevTo: ov.filters.prevTo, asOf: ov.asOf } : null;

  const [help, setHelp] = useState(false);
  const [remind, setRemind] = useState(null);

  // 搜索选中课程：只看这门课，并清掉会把它筛掉的其他课程筛选（UX 审查 19）
  const pickCourse = (c) => {
    const cleared = filters.cat.length || filters.enroll || filters.mode || filters.tp;
    patchUrl({ programs: c.id, cat: null, enroll: null, mode: null, tp: null });
    if (cleared) Toast.info(s.sCleared(loc(c, 'title')));
  };
  const exportCsv = () => { window.location.href = '/api/admin/export/completion.csv' + (qs ? '?' + qs : ''); };

  if (personId) {
    return <PersonPage s={s} lang={lang} loc={loc} userId={personId} filters={filters} fromList={listOn} onBack={closePerson} />;
  }
  if (listOn) {
    return (
      <PeopleListPage s={s} lang={lang} loc={loc} urlp={urlp} patchUrl={patchUrl} filters={filters} canWrite={canWrite}
        metaById={metaById} deptOpts={deptOpts} onPerson={openPerson} />
    );
  }

  const loading = dq.loading && !dq.data;
  const noData = !loading && dq.data && !(ov.perProgram || []).length && !(ov.employees || 0);
  return (
    <div className="wrap ovx-page">
      <div className="ovx-head">
        <div className="ovx-head-t">
          <h1 className="ovx-title">{s.title}</h1>
          <div className="ovx-lead">{s.lead}</div>
        </div>
        <OverviewSearch s={s} lang={lang} loc={loc} onCourse={pickCourse} onPerson={(p) => openPerson(p.userId)}
          onDept={(d) => patchUrl({ dept: String(d.id) })} />
        <div className="ovx-head-act">
          <Button theme="borderless" icon={<IconHelpCircle />} onClick={() => setHelp(true)} aria-label={s.help}><span className="ovx-hide-phone">{s.help}</span></Button>
          <Button icon={<IconDownload />} onClick={exportCsv} aria-label={s.exportCompletion}><span className="ovx-hide-phone">{s.exportCompletion}</span></Button>
        </div>
      </div>

      <OverviewFilters s={s} lang={lang} loc={loc} filters={filters} patch={patch} win={win} catInUse={catInUse}
        programsMeta={programsMeta} tps={tpQ.data} deptOpts={deptOpts} dept={dept} setDept={setDept} tree={tree}
        onDeptInvalid={onDeptInvalid} resetFilters={resetFilters} />

      {dq.error && (
        <Banner type="danger" closeIcon={null} className="ovx-banner"
          description={<span>{s.loadErr}{dq.error.message ? ` · ${dq.error.message}` : ''} <Button size="small" onClick={dq.reload}>{s.retry}</Button></span>} />
      )}

      <KpiCards s={s} kpis={ov.kpis} period={filters.period} loading={loading} onOpen={openList} />

      {loading ? <div className="card ovx-loading"><Spin /></div> : noData ? <div className="card ovx-empty">{s.empty}</div> : (
        <>
          <AttentionPanels s={s} lang={lang} loc={loc} attention={ov.attention} metaById={metaById} dept={dept} canWrite={canWrite}
            onList={openList} onFocusDept={focusDept} onRemind={setRemind} nav={nav} />

          <section className="ovx-sec">
            <div className="ovx-sec-h"><h2>{s.catTitle}</h2></div>
            <CategoryTable s={s} lang={lang} loc={loc} categories={ov.categories} perProgram={ov.perProgram} onList={openList} />
          </section>

          <HeatTable s={s} lang={lang} heat={ov.heat} onList={openList} onFocusDept={focusDept} dept={dept} />

          <div className="ovx-two">
            <ProjectCards s={s} lang={lang} loc={loc} projects={ov.projects} />
            <TrendChart s={s} weeks={ov.trend} />
          </div>
        </>
      )}

      <MetricHelpModal s={s} visible={help} onClose={() => setHelp(false)} />
      <RemindModal s={s} filters={filters} req={remind} onClose={() => setRemind(null)}
        onDone={() => { dashCache = { key: '', at: 0, data: null }; }} />
    </div>
  );
}
