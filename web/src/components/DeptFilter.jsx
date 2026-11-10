// 部门筛选（第二批 3.1，2026-10-08）：全站唯一的部门筛选控件，员工端（HoD 部门校准）与后台各页共用，所以不 import Semi。
//
// <DeptFilter
//   options={[{ id, name, parentId, level, path, inactive?, count? }]}  // 服务端 org.js deptOptionsOf 的形状
//   value={id | null | id[]}  onChange={(v) => {}}  multiple={false}
//   placeholder lang size="default|small" showNone={false} disabled
//   onInvalid={(id) => {}}   // value 不在 options 里时回调一次（宿主提示并删掉地址栏参数）
//   ready                    // 选项已按当前地址加载好才校验 value（缺省 = options 非空；审查 P1-8：加载中不能误删深链接参数）
// />
// 交互：触发按钮（高 32px，显示路径）→ 弹层：顶部搜索（名称、路径，不分大小写），下面按层分列，每列第一项是
// 「全部 X（含下级）」；点有下级的部门展开下一列，点叶子部门直接选中。分列按裁剪后的 parentId 深度（审查 P2：范围裁剪后
// 根可能是二级部门，不能按全树 level 分列）。level 为 null 的伪选项（部门不在部门表）放在第一列末尾。
// 键盘：↑↓ 移动、→ 展开、← 返回上一列、回车选中（有下级的部门回车 = 选中它及全部下级）、Esc 关闭、Tab 离开。
// 宽度 ≤ 640px 时改成底部抽屉、逐级下钻。选中值：部门 id、"name:<小写名>" 伪 id、"__none"（showNone 时的「无部门」）。
import { cloneElement, isValidElement, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { deptLayout, searchDepts, optionPath, ancestorIds, DEPT_NONE } from '../deptfilter.js';

const T = {
  zh: {
    all: '全部部门', search: '搜索部门', allOf: (name) => `全部 ${name}（含下级）`, incl: '含下级部门',
    none: '无部门', empty: '没有匹配的部门', inactive: '已停用', clear: '清除',
    invalid: '部门不存在或不在你的数据范围内，已清除该筛选。',
    back: '上一级', done: '完成', more: (n) => `等 ${n} 个部门`, loading: '部门加载中…', unavailable: '部门筛选暂不可用',
    label: '部门', people: (n) => `${n} 人`,
  },
  en: {
    all: 'All departments', search: 'Search departments', allOf: (name) => `All of ${name} (incl. sub-departments)`, incl: 'incl. sub-departments',
    none: 'No department', empty: 'No matching department', inactive: 'Inactive', clear: 'Clear',
    invalid: 'That department no longer exists or is outside your data scope. The filter was cleared.',
    back: 'Back', done: 'Done', more: (n) => `+${n - 1} more`, loading: 'Loading departments…', unavailable: 'Department filter unavailable',
    label: 'Department', people: (n) => `${n} ${n === 1 ? 'person' : 'people'}`,
  },
};

// 宿主显示「已清除」提示时可直接用这条文案
export const deptFilterInvalidText = (lang) => T[lang === 'zh' ? 'zh' : 'en'].invalid;

// 把 DeptFilter 放进 Semi Modal（第二批波次 3，W3-B 等后台宿主共用；本文件仍不 import Semi）：
//   <Modal {...dpfModalProps()} visible … >…<DeptFilter … />…</Modal>
// · motion:false —— 入场动画留下的 transform 会让手机底部抽屉（.dpf-sheet，position:fixed）改为相对弹窗定位；
// · modalRender —— 弹窗内容层（.semi-modal-content）的 overflow:hidden 会截掉桌面弹层（.dpf-pop，绝对定位，渲染在弹窗里），
//   改成 overflow:visible。宿主自己也有 modalRender 时传进来，先走宿主的再改样式。
// 弹层本来就渲染在弹窗内容里（不走 portal），Esc 只关弹层、不关弹窗（onKeyDown 里 stopPropagation）。
export function dpfModalRender(node) {
  if (!isValidElement(node)) return node;
  return cloneElement(node, { style: { ...((node.props && node.props.style) || {}), overflow: 'visible' } });
}
export function dpfModalProps(hostRender) {
  return {
    motion: false,
    modalRender: typeof hostRender === 'function' ? (node) => dpfModalRender(hostRender(node)) : dpfModalRender,
  };
}

const MOBILE_Q = '(max-width: 640px)';
const isMobile = () => { try { return !!(window.matchMedia && window.matchMedia(MOBILE_Q).matches); } catch { return false; } };

export default function DeptFilter({
  options, value, onChange, multiple = false, placeholder, lang = 'zh', size = 'default',
  showNone = false, onInvalid, disabled = false, ready, label, className = '',
}) {
  const s = T[lang === 'zh' ? 'zh' : 'en'];
  const list = useMemo(() => (Array.isArray(options) ? options : []), [options]);
  const layout = useMemo(() => deptLayout(list), [list]);
  const selected = useMemo(() => {
    const raw = multiple ? (Array.isArray(value) ? value : value ? [value] : []) : (value === null || value === undefined || value === '' ? [] : [Array.isArray(value) ? value[0] : value]);
    return raw.filter((x) => x !== null && x !== undefined && x !== '').map(String);
  }, [value, multiple]);
  const isReady = ready === undefined ? list.length > 0 : !!ready;

  const [open, setOpen] = useState(false);
  const [sheet, setSheet] = useState(false);
  const [q, setQ] = useState('');
  const [path, setPath] = useState([]);            // 已展开的部门 id：path[k] 的下级显示在第 k+1 列
  const [cur, setCur] = useState({ col: 0, idx: 0 });
  const [shift, setShift] = useState(0);
  const rootRef = useRef(null);
  const popRef = useRef(null);
  const searchRef = useRef(null);
  const triggerRef = useRef(null);
  const reportedRef = useRef('');
  const uid = useId().replace(/:/g, '');

  // value 不在选项里 → 回调一次（只在 ready 时；同一组无效值只报一次）
  useEffect(() => {
    if (!isReady || !onInvalid) return;
    const bad = selected.filter((id) => (id === DEPT_NONE ? !showNone : !layout.byId.has(id)));
    const key = bad.join('|');
    if (!bad.length) { reportedRef.current = ''; return; }
    if (reportedRef.current === key) return;
    reportedRef.current = key;
    onInvalid(multiple ? bad : bad[0]);
  }, [isReady, selected, layout, onInvalid, multiple, showNone]);

  // 列：第 0 列 = 「全部部门」+ 根 +（无部门）；第 k+1 列 = 「全部 X（含下级）」+ X 的下级
  const columns = useMemo(() => {
    const cols = [];
    const head = [{ kind: 'all' }, ...layout.roots.map((o) => ({ kind: 'opt', opt: o, kids: (layout.children.get(String(o.id)) || []).length > 0 }))];
    if (showNone) head.push({ kind: 'none' });
    cols.push(head);
    for (const id of path) {
      const o = layout.byId.get(id);
      if (!o) break;
      const kids = layout.children.get(id) || [];
      if (!kids.length) break;
      cols.push([{ kind: 'allof', opt: o }, ...kids.map((k) => ({ kind: 'opt', opt: k, kids: (layout.children.get(String(k.id)) || []).length > 0 }))]);
    }
    return cols;
  }, [layout, path, showNone]);

  const results = useMemo(() => {
    if (!q.trim()) return null;
    const hits = searchDepts(list, q).map((o) => ({ kind: 'opt', opt: o, kids: false, flat: true }));
    if (showNone && s.none.toLowerCase().includes(q.trim().toLowerCase())) hits.push({ kind: 'none' });
    return hits;
  }, [q, list, showNone, s.none]);

  const valueOf = (it) => (it.kind === 'all' ? null : it.kind === 'none' ? DEPT_NONE : String(it.opt.id));
  const isOn = (it) => { const v = valueOf(it); return v === null ? selected.length === 0 : selected.includes(v); };

  const close = useCallback((focusTrigger) => {
    setOpen(false); setSheet(false); setQ(''); setShift(0);
    if (focusTrigger && triggerRef.current) triggerRef.current.focus();
  }, []);

  const openPop = () => {
    if (disabled) return;
    const first = selected[0];
    const anc = first && layout.byId.has(first) ? ancestorIds(layout, first) : [];
    const mobile = isMobile();
    const nextPath = anc.slice(0, -1);
    setPath(nextPath);
    setCur({ col: nextPath.length, idx: 0 });
    setSheet(mobile);
    setOpen(true);
  };

  // 打开后把光标放到选中项上
  useEffect(() => {
    if (!open) return;
    const col = columns[columns.length - 1] || [];
    const i = col.findIndex((it) => isOn(it) && it.kind !== 'all');
    setCur({ col: columns.length - 1, idx: i >= 0 ? i : 0 });
    if (searchRef.current) searchRef.current.focus();
    // 只在打开时定位一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // 点外面关闭
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => { if (rootRef.current && !rootRef.current.contains(e.target)) close(false); };
    document.addEventListener('mousedown', onDown, true);
    document.addEventListener('touchstart', onDown, true);
    return () => { document.removeEventListener('mousedown', onDown, true); document.removeEventListener('touchstart', onDown, true); };
  }, [open, close]);

  // 弹层右边超出视口时整体左移（桌面）
  useLayoutEffect(() => {
    if (!open || sheet || !popRef.current) return;
    const r = popRef.current.getBoundingClientRect();          // 已含当前的 translateX(-shift)
    const vw = window.innerWidth || document.documentElement.clientWidth || 0;
    const left = r.left + shift, right = r.right + shift;       // 不平移时的位置
    const over = right - (vw - 8);
    const next = over > 0 ? Math.min(over, Math.max(0, left - 8)) : 0;
    if (Math.abs(next - shift) > 1) setShift(next);
  }, [open, sheet, columns.length, results, shift]);

  const pick = (it) => {
    const v = valueOf(it);
    if (!multiple) {
      if (v !== (selected[0] || null) && onChange) onChange(v);
      close(true);
      return;
    }
    if (v === null) { if (onChange) onChange([]); return; }
    const next = selected.includes(v) ? selected.filter((x) => x !== v) : [...selected, v];
    if (onChange) onChange(next);
  };
  const expand = (col, it) => {
    if (it.kind !== 'opt' || !it.kids) return false;
    setPath((p) => [...p.slice(0, col), String(it.opt.id)]);
    setCur({ col: col + 1, idx: 0 });
    return true;
  };
  const activate = (col, it, viaKey) => {
    if (results) { pick(it); return; }
    if (it.kind === 'opt' && it.kids && !viaKey) { expand(col, it); return; }
    pick(it);
  };

  // 抽屉（手机）：只显示最深一列，可返回上一级
  const sheetCol = columns.length - 1;
  const visibleCols = results ? [results] : sheet ? [columns[sheetCol]] : columns;
  const colIndex = (k) => (results ? 0 : sheet ? sheetCol : k);

  const onKeyDown = (e) => {
    const lists = results ? [results] : columns;
    const c = results ? 0 : Math.min(cur.col, lists.length - 1);
    const items = lists[c] || [];
    const move = (idx) => setCur({ col: c, idx: Math.max(0, Math.min(items.length - 1, idx)) });
    if (e.key === 'ArrowDown') { e.preventDefault(); move(cur.idx + 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); move(cur.idx - 1); }
    else if (e.key === 'Home' && !q) { e.preventDefault(); move(0); }
    else if (e.key === 'End' && !q) { e.preventDefault(); move(items.length - 1); }
    else if (e.key === 'ArrowRight' && !results) {
      const it = items[cur.idx];
      if (it && expand(c, it)) e.preventDefault();
    } else if (e.key === 'ArrowLeft' && !results && c > 0) {
      e.preventDefault();
      const parentId = path[c - 1];
      const prev = lists[c - 1] || [];
      const i = prev.findIndex((it) => it.kind === 'opt' && String(it.opt.id) === parentId);
      if (sheet) setPath((p) => p.slice(0, c - 1));
      setCur({ col: c - 1, idx: i >= 0 ? i : 0 });
    } else if (e.key === 'Enter') {
      const it = items[cur.idx];
      if (it) { e.preventDefault(); activate(c, it, true); }
    } else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(true); }
    else if (e.key === 'Tab') { close(false); }
  };

  // 触发按钮上显示的文字
  const shown = (() => {
    if (!selected.length) return null;
    const name = (id) => (id === DEPT_NONE ? s.none : layout.byId.has(id) ? optionPath(layout.byId.get(id)) : isReady ? id : '…');
    if (selected.length === 1) return name(selected[0]);
    return `${name(selected[0])} ${s.more(selected.length)}`;
  })();
  const noOptions = isReady && !list.length && !showNone;
  const title = disabled ? s.unavailable : shown || placeholder || s.all;

  const itemLabel = (it) => {
    if (it.kind === 'all') return s.all;
    if (it.kind === 'none') return s.none;
    if (it.kind === 'allof') return s.allOf(it.opt.name);
    return it.opt.name;
  };
  const renderItem = (it, col, idx) => {
    const id = `${uid}-c${col}-${idx}`;
    const on = isOn(it);
    const active = cur.col === col && cur.idx === idx;
    const expanded = it.kind === 'opt' && it.kids && path[col] === String(it.opt.id);
    const o = it.opt;
    return (
      <li key={id} id={id} role="option" aria-selected={on}
        className={'dpf-item' + (on ? ' on' : '') + (active ? ' active' : '') + (expanded ? ' open' : '') + (it.kind !== 'opt' ? ' dpf-' + it.kind : '') + (o && o.inactive ? ' off' : '')}
        onMouseDown={(e) => e.preventDefault()}
        onMouseEnter={() => setCur({ col, idx })}
        onClick={() => activate(col, it, false)}>
        {multiple && <span className={'dpf-check' + (on ? ' on' : '')} aria-hidden="true" />}
        <span className="dpf-name">
          <span className="dpf-name-t" title={o && it.kind === 'opt' ? optionPath(o) : itemLabel(it)}>{itemLabel(it)}</span>
          {it.flat && o && o.path && o.path !== o.name && <span className="dpf-path">{o.path}</span>}
        </span>
        {o && o.inactive && it.kind === 'opt' && <span className="dpf-tag">{s.inactive}</span>}
        {o && typeof o.count === 'number' && it.kind !== 'allof' && <span className="dpf-n tnum" aria-label={s.people(o.count)}>{o.count}</span>}
        {it.kind === 'opt' && it.kids && !it.flat && <span className="dpf-caret" aria-hidden="true">›</span>}
      </li>
    );
  };

  const activeId = open ? `${uid}-c${results ? 0 : cur.col}-${cur.idx}` : undefined;
  const sheetTitle = sheet && path.length ? optionPath(layout.byId.get(path[path.length - 1])) : s.all;

  return (
    <div ref={rootRef} className={'dpf' + (size === 'small' ? ' dpf-sm' : '') + (open ? ' is-open' : '') + (className ? ' ' + className : '')}>
      <button ref={triggerRef} type="button" className={'dpf-trigger' + (shown ? ' has-value' : '')} disabled={disabled}
        aria-haspopup="listbox" aria-expanded={open} aria-label={label || s.label} title={title}
        onClick={() => (open ? close(false) : openPop())}
        onKeyDown={(e) => { if (!open && (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); openPop(); } }}>
        <span className="dpf-trigger-t">{disabled ? s.unavailable : !isReady && selected.length ? s.loading : shown || placeholder || s.all}</span>
        <span className="dpf-trigger-caret" aria-hidden="true" />
      </button>
      {shown && !disabled && (
        <button type="button" className="dpf-clear" aria-label={s.clear} title={s.clear}
          onClick={() => { if (onChange) onChange(multiple ? [] : null); }}>×</button>
      )}
      {open && (
        <>
          {sheet && <div className="dpf-scrim" onClick={() => close(true)} aria-hidden="true" />}
          <div ref={popRef} className={sheet ? 'dpf-sheet' : 'dpf-pop'} role="dialog" aria-label={label || s.label}
            style={!sheet && shift ? { transform: `translateX(-${shift}px)` } : undefined} onKeyDown={onKeyDown}>
            {sheet && (
              <div className="dpf-sheet-h">
                {path.length > 0 && !results
                  ? <button type="button" className="dpf-back" onClick={() => { setPath((p) => p.slice(0, -1)); setCur({ col: Math.max(0, path.length - 1), idx: 0 }); }}>‹ {s.back}</button>
                  : <span />}
                <b className="dpf-sheet-t" title={results ? s.search : sheetTitle}>{results ? s.search : sheetTitle}</b>
                <button type="button" className="dpf-done" onClick={() => close(true)}>{s.done}</button>
              </div>
            )}
            <div className="dpf-search">
              <input ref={searchRef} type="search" value={q} placeholder={s.search} aria-label={s.search}
                aria-controls={`${uid}-lists`} aria-activedescendant={activeId}
                onChange={(e) => { setQ(e.target.value); setCur({ col: 0, idx: 0 }); }} />
            </div>
            <div id={`${uid}-lists`} className={'dpf-cols' + (results ? ' is-search' : '')}>
              {noOptions && !results && <div className="dpf-empty">{s.empty}</div>}
              {results && results.length === 0 && <div className="dpf-empty">{s.empty}</div>}
              {visibleCols.map((items, k) => (
                <ul key={k} className="dpf-col" role="listbox" aria-multiselectable={multiple || undefined} aria-label={k === 0 ? s.all : s.incl}>
                  {(items || []).map((it, i) => renderItem(it, colIndex(k), i))}
                </ul>
              ))}
            </div>
            {multiple && !sheet && (
              <div className="dpf-foot">
                <button type="button" className="dpf-link" onClick={() => { if (onChange) onChange([]); }}>{s.clear}</button>
                <button type="button" className="btn sm" onClick={() => close(true)}>{s.done}</button>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
