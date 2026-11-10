// 批量操作公共件（2026-10-06 SPEC-bulk-ops，B1–B4；2026-10-07 第二批 B5–B7）：勾选、批量操作栏、执行前确认、逐条结果报告。
// 申请审批、期次与成员、签到 / 完成登记名单、题库、课程库、评估周期、考试成绩共用；各页只管自己的按钮、请求与名称。
//
// 规则（需求「统一规则」1–7）：
//   1. 表头全选只选当前页（不用 Semi 默认的跨页全选）；手机宽度下表头隐藏，批量栏给「全选本页」按钮。
//   2. 执行前确认：「将对 N 项执行 <操作>」，列出前 5 项（按屏幕上的顺序），其余写「等 N 项」。
//   3. 结果逐条报告：全部成功 Toast「已完成 N 项」；有跳过 / 失败时弹窗逐条列出原因，成功的照常生效。
//      原本就是目标设置的项（unchanged）算成功，不进失败列表。
//   4. 整批拒绝（越界、超上限、整批回滚）只提示一句，勾选与数据都不动。
// rowSelection 只含 selectedRowKeys / onSelect / onSelectAll / getCheckboxProps / renderCell，不带 onChange ——
// Semi 全选后还会再发一次 onChange（带全部筛选行的 key），有了它「只选当前页」会被覆盖。
// renderCell 只改表头全选框：勾选 / 半选按当前页算，点它选满或取消本页（Semi 默认按跨页全部行算）。
import { useMedia } from '../useMedia.js';
import { cloneElement, isValidElement, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button, Modal, Toast } from '@douyinfe/semi-ui';
import { useI18n } from '../i18n.jsx';
import { errText } from '../apierr.js';
// 评估提醒的跳过原因文案统一在 reviewcodes.js（与员工端 DeptCalibration 共用）；这里的键仍逐个列出，
// test/bulk-ops.test.js 按字面量核对每个服务端码都有文案。
import { reviewWhy } from '../reviewcodes.js';

const T = {
  zh: {
    barLabel: '批量操作',
    selN: (n) => `已选 ${n} 项`,
    pageOnly: '全选仅限当前页',
    clear: '取消选择',
    selectPage: '全选本页',
    clearPage: '取消本页选择',
    confirmLead: (n, op) => `将对 ${n} 项执行「${op}」：`,
    andMore: (n) => `…等 ${n} 项`,
    cancel: '取消',
    done: (n) => `已完成 ${n} 项`,
    doneSome: (n, k) => `已完成 ${n} 项（其中 ${k} 项原本就是目标设置，未改动）`,
    partTitle: (op) => `「${op}」部分未完成`,
    partSummary: (ok, skip) => `成功 ${ok} 项（已生效），跳过或失败 ${skip} 项：`,
    partUnchanged: (k) => `成功的项中有 ${k} 项原本就是目标设置，未改动。`,
    warnTitle: (op) => `「${op}」已完成，请留意以下考试`,
    warnLead: '以下随机抽题考试的题目池已少于设定的抽题数：学员开考时抽到的题会不足，再次保存发布也会被拦下。请补充题目或调整抽题数。',
    // kind：objective / open / case（第四批：情境案例按「组」计）
    warnPool: (title, kind, pool, need) => (kind === 'case'
      ? `《${title}》：情境案例题组池 ${pool} 组，需抽 ${need} 组`
      : `《${title}》：${kind === 'open' ? '简答题' : '客观题'}题目池 ${pool} 题，需抽 ${need} 题`),
    close: '关闭',
    errScope: (n) => `所选项中有 ${n} 项不在你的数据范围内，整批未执行，数据未改动。`,
    errCap: (sel, cap) => `本次选中 ${sel} 项，超过单次上限 ${cap} 项，请分批操作。`,
    errBatch: (line) => `${line ? `第 ${line} 项` : '本批'}处理出错，整批已回滚，数据未改动。请重试；如仍失败请联系超级管理员。`,
    errNoItems: '未选择任何项。',
    errNote: '请填写驳回理由。',
    errNet: '网络异常，未收到服务器的处理结果。请刷新列表核对后再操作。',
    errGeneric: '操作失败，数据未改动，请稍后重试。',
    why: {
      not_found: '已不存在',
      already_decided: '已处理，跳过',
      admin_not_learner: '后台管理员账号，不能作为学员入班',   // CX-116
      project_or_user_gone: '发展项目或员工已不存在',
      no_cohort: '发展项目还没有期次',
      over_capacity: (d) => `期次「${d.cohort}」已满（${d.current}/${d.capacity}）`,
      not_member: '不是本发展项目的学员',
      withdrawn: '已退训，跳过',
      no_change: '已是目标设置，未修改',
      not_in_roster: '不在本活动名单中',
      self_checkin: '本人签到不可撤销',
      already_marked: (d) => `已有登记${({ attended: '（出席）', late: '（迟到）', excused: '（请假）', absent: '（缺席）', completed: '（已完成）' })[d && d.status] || ''}，如需更改请先撤销`,
      nothing_to_clear: '没有可撤销的登记',
      in_fixed_exam: (d) => `被固定题目考试${((d && d.exams) || []).map((e) => `《${e.title_zh || e.title || e.id}》`).join('')}使用，新课程不在该考试的关联课程中`,
      // 第二批（2026-10-07）：B5 课程库、B6 评估提醒、B7 考试成绩。键与服务端 BULK_REASONS 一一对应。
      // 评估相关的码（cycle_closed 起至 participant_departed）文案取自 reviewcodes.js；hod_not_ready 只用于旧记录（2026-10-08 起不再产生）。
      empty_course: '线上课程还没有内容（0 个模块、无考试），未发布',
      cycle_closed: () => reviewWhy('cycle_closed', 'zh'),
      stage_not_applicable: () => reviewWhy('stage_not_applicable', 'zh'),
      not_pending: '这一步已完成',
      none_pending: '这一步没有待完成的人',
      self_pending: () => reviewWhy('self_pending', 'zh'),
      manager_pending: () => reviewWhy('manager_pending', 'zh'),
      no_manager: () => reviewWhy('no_manager', 'zh'),
      no_hod: () => reviewWhy('no_hod', 'zh'),
      hod_not_ready: () => reviewWhy('hod_not_ready', 'zh'),
      hod_scope_partial: () => reviewWhy('hod_scope_partial', 'zh'),
      hod_is_manager: () => reviewWhy('hod_is_manager', 'zh'),
      dept_locked: () => reviewWhy('dept_locked', 'zh'),
      cooldown: () => reviewWhy('cooldown', 'zh'),
      recipient_inactive: () => reviewWhy('recipient_inactive', 'zh'),
      participant_departed: () => reviewWhy('participant_departed', 'zh'),
      no_exam: '不是考试答卷',
      result_pending: '有答卷仍在评分或待复核',
      already_passed: '已通过该考试，跳过',
      // 第四批：情境案例题组的分值是各小题之和，不能整题批量改分值
      case_points: '情境案例题组的分值按小题合计，请在题目中逐个修改小题分值',
    },
  },
  en: {
    barLabel: 'Bulk actions',
    selN: (n) => `${n} selected`,
    pageOnly: 'Select-all covers this page only',
    clear: 'Clear selection',
    selectPage: 'Select this page',
    clearPage: 'Deselect this page',
    confirmLead: (n, op) => `“${op}” will be applied to ${n} item${n === 1 ? '' : 's'}:`,
    andMore: (n) => `… ${n} in total`,
    cancel: 'Cancel',
    done: (n) => `Done: ${n} item${n === 1 ? '' : 's'}`,
    doneSome: (n, k) => `Done: ${n} (${k} already as requested — unchanged)`,
    partTitle: (op) => `“${op}” finished with exceptions`,
    partSummary: (ok, skip) => `${ok} succeeded (applied), ${skip} skipped or failed:`,
    partUnchanged: (k) => `${k} of the succeeded items were already as requested and were left unchanged.`,
    warnTitle: (op) => `“${op}” done — check these exams`,
    warnLead: 'These random-draw exams now have fewer questions in their pool than they draw: learners will get a shorter paper, and the exam cannot be published again until you add questions or lower the draw count.',
    warnPool: (title, kind, pool, need) => (kind === 'case'
      ? `“${title}”: scenario-case pool has ${pool} group${pool === 1 ? '' : 's'}, draws ${need}`
      : `“${title}”: ${kind === 'open' ? 'short-answer' : 'objective'} pool has ${pool}, draws ${need}`),
    close: 'Close',
    errScope: (n) => `${n} of the selected items are outside your data scope — nothing was changed.`,
    errCap: (sel, cap) => `${sel} selected; one bulk action is capped at ${cap}. Work in smaller batches.`,
    errBatch: (line) => `${line ? `Item #${line}` : 'The batch'} failed — the whole batch was rolled back and nothing was changed. Try again; if it keeps failing, ask a super-admin.`,
    errNoItems: 'Nothing selected.',
    errNote: 'Enter a reason to reject.',
    errNet: 'Network problem — no reply from the server. Refresh the list to check before trying again.',
    errGeneric: 'The action failed and nothing was changed. Try again later.',
    why: {
      not_found: 'No longer exists',
      already_decided: 'Already decided — skipped',
      admin_not_learner: 'Back-office admin account — can’t be enrolled as a learner',   // CX-116
      project_or_user_gone: 'The program or the employee no longer exists',
      no_cohort: 'The program has no cohort yet',
      over_capacity: (d) => `Cohort “${d.cohort}” is full (${d.current}/${d.capacity})`,
      not_member: 'Not a learner in this program',
      withdrawn: 'Already withdrawn — skipped',
      no_change: 'Already set — nothing changed',
      not_in_roster: 'Not on this roster',
      self_checkin: 'Self check-in can’t be undone',
      already_marked: (d) => `Already recorded${({ attended: ' (present)', late: ' (late)', excused: ' (excused)', absent: ' (absent)', completed: ' (completed)' })[d && d.status] || ''} — undo it first`,
      nothing_to_clear: 'Nothing to undo',
      in_fixed_exam: (d) => `Used by the fixed-question exam${((d && d.exams) || []).length === 1 ? '' : 's'} ${((d && d.exams) || []).map((e) => `“${e.title || e.title_zh || e.id}”`).join(', ')}, which does not link the new course`,
      empty_course: 'Online course with no modules and no exam — not published',
      cycle_closed: () => reviewWhy('cycle_closed', 'en'),
      stage_not_applicable: () => reviewWhy('stage_not_applicable', 'en'),
      not_pending: 'Already done at this step',
      none_pending: 'Nobody pending at this step',
      self_pending: () => reviewWhy('self_pending', 'en'),
      manager_pending: () => reviewWhy('manager_pending', 'en'),
      no_manager: () => reviewWhy('no_manager', 'en'),
      no_hod: () => reviewWhy('no_hod', 'en'),
      hod_not_ready: () => reviewWhy('hod_not_ready', 'en'),
      hod_scope_partial: () => reviewWhy('hod_scope_partial', 'en'),
      hod_is_manager: () => reviewWhy('hod_is_manager', 'en'),
      dept_locked: () => reviewWhy('dept_locked', 'en'),
      cooldown: () => reviewWhy('cooldown', 'en'),
      recipient_inactive: () => reviewWhy('recipient_inactive', 'en'),
      participant_departed: () => reviewWhy('participant_departed', 'en'),
      no_exam: 'Not an exam attempt',
      result_pending: 'An attempt is awaiting scoring or review',
      already_passed: 'Already passed — skipped',
      case_points: 'A scenario case scores the sum of its sub-questions — edit the sub-question points in the question',
    },
  },
};
const dictOf = (lang) => T[lang === 'zh' ? 'zh' : 'en'];

// 每张带勾选列的表：resizableTable(columns, { extra: canWrite ? BULK_SEL_EXTRA : 0 })
export const BULK_SEL_EXTRA = 60;

const EMPTY = [];
const ROW_SEL = 'tbody tr[data-row-key]';
const domRowKeys = (el) => [...new Set([...el.querySelectorAll(ROW_SEL)].map((tr) => tr.getAttribute('data-row-key')))];

// 与 Dashboard / OrgChart 的 useNarrow 同一断点：≤900px 时后台表格变卡片、表头（含全选框）隐藏
const NARROW_Q = '(max-width:900px)';
const useNarrow = () => useMedia(NARROW_Q);

/* ---------------- 勾选 ----------------
 * rows：表格的全部数据（页面自身筛选之后、跨所有页），引用须稳定（useMemo / q.data / 模块级常量）。
 * isSelectable(row)：可选（B2 只有在训学员可选）；传模块级或 useCallback 的函数。
 * resetOn：依赖数组，任一项变化即清空勾选（搜索词、筛选条件）。
 * pageKeys：可选，读不到 DOM 时表头全选的兜底。
 * ready：数据是否已到（页面传 !!q.data）。重载失败时 useAsync 把 data 置 null，此时不按空列表修剪勾选。
 * 返回 { keys, rows, count, clear, togglePage, wrapRef, rowSelection }：
 *   keys / rows 按屏幕上的顺序（当前页在前、按 DOM 行序；其余按数据顺序），每次读取时现算；
 *   wrapRef 放在包住 <Table> 的 <div> 上，全选本页与排序都读它里面的 tbody 行。
 */
export function useBulkSelection({ rows, rowKey = 'id', isSelectable, resetOn = EMPTY, pageKeys, ready = true } = {}) {
  const { lang } = useI18n();
  const list = rows || EMPTY;
  const [keys, setKeys] = useState(EMPTY);
  const wrapRef = useRef(null);

  // key（字符串）→ { row, i }；DOM 上的 data-row-key 是字符串，统一按字符串比
  const index = useMemo(() => {
    const m = new Map();
    list.forEach((r, i) => {
      if (r && r[rowKey] != null) { const k = String(r[rowKey]); if (!m.has(k)) m.set(k, { row: r, i }); }
    });
    return m;
  }, [list, rowKey]);
  const live = useRef(null);
  live.current = { index, isSelectable, pageKeys, list, rowKey };

  // 换搜索词 / 筛选条件 → 清空（逐项浅比较；数组本身每次渲染都是新的）
  const resetRef = useRef(resetOn);
  useEffect(() => {
    const prev = resetRef.current;
    resetRef.current = resetOn;
    if (prev === resetOn) return;
    if (prev.length !== resetOn.length || prev.some((v, i) => !Object.is(v, resetOn[i]))) setKeys(EMPTY);
  });

  // 行消失（重载后已处理、已删除）或变得不可选 → 从勾选里去掉；数据没到时不修剪
  useEffect(() => {
    if (!ready) return;
    setKeys((prev) => {
      if (!prev.length) return prev;
      const next = prev.filter((k) => { const e = index.get(k); return !!e && (!isSelectable || isSelectable(e.row)); });
      return next.length === prev.length ? prev : next;
    });
  }, [index, ready, isSelectable]);

  // 当前页渲染出来的行（卡片模式下也是 tr[data-row-key]）。表格已挂载时只认渲染出来的行：
  // 一行都没有（Semi 列筛选把本页筛空）就是本页为空，不能退回全部数据（否则会选中屏幕上看不到的项）。
  const visibleKeys = useCallback(() => {
    const { pageKeys: pk, list: all, rowKey: rk } = live.current;
    const el = wrapRef.current;
    if (el) return domRowKeys(el);
    return (pk || all.map((r) => r[rk])).map(String);
  }, []);

  // 当前页可见行的 key：表头全选框的勾选 / 半选状态按本页算（Semi 默认按跨页的全部筛选行算，
  // 选满一页在多页列表里会显示成半选，再点一下反而取消）。Semi 翻页、列筛选、排序都在表格内部，
  // 宿主组件不重渲染，所以用 MutationObserver 盯 wrapRef 里的行变化；wrapRef 换了节点（表格后挂载）时重挂。
  const [pageVis, setPageVis] = useState(EMPTY);
  const obsRef = useRef({ el: null, mo: null });
  useEffect(() => {
    const o = obsRef.current;
    const el = wrapRef.current;
    const sync = () => {
      const ks = o.el ? domRowKeys(o.el) : EMPTY;
      setPageVis((prev) => (prev.length === ks.length && prev.every((k, i) => k === ks[i]) ? prev : ks));
    };
    if (o.el !== el) {
      if (o.mo) o.mo.disconnect();
      o.el = el;
      o.mo = null;
      if (el && typeof MutationObserver !== 'undefined') {
        o.mo = new MutationObserver(sync);
        o.mo.observe(el, { childList: true, subtree: true });
      }
    }
    sync();
  });
  useEffect(() => () => {
    const o = obsRef.current;
    if (o.mo) o.mo.disconnect();
    o.mo = null;
    o.el = null;
  }, []);

  // 本页可选行全部选上（want = true）/ 全部取消（false）/ 切换（不传：都已选 → 取消，否则补上没选的）。其它页已选的不动。
  const setPage = useCallback((want) => {
    const { index: idx, isSelectable: can } = live.current;
    const page = visibleKeys().filter((k) => { const e = idx.get(k); return !!e && (!can || can(e.row)); });
    if (!page.length) return;
    setKeys((prev) => {
      const have = new Set(prev);
      const on = typeof want === 'boolean' ? want : !page.every((k) => have.has(k));
      if (!on) {
        const drop = new Set(page);
        const next = prev.filter((k) => !drop.has(k));
        return next.length === prev.length ? prev : next;
      }
      const add = page.filter((k) => !have.has(k));
      return add.length ? [...prev, ...add] : prev;
    });
  }, [visibleKeys]);
  const togglePage = useCallback(() => setPage(), [setPage]);

  const onSelect = useCallback((record, selected) => {
    if (!record) return;
    const k = String(record[live.current.rowKey]);
    setKeys((prev) => {
      const has = prev.includes(k);
      if (selected) return has ? prev : [...prev, k];
      return has ? prev.filter((x) => x !== k) : prev;
    });
  }, []);
  const onSelectAll = useCallback((selected) => { setPage(!!selected); }, [setPage]);
  const clear = useCallback(() => setKeys(EMPTY), []);

  // 表头全选框：勾选 / 半选按本页可选行算；点它 = 选满本页或取消本页（半选时点 = 选满）
  const pageSel = useMemo(
    () => pageVis.filter((k) => { const e = index.get(k); return !!e && (!isSelectable || isSelectable(e.row)); }),
    [pageVis, index, isSelectable],
  );
  const pageOn = useMemo(() => { const have = new Set(keys); return pageSel.filter((k) => have.has(k)).length; }, [keys, pageSel]);
  const pageAll = pageSel.length > 0 && pageOn === pageSel.length;
  const pageSome = pageOn > 0 && !pageAll;
  const renderCell = useCallback(({ inHeader, originNode }) => {
    if (!inHeader || !isValidElement(originNode)) return originNode;
    const s = dictOf(lang);
    return cloneElement(originNode, {
      selected: pageAll,
      indeterminate: pageSome,
      disabled: !pageSel.length,
      'aria-label': pageAll ? s.clearPage : s.selectPage,
      onChange: (checked) => setPage(!!checked),
    });
  }, [pageAll, pageSome, pageSel.length, setPage, lang]);

  const getCheckboxProps = useMemo(
    () => (isSelectable ? (r) => ({ disabled: !isSelectable(r) }) : undefined),
    [isSelectable],
  );
  // 交给 Semi 的 key 用行里的原值（数字 id 也能对上）
  const selectedRowKeys = useMemo(
    () => keys.map((k) => { const e = index.get(k); return e ? e.row[rowKey] : k; }),
    [keys, index, rowKey],
  );
  const rowSelection = useMemo(() => ({
    selectedRowKeys, onSelect, onSelectAll, renderCell, ...(getCheckboxProps ? { getCheckboxProps } : {}),
  }), [selectedRowKeys, onSelect, onSelectAll, renderCell, getCheckboxProps]);

  const orderRef = useRef({ index: null, out: EMPTY, rows: EMPTY });
  return useMemo(() => {
    // 屏幕顺序：当前页按 DOM 行序在前（排序后的样子），其余按数据顺序；结果不变时返回同一个数组
    const ordered = () => {
      const el = wrapRef.current;
      const dom = new Map();
      if (el) el.querySelectorAll(ROW_SEL).forEach((tr) => { const k = tr.getAttribute('data-row-key'); if (!dom.has(k)) dom.set(k, dom.size); });
      const rank = (k) => (dom.has(k) ? dom.get(k) : dom.size + (index.has(k) ? index.get(k).i : list.length));
      const out = keys.map((k, n) => [k, rank(k), n]).sort((a, b) => a[1] - b[1] || a[2] - b[2]).map((x) => x[0]);
      const c = orderRef.current;
      if (c.index === index && c.out.length === out.length && c.out.every((k, i) => k === out[i])) return c;
      const next = { index, out, rows: out.map((k) => index.get(k)).filter(Boolean).map((e) => e.row) };
      orderRef.current = next;
      return next;
    };
    return {
      get keys() { return ordered().out; },
      get rows() { return ordered().rows; },
      count: keys.length,
      clear,
      togglePage,
      wrapRef,
      rowSelection,
    };
  }, [keys, index, list, clear, togglePage, rowSelection]);
}

/* ---------------- 批量操作栏 ----------------
 * count === 0 时不渲染；传了 selectPage 且屏幕 ≤900px（表头全选框被隐藏）时，0 项也显示「全选本页」。
 * children：size="small" 的操作按钮。
 */
export function BulkBar({ count, onClear, busy = false, pageOnly = true, selectPage, children }) {
  const { lang } = useI18n();
  const s = dictOf(lang);
  const narrow = useNarrow();
  const showPick = typeof selectPage === 'function' && narrow;
  if (!count && !showPick) return null;
  return (
    <div className={'bulk-bar' + (count ? '' : ' bulk-bar-idle')} role="toolbar" aria-label={s.barLabel}>
      {count > 0 && (
        <span className="bulk-bar-lab" aria-live="polite">
          {s.selN(count)}
          {pageOnly && <span className="bulk-bar-scope">{s.pageOnly}</span>}
        </span>
      )}
      {showPick && <Button size="small" theme="light" className="bulk-bar-pick" disabled={busy} onClick={() => selectPage()}>{s.selectPage}</Button>}
      {count > 0 && <div className="bulk-bar-acts">{children}</div>}
      {count > 0 && <Button size="small" theme="borderless" disabled={busy} onClick={onClear}>{s.clear}</Button>}
    </div>
  );
}

/* ---------------- 执行前确认 ----------------
 * names：全部选中项的名称（按屏幕顺序）；列前 5 项，其余写「等 N 项」。children 放输入项（理由、分值、期次…）。
 */
export function BulkConfirmModal({ visible, op, names, danger = false, okText, okDisabled = false, loading = false, onOk, onCancel, children }) {
  const { lang } = useI18n();
  const s = dictOf(lang);
  const list = names || EMPTY;
  return (
    <Modal
      title={op}
      visible={!!visible}
      width={520}
      maskClosable={false}
      closable={!loading}
      okText={okText || op}
      cancelText={s.cancel}
      okButtonProps={{ ...(danger ? { type: 'danger' } : {}), disabled: !!okDisabled }}
      cancelButtonProps={{ disabled: !!loading }}
      confirmLoading={!!loading}
      onOk={onOk}
      onCancel={() => { if (!loading && onCancel) onCancel(); }}
    >
      <div className="bulk-confirm">
        <div className="bulk-confirm-lead">{s.confirmLead(list.length, op)}</div>
        <ul className="bulk-names">
          {list.slice(0, 5).map((n, i) => <li key={i}>{n}</li>)}
        </ul>
        {list.length > 5 && <div className="bulk-more">{s.andMore(list.length)}</div>}
        {children ? <div className="bulk-confirm-body">{children}</div> : null}
      </div>
    </Modal>
  );
}

/* ---------------- 逐条原因与整批错误 ---------------- */
export function bulkReason(item, lang) {
  const s = dictOf(lang);
  const w = item && item.code ? s.why[item.code] : null;
  if (typeof w === 'function') return w(item);
  if (w) return w;
  return (item && ((lang === 'zh' && item.error_zh) || item.error || item.code)) || '';
}

export function bulkErrorText(err, lang) {
  const s = dictOf(lang);
  const data = err && err.data && typeof err.data === 'object' ? err.data : null;
  if (!err || typeof err.status !== 'number') return s.errNet;   // fetch 本身失败：服务端可能已处理
  const map = {
    out_of_scope: (d) => s.errScope(d.outOfScope || 0),
    over_cap: (d) => s.errCap(d.selected, d.cap),
    batch_failed: (d) => s.errBatch(d.line),
    no_items: () => s.errNoItems,
    note_required: () => s.errNote,
  };
  if (data && data.code && map[data.code]) return errText(err, map);
  if (lang === 'zh' && data && data.error_zh) return data.error_zh;
  return err.message || s.errGeneric;
}

/* ---------------- 执行与结果 ----------------
 * run({ op, names, request, onSettled, followUp, doneText }) → Promise<'ok'|'partial'|'error'>
 *   names：{ [id]: 名称 }，提交时的快照（结果弹窗用，勾选清空后仍能显示名称）。
 *   onSettled(resp)：只在 HTTP 200 后调用（页面清空勾选、重载列表）。
 *   followUp(resp) → null | { label, request }：结果弹窗里的追加按钮（B1 培养项目申请超容量 → force:true 再提交）。
 *   doneText(resp) → string | null（第二批）：页面自己的结果说明（B5 补同步的学员数、B6 发出的提醒条数）。
 *     全部成功时代替默认的 Toast 文案；有结果弹窗时显示在汇总行下面。返回空值 = 用默认文案。
 * 200 且无跳过、无提醒 → Toast；有跳过或有 warnings（B4 随机抽题题目池不足）→ 结果弹窗；非 200 → Toast.error，勾选与数据不动。
 * modal：页面渲染一次（B3 放在宿主弹窗里）。
 */
export function useBulkRunner() {
  const { lang } = useI18n();
  const langRef = useRef(lang);
  langRef.current = lang;
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [result, setResult] = useState(null);

  const run = useCallback(async (opts) => {
    if (!opts || typeof opts.request !== 'function' || busyRef.current) return 'error';
    busyRef.current = true;
    setBusy(true);
    try {
      let resp;
      try {
        resp = await opts.request();
      } catch (err) {
        Toast.error({ content: bulkErrorText(err, langRef.current), duration: 6 });
        return 'error';
      }
      const s = dictOf(langRef.current);
      const results = resp && Array.isArray(resp.results) ? resp.results : EMPTY;
      try { if (opts.onSettled) opts.onSettled(resp); } catch (e) { console.error('[bulk] onSettled', e); } // eslint-disable-line no-console
      const done = resp && typeof resp.done === 'number' ? resp.done : results.filter((r) => r && r.ok).length;
      const skipped = resp && typeof resp.skipped === 'number' ? resp.skipped : results.filter((r) => r && !r.ok).length;
      const unchanged = resp && typeof resp.unchanged === 'number' ? resp.unchanged : results.filter((r) => r && r.ok && r.unchanged).length;
      const warnings = resp && Array.isArray(resp.warnings) ? resp.warnings : EMPTY;
      let note = null;
      if (typeof opts.doneText === 'function') {
        try { note = opts.doneText(resp) || null; } catch (e) { console.error('[bulk] doneText', e); note = null; } // eslint-disable-line no-console
      }
      if (!skipped && !warnings.length) {
        Toast.success(note || (unchanged ? s.doneSome(done, unchanged) : s.done(done)));
        return 'ok';
      }
      let fu = null;
      if (skipped && typeof opts.followUp === 'function') {
        try { fu = opts.followUp(resp) || null; } catch (e) { console.error('[bulk] followUp', e); fu = null; } // eslint-disable-line no-console
      }
      setResult({ opts, results, done, skipped, unchanged, warnings, fu, note });
      return skipped ? 'partial' : 'ok';
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, []);

  const s = dictOf(lang);
  const close = () => setResult(null);
  const names = (result && result.opts.names) || {};
  const op = result ? result.opts.op : '';
  const failed = result ? result.results.filter((r) => r && !r.ok) : EMPTY;
  const modal = (
    <Modal
      title={result ? (result.skipped ? s.partTitle(op) : s.warnTitle(op)) : ''}
      visible={!!result}
      width={560}
      maskClosable={false}
      onCancel={close}
      footer={(
        <>
          <Button disabled={busy} onClick={close}>{s.close}</Button>
          {result && result.fu && (
            <Button type="primary" theme="solid" loading={busy}
              onClick={() => { const r = result; close(); run({ ...r.opts, request: r.fu.request }); }}>
              {result.fu.label}
            </Button>
          )}
        </>
      )}
    >
      {result && (
        <div className="bulk-result">
          <div className="bulk-result-sum">
            {result.skipped ? s.partSummary(result.done, result.skipped)
              : (result.unchanged ? s.doneSome(result.done, result.unchanged) : s.done(result.done))}
          </div>
          {result.note && <div className="bulk-result-note">{result.note}</div>}
          {failed.length > 0 && (
            <ul className="bulk-result-list">
              {failed.map((r, i) => (
                <li key={String(r.id) + ':' + i}>
                  <span className="bulk-result-name">{names[r.id] || r.id}</span>
                  <span className="bulk-result-why">{bulkReason(r, lang)}</span>
                </li>
              ))}
            </ul>
          )}
          {result.skipped > 0 && result.unchanged > 0 && <div className="bulk-result-note">{s.partUnchanged(result.unchanged)}</div>}
          {result.warnings.length > 0 && (
            <div className="bulk-warn">
              <div className="bulk-warn-lead">{s.warnLead}</div>
              <ul className="bulk-warn-list">
                {result.warnings.map((w, i) => (
                  <li key={String(w && w.examId) + ':' + i}>
                    {s.warnPool(
                      (lang === 'zh' ? (w.title_zh || w.title) : (w.title || w.title_zh)) || w.examId,
                      w.kind, w.pool, w.need,
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </Modal>
  );

  return { busy, run, modal };
}
