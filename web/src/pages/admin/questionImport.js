// 题库批量导入的解析与导出（纯函数；Questions.jsx 的导入弹窗、「导出题库」与 test/question-import*.test.js 共用）。
//
// 双语列：题干、选项 A–L、解析/评分要点 各有「中文」与「英文」两列，分别写进题目的
// *_zh 字段与英文主字段（question / options[].text / explanation / rubric）。写法与单题编辑器一致：
// 英文主字段 = 英文 || 中文（服务端要求非空，学员端缺中文时也回落到它），*_zh = 中文 || null
// （学员端 loc() 中文界面优先读它，null 时回落到英文）。
//
// 旧模板（单语列：题目 / 选项A / 解析）照常可导：不带语言标记的列按「中文」读 —— 单题编辑器
// 里中文题干是必填的主语言，旧导入也是把同一段文字同时写进英文与 _zh 两个字段，结果不变。
// 同一行既有不带标记的旧列又有「中文」列时，以「中文」列为准。旧的 A–F 六个选项的文件照常可导（按表头找列）。
//
// 列序以首行表头为准（顺序随意）；没有可识别表头时按旧模板的固定列序（IMP_FIXED）读取。
//
// 第四批 6.1（2026-10-08）新题型的写法（模板「填写说明」页同一套说法）：
//   排序     选项按正确顺序填；「正确答案」可留空，或在选项乱序时填字母顺序（如 CADB）
//   匹配     每个选项格写「左项 => 右项」（=> 或 →），中英文两列各写一份；干扰项写「=> 右项」
//   分类     类别写在「分类(中文)」「Categories (EN)」两列，用 | 分隔；每个选项格写「项目 => 类别名」，类别名须与同语言的类别一致
//   判断     「正确答案」填 对/正确/是/T/True/√ 或 错/错误/否/F/False/×（判断题开放后存为独立的判断题 tf）
//   多空填空 题干里用 {{1}}…{{n}} 标出空格；「正确答案」写「1: 答案a / 答案b ; 2: 答案c」（空与空之间用 ; 或换行，同一空的多个答案用 | / 、）
//   案例     题型填「案例」的一行：题干 = 案例材料，「案例编号」填如 C1；其后「案例编号」相同的各行是它的小题（只限客观题）
// 题型由 web/src/qtypes/spec.js 的 ENABLED 把关：尚未开放的题型整行报错，不会悄悄换成别的题型。

import { ENABLED as SPEC_ENABLED, TYPES as SPEC_TYPES } from '../../qtypes/spec.js';

export const IMP_LETTERS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L'];
const NOPT = IMP_LETTERS.length;
// 旧模板列序：题型 | 题目 | 选项A..F | 正确答案 | 解析/评分要点 | 分值(问答)
export const IMP_FIXED = { type: 0, question: 1, options: [2, 3, 4, 5, 6, 7], answer: 8, expl: 9, points: 10 };

// 当前模板（web/public/templates/question-import-template.xlsx，由 web/scripts/question-template.mjs 生成）的表头。
export const IMP_TEMPLATE_HEADERS = [
  '题型 *', '题干(中文)', 'Stem (EN)',
  ...IMP_LETTERS.flatMap((l) => [`选项${l}(中文)`, `Option ${l} (EN)`]),
  '正确答案', '解析(中文)', 'Explanation (EN)', '分值',
  '案例编号 / Case ID', '分类(中文)', 'Categories (EN)',
];

// 题量上限（与服务端 modules/learning/qtypes/spec.js 的 LIMITS 同一组数字）
export const IMP_LIMITS = {
  text: 300, passage: 4000, blankAnswer: 100,
  ordering: { min: 3, max: 8 },
  matching: { min: 2, max: 8, distractorsMax: 3 },
  classify: { catMin: 2, catMax: 5, itemMin: 2, itemMax: 12 },
  cloze: { min: 1, max: 10, answersMax: 10 },
  case: { min: 2, max: 8 },
};

// 表头单元格 → 规范化文本：去空白、括号、星号等，转小写。
const norm = (raw) => String(raw || '').replace(/[\s*_（）()【】\[\]:：·\-]/g, '').toLowerCase();

// 规范化后的表头 → { base, lang }。lang: 'zh' | 'en' | null（不带语言标记 = 旧模板列）。
// 语言标记可以在前（中文题干）也可以在后（题干中文、stemen、optionaen）。
function splitLang(t) {
  let m = t.match(/^(中文|英文)(.+)$/);
  if (m) return { base: m[2], lang: m[1] === '中文' ? 'zh' : 'en' };
  m = t.match(/^(.+?)(中文|英文|chinese|english|zh|cn|en)$/);
  if (m) return { base: m[1], lang: /^(中文|chinese|zh|cn)$/.test(m[2]) ? 'zh' : 'en' };
  return { base: t, lang: null };
}

const fillN = () => new Array(NOPT).fill(-1);
const emptyMap = () => ({
  type: -1, points: -1,
  question: -1, questionZh: -1, questionEn: -1,
  options: fillN(), optionsZh: fillN(), optionsEn: fillN(),
  answer: -1, answerZh: -1, answerEn: -1,
  expl: -1, explZh: -1, explEn: -1,
  caseId: -1, cats: -1, catsZh: -1, catsEn: -1,
  hits: 0, bilingual: false,
});

// 表头行 → 列号映射；不是表头时返回 null。必须同时认出「题型」和至少一列题干，
// 这样数据行不会被误当成表头。
export function impHeaderMap(cells) {
  const map = emptyMap();
  const claim = (key, i) => { if (map[key] < 0) { map[key] = i; map.hits++; } };
  const claimOpt = (key, k, i) => { if (map[key][k] < 0) { map[key][k] = i; map.hits++; } };
  const suffix = { zh: 'Zh', en: 'En' };
  (cells || []).forEach((raw, i) => {
    const t = norm(raw);
    if (!t) return;
    // 案例编号是单列（不分语言）；先认，免得「caseid」被当成别的列
    if (/(案例编号|案例id|caseid|caseno)/.test(t)) return claim('caseId', i);
    // 先按原样认一遍（旧表头如「选项E」「Option E」不会被当成带语言标记的「选项 + en」）。
    const tries = [{ base: t, lang: null }];
    const sl = splitLang(t);
    if (sl.lang) tries.unshift(sl);
    for (const { base, lang } of tries) {
      const sfx = lang ? suffix[lang] : '';
      const letter = base.match(/^(?:选项|option|opt)?([a-l])$/) || base.match(/^(?:选项|option|opt)(1[0-2]|[1-9])$/);
      if (letter) {
        const k = /[a-l]/.test(letter[1]) ? letter[1].charCodeAt(0) - 97 : Number(letter[1]) - 1;
        claimOpt('options' + sfx, k, i);
        if (lang) map.bilingual = true;
        return;
      }
      if (/^(题型|类型|type)$/.test(base)) return claim('type', i);
      if (/^(题目|题干|问题|question|stem)$/.test(base)) { if (lang) map.bilingual = true; return claim('question' + sfx, i); }
      if (/^(正确答案|参考答案|答案|answer|correct|key)$/.test(base)) return claim('answer' + sfx, i);
      if (/(解析|评分要点|评分标准|说明|explanation|rubric)/.test(base)) { if (lang) map.bilingual = true; return claim('expl' + sfx, i); }
      if (/(分值|分数|满分|points|score)/.test(base)) return claim('points', i);
      if (/^(分类|类别|categories|category)$/.test(base)) return claim('cats' + sfx, i);
    }
  });
  if (map.type < 0 || (map.question < 0 && map.questionZh < 0 && map.questionEn < 0)) return null;
  return map;
}

// Excel 复制到剪贴板是制表符分隔；不含制表符时按逗号拆（CSV 式粘贴）。
export function impSplitPaste(text) {
  const lines = String(text || '').replace(/^﻿/, '').split(/\r?\n/);
  const tabbed = lines.some((l) => l.includes('\t'));
  return lines.map((l) => (tabbed ? l.split('\t') : l.split(','))
    .map((c) => c.trim().replace(/^"([\s\S]*)"$/, '$1')));
}

// 表格（粘贴或文件）→ 逐行检查后的记录 + 表头匹配到的列数。
// opts.enabled：已开放的题型（缺省 = web/src/qtypes/spec.js 的 ENABLED；测试用它检查阶段开关）。
export function impParseGrid(grid, s, opts = {}) {
  const body = (grid || [])
    .map((cells, i) => ({ cells: (cells || []).map((c) => String(c ?? '')), n: i + 1 }))
    .filter((r) => r.cells.some((c) => c.trim()));
  if (!body.length) return { rows: [], headerCols: 0, bilingual: false };
  const hdr = impHeaderMap(body[0].cells);
  const data = hdr
    ? body.slice(1)
    // 无表头：仍去掉首格「看起来像」模板表头的行。
    : body.filter((r) => !/题型|type/i.test(String(r.cells[0] || '').replace(/\s|\*/g, '')));
  const rows = data.map((r) => impMapRow(r.cells, r.n, s, hdr || IMP_FIXED, opts));
  if (rows.some((r) => r._case || r._caseRef)) groupCases(rows, s);
  return {
    rows,
    headerCols: hdr ? hdr.hits : 0,
    bilingual: !!(hdr && hdr.bilingual),
  };
}

export function impTypeOf(raw) {
  const t = String(raw || '').trim().toLowerCase();
  if (!t) return null;
  // 先认含「填空」「multi」等字样的新题型，免得被单选 / 多选 / 填空截走
  if (/多空|完形|cloze|multi-?blank|blanks/.test(t)) return 'cloze';
  if (/案例|情境|情景|^case$|scenario/.test(t)) return 'case';
  if (/排序|^order(ing)?$|sequence/.test(t)) return 'ordering';
  if (/匹配|连线|^match(ing)?$/.test(t)) return 'matching';
  if (/分类|归类|classif|categori/.test(t)) return 'classify';
  if (/单选|single|^mcq$/.test(t)) return 'mcq';
  if (/多选|multi/.test(t)) return 'multi';
  if (/判断|true|^tf$|^t\/f$/.test(t)) return 'tf';
  if (/填空|fill/.test(t)) return 'fill';
  if (/问答|简答|open|essay|short/.test(t)) return 'open';
  return null;
}

// 一对中英文 → 题目字段的写法（与单题编辑器一致）。
const pair = (zh, en) => ({ main: en || zh, zh: zh || null });
const textPair = (zh, en) => { const p = pair(zh, en); return { text: p.main, text_zh: p.zh }; };
const TF_YES = /^(对|正确|是|true|t|√|y|a)$/i;
const TF_NO = /^(错|错误|否|false|f|×|n|b)$/i;
// 「左 => 右」「项目 → 类别」：只按第一个箭头拆
const ARROW = /\s*(?:=>|→|⇒)\s*/;
const splitArrow = (cell) => {
  const m = String(cell || '').match(ARROW);
  if (!m) return null;
  return [cell.slice(0, m.index).trim(), cell.slice(m.index + m[0].length).trim()];
};
// 多值单元格：| ｜ 、 或两侧带空格的 /（不拆「2/3」）
const splitAlts = (x) => String(x || '').split(/\s*[|｜、／]\s*|\s+\/\s+/).map((y) => y.trim()).filter(Boolean);
// 类别列表：按位置对齐中英文，所以空位保留
const splitCats = (x) => { const t = String(x || '').trim(); return t ? t.split(/\s*[|｜]\s*/).map((y) => y.trim()) : []; };
const firstLine = (x) => { const l = String(x || '').trim().split(/\r?\n/)[0] || ''; return l.length > 120 ? l.slice(0, 119) + '…' : l; };
// 重复文字（大小写不敏感，空的不比）：排序题的步骤不能重复（服务端同一规则）
const dupText = (list) => { const k = list.filter(Boolean).map((x) => String(x).trim().toLowerCase()); return new Set(k).size !== k.length; };
const tooLong = (arr, max) => arr.some((x) => x && String(x).length > max);

export function impMapRow(cells, rowNo, s, map = IMP_FIXED, opts = {}) {
  const enabled = Array.isArray(opts.enabled) ? opts.enabled : SPEC_ENABLED;
  const v = (i) => (i == null || i < 0 ? '' : String(cells[i] ?? '').trim());
  const at = (arr, k) => (Array.isArray(arr) ? arr[k] : -1);
  const word = impTypeOf(v(map.type));
  // 判断题未开放时沿用旧写法：存成「正确 / 错误」两个选项的单选题
  const type = word === 'tf' && !enabled.includes('tf') ? 'tfLegacy' : word;
  const stemZh = v(map.questionZh) || v(map.question);
  const stemEn = v(map.questionEn);
  const stem = pair(stemZh, stemEn);
  const answer = v(map.answer) || v(map.answerZh) || v(map.answerEn);
  const explZh = v(map.explZh) || v(map.expl);
  const explEn = v(map.explEn);
  const expl = pair(explZh, explEn);
  const caseId = v(map.caseId);
  // _ans 先放原始答案单元格，校验没过的行也能看到用户实际填了什么（越界的「E」正是错误本身）；
  // 各题型校验通过后改写成规范形式。_stemZh / _stemEn 只给预览表用，提交前随 _ 前缀字段一起去掉。
  const rec = {
    _row: rowNo, _err: null, _ans: answer, _stemZh: stemZh, _stemEn: stemEn,
    question: stem.main, question_zh: stem.zh, explanation: expl.main || '', explanation_zh: expl.zh,
  };
  // 案例编号：案例行自己的编号，或小题行指向的案例（先记下，本行有错时案例也能知道少了一道小题）
  if (type === 'case') rec._case = caseId;
  else if (caseId) rec._caseRef = caseId;
  // 两样都缺时只报一次，不让「题型」错误把空题干挡在后面。
  if (!type) { rec._err = stem.main ? s.impErrType : s.impErrTypeStem; return rec; }
  if (type !== 'tfLegacy' && !enabled.includes(type)) { rec.type = type; rec._err = s.impErrPhase; return rec; }
  if (!stem.main) { rec._err = s.impErrStem; rec.type = type === 'tfLegacy' ? 'mcq' : type; return rec; }
  // 每题分值（所有题型）：分值列 1–100 的整数；空或无效 = 不设置（按考试的题型默认分值）
  { const pv = Math.round(Number(v(map.points))); if (map.points >= 0 && String(v(map.points) || '').trim() !== '' && Number.isFinite(pv) && pv >= 1 && pv <= 100) rec.points = pv; }
  if (type === 'tfLegacy') {
    rec.type = 'mcq';
    const yes = TF_YES.test(answer);
    const no = TF_NO.test(answer);
    if (!yes && !no) { rec._err = s.impErrTf; return rec; }
    rec.options = [
      { text: 'True', text_zh: '正确', ok: yes },
      { text: 'False', text_zh: '错误', ok: no },
    ];
    rec._ans = yes ? s.impAnsTrue : s.impAnsFalse;
    return rec;
  }
  rec.type = type;
  // 选项格（A–L）：每个字母一对中英文，带字母，空的跳过
  const optCells = () => {
    const out = [];
    for (let i = 0; i < NOPT; i++) {
      const zh = v(at(map.optionsZh, i)) || v(at(map.options, i));
      const en = v(at(map.optionsEn, i));
      if (zh || en) out.push({ zh, en, letter: IMP_LETTERS[i] });
    }
    return out;
  };
  if (type === 'mcq' || type === 'multi') {
    const opts2 = [];
    for (let i = 0; i < NOPT; i++) {
      const p = pair(v(at(map.optionsZh, i)) || v(at(map.options, i)), v(at(map.optionsEn, i)));
      if (p.main) opts2.push({ text: p.main, text_zh: p.zh, _letter: IMP_LETTERS[i] });
    }
    if (opts2.length < 2) { rec._err = s.impErrOpts; return rec; }
    const letters = [...new Set(answer.toUpperCase().replace(/[^A-L]/g, '').split(''))].filter(Boolean);
    const okSet = new Set(letters);
    rec.options = opts2.map((o) => ({ text: o.text, text_zh: o.text_zh, ok: okSet.has(o._letter) }));
    // 字母超出最后一个选项是最常见的错，单说「需要 1 个答案」会把它藏起来，所以先点名报。
    const outside = letters.filter((l) => !opts2.some((o) => o._letter === l));
    if (outside.length) { rec._err = s.impErrRange(outside.join(',')); return rec; }
    const okN = rec.options.filter((o) => o.ok).length;
    if (!okN) { rec._err = s.impErrNoAns; return rec; }
    if (type === 'mcq' && okN > 1) { rec._err = s.impErrSingle; return rec; }
    rec._ans = letters.join('');
    return rec;
  }
  if (type === 'fill') {
    // 可接受答案不分语言（学员答中文或英文都算对）：中英文答案列都并进同一个 answers。
    // 「 / 」（两侧带空格）也算分隔，免得「2/3」被拆开。
    const split = (x) => x.split(/[|;；、]|\s+\/\s+|／/).map((y) => y.trim()).filter(Boolean);
    const answers = [...new Set([v(map.answer), v(map.answerZh), v(map.answerEn)].flatMap(split))];
    if (!answers.length) { rec._err = s.impErrFill; return rec; }
    rec.answers = answers;
    rec._ans = answers.join(' | ');
    return rec;
  }
  if (type === 'open') {
    // open：解析列即评分要点
    rec.rubric = expl.main || '';
    rec.rubric_zh = expl.zh;
    rec.maxPoints = Math.min(100, Math.max(1, Number(v(map.points)) || 10));
    delete rec.points; // 简答题：分值列是评分满分（maxPoints），卷面权重按考试的题型默认分值
    rec._ans = s.impAnsPoints(rec.maxPoints);
    delete rec.explanation; delete rec.explanation_zh;
    return rec;
  }
  if (type === 'tf') {
    const yes = TF_YES.test(answer);
    const no = TF_NO.test(answer);
    if (!yes && !no) { rec._err = s.impErrTf; return rec; }
    rec.answer = yes;
    rec._ans = yes ? s.impAnsTrue : s.impAnsFalse;
    return rec;
  }
  if (type === 'ordering') {
    const cs = optCells();
    const L = IMP_LIMITS.ordering;
    if (cs.length < L.min || cs.length > L.max) { rec._err = s.impErrOrderN(L.min, L.max); return rec; }
    if (tooLong(cs.flatMap((c) => [c.zh, c.en]), IMP_LIMITS.text)) { rec._err = s.impErrLong(IMP_LIMITS.text); return rec; }
    let ordered = cs;
    const seq = answer.toUpperCase().replace(/[^A-L]/g, '');
    if (seq) {
      const have = cs.map((c) => c.letter);
      const ok = seq.length === have.length && new Set(seq).size === seq.length && [...seq].every((l) => have.includes(l));
      if (!ok) { rec._err = s.impErrOrderSeq; return rec; }
      ordered = [...seq].map((l) => cs.find((c) => c.letter === l));
    }
    rec.items = ordered.map((c) => textPair(c.zh, c.en));
    if (dupText(rec.items.map((x) => x.text)) || dupText(rec.items.map((x) => x.text_zh))) { rec._err = s.impErrOrderDup; return rec; }
    rec._ans = (seq || cs.map((c) => c.letter).join('')).split('').join('→');
    return rec;
  }
  if (type === 'matching') {
    const cs = optCells();
    const pairs = [];
    const distractors = [];
    for (const c of cs) {
      const zh = c.zh ? splitArrow(c.zh) : ['', ''];
      const en = c.en ? splitArrow(c.en) : ['', ''];
      if (!zh || !en) { rec._err = s.impErrArrow(c.letter); return rec; }
      const left = textPair(zh[0], en[0]);
      const right = textPair(zh[1], en[1]);
      if (!right.text) { rec._err = s.impErrArrow(c.letter); return rec; }
      if (left.text) pairs.push({ left, right });
      else distractors.push(right);
    }
    const L = IMP_LIMITS.matching;
    if (pairs.length < L.min || pairs.length > L.max) { rec._err = s.impErrPairs(L.min, L.max); return rec; }
    if (distractors.length > L.distractorsMax) { rec._err = s.impErrDistractors(L.distractorsMax); return rec; }
    const rights = [...pairs.map((p) => p.right), ...distractors].map((r) => r.text.toLowerCase());
    if (new Set(rights).size !== rights.length) { rec._err = s.impErrDupRight; return rec; }
    if (tooLong(pairs.flatMap((p) => [p.left.text, p.left.text_zh, p.right.text, p.right.text_zh]).concat(distractors.flatMap((d) => [d.text, d.text_zh])), IMP_LIMITS.text)) { rec._err = s.impErrLong(IMP_LIMITS.text); return rec; }
    rec.pairs = pairs;
    rec.distractors = distractors;
    rec._ans = s.impAnsPairs(pairs.length, distractors.length);
    return rec;
  }
  if (type === 'classify') {
    const zhList = splitCats(v(map.catsZh) || v(map.cats));
    const enList = splitCats(v(map.catsEn));
    const nCat = Math.max(zhList.length, enList.length);
    const categories = [];
    for (let i = 0; i < nCat; i++) categories.push(textPair(zhList[i] || '', enList[i] || ''));
    const L = IMP_LIMITS.classify;
    if (nCat < L.catMin || nCat > L.catMax || categories.some((c) => !c.text)) { rec._err = s.impErrCats(L.catMin, L.catMax); return rec; }
    const findCat = (list, name) => {
      const k = String(name || '').trim().toLowerCase();
      return k ? list.findIndex((x) => String(x || '').trim().toLowerCase() === k) : -1;
    };
    const items = [];
    for (const c of optCells()) {
      // 一种语言写了「项目 => 类别」就够：另一种语言可以只写项目（没有箭头 = 整格是项目）
      const zh = c.zh ? (splitArrow(c.zh) || [c.zh.trim(), '']) : ['', ''];
      const en = c.en ? (splitArrow(c.en) || [c.en.trim(), '']) : ['', ''];
      const iz = findCat(zhList, zh[1]);
      const ie = findCat(enList, en[1]);
      if ((zh[1] && iz < 0) || (en[1] && ie < 0)) { rec._err = s.impErrCatUnknown(c.letter, zh[1] && iz < 0 ? zh[1] : en[1]); return rec; }
      if (iz >= 0 && ie >= 0 && iz !== ie) { rec._err = s.impErrCatUnknown(c.letter, `${zh[1]} / ${en[1]}`); return rec; }
      const cat = iz >= 0 ? iz : ie;
      if (cat < 0) { rec._err = s.impErrArrow(c.letter); return rec; }
      const t = textPair(zh[0], en[0]);
      if (!t.text) { rec._err = s.impErrArrow(c.letter); return rec; }
      items.push({ ...t, cat });
    }
    if (items.length < L.itemMin || items.length > L.itemMax) { rec._err = s.impErrClassItems(L.itemMin, L.itemMax); return rec; }
    if (categories.some((_, i) => !items.some((it) => it.cat === i))) { rec._err = s.impErrCatEmpty; return rec; }
    if (tooLong(categories.flatMap((c) => [c.text, c.text_zh]).concat(items.flatMap((it) => [it.text, it.text_zh])), IMP_LIMITS.text)) { rec._err = s.impErrLong(IMP_LIMITS.text); return rec; }
    rec.categories = categories;
    rec.items = items;
    rec._ans = s.impAnsCats(categories.length, items.length);
    return rec;
  }
  if (type === 'cloze') {
    // 题干里的空格标记：{{1}}…{{n}} 各出现一次；中英文题干都有时两边一致
    const markers = (t) => [...String(t || '').matchAll(/\{\{\s*(\d+)\s*\}\}/g)].map((m) => Number(m[1]));
    const okSeq = (ms) => ms.length > 0 && ms.slice().sort((a, b) => a - b).every((x, i) => x === i + 1);
    const mm = markers(rec.question);
    const mz = rec.question_zh ? markers(rec.question_zh) : mm;
    const L = IMP_LIMITS.cloze;
    if (!okSeq(mm) || !okSeq(mz) || mm.length !== mz.length || mm.length > L.max) { rec._err = s.impErrMarkers; return rec; }
    const n = mm.length;
    const parts = String(answer || '').split(/\s*[;；\n]\s*/).map((x) => x.trim()).filter(Boolean);
    const blanks = Array.from({ length: n }, () => null);
    for (const p of parts) {
      const m = p.match(/^(\d+)\s*[:：.、]\s*([\s\S]*)$/);
      const k = m ? Number(m[1]) : (n === 1 && parts.length === 1 ? 1 : 0);
      const alts = splitAlts(m ? m[2] : p);
      if (!k || k > n || blanks[k - 1] || !alts.length) { rec._err = s.impErrBlankAns; return rec; }
      blanks[k - 1] = { answers: [...new Set(alts)] };
    }
    if (blanks.some((b) => !b) || blanks.some((b) => b.answers.length > L.answersMax) || tooLong(blanks.flatMap((b) => b.answers), IMP_LIMITS.blankAnswer)) { rec._err = s.impErrBlankAns; return rec; }
    rec.blanks = blanks;
    rec._ans = blanks.map((b, i) => `${i + 1}: ${b.answers.join(' | ')}`).join('; ');
    return rec;
  }
  if (type === 'case') {
    // 案例行：题干 = 案例材料；小题在后面的行（groupCases 收拢）
    if (!caseId) { rec._err = s.impErrCaseId; return rec; }
    if (String(stem.main).length > IMP_LIMITS.passage || String(stem.zh || '').length > IMP_LIMITS.passage) { rec._err = s.impErrLong(IMP_LIMITS.passage); return rec; }
    rec.passage = stem.main;
    rec.passage_zh = stem.zh;
    // 案例自己的题干（标题 / 作答说明）：与单题编辑器一致，用材料的第一行（服务端题干必填）
    rec.question = firstLine(stem.main);
    rec.question_zh = stem.zh ? firstLine(stem.zh) : null;
    delete rec.points; // 案例的分值 = 各小题分值之和
    rec.items = [];
    return rec;
  }
  rec._err = s.impErrType;
  return rec;
}

// 案例行与它的小题行收拢：小题行标 _sub（预览缩进显示，自己不单独提交），写进案例的 items。
// 小题写在案例行之前、案例编号不存在、题型不能做小题、小题本身有错、小题数不在 2–8 → 报在相应的行上。
function groupCases(rows, s) {
  const cases = new Map();     // 案例编号（不分大小写）→ 案例行
  const firstAt = new Map();   // 案例编号 → 案例行在 rows 里的位置
  rows.forEach((r, i) => {
    if (r._case == null || r.type !== 'case') return;
    const k = String(r._case).trim().toLowerCase();
    if (!k) return;
    if (cases.has(k)) { if (!r._err) r._err = s.impErrCaseDup(r._case); return; }
    cases.set(k, r);
    firstAt.set(k, i);
  });
  rows.forEach((r, i) => {
    if (!r._caseRef) return;
    const k = String(r._caseRef).trim().toLowerCase();
    r._sub = true;
    if (!cases.has(k)) {
      const later = rows.some((x, j) => j > i && x.type === 'case' && String(x._case || '').trim().toLowerCase() === k);
      if (!r._err) r._err = later ? s.impErrCaseOrder(r._caseRef) : s.impErrCaseUnknown(r._caseRef);
      return;
    }
    if (firstAt.get(k) > i) { if (!r._err) r._err = s.impErrCaseOrder(r._caseRef); return; }
    const host = cases.get(k);
    r._parent = host._row;
    if (!r._err && !(SPEC_TYPES[r.type] && SPEC_TYPES[r.type].caseItem)) r._err = s.impErrCaseSub;
    (host._subs = host._subs || []).push(r);
  });
  for (const host of cases.values()) {
    const subs = host._subs || [];
    delete host._subs;
    if (host._err) continue;
    const bad = subs.filter((r) => r._err);
    if (bad.length) { host._err = s.impErrCaseBadSub(bad.map((r) => r._row).join(', ')); continue; }
    const L = IMP_LIMITS.case;
    if (subs.length < L.min || subs.length > L.max) { host._err = s.impErrCaseN(L.min, L.max); continue; }
    host.items = subs.map((r) => stripImp(r));
    host._ans = s.impAnsSubs(subs.length);
  }
}

// 去掉只给预览用的 _ 前缀字段
export function stripImp(r) {
  return Object.fromEntries(Object.entries(r).filter(([k]) => !k.startsWith('_')));
}

// 预览行 → 提交给 POST /api/admin/questions/bulk 的 items：有错的行、案例的小题行（已并进案例）都不单独提交。
// 一组案例连同小题算 1 条（计入每批上限）。
export function impItems(rows) {
  return (rows || []).filter((r) => !r._err && !r._sub).map(stripImp);
}

/* ---------------- 导出（题库 → 与导入模板同一版式，导出的文件可原样再导入） ---------------- */

const LETTERS_OF = (n) => IMP_LETTERS.slice(0, n);
const S0 = (x) => (x == null ? '' : String(x));
const TF_WORD = { true: '对', false: '错' };
const TYPE_WORD = {
  mcq: '单选', multi: '多选', tf: '判断', fill: '填空', cloze: '多空填空', ordering: '排序',
  matching: '匹配', classify: '分类', open: '问答', case: '案例',
};

// 一道题（GET /api/admin/questions 的条目，或案例的小题）→ 模板的一行。caseId 给案例行与它的小题行。
function exportRow(q, caseId) {
  const H = IMP_TEMPLATE_HEADERS;
  const row = new Array(H.length).fill('');
  const col = (h) => H.indexOf(h);
  const opt = (i, zh, en) => { row[col(`选项${IMP_LETTERS[i]}(中文)`)] = S0(zh); row[col(`Option ${IMP_LETTERS[i]} (EN)`)] = S0(en); };
  row[col('题型 *')] = TYPE_WORD[q.type] || q.type;
  row[col('题干(中文)')] = S0(q.question_zh);
  row[col('Stem (EN)')] = S0(q.question);
  row[col('解析(中文)')] = S0(q.explanation_zh);
  row[col('Explanation (EN)')] = S0(q.explanation);
  row[col('分值')] = q.points == null ? '' : String(q.points);
  if (caseId) row[col('案例编号 / Case ID')] = caseId;
  const ans = (x) => { row[col('正确答案')] = x; };
  const arrow = (a, b) => `${S0(a)} => ${S0(b)}`.trim();
  switch (q.type) {
    case 'mcq': case 'multi': {
      const os = (q.options || []).slice(0, NOPT);
      os.forEach((o, i) => opt(i, o.text_zh, o.text));
      ans(LETTERS_OF(os.length).filter((_, i) => os[i].ok).join(''));
      break;
    }
    case 'tf': ans(TF_WORD[String(!!q.answer)]); break;
    case 'fill': ans((q.answers || []).join(' | ')); break;
    case 'cloze': ans((q.blanks || []).map((b, i) => `${i + 1}: ${(b.answers || []).join(' | ')}`).join('; ')); break;
    case 'ordering': (q.items || []).slice(0, NOPT).forEach((it, i) => opt(i, it.text_zh, it.text)); break;
    case 'matching': {
      const cells = [
        ...(q.pairs || []).map((p) => [p.left || {}, p.right || {}]),
        ...(q.distractors || []).map((d) => [{}, d || {}]),
      ].slice(0, NOPT);
      cells.forEach(([l, r], i) => {
        const zh = (l.text_zh || r.text_zh) ? arrow(l.text_zh, r.text_zh) : '';
        opt(i, zh, arrow(l.text, r.text));
      });
      break;
    }
    case 'classify': {
      const cats = q.categories || [];
      if (cats.some((c) => c.text_zh)) row[col('分类(中文)')] = cats.map((c) => S0(c.text_zh)).join(' | ');
      row[col('Categories (EN)')] = cats.map((c) => S0(c.text)).join(' | ');
      (q.items || []).slice(0, NOPT).forEach((it, i) => {
        const c = cats[it.cat] || {};
        const zh = it.text_zh ? `${it.text_zh} => ${S0(c.text_zh || '')}`.trim() : '';
        opt(i, zh, `${S0(it.text)} => ${S0(c.text)}`);
      });
      break;
    }
    case 'open':
      row[col('解析(中文)')] = S0(q.rubric_zh);
      row[col('Explanation (EN)')] = S0(q.rubric);
      row[col('分值')] = q.maxPoints == null ? '' : String(q.maxPoints);
      break;
    case 'case':
      row[col('题干(中文)')] = S0(q.passage_zh);
      row[col('Stem (EN)')] = S0(q.passage);
      row[col('分值')] = '';
      break;
    default: break;
  }
  return row;
}

// 题库条目 → [表头, ...行]（与 IMP_TEMPLATE_HEADERS 同一版式）。案例依次编号 C1、C2…，小题紧跟在案例行之后。
// unsupported（本页面不认识的新题型）跳过并计数。
export function impExportGrid(questions) {
  const out = [IMP_TEMPLATE_HEADERS.slice()];
  let caseN = 0;
  let skipped = 0;
  for (const q of questions || []) {
    if (!q || q.unsupported || !TYPE_WORD[q.type]) { skipped++; continue; }
    if (q.type === 'case') {
      caseN += 1;
      const id = `C${caseN}`;
      out.push(exportRow(q, id));
      for (const it of q.items || []) out.push(exportRow(it, id));
    } else {
      out.push(exportRow(q, ''));
    }
  }
  return { grid: out, skipped };
}
