// 名单整页（第三批 4.2，设计 §3.2；地址栏 ?list=<metric>）：看板上每个数字都点到这里。口径 = 看板筛选 + 名单覆盖（ldept / lcat / lprog / lenroll），
// 覆盖只用于名单请求，返回看板时看板筛选不变。服务端分页（每页 50），≤900px 表格自动转卡片（cardify）。
// 点姓名 → 员工培训记录整页；点课程 → 名单内只看该课程（lprog，留在名单上，UX 审查 28），页头另给「在看板中查看此课程」；
// 答卷行 → 考试成绩页的答卷整页。提醒按钮只在逾期 / 7 天内到期、且有培训写权限时出现，人数用服务端的 remindablePeople。
import { useEffect, useMemo, useState } from 'react';
import { Table, Button, Input, Select, Spin, Empty, Banner } from '@douyinfe/semi-ui';
import { IconArrowLeft, IconSearch, IconDownload, IconBell } from '@douyinfe/semi-icons';
import { useNavigate } from 'react-router-dom';
import { api, useAsync } from '../../../api.js';
import { cardify } from '../../../cardify.js';
import { categoryLabel } from '../../../categories.js';
import { queryOf, listParamsOf, unitOf, periodText, fmtN, fmtDay, LIST_KEYS } from './ovquery.js';
import RemindModal from './RemindModal.jsx';

const SORTS = {
  cell: ['dept', 'name', 'due', 'overdueDays', 'doneAt'],
  person: ['dept', 'name', 'hours'],
  attempt: ['submitted', 'dept', 'name'],
};
const SORT_LABEL = { dept: 'sortDept', name: 'sortName', due: 'sortDue', overdueDays: 'sortOverdueDays', doneAt: 'sortDoneAt', hours: 'sortHours', submitted: 'sortSubmitted' };
const ST_PILL = { done: 'ok', overdue: 'fail', inprog: 'pri', notstarted: 'muted' };
const ST_LABEL = { done: 'stDone', overdue: 'stOverdue', inprog: 'stInprog', notstarted: 'stNotstarted' };

export default function PeopleListPage({ s, lang, loc, urlp, patchUrl, filters, canWrite, metaById, deptOpts, onPerson }) {
  const nav = useNavigate();
  const lp = useMemo(() => listParamsOf(urlp), [urlp]);
  const metric = lp.metric;
  const unit = unitOf(metric);
  const qs = queryOf(filters, lp);
  const q = useAsync(() => api.get('/api/admin/overview/people?' + qs), [qs]);
  const data = q.data || null;
  const rows = data && Array.isArray(data.rows) ? data.rows : [];
  const [remind, setRemind] = useState(null);

  // 名单内查找：输入防抖 300ms 后写进地址栏 lq（replace），并回到第 1 页
  const [needle, setNeedle] = useState(urlp.lq || '');
  useEffect(() => { setNeedle(urlp.lq || ''); }, [urlp.lq]);
  useEffect(() => {
    if ((needle || '') === (urlp.lq || '')) return undefined;
    const t = setTimeout(() => patchUrl({ lq: needle.trim() || null, lp: null }), 300);
    return () => clearTimeout(t);
  }, [needle]); // eslint-disable-line react-hooks/exhaustive-deps

  const back = () => patchUrl(Object.fromEntries(LIST_KEYS.map((k) => [k, null])), { push: true });
  const setTab = (st) => patchUrl({ lst: st || null, lp: null });
  const setMetric = (m) => patchUrl({ list: m, lp: null, lsort: null }, { push: false });
  const onlyCourse = (id) => patchUrl({ lprog: id, lp: null });
  const toOverview = () => patchUrl({
    programs: lp.lprog, cat: null, enroll: null, mode: null, tp: null,
    ...Object.fromEntries(LIST_KEYS.map((k) => [k, null])),
  }, { push: true });
  const exportCsv = () => { window.location.href = '/api/admin/overview/people?' + queryOf(filters, { ...lp, page: null, format: 'csv', lang }); };

  // 页头说明：期间 · 类别 · 部门 · 课程 · 修读类型
  const deptName = (id) => {
    if (!id) return null;
    if (id === '__none') return s.heatNone;
    // 热力表「本部门直属」行下钻用 direct:<deptId>（服务端 filterKey）
    const dm = /^direct:(.+)$/.exec(String(id));
    if (dm) return s.heatDirect(deptName(dm[1]));
    const o = (deptOpts || []).find((x) => String(x.id) === String(id));
    return o ? o.name : String(id).replace(/^name:/, '');
  };
  const courseName = (id) => {
    const m = metaById.get(id);
    if (m) return loc(m, 'title');
    const r = rows.find((x) => x.programId === id);
    return r ? loc(r, 'title') : id;
  };
  const cats = lp.lcat ? [lp.lcat] : filters.cat;
  const progs = lp.lprog ? [lp.lprog] : filters.programs;
  const enroll = lp.lenroll || filters.enroll;
  const scope = [
    periodText(filters, lang),
    cats.length ? cats.map((k) => categoryLabel(k === '__none' ? null : k, lang)).join('、') : null,
    deptName(lp.ldept || filters.dept),
    progs.length === 1 ? courseName(progs[0]) : progs.length ? s.chipCourses(progs.length) : null,
    enroll === 'mandatory' ? s.onlyReq : enroll === 'elective' ? s.onlyEle : null,
    filters.src === 'assigned' ? s.onlyAssigned : filters.src === 'self' ? s.onlySelf : null,
  ].filter(Boolean);

  const nameCell = (_, r) => (
    <button type="button" className="ovx-link ovx-name" onClick={() => onPerson(r.userId)}>{r.name}</button>
  );
  const pill = (st) => <span className={'pill ' + (ST_PILL[st] || 'muted')}>{s[ST_LABEL[st]] || st}</span>;
  const columns = useMemo(() => {
    const base = [
      { title: s.colName, dataIndex: 'name', width: 150, render: nameCell },
      { title: s.colId, dataIndex: 'employeeId', width: 110, render: (v) => <span className="tnum">{v || s.dash}</span> },
      { title: s.colDept, dataIndex: 'department', width: 180, render: (v) => v || s.dash },
    ];
    if (unit === 'person') {
      return cardify([
        ...base,
        { title: s.colMgr, dataIndex: 'managerName', width: 140, render: (v) => v || s.dash },
        { title: s.colCoursesDone, dataIndex: 'completed', width: 110, align: 'right', render: (v) => <span className="tnum">{fmtN(v || 0)}</span> },
        { title: s.cAssigned, dataIndex: 'assigned', width: 110, align: 'right', render: (v) => <span className="tnum">{fmtN(v || 0)}</span> },
        { title: s.colOverdueN, dataIndex: 'overdue', width: 100, align: 'right', render: (v) => <span className="tnum">{fmtN(v || 0)}</span> },
        { title: s.colHours, dataIndex: 'hours', width: 90, align: 'right', render: (v) => <span className="tnum">{v == null ? s.dash : Number(v).toFixed(1)}</span> },
      ]);
    }
    if (unit === 'attempt') {
      return cardify([
        ...base,
        { title: s.colCourse, dataIndex: 'title', width: 220, render: (_, r) => loc(r, 'title') },
        { title: s.colSubmitted, dataIndex: 'submittedAt', width: 130, render: (v) => <span className="tnum">{fmtDay(v)}</span> },
        { title: s.colScore, dataIndex: 'percent', width: 80, align: 'right', render: (v) => <span className="tnum">{v == null ? s.dash : `${v}%`}</span> },
        { title: s.colResult, dataIndex: 'passed', width: 110, render: (v, r) => (
          <button type="button" className="ovx-link" onClick={() => nav('/admin/results?attempt=' + encodeURIComponent(r.attemptId))}>
            <span className={'pill ' + (v ? 'ok' : 'fail')}>{v ? s.resPass : s.resFail}</span>
          </button>
        ) },
      ]);
    }
    const lastTitle = metric === 'overdue' ? s.colDaysOverdue : metric === 'done' ? s.colDoneAt : `${s.colDaysOverdue} / ${s.colDoneAt}`;
    return cardify([
      ...base,
      { title: s.colMgr, dataIndex: 'managerName', width: 130, render: (v) => v || s.dash },
      { title: s.colCourse, dataIndex: 'title', width: 220, render: (_, r) => (
        lp.lprog === r.programId ? loc(r, 'title')
          : <button type="button" className="ovx-link ovx-course" onClick={() => onlyCourse(r.programId)}>{loc(r, 'title')}</button>
      ) },
      { title: s.colCat, dataIndex: 'category', width: 120, render: (v) => categoryLabel(v || null, lang) },
      // 第四批 7：来源（指派 / 自主学习）；旧服务端不带 source → 指派
      { title: s.colSource, dataIndex: 'source', width: 100, render: (v) => (v === 'self' ? <span className="pill pri">{s.srcSelf}</span> : s.srcAssigned) },
      { title: s.colStatus, dataIndex: 'status', width: 100, render: pill },
      { title: s.colProgress, dataIndex: 'progress', width: 80, align: 'right', render: (v) => <span className="tnum">{v == null ? s.dash : `${v}%`}</span> },
      { title: s.colDue, dataIndex: 'dueAt', width: 110, render: (v) => <span className="tnum">{v ? fmtDay(v) : s.dash}</span> },
      { title: lastTitle, dataIndex: 'daysOverdue', width: 120, render: (v, r) => (
        r.status === 'done' ? <span className="tnum">{r.doneAt ? fmtDay(r.doneAt) : s.dash}</span>
          : (v || 0) > 0 ? <span className="ovx-late tnum">{s.daysN(v)}</span> : s.dash
      ) },
      { title: s.colBest, dataIndex: 'bestPercent', width: 90, align: 'right', render: (v) => <span className="tnum">{v == null ? s.dash : `${v}%`}</span> },
    ]);
  }, [lang, unit, metric, lp.lprog]); // eslint-disable-line react-hooks/exhaustive-deps

  const remindable = data && typeof data.remindablePeople === 'number' ? data.remindablePeople : 0;
  const canRemind = canWrite && (metric === 'overdue' || metric === 'dueSoon') && remindable > 0;
  const page = (data && data.page) || lp.page || 1;
  const size = (data && data.size) || 50;
  const total = (data && data.total) || 0;
  const tabs = metric === 'assigned'
    ? [['', s.tAll], ['done', s.tDone], ['notdone', s.tNotdone], ['overdue', s.tOverdue], ['notstarted', s.tNotstarted]]
    : null;
  const sortOpts = [{ value: '', label: s.sortDefault }, ...SORTS[unit].map((k) => ({ value: k, label: s[SORT_LABEL[k]] }))];

  return (
    <div className="wrap ovx-page ovx-listpage">
      <div className="co-page-bar ovx-pagebar">
        <Button theme="borderless" icon={<IconArrowLeft />} onClick={back}>{s.back}</Button>
        <div className="co-page-titles">
          <h1 className="co-page-title ovx-wrap-title">{s.lTitle[metric]}</h1>
          <div className="co-page-sub">
            {scope.join(' · ')}
            {data ? ` · ${unit === 'cell' || unit === 'attempt' ? s.count(total, data.people || 0) : s.countPeople(total)}` : ''}
          </div>
        </div>
        {lp.lprog && <Button theme="borderless" onClick={toOverview}>{s.lOpenOverview}</Button>}
      </div>

      {(metric === 'covered' || metric === 'uncovered') && (
        <div className="ovx-tabs" role="tablist">
          {[['covered', s.lTitle.covered], ['uncovered', s.lTitle.uncovered]].map(([m, t]) => (
            <button key={m} type="button" role="tab" aria-selected={metric === m} className={metric === m ? 'on' : ''} onClick={() => setMetric(m)}>{t}</button>
          ))}
        </div>
      )}
      {tabs && (
        <div className="ovx-tabs" role="tablist">
          {tabs.map(([k, t]) => (
            <button key={k || 'all'} type="button" role="tab" aria-selected={(lp.status || '') === k} className={(lp.status || '') === k ? 'on' : ''} onClick={() => setTab(k)}>{t}</button>
          ))}
        </div>
      )}

      <div className="ovx-ltool">
        <Input prefix={<IconSearch />} value={needle} onChange={setNeedle} placeholder={s.lSearch} showClear aria-label={s.lSearch} className="ovx-lsearch" />
        <Select value={lp.sort || ''} optionList={sortOpts} onChange={(v) => patchUrl({ lsort: v || null, lp: null })} aria-label={s.sortLabel} className="ovx-lsort" />
        <div className="ovx-lact">
          <Button icon={<IconDownload />} onClick={exportCsv} disabled={!total}>{s.lExport}</Button>
          {canRemind && <Button theme="solid" icon={<IconBell />} onClick={() => setRemind({ metric, overrides: {
            ...(lp.ldept ? { ldept: lp.ldept } : {}), ...(lp.lcat ? { lcat: lp.lcat } : {}),
            ...(lp.lprog ? { lprog: lp.lprog } : {}), ...(lp.lenroll ? { lenroll: lp.lenroll } : {}),
          }, count: remindable })}>{s.lRemind(remindable)}</Button>}
        </div>
      </div>

      {q.error && (
        <Banner type="danger" closeIcon={null} description={`${s.loadErr}${q.error.message ? ' · ' + q.error.message : ''}`}
          style={{ marginBottom: 12 }} />
      )}

      <div className="card ovx-tablecard ovx-ltable">
        {q.loading && !data ? <div className="ovx-loading"><Spin /></div> : (
          <Table
            columns={columns}
            dataSource={rows}
            rowKey={(r) => (unit === 'attempt' ? r.attemptId : unit === 'person' ? r.userId : r.userId + '|' + r.programId)}
            loading={q.loading}
            size="middle"
            scroll={{ x: columns.reduce((n, c) => n + (c.width || 0), 0) }}
            pagination={total > size ? {
              currentPage: page, pageSize: size, total, showSizeChanger: false,
              onPageChange: (p) => patchUrl({ lp: p > 1 ? p : null }),
            } : false}
            empty={<Empty description={s.lNone} />}
          />
        )}
      </div>

      <RemindModal s={s} filters={filters} req={remind} onClose={() => setRemind(null)} onDone={() => q.reload()} />
    </div>
  );
}
