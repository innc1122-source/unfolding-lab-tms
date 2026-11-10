// 培训概览筛选条（第三批 4.1）：桌面一行筛选；≤640px 只留「时间」与「筛选 · n」，其余放进弹窗（短操作用弹窗，不用抽屉）。
// 所有筛选写进地址栏（Overview.jsx 的 patchUrl，replace），刷新、分享链接、返回都能还原。
// 部门用全站统一的 DeptFilter；放进 Semi Modal 时用 dpfModalProps()（motion:false + 内容层 overflow:visible）。
// 自定义时间用两个单日 DatePicker（从 / 至），不用双月面板的 dateRange（390px 放不下，UX 审查 12）。
import { useMemo, useState } from 'react';
import { Select, DatePicker, Button, Modal } from '@douyinfe/semi-ui';
import { IconFilter, IconClose } from '@douyinfe/semi-icons';
import DeptFilter, { dpfModalProps } from '../../../components/DeptFilter.jsx';
import { CategorySelect, EnrollSelect, ModeSelect, SourceSelect } from '../../../components/TrainingFilters.jsx';
import { activeFilterCount, joinIds } from './ovquery.js';
import { useMedia, PHONE_Q } from './useMedia.js';

const isoToday = () => { const d = new Date(); const p2 = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`; };

export default function OverviewFilters({
  s, lang, loc, filters, patch, win, catInUse, programsMeta, tps,
  deptOpts, dept, setDept, tree, onDeptInvalid, resetFilters,
}) {
  const phone = useMedia(PHONE_Q);
  const [open, setOpen] = useState(false);
  const n = activeFilterCount(filters);

  const periodOpts = [
    { value: 'quarter', label: s.pQuarter }, { value: 'month', label: s.pMonth }, { value: 'year', label: s.pYear },
    { value: 'all', label: s.pAll }, { value: 'custom', label: s.pCustom },
  ];
  const setPeriod = (v) => {
    if (v === 'custom') {
      // 切到自定义时先填上当前统计区间（没有就填今天），否则缺日期会被当成本季度
      const t = isoToday();
      patch({ period: 'custom', from: filters.from || (win && win.from) || t, to: filters.to || (win && win.to && win.to < t ? win.to : t) });
    } else patch({ period: v === 'quarter' ? null : v, from: null, to: null });
  };
  const setDay = (k) => (_date, str) => { if (str) patch({ period: 'custom', [k]: String(str).slice(0, 10) }); };

  const tpGroups = useMemo(() => {
    const g = { running: [], planning: [], closed: [] };
    for (const t of Array.isArray(tps) ? tps : []) if (g[t.status]) g[t.status].push(t);
    return g;
  }, [tps]);

  const periodCtl = (
    <div className="ovx-f ovx-f-period">
      <span className="ovx-f-lab">{s.fPeriod}</span>
      <div className="ovx-f-row">
        <Select value={filters.period} optionList={periodOpts} onChange={setPeriod} aria-label={s.fPeriod} className="ovx-sel-period" />
        {filters.period === 'custom' && (
          <>
            <DatePicker type="date" format="yyyy-MM-dd" value={filters.from || undefined} onChange={setDay('from')} aria-label={s.fFrom} placeholder={s.fFrom} className="ovx-date" />
            <DatePicker type="date" format="yyyy-MM-dd" value={filters.to || undefined} onChange={setDay('to')} aria-label={s.fTo} placeholder={s.fTo} className="ovx-date" />
          </>
        )}
      </div>
    </div>
  );

  const rest = (
    <>
      <div className="ovx-f">
        <span className="ovx-f-lab">{s.fDept}</span>
        <DeptFilter options={deptOpts} value={dept} onChange={setDept} lang={lang} label={s.fDept} placeholder={s.fDeptAll}
          ready={!!tree} disabled={tree === null} showNone={!!(tree && tree.hasNone)} onInvalid={onDeptInvalid} />
      </div>
      <div className="ovx-f">
        <span className="ovx-f-lab" id="ovx-lab-cat">{s.cCat}</span>
        <CategorySelect value={filters.cat} onChange={(v) => patch({ cat: joinIds(v || []) })} inUse={catInUse} className="ovx-sel" />
      </div>
      <div className="ovx-f">
        <span className="ovx-f-lab">{s.colEnroll}</span>
        <EnrollSelect value={filters.enroll} onChange={(v) => patch({ enroll: v || null })} />
      </div>
      <div className="ovx-f">
        <span className="ovx-f-lab">{s.colMode}</span>
        <ModeSelect value={filters.mode} onChange={(v) => patch({ mode: v || null })} />
      </div>
      <div className="ovx-f">
        <span className="ovx-f-lab">{s.fTp}</span>
        <Select value={filters.tp || ''} onChange={(v) => patch({ tp: v || null })} filter aria-label={s.fTp} className="ovx-sel ovx-sel-tp">
          <Select.Option value="">{s.tpAll}</Select.Option>
          {[['running', s.tpRunning], ['planning', s.tpPlanning], ['closed', s.tpClosed]].map(([k, label]) => (tpGroups[k].length ? (
            <Select.OptGroup key={k} label={label}>
              {tpGroups[k].map((t) => <Select.Option key={t.id} value={t.id}>{loc(t, 'title')}</Select.Option>)}
            </Select.OptGroup>
          ) : null))}
        </Select>
      </div>
      {/* 第四批 7：来源（指派 / 自主学习），地址栏 src */}
      <div className="ovx-f">
        <span className="ovx-f-lab">{s.fSrc}</span>
        <SourceSelect value={filters.src === 'all' ? '' : filters.src} onChange={(v) => patch({ src: v || null })} className="ovx-sel" />
      </div>
      <div className="ovx-f">
        <span className="ovx-f-lab">{s.fCohort}</span>
        <Select value={filters.cohort} onChange={(v) => patch({ cohort: v === 'all' ? null : v })} aria-label={s.fCohort} className="ovx-sel"
          optionList={[{ value: 'all', label: s.coAll }, { value: 'probation', label: s.coProb }, { value: 'new30', label: s.coNew }]} />
      </div>
    </>
  );

  // 统计区间说明 + 已选课程的筛选块（搜索选中课程时出现）
  const progTitle = (id) => { const p = (programsMeta || []).find((x) => x.id === id); return p ? loc(p, 'title') : id; };
  const rangeLine = !win ? null : filters.period === 'all' || !win.from
    ? s.rangeAll
    : win.prevFrom
      ? s.range(win.from, win.to, !!(win.asOf && win.to > win.asOf), win.prevFrom, win.prevTo)
      : s.rangeNoPrev(win.from, win.to, !!(win.asOf && win.to > win.asOf));

  return (
    <div className="ovx-filters">
      {phone ? (
        <div className="ovx-fbar ovx-fbar-phone">
          {periodCtl}
          <Button icon={<IconFilter />} onClick={() => setOpen(true)} className="ovx-fbtn" aria-haspopup="dialog">{s.filtersBtn(n)}</Button>
        </div>
      ) : (
        <div className="ovx-fbar">
          {periodCtl}
          {rest}
          {n > 0 && <Button theme="borderless" onClick={resetFilters} className="ovx-clear">{s.clear}</Button>}
        </div>
      )}
      <div className="ovx-range">
        {rangeLine && <span className="ovx-range-t">{rangeLine}</span>}
        {filters.programs.length > 0 && (
          <span className="ovx-chip">
            {filters.programs.length === 1 ? s.chipCourse(progTitle(filters.programs[0])) : s.chipCourses(filters.programs.length)}
            <button type="button" className="ovx-chip-x" aria-label={s.chipRemove} onClick={() => patch({ programs: null })}><IconClose size="small" /></button>
          </span>
        )}
        {phone && n > 0 && <Button size="small" theme="borderless" onClick={resetFilters}>{s.clear}</Button>}
      </div>
      {phone && (
        <Modal {...dpfModalProps()} className="u-modal-visible" title={s.filtersTitle} visible={open} onCancel={() => setOpen(false)}
          footer={<div className="ovx-modal-foot"><Button theme="borderless" onClick={resetFilters} disabled={!n}>{s.clear}</Button><Button theme="solid" onClick={() => setOpen(false)}>{s.done}</Button></div>}>
          <div className="ovx-fmodal">{rest}</div>
        </Modal>
      )}
    </div>
  );
}
