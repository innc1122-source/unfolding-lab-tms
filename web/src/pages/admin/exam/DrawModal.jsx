// 组卷「随机抽题，再调整」弹窗（第四批 6.2，短操作用弹窗）：每个题型抽几道（显示题库可用数）、案例几组、
// 按模块均衡（默认开）、只从未加入的题中抽、结果替换试卷（默认）或追加到末尾。
// 抽题本身是纯函数 drawPaper（drawPaper.js，test/exam-draw.test.js）。某个题型不够抽时先在弹窗里说明
// 「单选只抽到 30 题（需要 40）」，确认后才写进试卷。
import { useEffect, useMemo, useState } from 'react';
import { Modal, InputNumber, Checkbox, RadioGroup, Radio, Banner } from '@douyinfe/semi-ui';
import { typeLabel, enabledTypes } from '../../../qtypes/index.jsx';
import { drawPaper } from './drawPaper.js';

const T = {
  zh: {
    title: '随机抽题', lead: '按规则先抽一套，再在试卷上调整。',
    avail: (n) => `可用 0–${n}`, caseLabel: '情境案例（组）',
    balance: '按模块均衡抽取', onlyNew: '只从未加入的题中抽',
    result: '抽出的题', replace: '替换当前试卷', append: '追加到末尾',
    draw: '抽题', applyAnyway: '仍然应用', cancel: '取消',
    short: (t, got, want) => `${t}只抽到 ${got} 题（需要 ${want}）`,
    shortCase: (got, want) => `情境案例只抽到 ${got} 组（需要 ${want}）`,
    shortLead: '题库不够，以下题型没有抽满：',
    nothing: '请至少为一个题型填写抽题数。',
    capNote: (n) => `试卷最多 ${n} 题，超出的部分不会加入。`,
  },
  en: {
    title: 'Draw at random', lead: 'Draw a paper by rule, then adjust it.',
    avail: (n) => `0–${n} available`, caseLabel: 'Scenario cases (groups)',
    balance: 'Spread evenly across modules', onlyNew: 'Only questions not yet on the paper',
    result: 'Drawn questions', replace: 'Replace the paper', append: 'Append',
    draw: 'Draw', applyAnyway: 'Apply anyway', cancel: 'Cancel',
    short: (t, got, want) => `${t}: only ${got} drawn (needed ${want})`,
    shortCase: (got, want) => `Scenario cases: only ${got} drawn (needed ${want})`,
    shortLead: 'The bank is short for these types:',
    nothing: 'Enter a count for at least one type.',
    capNote: (n) => `A paper holds up to ${n} questions; the rest will not be added.`,
  },
};

export default function DrawModal({ visible, lang, pool, paper, cap, onCancel, onApply }) {
  const s = T[lang] || T.en;
  const [counts, setCounts] = useState({});
  const [balance, setBalance] = useState(true);
  const [onlyNew, setOnlyNew] = useState(false);
  const [mode, setMode] = useState('replace');
  const [pending, setPending] = useState(null); // 已抽出、但有题型没抽满，等确认
  const [err, setErr] = useState('');

  useEffect(() => { if (visible) { setPending(null); setErr(''); } }, [visible]);

  const onPaper = useMemo(() => new Set((paper || []).map(String)), [paper]);
  const source = useMemo(() => (onlyNew ? (pool || []).filter((q) => !onPaper.has(String(q.id))) : (pool || [])), [pool, onlyNew, onPaper]);
  const avail = useMemo(() => {
    const m = {};
    for (const q of source) m[q.type] = (m[q.type] || 0) + 1;
    return m;
  }, [source]);
  const types = enabledTypes().filter((t) => (pool || []).some((q) => q.type === t));

  const setCount = (t, v) => { setPending(null); setErr(''); setCounts((c) => ({ ...c, [t]: v == null || v === '' ? 0 : Math.max(0, Math.round(Number(v)) || 0) })); };

  const run = () => {
    if (pending) { onApply(pending.ids, mode); return; }
    const want = Object.fromEntries(types.map((t) => [t, counts[t] || 0]));
    if (!Object.values(want).some((n) => n > 0)) { setErr(s.nothing); return; }
    const r = drawPaper(source, { counts: want, balance }, Math.random);
    if (r.short.length) { setPending(r); return; }
    onApply(r.ids, mode);
  };

  const total = types.reduce((a, t) => a + (counts[t] || 0), 0);
  const willOverflow = (mode === 'append' ? (paper || []).length : 0) + total > cap;

  return (
    <Modal
      title={s.title}
      visible={visible}
      onCancel={onCancel}
      onOk={run}
      okText={pending ? s.applyAnyway : s.draw}
      cancelText={s.cancel}
      width={520}
      maskClosable={false}
    >
      <p className="exd-lead">{s.lead}</p>
      <div className="exd-grid">
        {types.map((t) => (
          <label key={t} className="exd-row">
            <span className="exd-type">{t === 'case' ? s.caseLabel : typeLabel(t, lang)}</span>
            <InputNumber min={0} max={200} precision={0} value={counts[t] || 0} onChange={(v) => setCount(t, v)} style={{ width: 96 }} aria-label={t === 'case' ? s.caseLabel : typeLabel(t, lang)} />
            <span className="exd-avail tnum">{s.avail(avail[t] || 0)}</span>
          </label>
        ))}
      </div>
      <div className="exd-opts">
        <Checkbox checked={balance} onChange={(e) => { setPending(null); setBalance(!!(e && e.target && e.target.checked)); }}>{s.balance}</Checkbox>
        <Checkbox checked={onlyNew} onChange={(e) => { setPending(null); setOnlyNew(!!(e && e.target && e.target.checked)); }}>{s.onlyNew}</Checkbox>
      </div>
      <div className="exd-mode">
        <span className="exd-type">{s.result}</span>
        <RadioGroup type="button" value={mode} onChange={(e) => setMode(e.target.value)}>
          <Radio value="replace">{s.replace}</Radio>
          <Radio value="append">{s.append}</Radio>
        </RadioGroup>
      </div>
      {willOverflow && <Banner type="warning" closeIcon={null} className="exd-banner" description={s.capNote(cap)} />}
      {err && <Banner type="danger" closeIcon={null} className="exd-banner" description={err} />}
      {pending && pending.short.length > 0 && (
        <Banner
          type="warning"
          closeIcon={null}
          className="exd-banner"
          description={(
            <>
              <div>{s.shortLead}</div>
              <ul className="exd-short">
                {pending.short.map((x) => (
                  <li key={x.type}>{x.type === 'case' ? s.shortCase(x.got, x.want) : s.short(typeLabel(x.type, lang, true), x.got, x.want)}</li>
                ))}
              </ul>
            </>
          )}
        />
      )}
    </Modal>
  );
}
