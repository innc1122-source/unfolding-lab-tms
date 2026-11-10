// 员工培训记录整页（第三批 4.2，设计 §3.3；地址栏 ?person=<userId>）：从搜索或名单进入。
// 数据：GET /api/admin/employees/:id/detail（培训读、按数据范围；越界 / 不存在同为 404）。programs[] 每项带
// category / enrollType / mode / hours / doneAt / bestPercent（G1 增补）。「本期学时」取名单接口 metric=covered 里本人的 hours
// （只带时间筛选，口径与看板人均学时一致）。返回：去掉 person；地址栏有 list 时回到名单，否则回看板。
// 「查看员工档案」只在有员工档案权限时显示（内置培训管理员没有）。
import { useMemo } from 'react';
import { Table, Button, Spin, Empty, Banner } from '@douyinfe/semi-ui';
import { IconArrowLeft } from '@douyinfe/semi-icons';
import { useNavigate } from 'react-router-dom';
import { api, useAsync } from '../../../api.js';
import { useAuth } from '../../../auth.jsx';
import { canSeeAdminPath } from '../../../rbac.js';
import { cardify } from '../../../cardify.js';
import { categoryLabel } from '../../../categories.js';
import { queryOf, periodText, fmtDay } from './ovquery.js';

const ST_PILL = { done: 'ok', overdue: 'fail', inprog: 'pri', notstarted: 'muted' };
const ST_LABEL = { done: 'stDone', overdue: 'stOverdue', inprog: 'stInprog', notstarted: 'stNotstarted' };

export default function PersonPage({ s, lang, loc, userId, filters, fromList, onBack }) {
  const nav = useNavigate();
  const { user } = useAuth();
  const q = useAsync(() => api.get('/api/admin/employees/' + encodeURIComponent(userId) + '/detail'), [userId]);
  const d = q.data && q.data.user && String(q.data.user.id) === String(userId) ? q.data : null;
  const du = d ? d.user : null;

  // 本期学时（只带时间筛选）
  const timeOnly = { period: filters.period, from: filters.from, to: filters.to, cat: [], programs: [], cohort: 'all' };
  const hq = useAsync(() => (du && du.employeeId
    ? api.get('/api/admin/overview/people?' + queryOf(timeOnly, { metric: 'covered', q: du.employeeId, size: 10 }))
    : Promise.resolve(null)), [du && du.employeeId, filters.period, filters.from, filters.to]);
  const hoursRow = hq.data && Array.isArray(hq.data.rows) ? hq.data.rows.find((r) => String(r.userId) === String(userId)) : null;
  const hours = hoursRow ? Number(hoursRow.hours) || 0 : hq.data ? 0 : null;

  const progs = useMemo(() => (d && Array.isArray(d.programs) ? d.programs.filter((p) => p.assigned) : []).map((p) => {
    const st = p.done ? 'done' : p.overdue ? 'overdue' : (p.progress || 0) > 0 || (p.attempts || []).length ? 'inprog' : 'notstarted';
    const best = p.bestPercent != null ? p.bestPercent
      : (p.attempts || []).reduce((m, a) => (a.percent != null && (m == null || a.percent > m) ? a.percent : m), null);
    return { ...p, st, best };
  }).sort((a, b) => ({ overdue: 0, inprog: 1, notstarted: 2, done: 3 }[a.st] - { overdue: 0, inprog: 1, notstarted: 2, done: 3 }[b.st])), [d]);

  const columns = useMemo(() => cardify([
    { title: s.colCourse, dataIndex: 'title', width: 240, render: (_, r) => loc(r, 'title') },
    { title: s.colCat, dataIndex: 'category', width: 120, render: (v) => categoryLabel(v || null, lang) },
    { title: s.colEnroll, dataIndex: 'enrollType', width: 100, render: (v) => (v === 'elective' ? s.enrollEle : s.enrollReq) },
    { title: s.colMode, dataIndex: 'mode', width: 100, render: (v) => (v === 'offline' ? s.modeOff : v === 'mixed' ? s.modeMixed : v ? s.modeOn : s.dash) },
    { title: s.colStatus, dataIndex: 'st', width: 100, render: (v) => <span className={'pill ' + ST_PILL[v]}>{s[ST_LABEL[v]]}</span> },
    { title: s.colProgress, dataIndex: 'progress', width: 80, align: 'right', render: (v) => <span className="tnum">{`${v || 0}%`}</span> },
    { title: s.colDue, dataIndex: 'dueAt', width: 110, render: (v) => <span className="tnum">{v ? fmtDay(v) : s.dash}</span> },
    { title: s.colDoneAt, dataIndex: 'doneAt', width: 110, render: (v) => <span className="tnum">{v ? fmtDay(v) : s.dash}</span> },
    { title: s.colBest, dataIndex: 'best', width: 90, align: 'right', render: (v) => <span className="tnum">{v == null ? s.dash : `${v}%`}</span> },
  ]), [lang]); // eslint-disable-line react-hooks/exhaustive-deps

  const backBtn = <Button theme="borderless" icon={<IconArrowLeft />} onClick={onBack}>{fromList ? s.backList : s.back}</Button>;
  if (!d) {
    return (
      <div className="wrap ovx-page ovx-personpage">
        <div className="co-page-bar ovx-pagebar">{backBtn}</div>
        <div className="card ovx-panel">
          {!q.error ? <div className="ovx-loading"><Spin /></div>
            : q.error.status === 404 ? <Empty description={s.pNotFound} />
              : <Banner type="danger" closeIcon={null} description={`${s.loadErr}${q.error.message ? ' · ' + q.error.message : ''}`} />}
        </div>
      </div>
    );
  }
  const nDone = progs.filter((p) => p.st === 'done').length;
  const nOver = progs.filter((p) => p.st === 'overdue').length;
  const per = periodText(filters, lang);
  return (
    <div className="wrap ovx-page ovx-personpage">
      <div className="co-page-bar ovx-pagebar">
        {backBtn}
        <div className="co-page-titles">
          <h1 className="co-page-title ovx-wrap-title">{du.name}</h1>
          <div className="co-page-sub">
            {[du.employeeId, du.department, du.position].filter(Boolean).join(' · ')}
            {du.active === false && <span className="pill muted ovx-inline-pill">{s.pInactive}</span>}
          </div>
        </div>
        {canSeeAdminPath(user, '/admin/employees') && (
          <Button onClick={() => nav('/admin/people/' + encodeURIComponent(du.id))}>{s.pOpenProfile}</Button>
        )}
      </div>
      <div className="ovx-sumchips">
        <span className="ovx-sumchip">{s.sumAssigned(progs.length)}</span>
        <span className="ovx-sumchip ok">{s.sumDone(nDone)}</span>
        <span className={'ovx-sumchip' + (nOver ? ' bad' : '')}>{s.sumOverdue(nOver)}</span>
        <span className="ovx-sumchip">{hours === null ? `${per} ${s.dash}` : s.sumHours(hours, per)}</span>
      </div>
      <section className="ovx-sec">
        <div className="ovx-sec-h"><h2>{s.pRecord}</h2></div>
        <div className="card ovx-tablecard">
          <Table columns={columns} dataSource={progs} rowKey="id" size="middle" pagination={false}
            scroll={{ x: columns.reduce((n, c) => n + (c.width || 0), 0) }}
            empty={<Empty description={s.pNoProg} />} />
        </div>
      </section>
    </div>
  );
}
