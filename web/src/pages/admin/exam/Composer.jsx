// 固定题目组卷（第四批 6.2 / F8，2026-10-08）：考试编辑页的子视图 ?edit=<id>&view=paper（新建考试同样可用）。
//   左「题库」：关联课程的题，可按题干、课程、模块、题型、分值、只看未加入筛选（地址栏 bq / bc / bm / bt / bp / bn），
//     ▸ 展开看选项与答案，勾选加入或把当前筛选结果整批加入；已在试卷上的题标「已加入」、不能再勾。
//   右「试卷」：按答题顺序排列，可拖动（桌面）、↑↓、焦点在拖动柄上 Alt+↑/↓、「移到第 n 题」调整顺序，移除，看分值与模块。
//   顶部常驻概况：题数（含案例组与小题数）、卷面总分、及格线折算分、题型构成、模块覆盖（0 题模块可点，题库筛到该模块）。
//   「随机抽题…」按规则先抽一套再调整（DrawModal）；「预览试卷」看学员看到的样子（PaperPreview）。
// 编辑的是考试表单的同一份 questionIds（setPaper），保存走考试页底部的保存按钮（现有的 POST / PUT，服务端去重、保序、限 200 题）。
// 手机（< 1180px）：「题库 | 试卷」切换，概况收成一行可展开；试卷不拖动，用 ↑↓ 与「移到…」。
import { useMemo, useState } from 'react';
import { Button, Input, Select, Checkbox, Banner, Modal, InputNumber, Popconfirm, Tooltip, Empty } from '@douyinfe/semi-ui';
import { IconArrowLeft, IconSearch } from '@douyinfe/semi-icons';
import { qtype, TypeTag, stemOf, typeLabel, ENABLED, enabledTypes } from '../../../qtypes/index.jsx';
import { useUrlState } from '../../../urlstate.js';
import { paperSummary, pointsOf, itemsOf, moveItem } from './paperSummary.js';
import DrawModal from './DrawModal.jsx';
import { IcWarn } from '../../../components/LineIcons.jsx';

export const PAPER_CAP = 200;
// 组卷页在地址栏里的筛选键（离开考试编辑页时一并清掉）
export const COMPOSER_KEYS = ['bq', 'bc', 'bm', 'bt', 'bp', 'bn'];

const T = {
  zh: {
    back: '返回考试设置', title: (n) => `组卷：${n}`, titleNew: '组卷：新考试',
    preview: '预览试卷', draw: '随机抽题…',
    bankH: '题库', paperH: '试卷', paneBank: '题库', panePaper: (n) => `试卷（${n}）`,
    searchPh: '搜索题干…', courseAll: '全部课程', moduleAll: '全部模块', typeAll: '全部题型', ptsAll: '全部分值',
    ptsOpt: (n) => `${n} 分`, onlyNew: '只看未加入',
    added: '已加入', addSel: (n) => `加入所选（${n}）`, addAll: (n) => `全部加入当前筛选结果（${n}）`, addBar: (n) => `加入 ${n} 题`,
    expand: '展开选项与答案', collapse: '收起',
    bankEmpty: '关联课程的题库里没有符合筛选的题目。', bankNone: '关联课程的题库还没有题目，请先到题库添加。',
    more: (n) => `再显示 ${n} 题`,
    paperEmpty: '从左侧题库勾选题目加入试卷。', paperEmptyPhone: '切换到「题库」勾选题目加入试卷。',
    clear: '清空试卷', clearAsk: '确定清空试卷上的全部题目？保存前可以离开本页放弃修改。', clearOk: '清空',
    up: '上移', down: '下移', remove: '移出试卷', moveTo: '移到…', handle: (n) => `第 ${n} 题，拖动或按 Alt+↑/↓ 调整顺序`,
    moveTitle: '移到第几题', moveLabel: (n) => `位置（1–${n}）`, moveOk: '移动', cancel: '取消',
    pts: (n) => `${n} 分`, subs: (n) => `${n} 小题`,
    outPool: '不在关联课程题库中，保存时会移除',
    published: '已发布：修改试卷只影响之后开考的人。',
    cap: (n) => `最多 ${n} 题，已达上限，不能再加入。`,
    sumCount: (n, c, i) => (c ? `${n} 题（含 ${c} 组案例 · 共 ${i} 小题）` : `${n} 题`),
    sumTotal: (n) => `卷面总分 ${n} 分`, sumPass: (p, n) => (n == null ? `及格线 ${p}%` : `及格线 ${p}%（≥ ${n} 分）`),
    sumModules: (a, b) => `模块覆盖 ${a} / ${b}`, sumZero: '0 题模块：', sumZeroTip: '点击在题库中只看这个模块',
    sumLine: (n, t, p) => `${n} 题 · ${t} 分 · 及格 ${p}%`, sumMore: '展开概况', sumLess: '收起概况',
    readOnly: '只读权限：可以查看试卷，不能修改。',
    noModule: '未分模块',
  },
  en: {
    back: 'Back to exam settings', title: (n) => `Build paper: ${n}`, titleNew: 'Build paper: new exam',
    preview: 'Preview paper', draw: 'Draw at random…',
    bankH: 'Question bank', paperH: 'Paper', paneBank: 'Bank', panePaper: (n) => `Paper (${n})`,
    searchPh: 'Search question stem…', courseAll: 'All courses', moduleAll: 'All modules', typeAll: 'All types', ptsAll: 'All points',
    ptsOpt: (n) => `${n} pts`, onlyNew: 'Only questions not on the paper',
    added: 'On paper', addSel: (n) => `Add selected (${n})`, addAll: (n) => `Add all filtered (${n})`, addBar: (n) => `Add ${n}`,
    expand: 'Show options and answer', collapse: 'Hide',
    bankEmpty: 'No question in the linked courses matches the filters.', bankNone: 'The linked courses have no questions yet. Add some in the Question Bank first.',
    more: (n) => `Show ${n} more`,
    paperEmpty: 'Tick questions in the bank on the left to add them to the paper.', paperEmptyPhone: 'Switch to Bank and tick questions to add them.',
    clear: 'Clear paper', clearAsk: 'Remove every question from the paper? You can still leave without saving.', clearOk: 'Clear',
    up: 'Move up', down: 'Move down', remove: 'Remove from paper', moveTo: 'Move to…', handle: (n) => `Question ${n}: drag, or press Alt+↑/↓ to reorder`,
    moveTitle: 'Move to position', moveLabel: (n) => `Position (1–${n})`, moveOk: 'Move', cancel: 'Cancel',
    pts: (n) => `${n} pt${n === 1 ? '' : 's'}`, subs: (n) => `${n} sub-question${n === 1 ? '' : 's'}`,
    outPool: 'Not in the linked courses’ bank; it will be removed on save',
    published: 'Published: changes apply to attempts started from now on.',
    cap: (n) => `Up to ${n} questions. The paper is full.`,
    sumCount: (n, c, i) => (c ? `${n} questions (incl. ${c} case group${c === 1 ? '' : 's'} · ${i} items)` : `${n} question${n === 1 ? '' : 's'}`),
    sumTotal: (n) => `Total ${n} pts`, sumPass: (p, n) => (n == null ? `Pass mark ${p}%` : `Pass mark ${p}% (≥ ${n} pts)`),
    sumModules: (a, b) => `Module coverage ${a} / ${b}`, sumZero: 'Modules with no question:', sumZeroTip: 'Show only this module in the bank',
    sumLine: (n, t, p) => `${n} Q · ${t} pts · pass ${p}%`, sumMore: 'Show summary', sumLess: 'Hide summary',
    readOnly: 'Read-only: you can view the paper but not change it.',
    noModule: 'No module',
  },
};

const PAGE = 60;

export default function Composer({
  lang, loc, examTitle, bank, courses, poolCourseIds, paper, setPaper,
  typePoints, passingScore, published, attempts, readOnly, onBack, onPreview,
}) {
  const s = T[lang] || T.en;
  const [urlp, patchUrl] = useUrlState();
  const bq = urlp.bq || '';
  const bc = urlp.bc || '';
  const bm = urlp.bm || '';
  const bt = urlp.bt || '';
  const bp = urlp.bp || '';
  const bn = urlp.bn === '1';
  const setF = (k, v) => patchUrl({ [k]: v || null }, { push: false });

  const [checked, setChecked] = useState([]);
  const [openBank, setOpenBank] = useState({});
  const [openPaper, setOpenPaper] = useState({});
  const [shown, setShown] = useState(PAGE);
  const [pane, setPane] = useState('bank');
  const [sumOpen, setSumOpen] = useState(false);
  const [drawOpen, setDrawOpen] = useState(false);
  const [moveAt, setMoveAt] = useState(null);   // 「移到…」弹窗：试卷上的位置
  const [moveTo, setMoveTo] = useState(1);
  const [dragFrom, setDragFrom] = useState(null);

  const poolSet = useMemo(() => new Set((poolCourseIds || []).map(String)), [poolCourseIds]);
  const enabled = useMemo(() => new Set(ENABLED), []);
  const pool = useMemo(() => (bank || []).filter((q) => q && !q.unsupported && enabled.has(q.type) && poolSet.has(String(q.courseId))), [bank, poolSet, enabled]);
  const byId = useMemo(() => new Map((bank || []).map((q) => [String(q.id), q])), [bank]);
  const onPaper = useMemo(() => new Set((paper || []).map(String)), [paper]);
  const full = (paper || []).length >= PAPER_CAP;

  // 模块：关联课程的模块按课程内顺序编号 M1、M2…（多门课程时带课程名区分）
  const poolCourses = useMemo(() => (courses || []).filter((c) => poolSet.has(String(c.id))), [courses, poolSet]);
  const modInfo = useMemo(() => {
    const m = new Map();
    for (const c of poolCourses) {
      (c.modules || []).forEach((mod, i) => {
        m.set(String(mod.id), { code: `M${i + 1}`, title: loc(mod, 'title') || mod.id, course: loc(c, 'title'), courseId: c.id });
      });
    }
    return m;
  }, [poolCourses, loc]);
  const modLabel = (id) => {
    const x = id ? modInfo.get(String(id)) : null;
    if (!x) return id ? String(id) : s.noModule;
    return poolCourses.length > 1 ? `${x.course} · ${x.code} ${x.title}` : `${x.code} ${x.title}`;
  };

  const ptsOf = (q) => pointsOf(q, typePoints);
  const textOf = (q) => [q.question, q.question_zh, q.passage, q.passage_zh].filter(Boolean).join(' ').toLowerCase();

  const filtered = useMemo(() => {
    const k = bq.trim().toLowerCase();
    return pool.filter((q) => {
      if (k && !textOf(q).includes(k)) return false;
      if (bc && String(q.courseId) !== bc) return false;
      if (bm && String(q.moduleId || '') !== bm) return false;
      if (bt && q.type !== bt) return false;
      if (bp && String(ptsOf(q)) !== bp) return false;
      if (bn && onPaper.has(String(q.id))) return false;
      return true;
    });
  }, [pool, bq, bc, bm, bt, bp, bn, onPaper, typePoints]); // eslint-disable-line react-hooks/exhaustive-deps

  const sum = useMemo(
    () => paperSummary(paper || [], bank || [], { typePoints, passingScore, poolCourseIds, enabled: ENABLED }),
    [paper, bank, typePoints, passingScore, poolCourseIds],
  );

  /* ---- 题库 → 试卷 ---- */
  const addIds = (ids) => {
    if (readOnly) return;
    const next = [...(paper || [])];
    const have = new Set(next.map(String));
    for (const id of ids) {
      if (next.length >= PAPER_CAP) break;
      if (have.has(String(id))) continue;
      have.add(String(id));
      next.push(id);
    }
    setPaper(next);
    setChecked([]);
  };
  const checkable = filtered.filter((q) => !onPaper.has(String(q.id)));
  const toggleCheck = (id) => setChecked((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));
  const checkedLive = checked.filter((id) => !onPaper.has(String(id)) && byId.has(String(id)));

  /* ---- 试卷顺序 ---- */
  const move = (from, to) => { if (!readOnly) setPaper(moveItem(paper || [], from, to)); };
  const removeAt = (i) => { if (!readOnly) setPaper((paper || []).filter((_, k) => k !== i)); };
  const onHandleKey = (e, i) => {
    if (!e.altKey) return;
    if (e.key === 'ArrowUp') { e.preventDefault(); move(i, i - 1); }
    if (e.key === 'ArrowDown') { e.preventDefault(); move(i, i + 1); }
  };

  /* ---- 选项列表 ---- */
  const typeOpts = enabledTypes().filter((t) => pool.some((q) => q.type === t)).map((t) => ({ value: t, label: typeLabel(t, lang) }));
  const ptsOpts = [...new Set(pool.map((q) => ptsOf(q)))].sort((a, b) => a - b).map((n) => ({ value: String(n), label: s.ptsOpt(n) }));
  const modOpts = [...new Set(pool.filter((q) => !bc || String(q.courseId) === bc).map((q) => String(q.moduleId || '')))]
    .filter(Boolean)
    .map((id) => ({ value: id, label: modLabel(id) }));
  const courseOpts = poolCourses.map((c) => ({ value: String(c.id), label: loc(c, 'title') }));

  const stemLine = (q) => {
    if (q.type === 'case') {
      const t = loc(q, 'passage') || stemOf(q, lang);
      return t;
    }
    return stemOf(q, lang);
  };
  const preview = (q) => {
    const Pv = qtype(q.type).BankPreview;
    return <div className="exc-preview"><Pv q={q} lang={lang} /></div>;
  };

  const zeroMods = sum.modules.zero;
  const summary = (
    <div className={'card exc-sum' + (sumOpen ? ' open' : '')} role="status" aria-live="polite">
      <button type="button" className="exc-sum-line link-btn" aria-expanded={sumOpen} onClick={() => setSumOpen((v) => !v)}>
        <span className="tnum">{s.sumLine(sum.count, sum.total, sum.passPct == null ? '—' : sum.passPct)}</span>
        <span className="exc-sum-caret" aria-hidden="true">{sumOpen ? '▴' : '▾'}</span>
        <span className="exc-sr">{sumOpen ? s.sumLess : s.sumMore}</span>
      </button>
      <div className="exc-sum-full">
        <span className="exc-sum-cell tnum">{s.sumCount(sum.count, sum.cases, sum.items)}</span>
        <span className="exc-sum-cell tnum"><b>{s.sumTotal(sum.total)}</b></span>
        {sum.passPct != null && <span className="exc-sum-cell tnum">{s.sumPass(sum.passPct, sum.passPoints)}</span>}
        {sum.typeMix.length > 0 && (
          <span className="exc-sum-cell exc-sum-mix">
            {sum.typeMix.map((m) => <span key={m.type} className="exc-mix tnum">{typeLabel(m.type, lang, true)} {m.count}</span>)}
          </span>
        )}
        {sum.modules.total > 0 && (
          <span className={'exc-sum-cell' + (zeroMods.length ? ' warn' : '')}>
            <span className="tnum">{s.sumModules(sum.modules.covered, sum.modules.total)}</span>
            {zeroMods.length > 0 && (
              <span className="exc-zero">
                <IcWarn /> {s.sumZero}
                {zeroMods.map((id) => (
                  <Tooltip key={id} content={s.sumZeroTip}>
                    <button type="button" className="exc-zero-chip" onClick={() => { patchUrl({ bm: id, bc: null }, { push: false }); setPane('bank'); }}>
                      {modLabel(id)}
                    </button>
                  </Tooltip>
                ))}
              </span>
            )}
          </span>
        )}
      </div>
    </div>
  );

  const bankPane = (
    <section className="card exc-pane exc-bank" aria-label={s.bankH}>
      <h2 className="exc-pane-h">{s.bankH} <span className="exc-pane-n tnum">{filtered.length}</span></h2>
      <div className="exc-filters">
        <Input className="exc-f-q" prefix={<IconSearch />} value={bq} onChange={(v) => setF('bq', v)} placeholder={s.searchPh} showClear aria-label={s.searchPh} />
        {courseOpts.length > 1 && <Select className="exc-f" value={bc || undefined} onChange={(v) => patchUrl({ bc: v || null, bm: null }, { push: false })} placeholder={s.courseAll} showClear optionList={courseOpts} aria-label={s.courseAll} />}
        <Select className="exc-f" value={bm || undefined} onChange={(v) => setF('bm', v)} placeholder={s.moduleAll} showClear optionList={modOpts} aria-label={s.moduleAll} disabled={!modOpts.length} />
        <Select className="exc-f" value={bt || undefined} onChange={(v) => setF('bt', v)} placeholder={s.typeAll} showClear optionList={typeOpts} aria-label={s.typeAll} />
        <Select className="exc-f" value={bp || undefined} onChange={(v) => setF('bp', v)} placeholder={s.ptsAll} showClear optionList={ptsOpts} aria-label={s.ptsAll} />
        <Checkbox className="exc-f-new" checked={bn} onChange={(e) => setF('bn', e && e.target && e.target.checked ? '1' : null)}>{s.onlyNew}</Checkbox>
      </div>
      {!pool.length ? (
        <Empty className="exc-empty" description={s.bankNone} />
      ) : !filtered.length ? (
        <Empty className="exc-empty" description={s.bankEmpty} />
      ) : (
        <ul className="exc-list">
          {filtered.slice(0, shown).map((q) => {
            const id = String(q.id);
            const added = onPaper.has(id);
            const open = !!openBank[id];
            const pts = ptsOf(q);
            return (
              <li key={id} className={'exc-row' + (added ? ' added' : '') + (open ? ' open' : '')}>
                <div className="exc-row-main">
                  <Checkbox
                    checked={added || checked.includes(q.id)}
                    disabled={added || readOnly || (full && !checked.includes(q.id))}
                    onChange={() => toggleCheck(q.id)}
                    aria-label={stemLine(q)}
                  />
                  <button type="button" className="exc-exp link-btn" aria-expanded={open} aria-label={open ? s.collapse : s.expand}
                    onClick={() => setOpenBank((m) => ({ ...m, [id]: !m[id] }))}>{open ? '▾' : '▸'}</button>
                  <TypeTag type={q.type} lang={lang} short size="small" />
                  <span className="exc-stem" title={stemLine(q)}>{stemLine(q)}</span>
                  {q.type === 'case' && <span className="exc-meta">{s.subs(itemsOf(q))}</span>}
                  <span className="exc-meta tnum">{s.pts(pts)}</span>
                  {q.moduleId && <span className="exc-mod" title={modLabel(q.moduleId)}>{(modInfo.get(String(q.moduleId)) || {}).code || ''}</span>}
                  {added && <span className="pill ok exc-added">{s.added}</span>}
                </div>
                {open && preview(q)}
              </li>
            );
          })}
        </ul>
      )}
      {filtered.length > shown && (
        <Button theme="borderless" className="exc-more" onClick={() => setShown((n) => n + PAGE)}>{s.more(Math.min(PAGE, filtered.length - shown))}</Button>
      )}
      {!readOnly && (
        <div className="exc-bank-foot">
          <Button theme="solid" type="primary" disabled={!checkedLive.length || full} onClick={() => addIds(checkedLive)}>{s.addSel(checkedLive.length)}</Button>
          <Button theme="light" type="primary" disabled={!checkable.length || full} onClick={() => addIds(checkable.map((q) => q.id))}>{s.addAll(checkable.length)}</Button>
        </div>
      )}
      {!readOnly && checkedLive.length > 0 && (
        <div className="exc-addbar">
          <Button theme="solid" type="primary" block disabled={full} onClick={() => { addIds(checkedLive); setPane('paper'); }}>{s.addBar(checkedLive.length)}</Button>
        </div>
      )}
    </section>
  );

  const outSet = new Set(sum.outOfPool.map(String));
  const paperPane = (
    <section className="card exc-pane exc-paper" aria-label={s.paperH}>
      <h2 className="exc-pane-h">{s.paperH} <span className="exc-pane-n tnum">{(paper || []).length}</span></h2>
      {!(paper || []).length ? (
        <Empty className="exc-empty" description={<><span className="exc-desk">{s.paperEmpty}</span><span className="exc-phone">{s.paperEmptyPhone}</span></>} />
      ) : (
        <ol className="exc-list exc-paperlist">
          {(paper || []).map((pid, i) => {
            const id = String(pid);
            const q = byId.get(id);
            const out = outSet.has(id);
            const open = !!openPaper[id];
            const n = i + 1;
            return (
              <li
                key={id}
                className={'exc-row' + (out ? ' out' : '') + (open ? ' open' : '') + (dragFrom === i ? ' dragging' : '')}
                draggable={!readOnly}
                onDragStart={(e) => { setDragFrom(i); try { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', String(i)); } catch { /* old browsers */ } }}
                onDragOver={(e) => { if (dragFrom != null) e.preventDefault(); }}
                onDrop={(e) => { e.preventDefault(); if (dragFrom != null && dragFrom !== i) move(dragFrom, i); setDragFrom(null); }}
                onDragEnd={() => setDragFrom(null)}
              >
                <div className="exc-row-main">
                  {!readOnly && (
                    <button type="button" className="exc-handle" aria-label={s.handle(n)} title={s.handle(n)} onKeyDown={(e) => onHandleKey(e, i)}>≡</button>
                  )}
                  <span className="exc-no tnum">{n}</span>
                  {q ? <TypeTag type={q.type} lang={lang} short size="small" /> : null}
                  <span className="exc-stem" title={q ? stemLine(q) : id}>{q ? stemLine(q) : id}</span>
                  {q && q.type === 'case' && <span className="exc-meta">{s.subs(itemsOf(q))}</span>}
                  {q && !out && <span className="exc-meta tnum">{s.pts(sum.points[id] ?? ptsOf(q))}</span>}
                  {q && q.moduleId && <span className="exc-mod" title={modLabel(q.moduleId)}>{(modInfo.get(String(q.moduleId)) || {}).code || ''}</span>}
                  {!readOnly && (
                    <span className="exc-acts">
                      <Button size="small" theme="borderless" type="tertiary" className="exc-btn" disabled={i === 0} onClick={() => move(i, i - 1)} aria-label={`${s.up} · ${n}`}>↑</Button>
                      <Button size="small" theme="borderless" type="tertiary" className="exc-btn" disabled={i === paper.length - 1} onClick={() => move(i, i + 1)} aria-label={`${s.down} · ${n}`}>↓</Button>
                      <Button size="small" theme="borderless" type="tertiary" className="exc-btn exc-moveto" onClick={() => { setMoveAt(i); setMoveTo(n); }}>{s.moveTo}</Button>
                      <Button size="small" theme="borderless" type="danger" className="exc-btn" onClick={() => removeAt(i)} aria-label={`${s.remove} · ${n}`}>✕</Button>
                    </span>
                  )}
                  {q && (
                    <button type="button" className="exc-exp link-btn" aria-expanded={open} aria-label={open ? s.collapse : s.expand}
                      onClick={() => setOpenPaper((m) => ({ ...m, [id]: !m[id] }))}>{open ? '▾' : '▸'}</button>
                  )}
                </div>
                {out && <div className="exc-outmsg" role="note">{s.outPool}</div>}
                {open && q && preview(q)}
              </li>
            );
          })}
        </ol>
      )}
      {!readOnly && (paper || []).length > 0 && (
        <div className="exc-paper-foot">
          <Popconfirm title={s.clear} content={s.clearAsk} okText={s.clearOk} cancelText={s.cancel} okType="danger" onConfirm={() => setPaper([])}>
            <Button theme="borderless" type="danger">{s.clear}</Button>
          </Popconfirm>
        </div>
      )}
    </section>
  );

  return (
    <div className="exc-page">
      <div className="co-page-bar exc-bar">
        <Button theme="borderless" icon={<IconArrowLeft />} onClick={onBack}>{s.back}</Button>
        <div className="co-page-titles">
          <h1 className="co-page-title" title={examTitle ? s.title(examTitle) : s.titleNew}>{examTitle ? s.title(examTitle) : s.titleNew}</h1>
        </div>
        <Button theme="light" onClick={onPreview}>{s.preview}</Button>
        {!readOnly && <Button theme="light" type="primary" onClick={() => setDrawOpen(true)} disabled={!pool.length}>{s.draw}</Button>}
      </div>
      {readOnly && <Banner type="info" closeIcon={null} className="exc-banner" description={s.readOnly} />}
      {published && attempts > 0 && <Banner type="info" closeIcon={null} className="exc-banner" description={s.published} />}
      {full && !readOnly && <Banner type="warning" closeIcon={null} className="exc-banner" description={s.cap(PAPER_CAP)} />}
      {summary}
      <div className="exc-tabs" role="tablist" aria-label={s.paperH}>
        <button type="button" role="tab" aria-selected={pane === 'bank'} className={'exc-tab' + (pane === 'bank' ? ' on' : '')} onClick={() => setPane('bank')}>{s.paneBank}</button>
        <button type="button" role="tab" aria-selected={pane === 'paper'} className={'exc-tab' + (pane === 'paper' ? ' on' : '')} onClick={() => setPane('paper')}>{s.panePaper((paper || []).length)}</button>
      </div>
      <div className="exc-grid" data-pane={pane}>
        {bankPane}
        {paperPane}
      </div>
      <DrawModal
        visible={drawOpen}
        lang={lang}
        pool={pool}
        paper={paper || []}
        cap={PAPER_CAP}
        onCancel={() => setDrawOpen(false)}
        onApply={(ids, mode) => {
          setDrawOpen(false);
          if (mode === 'append') addIds(ids);
          else setPaper(ids.slice(0, PAPER_CAP));
          setPane('paper');
        }}
      />
      <Modal
        title={s.moveTitle}
        visible={moveAt != null}
        onCancel={() => setMoveAt(null)}
        onOk={() => { if (moveAt != null) move(moveAt, Math.round(Number(moveTo) || 1) - 1); setMoveAt(null); }}
        okText={s.moveOk}
        cancelText={s.cancel}
        width={360}
      >
        <label className="exc-movefield">
          <span>{s.moveLabel((paper || []).length)}</span>
          <InputNumber min={1} max={Math.max(1, (paper || []).length)} precision={0} value={moveTo} onChange={(v) => setMoveTo(v)} style={{ width: '100%' }} />
        </label>
      </Modal>
    </div>
  );
}
