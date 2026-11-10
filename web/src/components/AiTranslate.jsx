// AI 翻译（2026-10-06 负责人需求）：培训内容中英互译，免去课程、题目、考试各写两遍。
// 挂在 AI 治理框架里（功能 translate，归属 learning）：开关、调用审计、限流、预算都走后台「系统设置 › AI 治理」。
// 只出草稿 —— 译文填进表单，HR 检查后照常保存；整门课程翻译也先确认再写入。
// 可用状态取 /api/me 的 ai.translate（on / demo 才显示入口）。
import { useState } from 'react';
import { Button, Dropdown, Modal, Toast } from '@douyinfe/semi-ui';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import { useI18n } from '../i18n.jsx';
import { errText } from '../apierr.js';

const T = {
  zh: {
    btn: 'AI 翻译', toEn: '中文 → English（填入英文栏）', toZh: 'English → 中文（填入中文栏）',
    empty: (from) => (from === 'zh' ? '中文栏是空的，没有可翻译的内容' : '英文栏是空的，没有可翻译的内容'),
    allDone: (to) => (to === 'en' ? '英文栏都已有译文。要重新翻译请选「覆盖已有译文」' : '中文栏都已有译文。要重新翻译请选「覆盖已有译文」'),
    toEnOw: '中文 → English（覆盖已有译文）', toZhOw: 'English → 中文（覆盖已有译文）',
    done: '已填入 AI 译文，请检查后保存', doneDemo: '演示模式：已填入带「演示译文」标记的占位内容，未调用 AI',
    eOff: '该 AI 功能未开启', eConf: 'AI 服务尚未接入', eRate: 'AI 翻译次数已达上限，请稍后再试', eBudget: '本月 AI 用量已达上限',
    eLong: '内容过长，请分批翻译', eMany: '一次最多翻译 80 个字段',
    owTitle: '覆盖已有译文？', owAsk: (n, to) => `将用 AI 译文覆盖${to === 'en' ? '英文' : '中文'}栏里已有的 ${n} 处内容。保存前仍可放弃修改。`, owOk: '覆盖', owCancel: '取消',
  },
  en: {
    btn: 'AI translate', toEn: 'Chinese → English (fill the English fields)', toZh: 'English → Chinese (fill the Chinese fields)',
    empty: (from) => (from === 'zh' ? 'The Chinese fields are empty — nothing to translate' : 'The English fields are empty — nothing to translate'),
    allDone: (to) => (to === 'en' ? 'The English fields already have a translation. Choose “overwrite” to translate again' : 'The Chinese fields already have a translation. Choose “overwrite” to translate again'),
    toEnOw: 'Chinese → English (overwrite existing)', toZhOw: 'English → Chinese (overwrite existing)',
    done: 'AI translation filled in — check it, then save', doneDemo: 'Demo mode: placeholder text marked “Demo translation” was filled in; no AI was called',
    eOff: 'This AI feature is not enabled', eConf: 'The AI service is not connected yet', eRate: 'AI translation limit reached — try again later', eBudget: "This month's AI usage limit has been reached",
    eLong: 'The content is too long — translate it in parts', eMany: 'Translate at most 80 fields at a time',
    owTitle: 'Overwrite existing translations?', owAsk: (n, to) => `The AI translation will replace ${n} existing ${to === 'en' ? 'English' : 'Chinese'} field${n === 1 ? '' : 's'}. You can still discard the changes before saving.`, owOk: 'Overwrite', owCancel: 'Cancel',
  },
};
export const aiErrMap = (s) => ({
  ai_feature_off: () => s.eOff, ai_not_configured: () => s.eConf, ai_rate_limited: () => s.eRate,
  ai_budget_exhausted: () => s.eBudget, ai_input_too_large: () => s.eLong, too_many_items: () => s.eMany,
});
export const aiTranslateOn = (user) => !!(user && user.ai && ['on', 'demo'].includes(user.ai.translate));
const hasCjk = (t) => /[一-鿿]/.test(String(t || ''));
// 目标栏是否「还没有译文」：空、与原文相同（英文栏回落成中文的情况）、或译成英文时英文栏里其实是中文
export const needsTranslation = (target, source, to) => {
  const t = String(target || '').trim();
  if (!t) return true;
  if (t === String(source || '').trim()) return true;
  return to === 'en' && hasCjk(t);
};

// 一次请求 ≤ 80 项、≤ 55,000 字：自动分批。items: [{ key, text, format?: 'text'|'html' }] → { map: Map(key → 译文), demo }
export async function translateItems(items, to, refId) {
  const out = new Map();
  let demo = false;
  let batch = [], len = 0;
  const flush = async () => {
    if (!batch.length) return;
    const r = await api.post('/api/admin/ai/translate', { to, refId: refId || undefined, items: batch });
    if (r && r.demo) demo = true;
    for (const it of (r && r.items) || []) out.set(String(it.key), it.text);
    batch = []; len = 0;
  };
  for (const it of items) {
    const text = String(it.text || '');
    if (!text.trim()) continue;
    if (batch.length >= 80 || (batch.length && len + text.length > 55000)) await flush();
    batch.push({ key: String(it.key), text, format: it.format === 'html' ? 'html' : 'text' });
    len += text.length;
  }
  await flush();
  return { map: out, demo };
}

// 表单里的按钮：pairs = [{ zh: '中文字段', en: '英文字段', html?: true }]，从 formApi 读原文、把译文写回。
// extra（选填）= { get(from) → [{ key, text, format }], set(map, to) }：表单之外的本地状态（如题目选项）。
// overwrite=false（默认）时只填目标栏还没有译文的字段。
export function AiTranslateButton({ formApi, pairs = [], extra, refId, size = 'small', overwrite = false, onDone }) {
  const { user } = useAuth();
  const { lang } = useI18n();
  const s = T[lang];
  const [busy, setBusy] = useState(false);
  if (!aiTranslateOn(user)) return null;
  const run = async (to, ow = overwrite) => {
    const fa = formApi && formApi.current !== undefined ? formApi.current : formApi;
    const from = to === 'en' ? 'zh' : 'en';
    const items = [];
    let hadSource = false;
    let replaced = 0;   // 覆盖模式下会被替换掉的已有译文数
    if (fa) {
      pairs.forEach((p, i) => {
        const src = String(fa.getValue(p[from]) || '');
        if (!src.trim()) return;
        hadSource = true;
        const fresh = needsTranslation(fa.getValue(p[to]), src, to);
        if (!ow && !fresh) return;
        if (ow && !fresh) replaced++;
        items.push({ key: 'f' + i, text: src, format: p.html ? 'html' : 'text' });
      });
    }
    if (extra && extra.get) {
      if (extra.get(from, to, true).length) hadSource = true;
      const list = extra.get(from, to, ow);
      if (ow) replaced += Math.max(0, list.length - extra.get(from, to, false).length);
      for (const it of list) items.push(it);
    }
    if (!items.length) { Toast.warning(hadSource ? s.allDone(to) : s.empty(from)); return; }
    if (replaced > 0) {
      // QA 2026-10-06 T1：覆盖前确认一次
      Modal.confirm({
        title: s.owTitle, content: s.owAsk(replaced, to), okText: s.owOk, cancelText: s.owCancel,
        okButtonProps: { type: 'danger' }, onOk: () => translateInto(fa, items, to),
      });
      return;
    }
    await translateInto(fa, items, to);
  };
  const translateInto = async (fa, items, to) => {
    setBusy(true);
    try {
      const { map, demo } = await translateItems(items, to, refId);
      if (fa) for (const [k, v] of map) if (k.startsWith('f')) fa.setValue(pairs[Number(k.slice(1))][to], v);
      if (extra && extra.set) extra.set(map, to);
      Toast.success(demo ? s.doneDemo : s.done);
      if (onDone) onDone(to, map);
    } catch (err) {
      Toast.error(errText(err, aiErrMap(s)));
    }
    setBusy(false);
  };
  return (
    <Dropdown trigger="click" position="bottomRight" clickToHide
      render={(
        <Dropdown.Menu>
          <Dropdown.Item onClick={() => run('en')}>{s.toEn}</Dropdown.Item>
          <Dropdown.Item onClick={() => run('zh')}>{s.toZh}</Dropdown.Item>
          <Dropdown.Divider />
          <Dropdown.Item onClick={() => run('en', true)}>{s.toEnOw}</Dropdown.Item>
          <Dropdown.Item onClick={() => run('zh', true)}>{s.toZhOw}</Dropdown.Item>
        </Dropdown.Menu>
      )}>
      <Button size={size} theme="light" loading={busy} className="ai-tr-btn">{s.btn}</Button>
    </Dropdown>
  );
}
