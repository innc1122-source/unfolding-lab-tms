// 绩效申诉（第二批 2.8，2026-10-08）员工端纯函数：不 import、不写 JSX，test/review-appeal-ui.test.js 去掉 export 后用 vm 直接求值。
// 页面在 pages/ReviewAppeal.jsx（「我的绩效」卡片上的申诉行、申诉整页、申诉征询列表与详情）。
// 状态来自服务端（GET /api/me/reviews/history 的 item.appeal.state、GET /api/me/reviews/:itemId/appeal 的 state）：
//   open / expired（推算，不入库）· submitted / in_review / withdrawn / maintained / adjusted（入库）· none（不开放 → history 里为 null）。

// 服务端 limits 缺省时的兜底（与设计 D3 / D4 一致；以服务端下发为准）
export const APPEAL_LIMITS = { reasonMin: 50, reasonMax: 4000, fileMaxBytes: 10485760, filesMax: 5, types: ['pdf', 'png', 'jpg'] };

export function limitsOf(l) {
  const src = l && typeof l === 'object' ? l : {};
  const out = { ...APPEAL_LIMITS };
  for (const k of ['reasonMin', 'reasonMax', 'fileMaxBytes', 'filesMax']) {
    const n = Number(src[k]);
    if (Number.isFinite(n) && n > 0) out[k] = n;
  }
  if (Array.isArray(src.types) && src.types.length) out.types = src.types.map((t) => String(t).toLowerCase());
  return out;
}

// 「我的绩效」卡片上申诉行的样子：tone = pill 的色调（'' = 默认 pill；null = 不出 pill、只出一行文字），
// labelKey = ReviewAppeal.jsx 词典 T 里的键，action = 'file'（提出申诉按钮）| 'view'（查看申诉）| 'outcome'（查看结论）| null
const CARD = {
  open: { tone: null, labelKey: 'cardOpen', action: 'file' },
  submitted: { tone: 'warn', labelKey: 'stSubmitted', action: 'view' },
  in_review: { tone: 'warn', labelKey: 'stInReview', action: 'view' },
  maintained: { tone: '', labelKey: 'stMaintained', action: 'outcome' },
  adjusted: { tone: 'ok', labelKey: 'stAdjusted', action: 'outcome' },
  withdrawn: { tone: 'muted', labelKey: 'stWithdrawn', action: null },
  expired: { tone: null, labelKey: 'stExpired', action: null },
};
export function appealCardState(appeal) {
  if (!appeal || typeof appeal !== 'object') return null;
  const c = CARD[appeal.state];
  return c ? { ...c } : null;
}

// 已有结论的两种状态
export function appealDecided(state) { return state === 'maintained' || state === 'adjusted'; }

// 书面说明字数：与服务端同一口径（trim 之后的 length，中英文都按字符数）
export function reasonLen(text) { return String(text || '').trim().length; }
export function reasonOk(text, limits) {
  const l = limitsOf(limits);
  const n = reasonLen(text);
  return n >= l.reasonMin && n <= l.reasonMax;
}

// 还能不能再加一个文件：已上传成功或正在上传的都算名额，上传失败的不算
export function activeFiles(files) { return (Array.isArray(files) ? files : []).filter((f) => f && !f.error); }
export function canAddFile(files, limits) { return activeFiles(files).length < limitsOf(limits).filesMax; }
export function slotsLeft(files, limits) { return Math.max(0, limitsOf(limits).filesMax - activeFiles(files).length); }

// 选文件后、上传前的本地检查（服务端仍按文件内容判定类型）：返回错误 code（与服务端 code 同名）或 null
const EXT_TYPE = { pdf: 'pdf', png: 'png', jpg: 'jpg', jpeg: 'jpg' };
const MIME_TYPE = { 'application/pdf': 'pdf', 'image/png': 'png', 'image/jpeg': 'jpg', 'image/jpg': 'jpg' };
export function fileTypeOf(file) {
  if (!file) return null;
  const m = /\.([A-Za-z0-9]+)$/.exec(String(file.name || ''));
  const byExt = m ? EXT_TYPE[m[1].toLowerCase()] : null;
  const byMime = MIME_TYPE[String(file.type || '').toLowerCase()] || null;
  return byExt || byMime || null;
}
export function fileCheck(file, limits) {
  const l = limitsOf(limits);
  const t = fileTypeOf(file);
  if (!t || !l.types.includes(t)) return 'appeal_file_type';
  const size = Number(file && file.size) || 0;
  if (size <= 0) return 'appeal_file_type';
  if (size > l.fileMaxBytes) return 'appeal_file_too_large';
  return null;
}

// 文件大小：B / KB / MB，一位小数（整数时不带 .0）
export function fmtSize(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v < 0) return '';
  if (v < 1024) return `${Math.round(v)} B`;
  const fix = (x) => { const r = Math.round(x * 10) / 10; return Number.isInteger(r) ? String(r) : r.toFixed(1); };
  if (v < 1024 * 1024) return `${fix(v / 1024)} KB`;
  return `${fix(v / (1024 * 1024))} MB`;
}

// 申诉征询列表：状态 → pill 色调与词典键
const CONSULT = {
  open: { tone: 'warn', labelKey: 'csOpen' },
  answered: { tone: 'ok', labelKey: 'csAnswered' },
  closed: { tone: 'muted', labelKey: 'csClosed' },
};
export function consultPill(state) { const c = CONSULT[state]; return c ? { ...c } : null; }
// 征询意见字数（服务端 10–4000，trim 后）
export const OPINION_LIMITS = { min: 10, max: 4000 };
export function opinionOk(text) { const n = reasonLen(text); return n >= OPINION_LIMITS.min && n <= OPINION_LIMITS.max; }
