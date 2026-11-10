import Overlay from '../components/Overlay.jsx';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useI18n } from '../i18n.jsx';
import { useAsync, api } from '../api.js';
import { useUrlState } from '../urlstate.js';
import ModuleTrail, { learnTrail } from '../components/ModuleTrail.jsx';
import { categoryLabel, categoryRank } from '../categories.js';
import {
  CATALOG_UNCAT, catalogFiltersOf, catalogFilterCount, filterCatalog, sortCatalog, catalogCategories, catalogAction, catalogTitle,
} from '../catalog.js';

// 课程目录（第四批 7「公开课程」，2026-10-08；设计 b4-design §7.2）：全员可自主学习的公开课程，无需申请。
//   「开始学习」= POST /api/catalog/courses/:programId/enroll（本人加入、来源 = 自主学习、无截止日期）→ 进入课程；
//   线下课程「加入课程」→ 留在本页，提示按时参加（加入即进入签到名单）。
//   筛选写进地址栏（q / cat / mode / mine）；?open=<programId> 直接打开该课程的介绍弹窗（未加入的人从课程链接进来时由
//   Course.jsx / ProgramDetail.jsx 转到这里）。纯函数在 web/src/catalog.js（test/catalog-filter.test.js）。
// 员工端不加载 Semi UI：筛选用原生控件，弹窗用与首页申请弹窗同一类原生 dialog（≤480px 全屏，见 b4-css/G5-app.css）。
// 9.1：本页不出现任何人员信息与人数。
const T = {
  zh: {
    title: '公开课',
    lead: '全员可自主学习的公开课程，点「开始学习」即可加入，学完计入学时。',
    searchPh: '搜索课程名称或简介',
    fCat: '课程类别', fCatAll: '全部类别', fCatN: (n) => `类别 · ${n}`, catNone: '未分类', catClear: '清除类别',
    fMode: '授课方式', fModeAll: '全部授课方式', modeOn: '线上', modeOff: '线下',
    mine: '只看未加入',
    hoursN: (h) => `${h} 学时`, modsN: (n) => `${n} 个模块`, minN: (n) => `约 ${n} 分钟`, hasExam: '含考试',
    sessionTbd: '开课时间待定',
    start: '开始学习', join: '加入课程', joined: '已加入', cont: (n) => `继续学习 ${n}%`, retake: '去补考',
    done: '已完成', view: '查看',
    joinedOk: '已加入，请按时参加',
    notPublic: '该课程已不再公开', sessionPassed: '该课程的开课日期已过，不能再加入', enrollFail: '加入失败，请重试',
    empty: '暂无公开课程', noMatch: '没有符合条件的课程', clear: '清除筛选',
    countN: (n) => `共 ${n} 门课程`,
    loading: '加载中…', error: '加载失败，请刷新页面重试。',
    // 课程介绍弹窗
    close: '关闭', intro: '课程介绍', desc: '课程简介', outline: '课程大纲',
    exam: '结业考试', examLine: (p, t) => (t ? `及格分 ${p}% · 限时 ${t} 分钟` : `及格分 ${p}% · 不限时`),
    session: '开课时间', place: '地点', trainer: '讲师',
    noDesc: '暂无课程简介',
    elective: '选修', mandatory: '必修',
  },
  en: {
    title: 'Public Courses',
    lead: 'Open courses anyone can take. Select “Start learning” to join; completed courses count toward your learning hours.',
    searchPh: 'Search course names and summaries',
    fCat: 'Category', fCatAll: 'All categories', fCatN: (n) => `Category · ${n}`, catNone: 'Uncategorized', catClear: 'Clear categories',
    fMode: 'Delivery', fModeAll: 'Any delivery', modeOn: 'Online', modeOff: 'In-person',
    mine: 'Not joined only',
    hoursN: (h) => `${h} h`, modsN: (n) => `${n} module${n === 1 ? '' : 's'}`, minN: (n) => `~${n} min`, hasExam: 'Includes an exam',
    sessionTbd: 'Session time not set',
    start: 'Start learning', join: 'Join course', joined: 'Joined', cont: (n) => `Continue ${n}%`, retake: 'Retake exam',
    done: 'Completed', view: 'View',
    joinedOk: 'You have joined; please attend on time',
    notPublic: 'This course is no longer public', sessionPassed: 'The session date for this course has passed, so you can no longer join', enrollFail: 'Couldn’t join. Please try again',
    empty: 'No open courses yet', noMatch: 'No courses match your filters', clear: 'Clear filters',
    countN: (n) => `${n} course${n === 1 ? '' : 's'}`,
    loading: 'Loading…', error: 'Couldn’t load. Refresh the page to try again.',
    close: 'Close', intro: 'Course details', desc: 'About this course', outline: 'Outline',
    exam: 'Final exam', examLine: (p, t) => (t ? `Pass mark ${p}% · ${t}-minute limit` : `Pass mark ${p}% · no time limit`),
    session: 'Session', place: 'Location', trainer: 'Trainer',
    noDesc: 'No description yet',
    elective: 'Elective', mandatory: 'Required',
  },
};

const fmtH = (h) => { const n = Math.round((Number(h) || 0) * 10) / 10; return Number.isInteger(n) ? String(n) : n.toFixed(1); };
const when = (v) => String(v || '').replace('T', ' ').slice(0, 16);
// 服务端错误码：{ code } 或 { error: code }
const codeOf = (e) => (e && e.data && (e.data.code || e.data.error)) || null;

export default function Catalog() {
  const { lang, loc } = useI18n();
  const s = T[lang] || T.en;
  const nav = useNavigate();
  const [urlp, patchUrl] = useUrlState();
  const f = useMemo(() => catalogFiltersOf(urlp), [urlp]);
  const openId = urlp.open || null;

  const { loading, error, data, reload } = useAsync(() => api.get('/api/catalog/courses'), []);
  const items = useMemo(() => (data && Array.isArray(data.items) ? data.items : []), [data]);
  const cats = useMemo(() => catalogCategories(data), [data]);
  const shown = useMemo(() => sortCatalog(filterCatalog(items, f), lang, categoryRank), [items, f, lang]);

  const [busy, setBusy] = useState(null);       // programId being joined
  const [msg, setMsg] = useState(null);         // { ok, text } — the status line under the toolbar

  const setF = (set) => patchUrl(set, { push: false });
  const clearAll = () => setF({ q: null, cat: null, mode: null, mine: null });
  const nFilters = catalogFilterCount(f);
  const [needle, setNeedle] = useState(f.q);
  useEffect(() => { setNeedle(f.q); }, [f.q]);
  useEffect(() => {
    if ((needle || '').trim() === f.q) return undefined;
    const t = setTimeout(() => setF({ q: needle.trim() || null }), 250);
    return () => clearTimeout(t);
  }, [needle]); // eslint-disable-line react-hooks/exhaustive-deps

  const openCourse = (pid) => { setMsg(null); patchUrl({ open: pid }, { push: false }); };
  const closeCourse = () => patchUrl({ open: null }, { push: false });

  const go = (it, act) => {
    if (act.enroll) { enroll(it, act); return; }
    if (act.href) nav(act.href);
  };
  const enroll = async (it, act) => {
    if (busy) return;
    setBusy(it.programId); setMsg(null);
    try {
      const r = await api.post(`/api/catalog/courses/${encodeURIComponent(it.programId)}/enroll`);
      if (it.mode === 'offline') {
        setMsg({ ok: true, text: s.joinedOk });
        if (openId) closeCourse();   // the status line sits under the toolbar, so close the intro dialog to show it
        reload();
      } else {
        nav(r && r.courseId ? `/course/${r.courseId}` : act.href);
      }
    } catch (e) {
      const code = codeOf(e);
      setMsg({ ok: false, text: code === 'session_passed' ? s.sessionPassed : code === 'not_public' ? s.notPublic : s.enrollFail });
      if (code === 'not_public' || code === 'session_passed') reload();
    } finally {
      setBusy(null);
    }
  };

  // 一行的操作按钮（与行主体并排，不嵌套在行按钮里）
  const actionOf = (it) => {
    const act = catalogAction(it);
    const b = busy === it.programId;
    if (act.kind === 'done') {
      return (
        <>
          <span className="pill ok cg-done">
            <svg className="ic sm" viewBox="0 0 24 24" aria-hidden="true"><path d="M20 6L9 17l-5-5" /></svg>{s.done}
          </span>
          <button type="button" className="btn sm ghost" onClick={() => go(it, act)}>{s.view}</button>
        </>
      );
    }
    if (act.kind === 'joined') {
      return (
        <>
          <span className="pill pri">{s.joined}</span>
          <button type="button" className="btn sm ghost" onClick={() => go(it, act)}>{s.view}</button>
        </>
      );
    }
    const label = act.kind === 'start' ? s.start : act.kind === 'join' ? s.join : act.kind === 'retake' ? s.retake : s.cont(act.progress);
    const ghost = act.kind === 'continue';
    return (
      <button type="button" className={'btn sm' + (ghost ? ' ghost' : '')} disabled={!!busy} aria-busy={b || undefined} onClick={() => go(it, act)}>
        {b ? '…' : label}
      </button>
    );
  };

  const metaOf = (it) => {
    const parts = [];
    if (it.mode === 'offline') {
      parts.push(it.sessionAt ? when(it.sessionAt) : s.sessionTbd);
      if (it.location) parts.push(it.location);
      if (Number(it.hours) > 0) parts.push(s.hoursN(fmtH(it.hours)));
    } else {
      if (Number(it.hours) > 0) parts.push(s.hoursN(fmtH(it.hours)));
      else if (Number(it.minutes) > 0) parts.push(s.minN(it.minutes));
      if (Number(it.moduleCount) > 0) parts.push(s.modsN(it.moduleCount));
      if (it.hasExam) parts.push(s.hasExam);
    }
    return parts.join(' · ');
  };

  const openItem = openId ? items.find((x) => String(x.programId) === String(openId)) || null : null;

  return (
    <div className="wrap cg-wrap">
      <ModuleTrail items={learnTrail(lang, 'catalog')} />
      <div className="ml-head">
        <h1 className="ml-title">{s.title}</h1>
        <p className="ml-lead">{s.lead}</p>
      </div>

      {loading && !data ? (
        <div className="ml-empty">{s.loading}</div>
      ) : error && !data ? (
        <div className="ml-empty">{s.error}</div>
      ) : items.length === 0 ? (
        <div className="ml-empty">{s.empty}</div>
      ) : (
        <>
          <div className="cg-toolbar" role="search">
            <input
              className="home-search cg-search" type="search" value={needle}
              onChange={(e) => setNeedle(e.target.value)} placeholder={s.searchPh} aria-label={s.searchPh}
            />
            <div className="cg-fsel">
              <CategoryPicker s={s} lang={lang} options={cats} value={f.cat}
                onChange={(list) => setF({ cat: list.length ? list.join(',') : null })} />
              <select className="cg-select" value={f.mode} aria-label={s.fMode} onChange={(e) => setF({ mode: e.target.value || null })}>
                <option value="">{s.fModeAll}</option>
                <option value="online">{s.modeOn}</option>
                <option value="offline">{s.modeOff}</option>
              </select>
            </div>
            <label className="cg-mine">
              <input type="checkbox" checked={f.mine} onChange={(e) => setF({ mine: e.target.checked ? '1' : null })} />
              <span>{s.mine}</span>
            </label>
            {(nFilters > 0 || f.q) && <button type="button" className="link-btn cg-clear" onClick={() => { setNeedle(''); clearAll(); }}>{s.clear}</button>}
          </div>

          {msg && <div className={'cg-msg' + (msg.ok ? ' ok' : ' err')} role="status">{msg.text}</div>}

          {shown.length === 0 ? (
            <div className="ml-empty">
              <div>{s.noMatch}</div>
              <button type="button" className="btn sm ghost cg-empty-clear" onClick={() => { setNeedle(''); clearAll(); }}>{s.clear}</button>
            </div>
          ) : (
            <>
              <div className="cg-count tnum">{s.countN(shown.length)}</div>
              <ul className="cg-list">
                {shown.map((it) => (
                  <li key={it.programId} className="cg-row" data-my={(it.my && it.my.status) || 'none'}>
                    <button type="button" className="cg-main" onClick={() => openCourse(it.programId)} aria-haspopup="dialog">
                      <span className="cg-title">{catalogTitle(it, lang)}</span>
                      {lang === 'zh' && it.title && it.title_zh && it.title !== it.title_zh && <span className="cg-alt">{it.title}</span>}
                      <span className="cg-tags">
                        <span className="pill muted">{categoryLabel(it.category || null, lang)}</span>
                        <span className={'pill' + (it.mode === 'offline' ? ' warn' : ' pri')}>{it.mode === 'offline' ? s.modeOff : s.modeOn}</span>
                      </span>
                      <span className="cg-meta">{metaOf(it)}</span>
                    </button>
                    <div className="cg-act">{actionOf(it)}</div>
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
      )}

      {openId && (
        <CourseDialog s={s} lang={lang} loc={loc} programId={openId} item={openItem}
          meta={openItem ? metaOf(openItem) : ''} action={openItem ? actionOf(openItem) : null} msg={msg && !msg.ok ? msg.text : null} onClose={closeCourse} />
      )}
    </div>
  );
}

// 类别多选（原生控件）：按钮 + 勾选列表弹层；Esc、点外面收起。值永远是中文键，未分类 = __none
function CategoryPicker({ s, lang, options, value, onChange }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const onDoc = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey); };
  }, [open]);
  const sorted = useMemo(() => [...(options || [])].sort((a, b) => categoryRank(a === CATALOG_UNCAT ? null : a) - categoryRank(b === CATALOG_UNCAT ? null : b)), [options]);
  const toggle = (k) => onChange(value.includes(k) ? value.filter((x) => x !== k) : [...value, k]);
  return (
    <div className="cg-cat" ref={ref}>
      <button type="button" className={'cg-select cg-cat-btn' + (value.length ? ' on' : '')} aria-haspopup="true" aria-expanded={open}
        aria-label={s.fCat} onClick={() => setOpen((v) => !v)}>
        {value.length ? s.fCatN(value.length) : s.fCatAll}
      </button>
      {open && (
        <div className="cg-cat-pop" role="group" aria-label={s.fCat}>
          {sorted.map((k) => (
            <label key={k} className="cg-cat-opt">
              <input type="checkbox" checked={value.includes(k)} onChange={() => toggle(k)} />
              <span>{k === CATALOG_UNCAT ? s.catNone : categoryLabel(k, lang)}</span>
            </label>
          ))}
          {value.length > 0 && <button type="button" className="link-btn cg-cat-clear" onClick={() => onChange([])}>{s.catClear}</button>}
        </div>
      )}
    </div>
  );
}

// 课程介绍弹窗（短操作 = 弹窗）：列表里已有的字段先显示，GET /api/catalog/courses/:programId 补上完整简介、大纲、考试与讲师。
// 课程不在目录里（取消公开 / 下线 / 未发布）→ 404 not_public，只显示一句说明。
function CourseDialog({ s, lang, loc, programId, item, meta, action, msg, onClose }) {
  const q = useAsync(() => api.get(`/api/catalog/courses/${encodeURIComponent(programId)}`), [programId]);
  const d = q.data || item || null;
  const gone = q.error && q.error.status === 404;
  const closeRef = useRef(null);
  useEffect(() => {
    if (closeRef.current) closeRef.current.focus();
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const outline = d && Array.isArray(d.outline) ? d.outline : [];
  const desc = d ? (loc(d, 'description') || loc(d, 'summary')) : '';
  const offline = d && d.mode === 'offline';
  return (
    <Overlay className="cg-mask" boxClassName="cg-dialog" labelledBy="cg-dlg-t" onClose={onClose} escape={false}>
        <div className="cg-dlg-head">
          <h3 id="cg-dlg-t">{d ? catalogTitle(d, lang) : s.intro}</h3>
          <button type="button" ref={closeRef} className="cg-dlg-x" aria-label={s.close} onClick={onClose}>
            <svg className="ic sm" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
          </button>
        </div>
        {gone ? (
          <p className="cg-dlg-note">{s.notPublic}</p>
        ) : !d ? (
          <p className="cg-dlg-note">{q.error ? s.error : s.loading}</p>
        ) : (
          <div className="cg-dlg-body">
            <div className="cg-tags">
              <span className="pill muted">{categoryLabel(d.category || null, lang)}</span>
              <span className={'pill' + (offline ? ' warn' : ' pri')}>{offline ? s.modeOff : s.modeOn}</span>
              {d.enrollType && <span className="pill">{d.enrollType === 'elective' ? s.elective : s.mandatory}</span>}
            </div>
            {meta && <div className="cg-meta">{meta}</div>}
            {d.exam && d.exam.passingScore != null && (
              <div className="cg-dlg-sec">
                <div className="cg-dlg-h">{s.exam}</div>
                <div className="cg-dlg-t">{s.examLine(d.exam.passingScore, d.exam.timeLimitMinutes)}</div>
              </div>
            )}
            <div className="cg-dlg-sec">
              <div className="cg-dlg-h">{s.desc}</div>
              <div className="cg-dlg-t cg-dlg-desc">{desc || s.noDesc}</div>
            </div>
            {offline ? (
              <div className="cg-dlg-sec">
                <dl className="cg-dlg-dl">
                  <div><dt>{s.session}</dt><dd className="tnum">{d.sessionAt ? when(d.sessionAt) : s.sessionTbd}</dd></div>
                  {d.location && <div><dt>{s.place}</dt><dd>{d.location}</dd></div>}
                  {d.trainerName && <div><dt>{s.trainer}</dt><dd>{d.trainerName}</dd></div>}
                </dl>
              </div>
            ) : outline.length > 0 && (
              <div className="cg-dlg-sec">
                <div className="cg-dlg-h">{s.outline}</div>
                <ol className="cg-outline">
                  {outline.map((m, i) => (
                    <li key={i}>
                      <span>{loc(m, 'title')}</span>
                      {Number(m.minutes) > 0 && <span className="cg-outline-m tnum">{s.minN(m.minutes)}</span>}
                    </li>
                  ))}
                </ol>
              </div>
            )}
          </div>
        )}
        {msg && <div className="cg-msg err" role="status">{msg}</div>}
        <div className="apply-foot cg-dlg-foot">
          <button type="button" className="btn ghost" onClick={onClose}>{s.close}</button>
          {!gone && action && <span className="cg-dlg-act">{action}</span>}
        </div>
    </Overlay>
  );
}
