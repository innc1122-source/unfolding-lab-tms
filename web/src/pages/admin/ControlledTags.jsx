// 受控人才标签：高潜 / 关键人才 / 流失风险（12.2 工作台改版，设计 b12 §5 / §7.5；2026-10-09）。
// 员工档案（People.jsx）身份区与「编辑资料」页的「人才发展」区共用：
//   · ControlledTagPills   只显示当前持有的受控标签（显示名按界面语言，取自 controlledTags.js），自由标签由宿主另行渲染；
//   · ControlledTagsEditor 三个开关式胶囊，点击打开确认框：写明「打上 / 取消 某标签」、理由必填（4–300 字，实时字数），
//                          确定后调用 POST /api/admin/employees/:id/controlled-tags { tag, action, reason }，
//                          成功回 { ok, talentTags, event }，宿主据此刷新档案。不随「保存资料」一起提交。
//   · splitTags / reservedKeyOf 给自由标签编辑框用：选项去掉受控值；输入能映射到受控标签的写法时提示并阻止创建。
//   · tagEventTitle / TagEventBody 时间线 source:'tag' 事件的标题文字。
// 受控标签的白名单与写法映射只在 web/src/controlledTags.js（组 1，与服务端 modules/talent/controlled-tags.js 同一份），
// 这里只引用、不复制。只读角色（无 talent 写）只显示胶囊，不显示开关与确认框。
// 「流失风险」不对本人显示（宿主传 hideFlight）：员工本人查看自己的后台档案时，看不到自己的流失风险标签。
import { useState } from 'react';
import { Button, Modal, Tag, TextArea, Toast, Typography } from '@douyinfe/semi-ui';
import { api } from '../../api.js';
import { errText } from '../../apierr.js';
import { useI18n } from '../../i18n.jsx';
import {
  KEYS, CANONICAL, REASON_MIN, REASON_MAX, keyOf, heldKeysOf, freeTagsOf, reasonOf, labelOf,
} from '../../controlledTags.js';

const { Text } = Typography;

/* ---------------- co-located bilingual strings ---------------- */
const T = {
  zh: {
    groupLabel: '受控人才标签',
    hint: '高潜、关键人才与流失风险只能从预设中选择，打上或取消都需要填写理由，并记入档案时间线与审计日志。',
    addTitle: (n) => `打上受控标签：${n}`,
    removeTitle: (n) => `取消受控标签：${n}`,
    addLead: '确认后立即生效，并写入该员工的档案时间线与审计日志。',
    removeLead: '确认后立即取消，并写入该员工的档案时间线与审计日志。',
    reason: '理由',
    reasonPh: '请说明打上或取消这个标签的依据，例如评估结论、盘点会决议或面谈情况',
    reasonRule: `4–300 字`,
    reasonShort: `理由至少 4 字`,
    reasonLong: `理由不能超过 300 字`,
    confirm: '确定', cancel: '取消',
    added: (n) => `已打上「${n}」`,
    removed: (n) => `已取消「${n}」`,
    unchanged: '标签状态没有变化',
    forbidden: '你的角色没有人才发展的编辑权限，不能调整受控标签',
    notFound: '该员工不存在或不在你的数据范围内',
    failed: '操作失败',
    held: '已打上',
    notHeld: '未打上',
    reserved: '这是受控标签，请在上方「受控人才标签」中选择',
    tlAdd: (n) => `打上受控标签：${n}`,
    tlRemove: (n) => `取消受控标签：${n}`,
    tlReason: '理由：',
    tlBy: '操作人：',
    tlSystem: '系统',
    tlDateUnknown: '打标日期不详（存量标签）',
    tlType: '人才标签',
  },
  en: {
    groupLabel: 'Controlled talent tags',
    hint: 'High potential, Key talent and Flight risk can only be chosen from this preset list. Adding or removing one requires a reason and is recorded on the profile timeline and in the audit log.',
    addTitle: (n) => `Add controlled tag: ${n}`,
    removeTitle: (n) => `Remove controlled tag: ${n}`,
    addLead: 'Takes effect immediately and is recorded on this employee\'s profile timeline and in the audit log.',
    removeLead: 'Removed immediately and recorded on this employee\'s profile timeline and in the audit log.',
    reason: 'Reason',
    reasonPh: 'State the basis for adding or removing this tag, e.g. a review outcome, a talent review decision or a conversation with the employee',
    reasonRule: `4–300 characters`,
    reasonShort: `The reason must be at least 4 characters`,
    reasonLong: `The reason cannot exceed 300 characters`,
    confirm: 'Confirm', cancel: 'Cancel',
    added: (n) => `"${n}" added`,
    removed: (n) => `"${n}" removed`,
    unchanged: 'The tag was already in that state',
    forbidden: 'Your role cannot edit talent development data, so controlled tags cannot be changed',
    notFound: 'This employee does not exist or is outside your data scope',
    failed: 'The change could not be saved',
    held: 'Added',
    notHeld: 'Not added',
    reserved: 'This is a controlled tag. Choose it under Controlled talent tags above',
    tlAdd: (n) => `Controlled tag added: ${n}`,
    tlRemove: (n) => `Controlled tag removed: ${n}`,
    tlReason: 'Reason:',
    tlBy: 'By:',
    tlSystem: 'System',
    tlDateUnknown: 'Date tagged unknown (existing tag)',
    tlType: 'Talent tags',
  },
};
export const controlledTagText = (lang) => T[lang === 'zh' ? 'zh' : 'en'];

/* ---------------- thin wrappers over web/src/controlledTags.js ---------------- */
// ---- 受控标签适配纯函数（无 JSX；test/talent-tags-ui.test.js 按源码截取，注入 controlledTags.js 的导出后直接跑）----
// 白名单、写法映射、显示名都在组 1 的 controlledTags.js；这里只按页面需要组合。「持有」用 heldKeysOf（任一写法），
// 与服务端判定「已持有再 add → unchanged」及 PUT 校验 checkTagSubmission 的 current 一侧同口径。
// 任意写法 → 受控 key（不是受控写法时 null）
export const reservedKeyOf = (tag) => keyOf(tag == null ? '' : String(tag));
// 标签数组 → { controlled: [canonical…]（按 KEYS 顺序）, free: [其余，原顺序] }
export const splitTags = (tags) => ({ controlled: heldKeysOf(tags).map((k) => CANONICAL[k]), free: freeTagsOf(tags) });
export const canonicalValues = () => KEYS.map((k) => CANONICAL[k]);
export const tagName = (key, lang) => labelOf(key, lang === 'zh' ? 'zh' : 'en');
// ---- /受控标签适配纯函数 ----

/* ---------------- 胶囊（只读显示） ---------------- */
export function ControlledTagPills({ tags, hideFlight = false }) {
  const { lang } = useI18n();
  const keys = heldKeysOf(tags).filter((k) => !(hideFlight && k === 'flight'));
  return keys.map((k) => <Tag key={k} color="indigo" type="light">{tagName(k, lang)}</Tag>);
}

/* ---------------- 编辑：三个开关式胶囊 + 理由确认框 ---------------- */
export function ControlledTagsEditor({ userId, tags, canWrite, hideFlight = false, onChanged }) {
  const { lang } = useI18n();
  const s = controlledTagText(lang);
  const held = heldKeysOf(tags);
  const [ask, setAsk] = useState(null);          // { key, action }
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [touched, setTouched] = useState(false);
  const keys = KEYS.filter((k) => !(hideFlight && k === 'flight'));

  const len = Array.from(reason.trim()).length;
  const reasonErr = reasonOf(reason) ? '' : len < REASON_MIN ? s.reasonShort : s.reasonLong;
  const open = (key) => { setAsk({ key, action: held.includes(key) ? 'remove' : 'add' }); setReason(''); setTouched(false); };
  const close = () => { if (!busy) setAsk(null); };

  const submit = async () => {
    setTouched(true);
    if (!ask || reasonErr) return;
    setBusy(true);
    try {
      const res = (await api.post(`/api/admin/employees/${encodeURIComponent(userId)}/controlled-tags`, { tag: ask.key, action: ask.action, reason: reasonOf(reason) })) || {};
      const name = tagName(ask.key, lang);
      if (res.unchanged) Toast.info(s.unchanged);
      else Toast.success(ask.action === 'add' ? s.added(name) : s.removed(name));
      setAsk(null);
      if (onChanged) onChanged(res.talentTags);
    } catch (err) {
      const msg = errText(err, {
        reason_required: () => s.reasonShort,
      });
      if (err && err.status === 403) Toast.error(s.forbidden);
      else if (err && err.status === 404) Toast.error(s.notFound);
      else Toast.error((lang === 'zh' && err && err.data && err.data.error_zh) || msg || s.failed);
    } finally {
      setBusy(false);
    }
  };

  if (!keys.length) return null;
  if (!canWrite) {
    return <div className="ppl-id-tags"><ControlledTagPills tags={tags} hideFlight={hideFlight} /></div>;
  }
  const name = ask ? tagName(ask.key, lang) : '';
  return (
    <div style={{ marginTop: 12 }}>
      <div className="ppl-flabel">{s.groupLabel}</div>
      <div className="ppl-chips" role="group" aria-label={s.groupLabel} style={{ marginBottom: 4 }}>
        {keys.map((k) => {
          const on = held.includes(k);
          return (
            <button key={k} type="button" aria-pressed={on} className={'ppl-chip' + (on ? ' on' : '')}
              title={on ? s.held : s.notHeld} onClick={() => open(k)}>
              {tagName(k, lang)}
            </button>
          );
        })}
      </div>
      <Text type="tertiary" size="small" className="org-page-hint">{s.hint}</Text>

      <Modal visible={!!ask} title={ask ? (ask.action === 'add' ? s.addTitle(name) : s.removeTitle(name)) : ''}
        maskClosable={false} closable={!busy} onCancel={close}
        footer={(
          <>
            <Button theme="borderless" disabled={busy} onClick={close}>{s.cancel}</Button>
            <Button theme="solid" type={ask && ask.action === 'remove' ? 'danger' : 'primary'} loading={busy}
              disabled={!!reasonErr} onClick={submit}>{s.confirm}</Button>
          </>
        )}>
        {ask && (
          <div>
            <p style={{ margin: '0 0 12px' }}>{ask.action === 'add' ? s.addLead : s.removeLead}</p>
            <div className="ppl-flabel">{s.reason}<span className="ppl-req">*</span> <Text type="tertiary" size="small">{s.reasonRule}</Text></div>
            <TextArea value={reason} autosize={{ minRows: 3, maxRows: 6 }} maxCount={REASON_MAX} placeholder={s.reasonPh}
              onChange={(v) => setReason(String(v || '').slice(0, REASON_MAX + 50))} onBlur={() => setTouched(true)}
              aria-required="true" aria-invalid={touched && !!reasonErr} />
            {touched && reasonErr && <Text type="danger" size="small">{reasonErr}</Text>}
          </div>
        )}
      </Modal>
    </div>
  );
}

/* ---------------- 时间线：source:'tag' 事件 ---------------- */
// 标题「打上受控标签：高潜」/「取消受控标签：流失风险」；正文为理由与操作人；dateUnknown 时日期写「打标日期不详（存量标签）」。
export function tagEventTitle(e, lang) {
  const s = controlledTagText(lang);
  const n = tagName(e && e.tagKey, lang);
  return e && e.action === 'remove' ? s.tlRemove(n) : s.tlAdd(n);
}
export function TagEventBody({ e }) {
  const { lang } = useI18n();
  const s = controlledTagText(lang);
  const actor = (e && e.actor && e.actor.name) || s.tlSystem;
  return (
    <div className="ppl-ev-body">
      {e && e.reason && <div><Text type="tertiary">{s.tlReason}</Text> {e.reason}</div>}
      <div><Text type="tertiary">{s.tlBy}</Text> {actor}</div>
    </div>
  );
}
