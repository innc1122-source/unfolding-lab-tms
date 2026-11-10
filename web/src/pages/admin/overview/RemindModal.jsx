// 发送提醒的确认弹窗（第三批 4.1 / 4.2）：看板「需要关注」与名单页共用。
// req = { metric: 'overdue' | 'dueSoon', overrides: { ldept?, lcat?, lprog?, lenroll? }, count: remindablePeople }
// 请求体 = 当前看板筛选 + 名单覆盖 + metric（与 GET /api/admin/overview/people 同一口径，服务端保证 reminded + skippedToday = remindablePeople）。
import { useEffect, useState } from 'react';
import { Modal, Toast } from '@douyinfe/semi-ui';
import { api } from '../../../api.js';
import { bodyOf } from './ovquery.js';

export default function RemindModal({ s, filters, req, onClose, onDone }) {
  const [busy, setBusy] = useState(false);
  // CX-188：打开时预演一次（dryRun，不发送），预览写「将向 N 人发送」并注明今天已提醒、不再发送的人数
  const [pre, setPre] = useState(null);
  useEffect(() => {
    setPre(null);
    if (!req) return undefined;
    let alive = true;
    // CX-195：dryRun 单独以布尔带上，不经 bodyOf（bodyOf 经查询串拼接，布尔会变成字符串 "true"，服务端原来按真实发送处理）
    api.post('/api/admin/training/remind-overdue', { ...bodyOf(filters, { ...(req.overrides || {}), metric: req.metric }), dryRun: true })
      .then((r) => { if (alive && r) setPre({ n: Number(r.reminded) || 0, k: Number(r.skippedToday) || 0 }); })
      .catch(() => { if (alive) setPre({ n: (req && req.count) || 0, k: 0, fallback: true }); });   // 预演失败时回落到名单人数，不卡在「正在统计」
    return () => { alive = false; };
  }, [req]); // eslint-disable-line react-hooks/exhaustive-deps
  // CX-211：预演返回前「发送」置灰、正文写「正在统计…」，不先按 remindablePeople 显示人数
  const willSend = pre ? pre.n : 0;
  const send = async () => {
    if (!req) return;
    setBusy(true);
    try {
      const r = await api.post('/api/admin/training/remind-overdue', bodyOf(filters, { ...(req.overrides || {}), metric: req.metric }));
      const n = (r && r.reminded) || 0;
      const k = (r && r.skippedToday) || 0;
      if (!n && !k) Toast.info(s.remindNone);
      else Toast.success(k ? `${s.remindDone(n)} · ${s.remindSkipped(k)}` : s.remindDone(n));
      onClose();
      if (onDone) onDone(r);
    } catch (err) {
      Toast.error(err.message);
    }
    setBusy(false);
  };
  return (
    <Modal title={s.remindTitle} visible={!!req} onCancel={onClose} onOk={send} okText={s.confirm} cancelText={s.cancel}
      confirmLoading={busy} okButtonProps={{ disabled: !req || !pre || !willSend }}>
      <p className="ovx-remind-body">{req ? (!pre ? s.remindCounting : !pre.n ? s.remindNone : s.remindBody(willSend)) : ''}</p>
      {pre && pre.k > 0 && <p className="ovx-remind-body">{s.remindSkipPre(pre.k)}</p>}
      {pre && pre.fallback && pre.n > 0 && <p className="ovx-remind-note">{s.remindNoDedupe}</p>}
      <p className="ovx-remind-note">{s.remindNote}</p>
    </Modal>
  );
}
