// 指派弹窗共用布局（UI 批 U2 11.5 / F52，2026-10-09）：课程库「指派课程」与培养项目「添加学员」两处同一套结构。
//   AssignModes    页签，固定顺序：按条件 / 粘贴工号 / 逐个选择（内部键仍是 'dept' | 'paste' | 'pick'）
//   AssignCriteria 条件两行：左侧标签、右侧等宽选择框 ——「部门（含下级，可多选）」「职级（可多选）」；职级区间在职级下拉里
//   AssignResult   醒目的人数结果条：主数字（将新指派 / 将新加入 X 人）+ 符合条件 / 跳过 / 未设职级 / 工号未找到，附「查看名单」
//   AssignFooter   底部一行：左侧截止日期等参数，右侧 取消 / 主按钮；主按钮不可用时在按钮旁写明原因
//   AssignHelp     标题旁的「?」：说明文字收进悬停提示，不再占两行正文
//   assignBlockReason(...)  主按钮不可用的原因键（见 T.why），可用时返回 null
// 选人逻辑与接口调用仍留在各自弹窗里（课程指派 POST /api/admin/assignments/bulk，加学员 POST /api/admin/tprojects/:id/members），
// 这里只管排版与共用文字。
import { useState } from 'react';
import { Button, Tooltip } from '@douyinfe/semi-ui';
import { IconHelpCircle } from '@douyinfe/semi-icons';
import { useI18n } from '../i18n.jsx';

const T = {
  zh: {
    modesLab: '选人方式', byCond: '按条件', byPaste: '粘贴工号', byPick: '逐个选择',
    deptLab: '部门', deptSub: '含下级，可多选', gradeLab: '职级', gradeSub: '可多选',
    help: '说明', unit: '人',
    showList: '查看名单', hideList: '收起名单', listMore: (n) => `等，共 ${n} 人`,
    why: {
      cond: '请先选择部门或职级',
      paste: '请先粘贴工号',
      pick: '请先选择员工',
      tree: '组织架构加载中，请稍候',
      nomatch: '没有符合条件的员工',
      none: '符合条件的员工都已在名单中，没有需要新增的人员',
    },
  },
  en: {
    modesLab: 'How to choose people', byCond: 'By criteria', byPaste: 'Paste IDs', byPick: 'Pick individually',
    deptLab: 'Department', deptSub: 'includes sub-departments; multiple allowed', gradeLab: 'Job grade', gradeSub: 'multiple allowed',
    help: 'About this', unit: '',
    showList: 'View list', hideList: 'Hide list', listMore: (n) => `and more, ${n} in total`,
    why: {
      cond: 'Choose a department or a job grade first',
      paste: 'Paste employee IDs first',
      pick: 'Pick employees first',
      tree: 'Loading the organization structure…',
      nomatch: 'No employees match',
      none: 'Everyone who matches is already included; there is nobody new to add',
    },
  },
};

const MODES = [['dept', 'byCond'], ['paste', 'byPaste'], ['pick', 'byPick']];

export function AssignModes({ mode, onChange }) {
  const { lang } = useI18n();
  const s = T[lang] || T.zh;
  return (
    <div className="asg-modes" role="tablist" aria-label={s.modesLab}>
      {MODES.map(([k, label]) => (
        <button key={k} type="button" role="tab" aria-selected={mode === k}
          className={'asg-mode' + (mode === k ? ' on' : '')} onClick={() => onChange(k)}>
          {s[label]}
        </button>
      ))}
    </div>
  );
}

export function AssignCriteria({ dept, grade }) {
  const { lang } = useI18n();
  const s = T[lang] || T.zh;
  return (
    <div className="asg-crit">
      <div className="asg-crit-lab">{s.deptLab}<span className="asg-crit-sub">{s.deptSub}</span></div>
      <div className="asg-crit-ctl">{dept}</div>
      <div className="asg-crit-lab">{s.gradeLab}<span className="asg-crit-sub">{s.gradeSub}</span></div>
      <div className="asg-crit-ctl">{grade}</div>
    </div>
  );
}

// main = { label, n }；items = [{ key, label, n, tone?: 'warn' | 'bad' }]，为 0 也照常显示（验收 U-5 逐项核对名单）；names = 将新增人员的显示名
export function AssignResult({ main, items, names }) {
  const { lang } = useI18n();
  const s = T[lang] || T.zh;
  const [open, setOpen] = useState(false);
  const list = names || [];
  const shown = (items || []).filter(Boolean);
  const CAP = 200;
  return (
    <div className={'asg-result' + (main.n > 0 ? ' has' : '')} role="status" aria-live="polite">
      <div className="asg-result-row">
        <div className="asg-result-main">
          <span className="asg-result-k">{main.label}</span>
          <b className="asg-result-n tnum">{main.n}</b>
          <span className="asg-result-u">{s.unit}</span>
        </div>
        {shown.length > 0 && (
          <div className="asg-result-items">
            {shown.map((x) => (
              <span key={x.key} className={'asg-ri' + (x.tone ? ' ' + x.tone : '')}>{x.label} <b className="tnum">{x.n}</b></span>
            ))}
          </div>
        )}
        {list.length > 0 && (
          <button type="button" className="asg-result-toggle" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
            {open ? s.hideList : s.showList}
          </button>
        )}
      </div>
      {open && list.length > 0 && (
        <div className="asg-result-list">
          {list.slice(0, CAP).join('、')}
          {list.length > CAP ? ' ' + s.listMore(list.length) : ''}
        </div>
      )}
    </div>
  );
}

export function AssignFooter({ left, reason, cancelText, onCancel, okText, onOk, loading }) {
  const { lang } = useI18n();
  const s = T[lang] || T.zh;
  return (
    <div className="asg-foot">
      <div className="asg-foot-l">{left}</div>
      <div className="asg-foot-r">
        {reason && <span className="asg-why" role="note">{s.why[reason] || ''}</span>}
        <Button onClick={onCancel}>{cancelText}</Button>
        <Button theme="solid" type="primary" loading={loading} disabled={!!reason} onClick={onOk}
          title={reason ? s.why[reason] : undefined}>{okText}</Button>
      </div>
    </div>
  );
}

export function AssignHelp({ text }) {
  const { lang } = useI18n();
  const s = T[lang] || T.zh;
  if (!text) return null;
  return (
    <Tooltip content={<div className="asg-help-tip">{text}</div>} position="bottomLeft">
      <button type="button" className="asg-help" aria-label={s.help}><IconHelpCircle size="small" /></button>
    </Tooltip>
  );
}

// 主按钮不可用的原因。mode：'dept'（按条件）| 'paste' | 'pick'。
//   criteria：按条件时是否选了部门或职级；waitTree：选了部门但部门树还没就绪；
//   input：粘贴的工号个数 / 逐个选择的人数；matched：符合条件的人数（含已在名单中的）；fresh：将新增的人数。
export function assignBlockReason({ mode, criteria, waitTree, input, matched, fresh }) {
  if (fresh > 0) return null;
  if (mode === 'dept') {
    if (!criteria) return 'cond';
    if (waitTree) return 'tree';
  } else if (mode === 'paste') {
    if (!input) return 'paste';
  } else if (!input) return 'pick';
  return matched > 0 ? 'none' : 'nomatch';
}
