// 第四批 6.1（2026-10-08，G3）：题型的纯函数层（不碰 React、不碰网络），test/qtypes-model.test.js 用 vm 跑。
//   · 编辑稿 draft ⇄ 接口请求体：toDraft(q) / toBody(draft) / emptyDraft(type) / changeType(draft, type)，取代 Questions.jsx 里的
//     toRow / buildBody / draftToBody；编辑稿一律用服务端题型键（mcq / multi / tf / fill / cloze / ordering / matching / classify /
//     open / case），界面词 single / multiple / truefalse / short 不再出现。
//   · validateDraft(draft) → [{ field, code, min?, max? }]：与服务端 validate 同样的限制，保存前就能在行内报错。
//   · 学员作答：isAnswered(q, v) / slotsOf(questions)（答题卡按小题展开：案例 3 有 4 小题 → 3.1–3.4）；
//   · 成绩：earnedOf(d) / maxOf(d) / stateOf(d)（新题型按 points × credit，老题型沿用旧口径）；
//   · AI：fromAiDraft(d) / fromAiCase(c)，AI 翻译：translatePairs(draft) / applyTranslations(draft, map, to)。
// 只从同目录的 spec.js 取题型目录（测试时两个文件拼在一起跑）。
import { TYPES, ENABLED, AI_TYPE_MAP, caseItemTypes, defaultPointsOf } from './spec.js';

const str = (x) => (x == null ? '' : String(x));
const trim = (x) => str(x).trim();
const isObj = (x) => !!x && typeof x === 'object' && !Array.isArray(x);
const arr = (x) => (Array.isArray(x) ? x : []);
const uniq = (list) => [...new Set(list)];
const r1 = (x) => Math.round(x * 10) / 10;

// 编辑稿里的双语文字一律是 { zh, en }；接口里是 { text, text_zh }（text 必填 = 英文，没有英文时回落中文；text_zh 可空）
const bi = (zh, en) => ({ zh: str(zh), en: str(en) });
const fromText = (o) => bi(o && o.text_zh, o && o.text);
const toText = (b) => {
  const zh = trim(b && b.zh), en = trim(b && b.en);
  return { text: en || zh, text_zh: zh || null };
};
const blankBi = (b) => !trim(b && b.zh) && !trim(b && b.en);

export const LIMITS = {
  textMax: 300, passageMax: 4000,
  optionsMin: 2, optionsMax: 12,
  orderingMin: 3, orderingMax: 8,
  pairsMin: 2, pairsMax: 8, distractorsMax: 3,
  categoriesMin: 2, categoriesMax: 5, classItemsMin: 2, classItemsMax: 12,
  blanksMin: 1, blanksMax: 10, acceptedMax: 10, acceptedLen: 100, clozeAnswerLen: 200,
  subsMin: 2, subsMax: 8,
  pointsMax: 100,
};

/* ---------------- 编辑稿 ---------------- */

const opt = (ok) => ({ zh: '', en: '', ok: !!ok });
function emptyFields(type) {
  switch (type) {
    case 'mcq': return { options: [opt(true), opt(false)] };
    case 'multi': return { options: [opt(false), opt(false)] };
    case 'tf': return { answer: true };
    case 'fill': return { answers: [''] };
    case 'cloze': return { blanks: [] };
    case 'open': return { rubric: bi('', ''), maxPoints: 10 };
    case 'ordering': return { items: [bi(), bi(), bi()] };
    case 'matching': return { pairs: [{ left: bi(), right: bi() }, { left: bi(), right: bi() }], distractors: [] };
    case 'classify': return { categories: [bi(), bi()], items: [{ zh: '', en: '', cat: 0 }, { zh: '', en: '', cat: 1 }] };
    case 'case': return { passage: bi(), subs: [emptySub('mcq'), emptySub('mcq')] };
    default: return {};
  }
}
export function emptySub(type = 'mcq') {
  return { sid: null, type, stem: bi(), explanation: bi(), points: null, ...emptyFields(type) };
}
export function emptyDraft(type = 'mcq', base = {}) {
  return {
    id: null, courseId: base.courseId == null ? null : base.courseId, moduleId: base.moduleId == null ? null : base.moduleId,
    type, stem: bi(), explanation: bi(), points: null, ...emptyFields(type),
  };
}

// 换题型：保留题干、解析、分值（案例没有题目级分值）与所属课程，题型专属字段重置
export function changeType(draft, type) {
  const keep = { id: draft.id == null ? null : draft.id, courseId: draft.courseId == null ? null : draft.courseId, moduleId: draft.moduleId == null ? null : draft.moduleId, stem: draft.stem || bi(), explanation: draft.explanation || bi(), points: type === 'case' ? null : (draft.points == null ? null : draft.points) };
  const out = { ...keep, type, ...emptyFields(type) };
  if ('sid' in draft) out.sid = draft.sid;
  return out;
}
// 题型专属字段里是否已经填了东西（换题型前要不要确认）
export function hasTypeContent(draft) {
  if (!draft) return false;
  const anyBi = (list) => arr(list).some((b) => !blankBi(b));
  switch (draft.type) {
    case 'mcq': case 'multi': return anyBi(draft.options);
    case 'tf': return false;
    case 'fill': return arr(draft.answers).some((a) => trim(a));
    case 'cloze': return arr(draft.blanks).some((b) => arr(b.answers).some((a) => trim(a)));
    case 'open': return !blankBi(draft.rubric);
    case 'ordering': return anyBi(draft.items);
    case 'matching': return arr(draft.pairs).some((p) => !blankBi(p.left) || !blankBi(p.right)) || anyBi(draft.distractors);
    case 'classify': return anyBi(draft.categories) || anyBi(draft.items);
    case 'case': return !blankBi(draft.passage) || arr(draft.subs).some((s) => !blankBi(s.stem) || hasTypeContent(s));
    default: return false;
  }
}

function fieldsFromQ(q) {
  switch (q.type) {
    case 'mcq': case 'multi':
      return { options: arr(q.options).map((o) => ({ ...fromText(o), ok: !!(o && o.ok) })) };
    case 'tf': return { answer: q.answer !== false };
    case 'fill': { const a = arr(q.answers).map(str); return { answers: a.length ? a : [''] }; }
    case 'cloze': return { blanks: arr(q.blanks).map((b) => ({ answers: arr(b && b.answers).map(str) })) };
    case 'open': return { rubric: bi(q.rubric_zh, q.rubric), maxPoints: q.maxPoints == null ? 10 : Number(q.maxPoints) };
    case 'ordering': return { items: arr(q.items).map(fromText) };
    case 'matching':
      return {
        pairs: arr(q.pairs).map((p) => ({ left: fromText(p && p.left), right: fromText(p && p.right) })),
        distractors: arr(q.distractors).map(fromText),
      };
    case 'classify':
      return {
        categories: arr(q.categories).map(fromText),
        items: arr(q.items).map((it) => ({ ...fromText(it), cat: Number.isInteger(it && it.cat) ? it.cat : 0 })),
      };
    case 'case': return { passage: bi(q.passage_zh, q.passage), subs: arr(q.items).map(subFromQ) };
    default: return {};
  }
}
function subFromQ(it) {
  return {
    sid: it && it.sid != null ? it.sid : null, type: it && it.type,
    stem: bi(it && it.question_zh, it && it.question), explanation: bi(it && it.explanation_zh, it && it.explanation),
    points: it && it.points != null ? Number(it.points) : null, ...fieldsFromQ(it || {}),
  };
}

// 题库题目（/api/admin/questions 的一条）→ 编辑稿
export function toDraft(q) {
  if (!q) return emptyDraft();
  return {
    id: q.id == null ? null : q.id, courseId: q.courseId == null ? null : q.courseId, moduleId: q.moduleId == null ? null : q.moduleId,
    type: q.type, stem: bi(q.question_zh, q.question), explanation: bi(q.explanation_zh, q.explanation),
    points: q.points == null ? null : Number(q.points),
    ...fieldsFromQ(q),
  };
}

const pointsVal = (p) => (p == null || p === '' || !Number.isFinite(Number(p)) ? null : Number(p));

// 案例的题目级题干是「标题 / 作答说明」，可以不填；不填时用案例材料的第一行（服务端题干必填）
const firstLine = (s) => { const t = trim(s).split(/\r?\n/)[0] || ''; return t.length > 120 ? t.slice(0, 119) + '…' : t; };

function fieldsToBody(d) {
  switch (d.type) {
    case 'mcq': case 'multi':
      return { options: arr(d.options).filter((o) => !blankBi(o)).map((o) => ({ ...toText(o), ok: !!o.ok })) };
    case 'tf': return { answer: d.answer !== false };
    case 'fill': return { answers: uniq(arr(d.answers).map(trim).filter(Boolean)) };
    case 'cloze': return { blanks: arr(d.blanks).map((b) => ({ answers: uniq(arr(b && b.answers).map(trim).filter(Boolean)) })) };
    case 'open': {
      const rz = trim(d.rubric && d.rubric.zh), re = trim(d.rubric && d.rubric.en);
      return { rubric: re || rz, rubric_zh: rz || null, maxPoints: Number(d.maxPoints) || 10 };
    }
    case 'ordering': return { items: arr(d.items).filter((b) => !blankBi(b)).map(toText) };
    case 'matching':
      return {
        pairs: arr(d.pairs).filter((p) => !(blankBi(p.left) && blankBi(p.right))).map((p) => ({ left: toText(p.left), right: toText(p.right) })),
        distractors: arr(d.distractors).filter((b) => !blankBi(b)).map(toText),
      };
    case 'classify':
      return {
        categories: arr(d.categories).map(toText),
        items: arr(d.items).filter((b) => !blankBi(b)).map((it) => ({ ...toText(it), cat: Number(it.cat) })),
      };
    case 'case': {
      const pz = trim(d.passage && d.passage.zh), pe = trim(d.passage && d.passage.en);
      return { passage: pe || pz, passage_zh: pz || null, items: arr(d.subs).map(subToBody) };
    }
    default: return {};
  }
}
const explBody = (d) => {
  const ez = trim(d.explanation && d.explanation.zh), ee = trim(d.explanation && d.explanation.en);
  return { explanation: ee || ez, explanation_zh: ez || null };
};
function stemBody(d) {
  let sz = trim(d.stem && d.stem.zh), se = trim(d.stem && d.stem.en);
  if (d.type === 'case' && !sz && !se) {
    sz = firstLine(d.passage && d.passage.zh);
    se = firstLine(d.passage && d.passage.en);
  }
  return { question: se || sz, question_zh: sz || null };
}
function subToBody(s) {
  return { type: s.type, ...stemBody(s), points: pointsVal(s.points), ...explBody(s), ...fieldsToBody(s) };
}

// 编辑稿 → POST / PUT /api/admin/questions 的请求体（字段平铺，与服务端 validate 对应）
export function toBody(draft) {
  const d = draft || {};
  const body = { courseId: d.courseId, type: d.type, ...stemBody(d), points: d.type === 'case' ? null : pointsVal(d.points) };
  if (d.type !== 'open') Object.assign(body, explBody(d));
  return Object.assign(body, fieldsToBody(d));
}

/* ---------------- 保存前校验（与服务端同样的限制） ---------------- */

const MARKER_RE = /\{\{(\d+)\}\}/g;
// 题干里的空格标记 {{n}}，按出现顺序
export const clozeMarkers = (text) => [...str(text).matchAll(MARKER_RE)].map((m) => Number(m[1]));
// 标记是否恰好是 1…n、各出现一次
export const markersOk = (text, n) => {
  const m = clozeMarkers(text);
  if (m.length !== n) return false;
  const seen = new Set(m);
  if (seen.size !== n) return false;
  for (let i = 1; i <= n; i++) if (!seen.has(i)) return false;
  return true;
};
// 题干拆成文字段与空格段：[{ t: 'text', s }, { t: 'blank', n }]（n 从 1 起）
export function clozeParts(text) {
  const s = str(text), out = [];
  let last = 0;
  for (const m of s.matchAll(MARKER_RE)) {
    if (m.index > last) out.push({ t: 'text', s: s.slice(last, m.index) });
    out.push({ t: 'blank', n: Number(m[1]) });
    last = m.index + m[0].length;
  }
  if (last < s.length) out.push({ t: 'text', s: s.slice(last) });
  return out;
}
// 在 pos 处插入下一个空格标记，返回 { text, n }
export function insertMarker(text, pos, n) {
  const s = str(text);
  const at = pos == null || pos < 0 || pos > s.length ? s.length : pos;
  return { text: s.slice(0, at) + `{{${n}}}` + s.slice(at), n };
}

function validateInto(d, out, p, inCase) {
  const err = (field, code, extra) => out.push({ field: p + field, code, ...(extra || {}) });
  const tooLong = (b, field, max = LIMITS.textMax) => {
    if (str(b && b.zh).trim().length > max || str(b && b.en).trim().length > max) err(field, 'too_long', { max });
  };
  if (!d || !TYPES[d.type] || !ENABLED.includes(d.type)) { err('type', 'bad_type'); return; }
  if (inCase && !caseItemTypes().includes(d.type)) { err('type', 'case_sub_type'); return; }
  if (!inCase && !p && (d.courseId == null || d.courseId === '')) err('courseId', 'required');
  if (d.type !== 'case' && blankBi(d.stem)) err('stem', 'required');
  // 分值：1–100 的整数（服务端 pointsOf 同口径；不合规的服务端会当作「未设置」，这里提前拦下）
  if (d.type !== 'case' && d.points != null && d.points !== '') {
    const n = Number(d.points);
    if (!Number.isInteger(n) || n < 1 || n > LIMITS.pointsMax) err('points', 'points_range', { min: 1, max: LIMITS.pointsMax });
  }
  // 同一组文字不能重复（大小写不敏感，中英文各自比；与服务端 dupIndex 同口径）
  const dupCheck = (list, fieldOf, code = 'duplicate') => {
    const seen = { zh: new Set(), en: new Set() };
    list.forEach((b, i) => {
      if (!b || blankBi(b)) return;
      const t = toText(b);
      let hit = false;
      for (const [lang, v] of [['en', t.text], ['zh', t.text_zh]]) {
        if (!v) continue;
        const k = v.trim().toLowerCase();
        if (seen[lang].has(k)) hit = true;
        seen[lang].add(k);
      }
      if (hit) err(fieldOf(i), code);
    });
  };
  switch (d.type) {
    case 'mcq': case 'multi': {
      const opts = arr(d.options).filter((o) => !blankBi(o));
      if (opts.length < LIMITS.optionsMin) err('options', 'options_min', { min: LIMITS.optionsMin });
      const ok = opts.filter((o) => o.ok).length;
      if (d.type === 'mcq' && opts.length >= LIMITS.optionsMin && ok !== 1) err('options', 'mcq_one_correct');
      if (d.type === 'multi' && opts.length >= LIMITS.optionsMin && ok < 1) err('options', 'multi_correct');
      break;
    }
    case 'tf':
      if (typeof d.answer !== 'boolean') err('answer', 'tf_answer');
      break;
    case 'fill':
      if (!arr(d.answers).some((a) => trim(a))) err('answers', 'fill_answers');
      break;
    case 'cloze': {
      const blanks = arr(d.blanks);
      const n = blanks.length;
      if (n < LIMITS.blanksMin || n > LIMITS.blanksMax) err('blanks', 'cloze_blanks', { min: LIMITS.blanksMin, max: LIMITS.blanksMax });
      blanks.forEach((b, i) => {
        const acc = uniq(arr(b && b.answers).map(trim).filter(Boolean));
        if (acc.length < 1 || acc.length > LIMITS.acceptedMax) err(`blanks.${i}`, 'cloze_answers', { min: 1, max: LIMITS.acceptedMax });
        else if (acc.some((a) => a.length > LIMITS.acceptedLen)) err(`blanks.${i}`, 'too_long', { max: LIMITS.acceptedLen });
      });
      if (n >= LIMITS.blanksMin) {
        for (const lang of ['zh', 'en']) {
          const t = trim(d.stem && d.stem[lang]);
          if (t && !markersOk(t, n)) err(`stem.${lang}`, 'cloze_markers', { max: n });
        }
      }
      break;
    }
    case 'ordering': {
      const items = arr(d.items).filter((b) => !blankBi(b));
      if (items.length < LIMITS.orderingMin || items.length > LIMITS.orderingMax) err('items', 'items_count', { min: LIMITS.orderingMin, max: LIMITS.orderingMax });
      arr(d.items).forEach((b, i) => tooLong(b, `items.${i}`));
      dupCheck(arr(d.items), (i) => `items.${i}`);
      break;
    }
    case 'matching': {
      const pairs = arr(d.pairs);
      const used = pairs.filter((pp) => !(blankBi(pp.left) && blankBi(pp.right)));
      if (used.length < LIMITS.pairsMin || used.length > LIMITS.pairsMax) err('pairs', 'pairs_count', { min: LIMITS.pairsMin, max: LIMITS.pairsMax });
      const ds = arr(d.distractors);
      if (ds.filter((b) => !blankBi(b)).length > LIMITS.distractorsMax) err('distractors', 'distractors_max', { max: LIMITS.distractorsMax });
      pairs.forEach((pp, i) => {
        if (blankBi(pp.left) && blankBi(pp.right)) return;
        if (blankBi(pp.left)) err(`pairs.${i}.left`, 'required');
        if (blankBi(pp.right)) err(`pairs.${i}.right`, 'required');
        tooLong(pp.left, `pairs.${i}.left`); tooLong(pp.right, `pairs.${i}.right`);
      });
      ds.forEach((b, i) => { if (!blankBi(b)) tooLong(b, `distractors.${i}`); });
      // 左项不能重复；右项连同干扰项不能重复
      dupCheck(pairs.map((pp) => pp.left), (i) => `pairs.${i}.left`);
      dupCheck([...pairs.map((pp) => pp.right), ...ds], (i) => (i < pairs.length ? `pairs.${i}.right` : `distractors.${i - pairs.length}`), 'right_duplicate');
      break;
    }
    case 'classify': {
      const cats = arr(d.categories);
      if (cats.length < LIMITS.categoriesMin || cats.length > LIMITS.categoriesMax) err('categories', 'categories_count', { min: LIMITS.categoriesMin, max: LIMITS.categoriesMax });
      cats.forEach((c, i) => { if (blankBi(c)) err(`categories.${i}`, 'required'); tooLong(c, `categories.${i}`); });
      dupCheck(cats, (i) => `categories.${i}`);
      dupCheck(arr(d.items), (i) => `items.${i}`);
      const items = arr(d.items);
      const used = items.filter((b) => !blankBi(b));
      if (used.length < LIMITS.classItemsMin || used.length > LIMITS.classItemsMax) err('items', 'items_count', { min: LIMITS.classItemsMin, max: LIMITS.classItemsMax });
      const hit = new Set();
      items.forEach((it, i) => {
        if (blankBi(it)) return;
        tooLong(it, `items.${i}`);
        const c = Number(it.cat);
        if (!Number.isInteger(c) || c < 0 || c >= cats.length) err(`items.${i}`, 'cat_required');
        else hit.add(c);
      });
      cats.forEach((c, i) => { if (!blankBi(c) && !hit.has(i)) err(`categories.${i}`, 'category_empty'); });
      break;
    }
    case 'case': {
      if (blankBi(d.passage)) err('passage', 'required');
      tooLong(d.passage, 'passage', LIMITS.passageMax);
      const subs = arr(d.subs);
      if (subs.length < LIMITS.subsMin || subs.length > LIMITS.subsMax) err('subs', 'subs_count', { min: LIMITS.subsMin, max: LIMITS.subsMax });
      subs.forEach((s, i) => validateInto(s, out, `${p}subs.${i}.`, true));
      break;
    }
    default: break;
  }
}
export function validateDraft(draft, opts) {
  const out = [];
  validateInto(draft, out, '', !!(opts && opts.inCase));
  return out;
}
// 某个字段（或其下级）有没有错：errorsAt(errors, 'pairs.1') 命中 pairs.1.left / pairs.1.right
export const errorsAt = (errors, field) => arr(errors).filter((e) => e.field === field || e.field.startsWith(field + '.'));

// 案例合计分：每个小题自己的分值，没填时按题型默认分值（考试的题型默认分值在出卷时才知道，这里按目录默认）
export const caseTotal = (draft) => r1(arr(draft && draft.subs).reduce((sum, s) => sum + (pointsVal(s.points) != null ? pointsVal(s.points) : (defaultPointsOf(s.type) || 1)), 0));

/* ---------------- 学员作答 ---------------- */

export function isAnswered(q, v) {
  if (!q || v == null) return false;
  switch (q.type) {
    case 'mcq': return typeof v === 'number';
    case 'multi': return Array.isArray(v) && v.length > 0;
    case 'tf': return typeof v === 'boolean';
    case 'fill': case 'open': return typeof v === 'string' && v.trim() !== '';
    case 'cloze': {
      const n = Number(q.blanks) || 0;
      return Array.isArray(v) && n > 0 && v.length === n && v.every((x) => typeof x === 'string' && x.trim() !== '');
    }
    // 排序题：没动过（也没点「确认顺序」）就是未作答 —— 打乱后的初始顺序不算答案
    case 'ordering': return Array.isArray(v) && v.length === arr(q.items).length && v.length > 0;
    case 'matching': return Array.isArray(v) && v.length === arr(q.lefts).length && v.length > 0 && v.every((x) => Number.isInteger(x));
    case 'classify': return Array.isArray(v) && v.length === arr(q.items).length && v.length > 0 && v.every((x) => Number.isInteger(x));
    case 'case': {
      const items = arr(q.items);
      return isObj(v) && items.length > 0 && items.every((s) => isAnswered(s, v[s.sid]));
    }
    default: return typeof v === 'string' ? v.trim() !== '' : true;
  }
}

// 答题卡格子：普通题一格；案例按小题展开，标号 3.1、3.2…
//   [{ key, qIdx, q, sub, label, caseNo }]，key 用于标记与跳转（普通题 = 题目 id，小题 = `${id}:${sid}`）
export function slotsOf(questions) {
  const out = [];
  arr(questions).forEach((q, qIdx) => {
    const no = qIdx + 1;
    if (q && q.type === 'case' && arr(q.items).length) {
      q.items.forEach((sub, k) => out.push({ key: `${q.id}:${sub.sid}`, qIdx, q, sub, label: `${no}.${k + 1}`, caseNo: no }));
    } else out.push({ key: q && q.id, qIdx, q, sub: null, label: String(no), caseNo: null });
  });
  return out;
}
// 某格是否已作答
export function slotAnswered(slot, answers) {
  const v = answers ? answers[slot.q.id] : undefined;
  if (!slot.sub) return isAnswered(slot.q, v);
  return isAnswered(slot.sub, isObj(v) ? v[slot.sub.sid] : undefined);
}

// 列表移动：把 from 位置的元素移到 to 位置
export function moveItem(list, from, to) {
  const a = arr(list).slice();
  if (from < 0 || from >= a.length || to < 0 || to >= a.length || from === to) return a;
  const [x] = a.splice(from, 1);
  a.splice(to, 0, x);
  return a;
}
export const identity = (n) => Array.from({ length: Math.max(0, n | 0) }, (_, i) => i);

/* ---------------- 成绩 ---------------- */

const hasCredit = (d) => typeof d.credit === 'number' && Number.isFinite(d.credit);
// 一道题的满分：题目分值；旧答卷没有分值时按旧口径（客观题 1 分，简答 maxPoints/10）；案例 = 小题合计
export function maxOf(d) {
  if (!d) return 0;
  if (d.type === 'case') return r1(arr(d.items).reduce((s, x) => s + maxOf(x), 0));
  if (d.points != null) return Number(d.points) || 0;
  if (d.type === 'open') return (Number(d.maxPoints) || 0) / 10;
  return 1;
}
// 一道题拿到的分，保留一位小数：新题型 = 分值 × credit；老题型沿用旧口径（多选部分正确 = 一半）；简答按 score / maxPoints 折算
export function earnedOf(d) {
  if (!d) return 0;
  if (d.type === 'case') return r1(arr(d.items).reduce((s, x) => s + earnedOf(x), 0));
  const pts = maxOf(d);
  if (d.type === 'open') return d.score == null || !d.maxPoints ? 0 : r1((Number(d.score) / Number(d.maxPoints)) * pts);
  if (hasCredit(d)) return r1(pts * Math.max(0, Math.min(1, d.credit)));
  return d.isRight ? pts : d.partial ? r1(pts / 2) : 0;
}
// 对错状态：ok / partial / bad；简答没分数时 pending
export function stateOf(d) {
  if (!d) return 'bad';
  if (d.type === 'open') {
    if (d.score == null) return 'pending';
    const max = Number(d.maxPoints) || 0;
    const sc = Number(d.score) || 0;
    if (max > 0 && sc >= max) return 'ok';
    if (sc > 0) return 'partial';
    return 'bad';
  }
  // 案例没带 credit 时按小题合计判断
  if (d.type === 'case' && !hasCredit(d) && d.isRight == null) {
    const e = earnedOf(d), m = maxOf(d);
    if (m > 0 && e >= m) return 'ok';
    return e > 0 ? 'partial' : 'bad';
  }
  if (d.isRight || (hasCredit(d) && d.credit >= 1)) return 'ok';
  if (d.partial || (hasCredit(d) && d.credit > 0)) return 'partial';
  return 'bad';
}
// 排序题回顾：作答顺序里相邻两项是否也在正确顺序里相邻、同方向（长度 n-1）
export function orderingPairs(response, key) {
  const r = arr(response), k = arr(key);
  const pos = new Map(k.map((x, i) => [x, i]));
  const out = [];
  for (let i = 0; i + 1 < r.length; i++) out.push(pos.has(r[i]) && pos.get(r[i + 1]) === pos.get(r[i]) + 1);
  return out;
}

/* ---------------- AI 草稿 ---------------- */

// AI 出题的一条（QUESTION_ITEM）→ 编辑稿；base 带 courseId
export function fromAiDraft(d, base = {}) {
  const x = d || {};
  const type = AI_TYPE_MAP[x.type] || x.type;
  const out = {
    id: null, courseId: base.courseId == null ? null : base.courseId, moduleId: null, type,
    stem: bi(x.question_zh, x.question), explanation: bi(x.explanation_zh, x.explanation), points: null,
  };
  const options = arr(x.options).map((o) => ({ ...fromText(o), ok: !!(o && (o.correct || o.ok)) }));
  switch (type) {
    case 'mcq': case 'multi': return { ...out, options };
    case 'tf': {
      if (typeof x.answer === 'boolean') return { ...out, answer: x.answer };
      const t = arr(x.options).find((o) => /^true$/i.test(trim(o && o.text)) || trim(o && o.text_zh) === '正确');
      return { ...out, answer: t ? !!(t.correct || t.ok) : true };
    }
    case 'fill': return { ...out, answers: arr(x.answers).map(str).filter((a) => a.trim()) };
    case 'cloze': return { ...out, blanks: arr(x.blanks).map((b) => ({ answers: arr(b && b.answers).map(str) })) };
    case 'open': return { ...out, explanation: bi(), rubric: bi(x.rubric_zh, x.rubric), maxPoints: Number(x.maxPoints) || 10 };
    case 'ordering': return { ...out, items: arr(x.items).map(fromText) };
    case 'matching': {
      const all = arr(x.pairs);
      const isDistractor = (p) => !trim(p && p.left) && !trim(p && p.left_zh);
      return {
        ...out,
        pairs: all.filter((p) => !isDistractor(p)).map((p) => ({ left: bi(p.left_zh, p.left), right: bi(p.right_zh, p.right) })),
        distractors: all.filter(isDistractor).map((p) => bi(p.right_zh, p.right)),
      };
    }
    case 'classify':
      return {
        ...out,
        categories: arr(x.categories).map(fromText),
        items: arr(x.items).map((it) => ({ ...fromText(it), cat: Number.isInteger(it && it.category) && it.category >= 0 ? it.category : 0 })),
      };
    default: return { ...out, ...emptyFields(type) };
  }
}
// AI 出题的一组案例 → 案例编辑稿
export function fromAiCase(c, base = {}) {
  const x = c || {};
  return {
    id: null, courseId: base.courseId == null ? null : base.courseId, moduleId: null, type: 'case',
    stem: bi(x.question_zh || x.title_zh, x.question || x.title), explanation: bi(), points: null,
    passage: bi(x.passage_zh, x.passage),
    subs: arr(x.questions).map((q) => {
      const d = fromAiDraft(q, base);
      const { id, courseId, moduleId, ...rest } = d; // eslint-disable-line no-unused-vars
      return { sid: null, ...rest };
    }),
  };
}

/* ---------------- AI 翻译 ---------------- */

// 编辑稿里所有可翻译的双语字段的路径（stem / explanation / rubric / options.0 / pairs.1.left / subs.0.items.2 …）
function biPaths(d, prefix, out) {
  if (!d) return out;
  out.push(prefix + 'stem');
  if (d.type !== 'open' && d.type !== 'case') out.push(prefix + 'explanation');
  const each = (list, name) => arr(list).forEach((_, i) => out.push(`${prefix}${name}.${i}`));
  switch (d.type) {
    case 'mcq': case 'multi': each(d.options, 'options'); break;
    case 'open': out.push(prefix + 'rubric'); break;
    case 'ordering': each(d.items, 'items'); break;
    case 'matching':
      arr(d.pairs).forEach((_, i) => { out.push(`${prefix}pairs.${i}.left`); out.push(`${prefix}pairs.${i}.right`); });
      each(d.distractors, 'distractors');
      break;
    case 'classify': each(d.categories, 'categories'); each(d.items, 'items'); break;
    case 'case':
      out.push(prefix + 'passage');
      arr(d.subs).forEach((s, i) => biPaths(s, `${prefix}subs.${i}.`, out));
      break;
    default: break;
  }
  return out;
}
const getAt = (obj, path) => path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
// → [{ key, zh, en }]，key 即路径
export function translatePairs(draft) {
  return biPaths(draft, '', []).map((key) => {
    const b = getAt(draft, key) || {};
    return { key, zh: str(b.zh), en: str(b.en) };
  });
}
// 把译文写回：map = Map(key → 译文)，to = 'zh' | 'en'；返回新的编辑稿
export function applyTranslations(draft, map, to) {
  const next = JSON.parse(JSON.stringify(draft));
  for (const [key, text] of map) {
    const b = getAt(next, String(key));
    if (b && typeof b === 'object' && (to === 'zh' || to === 'en')) b[to] = str(text);
  }
  return next;
}

/* ---------------- 编辑稿的局部更新 ---------------- */

// 按路径改一处，返回新的编辑稿：setAt(draft, 'pairs.1.left.zh', '…')
export function setAt(draft, path, value) {
  const keys = String(path).split('.');
  const walk = (o, i) => {
    const k = keys[i];
    const base = Array.isArray(o) ? o.slice() : { ...(o || {}) };
    base[k] = i === keys.length - 1 ? value : walk(o == null ? undefined : o[k], i + 1);
    return base;
  };
  return walk(draft, 0);
}
