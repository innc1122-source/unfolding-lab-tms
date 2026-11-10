// 培训筛选控件（第三批 4.1 / 4.3 / 8.6，2026-10-08；设计 b3-design §17「Shared front-end contracts」）
// 培训概览（G3）与课程库（G4）共用同一组类别 / 修读类型 / 授课方式下拉，课程指派与培养项目加学员共用职级下拉。
//
//   CategorySelect({ value: string[], onChange(string[]), inUse?: string[], includeNone = true, size?, className?, insetLabel?, placeholder? })
//       多选；选项 = 类别目录（categories.js）+ 正在使用的自定义值，按语言显示标签，值永远是中文键；
//       includeNone 时末尾有「未分类」（值 '__none'）。不选 = 全部类别（占位文字「全部类别」）。
//   EnrollSelect({ value: '' | 'mandatory' | 'elective', onChange, size?, className?, insetLabel?, allLabel? })
//   ModeSelect({ value: '' | 'online' | 'offline', onChange, size?, className?, insetLabel?, allLabel? })
//       单选；第一项是「全部」（值 ''）。
//   PublicSelect({ value: '' | '1' | '0', onChange, … })            第四批 7：课程库「公开课程」筛选
//   SourceSelect({ value: '' | 'assigned' | 'self', onChange, … })  第四批 7：培训概览「来源」筛选（指派 / 自主学习）
//   JobGradeSelect({ value: string[], onChange(string[]), ranks, inUse?, size?, className? })
//       多选职级；下拉底部「选择区间：从 … 至 … 加入」（UI 批 U2 11.5 并入下拉，原先单独一行）。ranks = GET /api/admin/job-grades 的 ranks。
//   parseList(str) → string[]   地址栏逗号列表 → 数组（去空、去重）
//   joinList(arr) → string|null 数组 → 逗号列表；空数组 → null（patch 时删掉该键）
import { useMemo, useState } from 'react';
import { Select, Button } from '@douyinfe/semi-ui';
import { useI18n } from '../i18n.jsx';
import { categoryOptions, UNCATEGORIZED } from '../categories.js';
import { gradeOptions, ranksInRange } from '../jobgrades.js';

const T = {
  zh: {
    fCat: '课程类别', fCatAll: '全部类别', catNone: '未分类',
    fEnroll: '修读类型', fEnrollAll: '全部修读类型', enrollReq: '必修', enrollEle: '选修',
    fMode: '授课方式', fModeAll: '全部授课方式', modeOn: '线上', modeOff: '线下',
    fGrade: '职级', fGradeAll: '选择一个或多个职级', gradeFrom: '选择区间：从', gradeTo: '至', gradeAdd: '加入',
    trackP: '专业序列（P）', trackM: '管理序列（M）', trackOther: '其他职级',
    fPub: '公开课程', fPubAll: '全部（公开与非公开）', pubYes: '公开课程', pubNo: '非公开课程',
    fSrc: '来源', fSrcAll: '全部来源', srcAssigned: '指派', srcSelf: '自主学习',
  },
  en: {
    fCat: 'Category', fCatAll: 'All categories', catNone: 'Uncategorized',
    fEnroll: 'Requirement type', fEnrollAll: 'Any requirement type', enrollReq: 'Required', enrollEle: 'Elective',
    fMode: 'Delivery', fModeAll: 'Any delivery', modeOn: 'Online', modeOff: 'In-person',
    fGrade: 'Job grade', fGradeAll: 'Pick one or more job grades', gradeFrom: 'Range: from', gradeTo: 'to', gradeAdd: 'Add',
    trackP: 'Professional track (P)', trackM: 'Management track (M)', trackOther: 'Other grades',
    fPub: 'Public course', fPubAll: 'Public and not public', pubYes: 'Public courses', pubNo: 'Not public',
    fSrc: 'Source', fSrcAll: 'All sources', srcAssigned: 'Assigned', srcSelf: 'Self-directed',
  },
};

export function parseList(str) {
  if (Array.isArray(str)) return [...new Set(str.map((x) => String(x).trim()).filter(Boolean))];
  return [...new Set(String(str == null ? '' : str).split(',').map((x) => x.trim()).filter(Boolean))];
}
export function joinList(arr) {
  const list = parseList(arr || []);
  return list.length ? list.join(',') : null;
}

export function CategorySelect({ value, onChange, inUse = [], includeNone = true, size, className, insetLabel, placeholder }) {
  const { lang } = useI18n();
  const s = T[lang] || T.zh;
  const opts = useMemo(() => {
    const list = categoryOptions(lang, inUse);
    return includeNone ? [...list, { label: s.catNone, value: UNCATEGORIZED }] : list;
  }, [lang, inUse, includeNone, s.catNone]);
  return (
    <Select
      multiple filter showClear maxTagCount={2} size={size}
      className={'tf-select tf-cat' + (className ? ' ' + className : '')}
      insetLabel={insetLabel} aria-label={s.fCat}
      placeholder={placeholder || s.fCatAll}
      value={Array.isArray(value) ? value : []}
      onChange={(v) => onChange(Array.isArray(v) ? v : [])}
      optionList={opts}
    />
  );
}

export function EnrollSelect({ value, onChange, size, className, insetLabel, allLabel }) {
  const { lang } = useI18n();
  const s = T[lang] || T.zh;
  return (
    <Select
      size={size} className={'tf-select tf-enroll' + (className ? ' ' + className : '')}
      insetLabel={insetLabel} aria-label={s.fEnroll}
      value={value || ''} onChange={(v) => onChange(v || '')}
      optionList={[
        { value: '', label: allLabel || s.fEnrollAll },
        { value: 'mandatory', label: s.enrollReq },
        { value: 'elective', label: s.enrollEle },
      ]}
    />
  );
}

export function ModeSelect({ value, onChange, size, className, insetLabel, allLabel }) {
  const { lang } = useI18n();
  const s = T[lang] || T.zh;
  return (
    <Select
      size={size} className={'tf-select tf-mode' + (className ? ' ' + className : '')}
      insetLabel={insetLabel} aria-label={s.fMode}
      value={value || ''} onChange={(v) => onChange(v || '')}
      optionList={[
        { value: '', label: allLabel || s.fModeAll },
        { value: 'online', label: s.modeOn },
        { value: 'offline', label: s.modeOff },
      ]}
    />
  );
}

// 第四批 7：课程库「公开课程」筛选（地址栏 pub = '1' 公开 | '0' 非公开 | 空 = 全部）
export function PublicSelect({ value, onChange, size, className, insetLabel, allLabel }) {
  const { lang } = useI18n();
  const s = T[lang] || T.zh;
  return (
    <Select
      size={size} className={'tf-select tf-pub' + (className ? ' ' + className : '')}
      insetLabel={insetLabel} aria-label={s.fPub}
      value={value || ''} onChange={(v) => onChange(v || '')}
      optionList={[
        { value: '', label: allLabel || s.fPubAll },
        { value: '1', label: s.pubYes },
        { value: '0', label: s.pubNo },
      ]}
    />
  );
}

// 第四批 7：培训概览「来源」筛选（地址栏 src = 'assigned' 指派 | 'self' 自主学习 | 空 = 全部）
export function SourceSelect({ value, onChange, size, className, insetLabel, allLabel }) {
  const { lang } = useI18n();
  const s = T[lang] || T.zh;
  return (
    <Select
      size={size} className={'tf-select tf-src' + (className ? ' ' + className : '')}
      insetLabel={insetLabel} aria-label={s.fSrc}
      value={value === 'assigned' || value === 'self' ? value : ''} onChange={(v) => onChange(v || '')}
      optionList={[
        { value: '', label: allLabel || s.fSrcAll },
        { value: 'assigned', label: s.srcAssigned },
        { value: 'self', label: s.srcSelf },
      ]}
    />
  );
}

export function JobGradeSelect({ value, onChange, ranks, inUse = [], size, className }) {
  const { lang } = useI18n();
  const s = T[lang] || T.zh;
  const opts = useMemo(() => gradeOptions(ranks, inUse), [ranks, inUse]);
  const groups = useMemo(() => {
    const by = { P: [], M: [], '': [] };
    for (const o of opts) (by[o.track === 'P' || o.track === 'M' ? o.track : ''] || by['']).push(o);
    return [['P', s.trackP, by.P], ['M', s.trackM, by.M], ['', s.trackOther, by['']]].filter((g) => g[2].length);
  }, [opts, s.trackP, s.trackM, s.trackOther]);
  const cur = Array.isArray(value) ? value : [];
  const [from, setFrom] = useState(undefined);
  const [to, setTo] = useState(undefined);
  const addRange = () => {
    if (!from || !to) return;
    const add = ranksInRange(ranks, from, to);
    onChange([...new Set([...cur, ...add])]);
    setFrom(undefined); setTo(undefined);
  };
  // UI 批 U2 11.5（2026-10-09）：「职级段」并入职级下拉 —— 下拉底部一行「选择区间：从 … 至 … 加入」，不再单独占一行。
  // 区间两端用原生 <select>：它不弹出到 body，点选时不会被外层下拉当成「点到外面」而收起。
  const range = (
    <div className="tf-grade-slot">
      <span className="tf-grade-lab">{s.gradeFrom}</span>
      <select className="tf-grade-end" aria-label={s.gradeFrom} value={from || ''} onChange={(e) => setFrom(e.target.value || undefined)}>
        <option value="" />
        {opts.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
      <span className="tf-grade-lab">{s.gradeTo}</span>
      <select className="tf-grade-end" aria-label={s.gradeTo} value={to || ''} onChange={(e) => setTo(e.target.value || undefined)}>
        <option value="" />
        {opts.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
      <Button size="small" theme="light" disabled={!from || !to} onClick={addRange}>{s.gradeAdd}</Button>
    </div>
  );
  return (
    <div className={'tf-grade' + (className ? ' ' + className : '')}>
      <Select
        multiple filter showClear maxTagCount={8} size={size} style={{ width: '100%' }}
        className="tf-select tf-grade-sel" aria-label={s.fGrade} placeholder={s.fGradeAll}
        value={cur} onChange={(v) => onChange(Array.isArray(v) ? v : [])}
        outerBottomSlot={opts.length ? range : null}
      >
        {groups.map(([k, label, list]) => (
          <Select.OptGroup key={k || 'other'} label={label}>
            {list.map((o) => <Select.Option key={o.value} value={o.value}>{o.label}</Select.Option>)}
          </Select.OptGroup>
        ))}
      </Select>
    </div>
  );
}
