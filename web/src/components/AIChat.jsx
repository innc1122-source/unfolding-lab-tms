import { useState, useRef, useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { useI18n } from '../i18n.jsx';
import { useAuth } from '../auth.jsx';
import { useCourseScope } from '../coursescope.jsx';
import { api } from '../api.js';
import { errText } from '../apierr.js';

// 浮动的 AI 学习助手（AI 辅助模块，NEXT-WORK/specs/03-ai-governance-spec.md 4.1、2.6）。
// 服务端按「当前课程 + 当前模块」作答（课程阅读页经 useCourseScope 告诉这里正在看哪一个模块）；
// 切换课程或模块时清空对话，避免把上一门课的对话一并发送。显示条件：/api/me 的 ai.assistant 为 on 或 demo。
// 首次打开先显示告知（带版本号），员工点「知道了」后由服务端记一条确认（/api/me/ai-notice-ack）；
// 浏览器 localStorage 只作缓存。面板顶部常驻一行告知；每条回复标注「AI 生成」。
const T = {
  zh: {
    title: 'AI 学习助手', hint: '可针对当前课程内容提问。', close: '关闭', clear: '清空对话',
    ph: '输入你的问题…', send: '发送', sending: '思考中…',
    greet: '你好！在课程页向我提问，我会根据本课内容为你解答。',
    needCourse: '请先打开一门课程，我才能针对课程内容回答你。',
    error: '暂时无法回答，请稍后再试。',
    banner: '回答由 AI 生成，仅供学习参考，以课程内容和公司政策为准。',
    noticeTitle: '使用前请阅读',
    notice: '你输入的问题会连同当前课程内容发送给公司指定的 AI 服务处理。TMS 不保存对话内容，只记录使用时间、所在课程和用量，保留 180 天，用于费用与安全管理；公司 AI 服务对内容的保留规则见隐私政策。请勿输入个人信息、客户或玩家信息及其他敏感信息。',
    ack: '知道了', aiTag: 'AI 生成',
    demo: '演示模式：未接入 AI 服务，以下内容不是 AI 分析结果。',
    errs: {
      ai_rate_limited: (d) => `提问过于频繁，请 ${Math.max(1, Math.ceil((d.retryAfterSec || 60) / 60))} 分钟后再试。`,
      ai_exam_in_progress: () => '考试进行中，学习助手暂不可用。',
      ai_budget_exhausted: () => '本月 AI 用量已达上限。',
      ai_not_configured: () => 'AI 服务尚未接入。',
      ai_feature_off: () => '该 AI 功能未开启。',
      ai_timeout: () => 'AI 服务响应超时，请稍后再试。',
      ai_refused: () => 'AI 无法处理此请求，请换一种问法。',
      ai_input_too_large: () => '内容过长，请缩短后重试。',
      ai_output_truncated: () => 'AI 生成内容不完整，请重试。',
      ai_output_invalid: () => 'AI 生成内容不完整，请重试。',
      ai_upstream_error: () => 'AI 服务暂时不可用，请稍后再试。',
      ai_auth_failed: () => 'AI 服务暂时不可用，请稍后再试。',
      ai_model_not_found: () => 'AI 服务暂时不可用，请稍后再试。',
      ai_bad_request: () => 'AI 服务暂时不可用，请稍后再试。',
    },
  },
  en: {
    title: 'AI Learning Assistant', hint: 'Ask questions about the current course.', close: 'Close', clear: 'Clear conversation',
    ph: 'Type your question…', send: 'Send', sending: 'Thinking…',
    greet: 'Hi! Open a course and ask me — I answer from that course’s content.',
    needCourse: 'Open a course first so I can answer from its content.',
    error: 'Could not answer right now. Please try again shortly.',
    banner: 'Answers are AI-generated for learning support; the course content and company policy prevail.',
    noticeTitle: 'Before you start',
    notice: 'Your question and the current course content are sent to the company-designated AI service for processing. TMS does not store the conversation; it records only when you used the assistant, in which course, and how much, kept for 180 days for cost and security management. How the company AI service retains content is described in the privacy policy. Do not enter personal, customer or player information, or any other sensitive information.',
    ack: 'Got it', aiTag: 'AI-generated',
    demo: 'Demo mode: the AI service is not connected, so the content below is not an AI answer.',
    errs: {
      ai_rate_limited: (d) => `Too many requests. Please try again in ${Math.max(1, Math.ceil((d.retryAfterSec || 60) / 60))} min.`,
      ai_exam_in_progress: () => 'The study assistant is unavailable during an exam.',
      ai_budget_exhausted: () => "This month's AI usage limit has been reached.",
      ai_not_configured: () => 'The AI service is not connected yet.',
      ai_feature_off: () => 'This AI feature is not enabled.',
      ai_timeout: () => 'The AI service timed out. Please try again later.',
      ai_refused: () => 'The AI could not process this request. Please rephrase.',
      ai_input_too_large: () => 'The content is too long. Please shorten it.',
      ai_output_truncated: () => 'The AI response was incomplete. Please retry.',
      ai_output_invalid: () => 'The AI response was incomplete. Please retry.',
      ai_upstream_error: () => 'The AI service is temporarily unavailable. Please try again later.',
      ai_auth_failed: () => 'The AI service is temporarily unavailable. Please try again later.',
      ai_model_not_found: () => 'The AI service is temporarily unavailable. Please try again later.',
      ai_bad_request: () => 'The AI service is temporarily unavailable. Please try again later.',
    },
  },
};

const ackKey = (v) => 'tms-ai-notice-assistant-v' + v;
function cachedAck(v) {
  try { return localStorage.getItem(ackKey(v)) === '1'; } catch { return false; }
}

export default function AIChat() {
  const { lang } = useI18n();
  const { user } = useAuth();
  const { scope } = useCourseScope();
  const { pathname } = useLocation();
  const s = T[lang];

  // Prefer the exact course + module the learner is viewing (set by the course
  // reader); fall back to parsing the course id from the route.
  const routeMatch = pathname.match(/^\/course\/([^/]+)/);
  const courseId = scope.courseId || (routeMatch ? routeMatch[1] : null);
  const moduleId = scope.moduleId || undefined;

  const ai = (user && user.ai) || null;
  const state = ai ? ai.assistant : (user && user.aiEnabled ? 'on' : 'off');
  const notice = (ai && ai.notice && ai.notice.assistant) || { version: 2, acked: false };

  const [open, setOpen] = useState(false);
  const [msgs, setMsgs] = useState([{ role: 'ai', text: s.greet, local: true }]);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [acked, setAcked] = useState(() => !!notice.acked || cachedAck(notice.version));
  const bodyRef = useRef(null);
  const inputRef = useRef(null);

  useEffect(() => { if (notice.acked) setAcked(true); }, [notice.acked]);
  useEffect(() => { if (bodyRef.current) bodyRef.current.scrollTop = bodyRef.current.scrollHeight; }, [msgs, open, busy]);
  // Move keyboard focus into the panel on open, and close it on Escape.
  useEffect(() => {
    if (!open) return;
    if (inputRef.current) inputRef.current.focus();
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, acked]);
  // Keep the seeded greeting in the active language while nothing else is said.
  useEffect(() => {
    setMsgs((prev) => (prev.length === 1 && prev[0].local) ? [{ role: 'ai', text: s.greet, local: true }] : prev);
  }, [lang]); // eslint-disable-line react-hooks/exhaustive-deps
  // 切换课程或模块时清空对话（方案 4.1 第 2 条）
  useEffect(() => {
    setMsgs([{ role: 'ai', text: T[lang].greet, local: true }]);
  }, [courseId, moduleId]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!user || (state !== 'on' && state !== 'demo')) return null;

  const doAck = async () => {
    setAcked(true);
    try { localStorage.setItem(ackKey(notice.version), '1'); } catch { /* 存储不可用时以服务端记录为准 */ }
    try { await api.post('/api/me/ai-notice-ack', { notice: 'assistant', version: notice.version }); } catch { /* 下次打开会再次提示 */ }
  };
  const clear = () => setMsgs([{ role: 'ai', text: s.greet, local: true }]);

  const send = async () => {
    const q = text.trim();
    if (!q || busy) return;
    setText('');
    if (!courseId) {
      setMsgs((prev) => [...prev, { role: 'me', text: q }, { role: 'ai', text: s.needCourse, local: true }]);
      return;
    }
    const next = [...msgs, { role: 'me', text: q }];
    setMsgs(next);
    setBusy(true);
    try {
      // Map to the API's {role:'user'|'assistant', content} shape; local lines (greeting, hints, errors) are not sent.
      const messages = next.filter((x) => !x.local).map((x) => ({ role: x.role === 'me' ? 'user' : 'assistant', content: x.text }));
      const res = await api.post('/api/ai/assistant', { courseId, moduleId, messages });
      setMsgs((prev) => [...prev, { role: 'ai', text: (res && res.reply) || s.error, demo: !!(res && res.demo) }]);
    } catch (e) {
      setMsgs((prev) => [...prev, { role: 'ai', text: errText(e, s.errs) || s.error, local: true, err: true }]);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button className={'ai-fab' + (open ? ' hide' : '')} onClick={() => setOpen(true)} aria-label={s.title}>
        <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 11.5a8.38 8.38 0 01-.9 3.8 8.5 8.5 0 01-7.6 4.7 8.38 8.38 0 01-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 01-.9-3.8 8.5 8.5 0 014.7-7.6 8.38 8.38 0 013.8-.9h.5a8.48 8.48 0 018 8v.5z" />
        </svg>
      </button>

      {open && (
        <div className="ai-panel" role="dialog" aria-label={s.title}>
          <div className="ai-head">
            <div>
              <div className="ai-title">{s.title}</div>
              <div className="ai-hint">{s.hint}</div>
            </div>
            {acked && msgs.length > 1 && (
              <button className="ai-x ai-clear" onClick={clear} aria-label={s.clear} title={s.clear}>
                <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14" /></svg>
              </button>
            )}
            <button className="ai-x" onClick={() => setOpen(false)} aria-label={s.close}>
              <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M6 6l12 12M18 6L6 18" /></svg>
            </button>
          </div>
          <div className="ai-banner">{state === 'demo' ? s.demo : s.banner}</div>
          {!acked ? (
            <div className="ai-notice">
              <div className="ai-notice-h">{s.noticeTitle}</div>
              <p>{s.notice}</p>
              <button className="btn sm" onClick={doAck}>{s.ack}</button>
            </div>
          ) : (
            <>
              <div className="ai-body" ref={bodyRef}>
                {msgs.map((mm, i) => (
                  <div key={i} className={'ai-msg ' + mm.role + (mm.err ? ' err' : '')}>
                    {mm.text}
                    {mm.role === 'ai' && !mm.local && <span className="ai-tag">{mm.demo ? s.demo : s.aiTag}</span>}
                  </div>
                ))}
                {busy && <div className="ai-msg ai" style={{ opacity: 0.6 }}>{s.sending}</div>}
              </div>
              <div className="ai-input">
                <input ref={inputRef} value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && send()} placeholder={s.ph} disabled={busy} maxLength={4000} />
                <button className="btn sm" onClick={send} disabled={busy}>{busy ? s.sending : s.send}</button>
              </div>
            </>
          )}
        </div>
      )}
    </>
  );
}
