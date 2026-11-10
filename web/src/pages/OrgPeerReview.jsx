// （10/12 起：本部门得分只在 HR「发布结果」后显示，发布后不再按 3 个评分部门门槛隐藏；卡点匿名，见 /api/me/reviews/orgperf mine[].peer / pending）
// 组织绩效 · 员工端「组织互评」（负责人 2026-10-10）：只给一级部门负责人。放在「绩效评估」页的视图里（?view=org）。
//   进行中的互评（负责人 10/10 改版）：逐部门一屏，顶部「第 3 / 45 个部门」，上一个 / 下一个（翻页时自动存草稿）。
//     先显示三个维度（1–10 分，或「不适用」）；至少打了一个分后才出现第二题「最需解决的卡点」。
//     没打分直接「下一个部门」= 跳过，按不适用处理，不拦提交、不进平均、不算有效评分部门。
//     卡点题默认选填；HR 建轮时设了「卡点题必填」，打了分的部门必须填卡点才能下一个 / 提交（服务端同样校验 issue_required）。
//     最后一页列出已打分与跳过的部门（可点回去改），确认后提交（确认框沿用原样式）。提交后不能改，HR 可退回。评分人所在部门由系统识别，不用选。
//   本部门：近 4 个季度的组织绩效评级；最近结束的互评里其他部门对本部门的平均分与卡点（匿名；评分部门少于 3 个时不显示）。
// 数据 GET /api/me/reviews/orgperf，保存 PUT /api/me/reviews/orgperf/rounds/:id。员工端包：不引 Semi。
import Overlay from '../components/Overlay.jsx';
import { useEffect, useMemo, useRef, useState } from 'react';
import { api, useAsync } from '../api.js';
import { date as fmtDate } from '../fmt.js';   // 统一按本地日显示（QA 32-2：截 UTC 前 10 位会早一天）

const T = {
  zh: {
    lead: '请根据过去一个季度中与各部门的实际协同体验，按行为参照分别打分，不要凭整体印象打分；不适用请选「不适用」。本次为部门互评，无需自评。',
    none: '目前没有需要你填写的互评。', due: (d) => `截止 ${d}`, submittedAt: (d) => `已提交 · ${d}`, closed: '已结束',
    rubric: '评分参照', hideRubric: '收起评分参照', showRubric: '查看评分参照', na: '不适用', score: '分',
    stepOf: (i, n) => `第 ${i} / ${n} 个部门`, prev: '上一个部门', next: '下一个部门', toReview: '下一步：确认提交', backToList: '返回部门', toSummary: '查看汇总',
    skipHint: '没有打分，将按「跳过」处理（不适用，不进平均）。', issue: '最需解决的卡点', issueReq: '（本轮必填）', issueOpt: '（选填）',
    issueNeed: '本轮要求打了分的部门填写卡点，请先填写再继续。',
    reviewTitle: '确认并提交', reviewDone: '作答汇总', scoredN: (n) => `已打分 ${n} 个部门`, skippedN: (n) => `跳过 ${n} 个部门`, reviewHint: '在下拉框中选择部门，可以回去查看或修改。', reviewHintRo: '在下拉框中选择部门可以查看（已提交，不能修改）。',
    scoredL: '已打分', skippedL: '跳过（不适用）',
    noneScored: '你还没有给任何部门打分；提交后所有部门都按跳过处理。', issueMissing: (n) => `还有 ${n} 个已打分的部门没填卡点（标红的部门）。`,
    save: '保存草稿', submit: '提交', saving: '保存中…', saved: '已保存草稿', submittedOk: '已提交',
    askTitle: '提交互评？', askBody: '提交后不能修改；如需修改请联系 HR 退回。', cancel: '取消', err: '保存失败：',
    mineTitle: (d) => `本部门组织绩效 · ${d}`, results: '近 4 个季度评级', noResults: '还没有导入组织绩效结果。',
    peerTitle: (n) => `其他部门的互评 · ${n}`, peerHidden: (n) => `评分部门不足 ${n} 个，为保护匿名，暂不显示本部门的互评汇总。`, peerNone: '还没有已发布结果的互评。', peerPending: (n) => `「${n}」已结束，HR 发布结果后可在这里查看本部门得分。`, issuesAnon: '（匿名，不显示来自哪个部门）', dimFew: (min, n) => `评分部门不足 ${min} 个（现 ${n} 个），不显示`,
    overall: '总平均', ratersN: (n) => `${n} 个部门评分`, issues: '其他部门提出的卡点', noIssues: '没有填写。',
    skippedRest: (n) => `其余 ${n} 个部门跳过（不适用，不进平均）。`, noneScoredRo: '本轮没有给任何部门打分，全部按跳过处理。',
    colDept: '部门', colSum: '合计', colAvg: '平均', view: '查看', edit: '查看 / 修改', backToSum: '返回汇总', issueMissingOne: '未填（本轮必填）', noIssueOne: '未填',
    pickDept: '选择部门…', missMark: ' · 缺卡点', noRecords: '还没有已提交或已结束的互评。', noMine: '你目前不是一级部门负责人，没有本部门的组织绩效可查看。',
  },
  en: {
    lead: 'Score each department from your actual working experience last quarter, using the behavioural guide — not your overall impression. Choose N/A if it does not apply. This is a peer review of other departments; you do not rate your own.',
    none: 'You have no peer review to fill in right now.', due: (d) => `Due ${d}`, submittedAt: (d) => `Submitted · ${d}`, closed: 'Closed',
    rubric: 'Scoring guide', hideRubric: 'Hide scoring guide', showRubric: 'Show scoring guide', na: 'N/A', score: 'pts',
    stepOf: (i, n) => `Department ${i} of ${n}`, prev: 'Previous department', next: 'Next department', toReview: 'Next: review and submit', backToList: 'Back to departments', toSummary: 'See summary',
    skipHint: 'No score given, so this department will be skipped (treated as N/A and left out of the averages).', issue: 'Blocker to fix', issueReq: ' (required this round)', issueOpt: ' (optional)',
    issueNeed: 'This round asks for a blocker for every department you score. Write it before moving on.',
    reviewTitle: 'Review and submit', reviewDone: 'Your answers', scoredN: (n) => `${n} department${n === 1 ? '' : 's'} scored`, skippedN: (n) => `${n} skipped`, reviewHint: 'Choose a department from the list to go back and view or change it.', reviewHintRo: 'Choose a department from the list to view it (submitted; it can no longer be changed).',
    scoredL: 'Scored', skippedL: 'Skipped (N/A)',
    noneScored: 'You have not scored any department yet; if you submit, every department counts as skipped.', issueMissing: (n) => `${n} scored department${n === 1 ? '' : 's'} (in red) still need a blocker.`,
    save: 'Save draft', submit: 'Submit', saving: 'Saving…', saved: 'Draft saved', submittedOk: 'Submitted',
    askTitle: 'Submit the peer review?', askBody: 'You cannot change it after submitting; ask HR to return it if you need to.', cancel: 'Cancel', err: 'Couldn’t save: ',
    mineTitle: (d) => `Organisational performance · ${d}`, results: 'Ratings, last 4 quarters', noResults: 'No organisational results imported yet.',
    peerTitle: (n) => `Peer review from other departments · ${n}`, peerHidden: (n) => `Fewer than ${n} departments rated yours, so the summary is hidden to protect anonymity.`, peerNone: 'No peer review results published yet.', peerPending: (n) => `"${n}" has closed. Your department's scores appear here once HR publishes the results.`, issuesAnon: ' (anonymous; the department is not shown)', dimFew: (min, n) => `Hidden: fewer than ${min} departments scored this (${n})`,
    overall: 'Overall', ratersN: (n) => `${n} departments rated`, issues: 'Blockers raised by other departments', noIssues: 'None written.',
    skippedRest: (n) => `The other ${n} department${n === 1 ? ' was' : 's were'} skipped (N/A, not in the averages).`, noneScoredRo: 'No department was scored in this round; all were skipped.',
    colDept: 'Department', colSum: 'Total', colAvg: 'Average', view: 'View', edit: 'View / change', backToSum: 'Back to summary', issueMissingOne: 'Missing (required)', noIssueOne: 'Not written',
    pickDept: 'Choose a department…', missMark: ' · blocker missing', noRecords: 'No submitted or closed peer review yet.', noMine: 'You are not a head of department, so there are no department results to show.',
  },
};

const localDay = (iso) => fmtDate(iso);
const hasScore = (a, k) => !!a && !!a.scores && a.scores[k] !== undefined && a.scores[k] !== null && a.scores[k] !== '';
// 与服务端 checkAnswer().scored 一致：至少一个维度打了大于 0 的分；全空或全「不适用」= 跳过
const scoredOf = (a, dims) => dims.some((d) => hasScore(a, d.key) && Number(a.scores[d.key]) > 0);
const issueOf = (a) => String((a && a.issue) || '').trim();

function Round({ r, dims, bands, issuePrompt, s, lang, onDone }) {
  const done = !!r.submittedAt || r.status !== 'open';
  const N = r.targets.length;
  const [answers, setAnswers] = useState(() => r.answers || {});
  const [step, setStep] = useState(() => (done ? N : 0));   // 0..N-1 = 第几个部门；N = 确认页（已提交 / 已结束时直接显示汇总）
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const [asking, setAsking] = useState(false);
  const [guide, setGuide] = useState(true);
  // 负责人 10/12：从汇总表点进某个部门（或已提交 / 已结束只读查看）时，底部是「返回汇总」，不是上一个 / 下一个部门
  const [fromSum, setFromSum] = useState(false);
  const dirty = useRef(false);
  const top = useRef(null);
  useEffect(() => { setAnswers(r.answers || {}); dirty.current = false; }, [r]);
  const scored = r.targets.filter((t) => scoredOf(answers[t.dept1Id], dims));
  const skipped = r.targets.filter((t) => !scoredOf(answers[t.dept1Id], dims));
  const needIssue = r.issueRequired ? scored.filter((t) => !issueOf(answers[t.dept1Id])) : [];

  const setScore = (tid, k, v) => {
    dirty.current = true;
    setAnswers((all) => { const cur = all[tid] || {}; const sc = { ...(cur.scores || {}) }; if (v === null) delete sc[k]; else sc[k] = v; return { ...all, [tid]: { scores: sc, issue: cur.issue || '' } }; });
  };
  const setIssue = (tid, v) => { dirty.current = true; setAnswers((all) => ({ ...all, [tid]: { scores: (all[tid] && all[tid].scores) || {}, issue: v } })); };
  // 跳过的部门不带卡点文字（免得留下没打分部门的卡点）
  const payload = () => Object.fromEntries(Object.entries(answers).map(([tid, x]) => [tid, { scores: (x && x.scores) || {}, issue: scoredOf(x, dims) ? (x.issue || '') : '' }]));
  const save = async (submit) => {
    setBusy(true); setMsg(null);
    let ok = false;
    try {
      await api.put(`/api/me/reviews/orgperf/rounds/${encodeURIComponent(r.id)}`, { dept1Id: r.dept1Id, answers: payload(), submit: !!submit });
      dirty.current = false; ok = true;
      if (submit) { setMsg({ err: false, text: s.submittedOk }); onDone(); }
    } catch (e) {
      const d = e && e.data;
      setMsg({ err: true, text: d && d.code === 'issue_required' ? s.issueMissing((d.missing || []).length) : s.err + ((d && (lang === 'zh' ? d.error_zh || d.error : d.error)) || (e && e.message) || '') });
    }
    setBusy(false); setAsking(false);
    return ok;
  };
  const go = async (to) => {
    if (!done && dirty.current && !(await save(false))) return;   // 翻页自动存草稿；存不上就停在本页
    setMsg(null);
    setStep(to);
    if (top.current && top.current.scrollIntoView) top.current.scrollIntoView({ block: 'start', behavior: 'smooth' });
  };

  const t = step < N ? r.targets[step] : null;
  const a = t ? answers[t.dept1Id] || {} : null;
  const isScored = t ? scoredOf(a, dims) : false;
  const blocked = !!t && !done && !!r.issueRequired && isScored && !issueOf(a);
  const pct = N ? Math.round((Math.min(step + (t ? 1 : 0), N) / N) * 100) : 100;
  const jump = done || fromSum;   // 跳转模式：返回汇总 + 下拉切换部门
  const toSummary = () => { setFromSum(false); go(N); };
  const open = (i) => { setFromSum(true); go(i); };
  // 汇总表一行：各维度分（不适用显示「不适用」）、合计、平均（只算大于 0 的分，与服务端口径一致）
  const rowOf = (x) => {
    const sc = (answers[x.dept1Id] && answers[x.dept1Id].scores) || {};
    const vals = dims.map((d) => (hasScore(answers[x.dept1Id], d.key) ? Number(sc[d.key]) : null));
    const pos = vals.filter((v) => v != null && v > 0);
    const sum = pos.reduce((a2, b) => a2 + b, 0);
    return { vals, sum, avg: pos.length ? Math.round((sum / pos.length) * 10) / 10 : null };
  };
  const deptPick = (cur) => (
    <select className="rv-inp op-dept-sel" value={cur} aria-label={s.pickDept} onChange={(e) => { if (e.target.value !== '') open(Number(e.target.value)); }}>
      {cur === '' && <option value="">{s.pickDept}</option>}
      {[[scored, s.scoredL], [skipped, s.skippedL]].map(([list, label]) => list.length > 0 && (
        <optgroup key={label} label={`${label}（${list.length}）`}>
          {list.map((x) => <option key={x.dept1Id} value={r.targets.indexOf(x)}>{x.dept1}{needIssue.includes(x) ? s.missMark : ''}</option>)}
        </optgroup>
      ))}
    </select>
  );

  return (
    <section className="card op-round" ref={top}>
      <div className="op-round-h">
        <h2>{r.name}</h2>
        <span className="tdb-h">{r.dept1}{r.dueOn ? ` · ${s.due(r.dueOn)}` : ''}</span>
        {r.submittedAt ? <span className="pill ok">{s.submittedAt(localDay(r.submittedAt))}</span> : r.status !== 'open' ? <span className="pill muted">{s.closed}</span> : null}
      </div>
      {!done && step === 0 && <p className="ml-lead">{s.lead}</p>}

      {!(t && jump) && !(done && !t) && <div className="op-progress">
        <span className="op-progress-t tnum">{t ? s.stepOf(step + 1, N) : (done ? s.reviewDone : s.reviewTitle)}</span>
        <span className="op-progress-bar" aria-hidden="true"><i style={{ width: pct + '%' }} /></span>
      </div>}

      {t && (
        <div className="op-step">
          <div className="op-step-top">
            <h3 className="op-step-h">{t.dept1}</h3>
            {jump && deptPick(step)}
          </div>
          <button type="button" className="link-btn" onClick={() => setGuide((v) => !v)}>{guide ? s.hideRubric : s.showRubric}</button>
          {guide && (
            <div className="op-rubric" role="table" aria-label={s.rubric}>
              <div className="op-rubric-row op-rubric-head" role="row">
                <span role="columnheader" />
                {bands.map((b) => <span key={b.from} role="columnheader" className={'op-band op-band-' + b.from}><b className="tnum">{b.from}–{b.to}</b> {lang === 'zh' ? b.zh : b.en}</span>)}
              </div>
              {dims.map((d) => (
                <div key={d.key} className="op-rubric-row" role="row">
                  <span role="rowheader"><b>{lang === 'zh' ? d.zh : d.en}</b><small>{lang === 'zh' ? d.subZh : d.subEn}</small></span>
                  {d.bands.map((x, k) => <span key={k} role="cell">{lang === 'zh' ? x[0] : x[1]}</span>)}
                </div>
              ))}
            </div>
          )}
          {dims.map((d) => {
            const v = hasScore(a, d.key) ? Number(a.scores[d.key]) : null;
            const bi = v && v > 0 ? Math.min(4, Math.floor((v - 1) / 2)) : -1;
            return (
              <div key={d.key} className="op-dim2" role="group" aria-label={lang === 'zh' ? d.zh : d.en}>
                <div className="op-dim2-h"><b>{lang === 'zh' ? d.zh : d.en}</b><small>{lang === 'zh' ? d.subZh : d.subEn}</small></div>
                <div className="op-chips">
                  {Array.from({ length: 10 }, (_, k) => k + 1).map((n) => (
                    <button key={n} type="button" className={'op-chip tnum' + (v === n ? ' on' : '')} aria-pressed={v === n} disabled={done || busy} onClick={() => setScore(t.dept1Id, d.key, v === n ? null : n)}>{n}</button>
                  ))}
                  <button type="button" className={'op-chip op-chip-na' + (v === 0 ? ' on' : '')} aria-pressed={v === 0} disabled={done || busy} onClick={() => setScore(t.dept1Id, d.key, v === 0 ? null : 0)}>{s.na}</button>
                </div>
                {bi >= 0 && bands[bi] && d.bands[bi] && <div className={'op-hint op-hint-' + bands[bi].from}><b className="tnum">{v} {s.score}</b> · {lang === 'zh' ? bands[bi].zh : bands[bi].en}：{lang === 'zh' ? d.bands[bi][0] : d.bands[bi][1]}</div>}
              </div>
            );
          })}
          {isScored ? (
            <label className="op-issue">
              <span><b>{s.issue}</b>{r.issueRequired ? s.issueReq : s.issueOpt}</span>
              <textarea rows={3} maxLength={1000} value={(a && a.issue) || ''} disabled={done || busy} placeholder={lang === 'zh' ? issuePrompt.zh : issuePrompt.en} onChange={(e) => setIssue(t.dept1Id, e.target.value)} />
            </label>
          ) : !done && <p className="tdb-h op-skip">{s.skipHint}</p>}
          {blocked && <div className="rv-msg err" role="status">{s.issueNeed}</div>}
        </div>
      )}

      {!t && (
        <div className="op-review">
          <div className="op-review-n"><span className="pill ok tnum">{s.scoredN(scored.length)}</span><span className="pill muted tnum">{s.skippedN(skipped.length)}</span></div>
          {/* 负责人 10/12：汇总 = 已打分部门的列表（各维度分、合计、平均、卡点），点行查看 / 修改；跳过的几十个部门不平铺，用下拉框打开 */}
          {scored.length > 0 && (
            <div className="op-sum-wrap">
              <table className="rv-tbl op-sum-tbl">
                <thead><tr>
                  <th>{s.colDept}</th>
                  {dims.map((d) => <th key={d.key} className="num">{lang === 'zh' ? d.zh : d.en}</th>)}
                  <th className="num">{s.colSum}</th><th className="num">{s.colAvg}</th><th>{s.issue}</th><th />
                </tr></thead>
                <tbody>
                  {scored.map((x) => { const row = rowOf(x); const iss = issueOf(answers[x.dept1Id]); return (
                    <tr key={x.dept1Id} className={needIssue.includes(x) ? 'miss' : undefined}>
                      <td><b>{x.dept1}</b></td>
                      {row.vals.map((v, k) => <td key={k} className="num tnum">{v == null ? '—' : v === 0 ? s.na : v}</td>)}
                      <td className="num tnum"><b>{row.sum}</b></td>
                      <td className="num tnum">{row.avg == null ? '—' : row.avg}</td>
                      <td className="op-sum-issue">{iss ? <span title={iss}>{iss}</span> : <span className="tdb-h">{needIssue.includes(x) ? s.issueMissingOne : s.noIssueOne}</span>}</td>
                      <td className="num"><button type="button" className="link-btn" onClick={() => open(r.targets.indexOf(x))}>{done ? s.view : s.edit}</button></td>
                    </tr>
                  ); })}
                </tbody>
              </table>
            </div>
          )}
          {/* 互评记录（已提交 / 已结束）：只看表格，一目了然；跳过的部门只写数量 */}
          {done ? (scored.length === 0 ? <p className="tdb-h">{s.noneScoredRo}</p> : <p className="tdb-h">{s.skippedRest(skipped.length)}</p>) : (
            <label className="op-review-pick">
              <span className="tdb-h">{s.reviewHint}</span>
              {deptPick('')}
            </label>
          )}
          {!done && scored.length === 0 && <p className="rv-msg">{s.noneScored}</p>}
          {!done && needIssue.length > 0 && <p className="rv-msg err">{s.issueMissing(needIssue.length)}</p>}
        </div>
      )}

      {msg && <div className={'rv-msg' + (msg.err ? ' err' : '')} role="status">{msg.text}</div>}
      <div className="op-acts">
        {t && jump && <button type="button" className="btn ghost" disabled={busy} onClick={toSummary}>{s.backToSum}</button>}
        {!jump && step > 0 && <button type="button" className="btn ghost" disabled={busy} onClick={() => go(step - 1)}>{t ? s.prev : s.backToList}</button>}
        <span className="op-acts-gap" />
        {!done && t && <button type="button" className="btn ghost" disabled={busy} onClick={async () => { if (await save(false)) setMsg({ err: false, text: s.saved }); }}>{busy ? s.saving : s.save}</button>}
        {t && !jump && <button type="button" className="btn" disabled={busy || blocked} onClick={() => go(step + 1)}>{step === N - 1 ? s.toReview : s.next}</button>}
        {!done && !t && <button type="button" className="btn" disabled={busy || needIssue.length > 0} onClick={() => setAsking(true)}>{s.submit}</button>}
      </div>
      {asking && (
        <Overlay kind="exam" boxClassName="rv-ap-dialog" label={s.askTitle} busy={busy} onClose={() => setAsking(false)}>
            <h3>{s.askTitle}</h3>
            <p>{s.askBody}</p>
            <p className="tdb-h tnum">{s.scoredN(scored.length)} · {s.skippedN(skipped.length)}</p>
            <div className="exam-dialog-act">
              <button type="button" className="btn ghost" disabled={busy} onClick={() => setAsking(false)}>{s.cancel}</button>
              <button type="button" className="btn" autoFocus disabled={busy} onClick={() => save(true)}>{s.submit}</button>
            </div>
        </Overlay>
      )}
    </section>
  );
}

function Mine({ m, dims, s, lang }) {
  const p = m.peer;
  return (
    <section className="card op-mine">
      <h2>{s.mineTitle(m.dept1)}</h2>
      <div className="tdb-h">{s.results}</div>
      {m.results.length === 0 ? <p className="tdb-h">{s.noResults}</p> : (
        <ul className="tdb-list">{m.results.map((x) => <li key={x.quarter}><span className="tnum">{x.quarter}</span><b>{x.rating}</b></li>)}</ul>
      )}
      {m.pending && <p className="tdb-h">{s.peerPending(m.pending.name)}</p>}
      {!p ? (!m.pending && <p className="tdb-h">{s.peerNone}</p>) : p.hidden ? <p className="tdb-h">{s.peerHidden(p.minRaters)}</p> : (
        <>
          <div className="tdb-h" style={{ marginTop: 12 }}>{s.peerTitle(p.name)} · {s.ratersN(p.raters)}</div>
          <ul className="tdb-list">
            {dims.map((d) => <li key={d.key}><span>{lang === 'zh' ? d.zh : d.en}</span><b className="tnum">{p.dims[d.key] && p.dims[d.key].avg != null ? p.dims[d.key].avg : (p.dims[d.key] && p.dims[d.key].few ? s.dimFew(p.minRaters || 3, p.dims[d.key].n || 0) : '—')}</b></li>)}
            <li><span>{s.overall}</span><b className="tnum">{p.overall == null ? '—' : p.overall}</b></li>
          </ul>
          <div className="tdb-h" style={{ marginTop: 12 }}>{s.issues}{s.issuesAnon}</div>
          {p.issues.length ? <ol className="op-issues">{p.issues.map((t, k) => <li key={k}>{t}</li>)}</ol> : <p className="tdb-h">{s.noIssues}</p>}
        </>
      )}
    </section>
  );
}

// tab（负责人 10/12，组织绩效下三个页签）：fill = 待填写的互评；records = 已提交或已结束的互评；result = 本部门组织绩效
export default function OrgPeerReview({ lang, tab = 'fill' }) {
  const s = T[lang === 'zh' ? 'zh' : 'en'];
  const q = useAsync(() => api.get('/api/me/reviews/orgperf'), []);
  const d = q.data;
  const dims = useMemo(() => (d && Array.isArray(d.dims) ? d.dims : []), [d]);
  if (q.loading && !d) return <div className="card rv-empty">…</div>;
  if (!d) return null;
  if (tab === 'result') {
    const mine = d.mine || [];
    return <div className="op-me">{mine.length === 0 ? <div className="card rv-empty">{s.noMine}</div> : mine.map((m) => <Mine key={m.dept1Id} m={m} dims={dims} s={s} lang={lang} />)}</div>;
  }
  const isDone = (r) => !!r.submittedAt || r.status !== 'open';
  const rounds = d.rounds.filter((r) => (tab === 'records' ? isDone(r) : !isDone(r)));
  return (
    <div className="op-me">
      {rounds.length === 0 ? <div className="card rv-empty">{tab === 'records' ? s.noRecords : s.none}</div>
        : rounds.map((r) => <Round key={r.id + ':' + r.dept1Id} r={r} dims={Array.isArray(r.dims) && r.dims.length ? r.dims : dims} bands={d.bands || []} issuePrompt={d.issuePrompt || { zh: '', en: '' }} s={s} lang={lang} onDone={q.reload} />)}
    </div>
  );
}
