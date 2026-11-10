// 脱敏规则库（方案 2.2.2，R1–R7）：纯函数，零依赖。发给模型之前，按规则去除或替换直接标识。
//
// 用法：
//   const ctx = createContext({ self, managers, roster, departments, selfLabel });
//   const safe = redact(text, ctx);             // R1–R5c；按上下文替换
//   const safe2 = redact(text, ctx, { r6: true, r7: true });   // 画像：部门占位（R6）、敏感话题整句删除（R7）
//   restore(modelOutput, ctx)                   // 只还原登记为「可还原」的占位符（部门、上级）
//   ctx.counts                                  // 各规则的替换次数，写入 ai_calls.redactions（只记次数）
//
// 这是「去标识化」，不是「匿名化」：规则库识别不了单词名、昵称、花名册以外的人名（客户或玩家的姓名）
// 以及间接可识别的描述（方案 2.2.2 残余风险，已写入 HANDOVER-IT §10.8）。
"use strict";

// R1 邮箱
const RE_EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
// R2 电话：菲律宾手机（+63 / 0 9xx…）、马尼拉固话 (02) xxxx xxxx、带国际区号的长号码
const RE_PHONE = [
  /(?:\+?63|0)[\s-]?9\d{2}[\s-]?\d{3}[\s-]?\d{4}\b/g,
  /\(0?2\)[\s-]?\d{3,4}[\s-]?\d{4}\b/g,
  /\+\d{1,3}[\s-]?\(?\d{1,4}\)?[\s-]?\d{3,4}[\s-]?\d{3,4}\b/g,
];
// R3 证件号：TIN、SSS、PhilHealth、Pag-IBIG、UMID CRN 的常见分组格式
const RE_GOVID = [
  /\b\d{3}-\d{3}-\d{3}(?:-\d{3,5})?\b/g,      // TIN
  /\b\d{2}-\d{7}-\d\b/g,                       // SSS
  /\b\d{2}-\d{9}-\d\b/g,                       // PhilHealth
  /\b\d{4}-\d{4}-\d{4}\b/g,                    // Pag-IBIG
  /\b\d{4}-\d{7}-\d\b/g,                       // UMID CRN
];
// R4 长数字串（账户、卡号）：9–19 位连续数字，或 4 位一组的分组数字。放在 R2、R3 之后
const RE_LONGNUM = [/\b\d{4}(?:[ -]\d{4}){2,3}\b/g, /\b\d{9,19}\b/g];
// R7 敏感话题词表（中、英、菲律宾语）：命中的整句删除
const SENSITIVE = [
  "健康", "医疗", "就医", "住院", "病假", "生病", "疾病", "怀孕", "孕", "产假", "流产", "残疾", "宗教", "信仰", "工会", "婚姻", "离婚", "结婚", "家属", "家人", "家庭",
  "health", "medical", "hospital", "sick leave", "illness", "diagnos", "pregnan", "maternity", "miscarriage", "disabilit", "religio", "church", "union", "marriage", "married", "divorce", "family member", "spouse",
  "sakit", "ospital", "buntis", "manganak", "relihiyon", "simbahan", "unyon", "kasal", "hiwalay", "pamilya", "asawa",
];
// 两个汉字的花名册姓名如果同时是常用词，只在前后有称谓或标点时才匹配（避免误伤）
const CJK_STOP = new Set(["高兴", "文明", "金钱", "安全", "平安", "明天", "向前", "方便", "常规", "江湖", "林业", "白天", "黄金", "春天", "海洋", "王国", "高明", "方向", "马上", "于是", "东方", "华丽", "成功", "胜利", "永远", "开心", "晓得"]);
const CJK_TITLE = /^(?:经理|主管|总监|总|同事|先生|女士|小姐|老师|组长|科长|部长|主任|姐|哥|[，。、：；！？,.:;!?\s（）()「」“”"'])/;
const CJK_TITLE_BEFORE = /(?:和|跟|与|给|对|向|把|被|让|请|[，。、：；！？,.:;!?\s（）()「」“”"'])$/;

const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const isCjkName = (s) => /^[一-鿿]{2,}$/.test(s);
const wordCount = (s) => String(s).trim().split(/\s+/).filter(Boolean).length;

// createContext({ self, managers, roster, departments, selfLabel })
//   self        { name, employeeId }         本人（学员 / 被分析的员工）
//   managers    [姓名]                       实线上级与虚线上级，替换为 [上级]（可还原）
//   roster      [姓名]                       花名册全名；拉丁字母两词及以上、中文两字及以上才参与匹配
//   departments [部门名]                     R6 用（画像），替换为 [部门A]…（可还原）
//   selfLabel   "[学员]" | "[员工]"          本人的占位符
function createContext(o = {}) {
  const self = o.self || {};
  const selfNames = [self.name, self.employeeId].filter((x) => typeof x === "string" && x.trim().length >= 2).map((x) => x.trim());
  const managers = [...new Set((o.managers || []).filter((x) => typeof x === "string" && x.trim().length >= 2).map((x) => x.trim()))];
  const skip = new Set([...selfNames, ...managers].map((x) => x.toLowerCase()));
  const roster = [...new Set((o.roster || []).filter((n) => typeof n === "string").map((n) => n.trim()))]
    .filter((n) => !skip.has(n.toLowerCase()) && (isCjkName(n) || wordCount(n) >= 2))
    .sort((a, b) => b.length - a.length); // 长名先匹配：「张伟明」不能先被「张伟」替换掉一截
  const departments = [...new Set((o.departments || []).filter((d) => typeof d === "string" && d.trim().length >= 2).map((d) => d.trim()))]
    .sort((a, b) => b.length - a.length);
  return {
    selfLabel: o.selfLabel || "[员工]",
    selfNames, managers, roster, departments,
    counts: {},
    people: new Map(), // 原名（小写）→ [人员N]
    depts: new Map(),  // 部门名 → [部门A]
    // 占位符 → 原文（只有部门与上级）。[上级] 一律还原为实线上级（方案 2.2.3 D「[上级] 还原为姓名」），
    // 不论输入里是否出现过上级的姓名 —— 模型按提示词用 [上级] 指代上级时同样要还原
    restorable: new Map(managers.length ? [["[上级]", managers[0]]] : []),
    seq: { email: 0, phone: 0, id: 0, num: 0 },
  };
}
function bump(ctx, rule, n = 1) { ctx.counts[rule] = (ctx.counts[rule] || 0) + n; }

function replaceAll(text, re, fn) {
  re.lastIndex = 0;
  return text.replace(re, fn);
}
// 拉丁字母姓名：不区分大小写的整词匹配
function latinNameRe(name) {
  return new RegExp("(^|[^\\p{L}\\p{N}])(" + escRe(name).replace(/\s+/g, "\\s+") + ")(?=$|[^\\p{L}\\p{N}])", "giu");
}
function replaceName(text, name, placeholder, ctx, rule) {
  if (isCjkName(name)) {
    if (!text.includes(name)) return text;
    let out = "", i = 0;
    for (;;) {
      const j = text.indexOf(name, i);
      if (j < 0) { out += text.slice(i); break; }
      const before = text.slice(0, j), after = text.slice(j + name.length);
      const guarded = name.length === 2 && CJK_STOP.has(name);
      const ok = !guarded || CJK_TITLE.test(after) || CJK_TITLE_BEFORE.test(before) || before === "" || after === "";
      out += text.slice(i, j) + (ok ? placeholder : name);
      if (ok) bump(ctx, rule);
      i = j + name.length;
    }
    return out;
  }
  if (!text.toLowerCase().includes(name.toLowerCase().split(/\s+/)[0])) return text;
  return text.replace(latinNameRe(name), (m, pre) => { bump(ctx, rule); return pre + placeholder; });
}

function redact(text, ctx, opts = {}) {
  let s = String(text == null ? "" : text);
  if (!s) return s;
  // R7（只在画像被批准为 mask 的自由文本上用）：先删整句，避免句子里的标识再被替换成占位符后泄露上下文
  if (opts.r7) {
    const parts = s.split(/(?<=[。！？!?；;.\n])/);
    s = parts.map((p) => {
      const low = p.toLowerCase();
      if (SENSITIVE.some((w) => low.includes(w))) { bump(ctx, "R7"); return "[已删除]"; }
      return p;
    }).join("");
  }
  s = replaceAll(s, RE_EMAIL, () => { bump(ctx, "R1"); return `[邮箱${++ctx.seq.email}]`; });
  for (const re of RE_PHONE) s = replaceAll(s, re, () => { bump(ctx, "R2"); return `[电话${++ctx.seq.phone}]`; });
  for (const re of RE_GOVID) s = replaceAll(s, re, () => { bump(ctx, "R3"); return `[证件号${++ctx.seq.id}]`; });
  for (const re of RE_LONGNUM) s = replaceAll(s, re, () => { bump(ctx, "R4"); return `[号码${++ctx.seq.num}]`; });
  // R5 / R5c：本人（姓名、工号）→ selfLabel；上级 → [上级]（可还原）；花名册其他全名 → [人员N]（不还原）
  for (const n of ctx.selfNames) s = replaceName(s, n, ctx.selfLabel, ctx, isCjkName(n) ? "R5c" : "R5");
  for (const n of ctx.managers) {
    const before = s;
    s = replaceName(s, n, "[上级]", ctx, isCjkName(n) ? "R5c" : "R5");
    if (s !== before) ctx.restorable.set("[上级]", n);
  }
  const low = s.toLowerCase();
  for (const n of ctx.roster) {
    const probe = isCjkName(n) ? n : n.toLowerCase().split(/\s+/)[0];
    if (!(isCjkName(n) ? s.includes(probe) : low.includes(probe))) continue;
    const key = n.toLowerCase();
    let ph = ctx.people.get(key);
    const next = replaceName(s, n, ph || "\u0000", ctx, isCjkName(n) ? "R5c" : "R5");
    if (next === s) continue;
    if (!ph) { ph = `[人员${ctx.people.size + 1}]`; ctx.people.set(key, ph); }
    s = next.split("\u0000").join(ph);
  }
  // R6（画像）：部门名 → [部门A]…，可还原
  if (opts.r6) {
    for (const d of ctx.departments) {
      if (!s.includes(d)) continue;
      let ph = ctx.depts.get(d);
      if (!ph) { ph = `[部门${String.fromCharCode(65 + (ctx.depts.size % 26))}${ctx.depts.size >= 26 ? Math.floor(ctx.depts.size / 26) : ""}]`; ctx.depts.set(d, ph); ctx.restorable.set(ph, d); }
      const n = s.split(d).length - 1;
      bump(ctx, "R6", n);
      s = s.split(d).join(ph);
    }
  }
  return s;
}
// 部门占位（结构化字段直接替换，不做全文扫描）：transfer 的 fromDept / toDept
function deptPlaceholder(ctx, d) {
  const name = String(d || "").trim();
  if (!name) return "";
  let ph = ctx.depts.get(name);
  if (!ph) { ph = `[部门${String.fromCharCode(65 + (ctx.depts.size % 26))}${ctx.depts.size >= 26 ? Math.floor(ctx.depts.size / 26) : ""}]`; ctx.depts.set(name, ph); ctx.restorable.set(ph, name); }
  bump(ctx, "R6");
  return ph;
}
// 占位符还原：只还原部门与上级；[员工] / [学员] / [人员N] 以及电话、邮箱等占位符保持原样。
// 调用方（功能层）只在全部校验通过之后调用一次（方案 3.2）。
function restore(text, ctx, opts = {}) {
  let s = String(text == null ? "" : text);
  for (const [ph, orig] of ctx.restorable) s = s.split(ph).join(orig);
  if (opts.selfAs) s = s.split(ctx.selfLabel).join(opts.selfAs);
  return s;
}

module.exports = { createContext, redact, restore, deptPlaceholder, SENSITIVE };
