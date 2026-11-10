// 培训概览全局搜索（第三批 4.2，设计 §3.1）：课程 / 员工 / 部门三组，每组最多 5 条（多于 5 条或服务端 more=true 时提示细化关键词）。
// 250ms 防抖；≥2 个字符（含中文时 1 个）才请求 GET /api/admin/training/search?q=。结果在输入框下方就地展开（不是侧滑面板），
// 窄屏最高 min(60dvh, 420px) 内部滚动。键盘：↑ ↓ 移动，回车选中，Esc 关闭；role=combobox + listbox + aria-activedescendant。
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Input } from '@douyinfe/semi-ui';
import { IconSearch } from '@douyinfe/semi-icons';
import { api } from '../../../api.js';
import { categoryLabel } from '../../../categories.js';
import { searchReady } from './ovquery.js';

const LIMIT = 5;

export default function OverviewSearch({ s, lang, loc, onCourse, onPerson, onDept }) {
  const [q, setQ] = useState('');
  const [res, setRes] = useState(null);       // { q, courses, people, depts, more }
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const [act, setAct] = useState(-1);
  const boxRef = useRef(null);
  const uid = useId().replace(/:/g, '');
  const ready = searchReady(q);

  useEffect(() => {
    if (!ready) { setRes(null); setBusy(false); return undefined; }
    let alive = true;
    setBusy(true);
    const t = setTimeout(() => {
      api.get('/api/admin/training/search?q=' + encodeURIComponent(q.trim()))
        .then((r) => { if (alive) { setRes(r || null); setAct(-1); } })
        .catch(() => { if (alive) setRes({ q, courses: [], people: [], depts: [], more: {} }); })
        .finally(() => { if (alive) setBusy(false); });
    }, 250);
    return () => { alive = false; clearTimeout(t); };
  }, [q, ready]);

  // 点外面关闭
  useEffect(() => {
    if (!open) return undefined;
    const fn = (e) => { if (boxRef.current && !boxRef.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', fn);
    document.addEventListener('touchstart', fn);
    return () => { document.removeEventListener('mousedown', fn); document.removeEventListener('touchstart', fn); };
  }, [open]);

  const enrollText = (v) => (v === 'elective' ? s.enrollEle : s.enrollReq);
  const modeText = (v) => (v === 'offline' ? s.modeOff : v === 'mixed' ? s.modeMixed : s.modeOn);
  const groups = useMemo(() => {
    if (!res) return [];
    const more = res.more || {};
    const g = [];
    const courses = Array.isArray(res.courses) ? res.courses : [];
    const people = Array.isArray(res.people) ? res.people : [];
    const depts = Array.isArray(res.depts) ? res.depts : [];
    if (courses.length) g.push({ key: 'courses', label: s.sCourses, more: !!more.courses || courses.length > LIMIT,
      items: courses.slice(0, LIMIT).map((c) => ({ kind: 'course', id: c.id, raw: c, main: loc(c, 'title'),
        sub: [categoryLabel(c.category || null, lang), enrollText(c.enrollType), modeText(c.mode)].filter(Boolean).join(' · ') })) });
    if (people.length) g.push({ key: 'people', label: s.sPeople, more: !!more.people || people.length > LIMIT,
      items: people.slice(0, LIMIT).map((p) => ({ kind: 'person', id: p.userId, raw: p, main: p.name, sub: [p.employeeId, p.department].filter(Boolean).join(' · ') })) });
    if (depts.length) g.push({ key: 'depts', label: s.sDepts, more: !!more.depts || depts.length > LIMIT,
      items: depts.slice(0, LIMIT).map((d) => ({ kind: 'dept', id: d.id, raw: d, main: d.name, sub: d.path && d.path !== d.name ? d.path : '' })) });
    return g;
  }, [res, lang]); // eslint-disable-line react-hooks/exhaustive-deps
  const flat = useMemo(() => groups.flatMap((g) => g.items), [groups]);

  const pick = (it) => {
    if (!it) return;
    setOpen(false); setQ(''); setRes(null);
    if (it.kind === 'course') onCourse(it.raw);
    else if (it.kind === 'person') onPerson(it.raw);
    else onDept(it.raw);
  };
  const onKey = (e) => {
    if (e.key === 'Escape') { setOpen(false); return; }
    if (!flat.length) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); setAct((i) => (i + 1) % flat.length); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setOpen(true); setAct((i) => (i <= 0 ? flat.length - 1 : i - 1)); }
    else if (e.key === 'Enter' && open) { e.preventDefault(); pick(flat[act >= 0 ? act : 0]); }
  };

  const listId = 'ovx-s-' + uid;
  const optId = (i) => listId + '-' + i;
  const showPop = open && q.trim().length > 0;
  let idx = -1;
  return (
    <div className="ovx-search" ref={boxRef}>
      <Input prefix={<IconSearch />} value={q} placeholder={s.sPh} showClear
        onChange={(v) => { setQ(v); setOpen(true); }} onFocus={() => setOpen(true)} onKeyDown={onKey}
        role="combobox" aria-expanded={showPop} aria-controls={listId} aria-autocomplete="list" aria-label={s.sPh}
        aria-activedescendant={showPop && act >= 0 ? optId(act) : undefined} />
      {showPop && (
        <div className="ovx-s-pop" id={listId} role="listbox" aria-label={s.sPh}>
          {!ready ? <div className="ovx-s-note">{s.sMin}</div>
            : busy && !res ? <div className="ovx-s-note">{s.sLoading}</div>
              : !flat.length ? <div className="ovx-s-note">{s.sNone(q.trim())}</div>
                : groups.map((g) => (
                  <div className="ovx-s-group" key={g.key} role="group" aria-label={g.label}>
                    <div className="ovx-s-gh" aria-hidden>{g.label}</div>
                    {g.items.map((it) => {
                      idx += 1;
                      const i = idx;
                      return (
                        <div key={it.kind + it.id} id={optId(i)} role="option" aria-selected={i === act}
                          className={'ovx-s-opt' + (i === act ? ' on' : '')}
                          onMouseEnter={() => setAct(i)} onMouseDown={(e) => e.preventDefault()} onClick={() => pick(it)}>
                          <span className="ovx-s-main">{it.main}</span>
                          {it.sub && <span className="ovx-s-sub">{it.sub}</span>}
                        </div>
                      );
                    })}
                    {g.more && <div className="ovx-s-more">{s.sMore}</div>}
                  </div>
                ))}
        </div>
      )}
    </div>
  );
}
