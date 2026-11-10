// 组卷「随机抽题，再调整」（第四批 6.2，2026-10-08）：纯函数，无 import（test/exam-draw.test.js 直接 import 跑）。
//
// drawPaper(bank, rules, rng) → { ids, short: [{ type, want, got }] }
//   bank   题库条目（已按关联课程过滤、去掉 unsupported 与未开放题型）：{ id, type, moduleId, ... }
//   rules  {
//            counts:   { [题型]: 题数 }       组卷弹窗：每个题型各抽几道（case = 案例组数，也可用 caseCount）
//            groups:   { objective, open, case }  「预览一套随机试卷」：与服务端开考同一口径，客观题各题型合成一个池
//            caseCount 案例组数（counts.case 的别名）
//            balance   true = 按模块轮流抽（模块先打乱，模块内再打乱），尽量每个模块都抽到
//            exclude   不参与抽题的 id（「只从未加入的题中抽」时传试卷上已有的题）
//            order     题型顺序（缺省按题型注册表顺序）
//          }
//   rng    () => [0, 1) 的随机数；测试传固定种子的版本，结果可复现
// 返回的 ids 按题型顺序排列（同一题型内为抽中的顺序）；某个题型题库不够时照样抽完能抽的，并在 short 里报「要 n 只抽到 m」。
// 案例题组整组抽（一题 = 一组），不拆小题。

export const DRAW_ORDER = ['mcq', 'multi', 'tf', 'fill', 'cloze', 'ordering', 'matching', 'classify', 'open', 'case'];

// 题型 → 抽题分组（与服务端 REG.groupOf 同口径：简答 = open，案例 = case，其余 = objective）
export function drawGroupOf(type) {
  if (type === 'open') return 'open';
  if (type === 'case') return 'case';
  return 'objective';
}

function shuffled(arr, rng) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const t = a[i]; a[i] = a[j]; a[j] = t;
  }
  return a;
}

// 从 list 里抽 want 道。balance：模块轮流（round-robin），否则整体打乱后取前 want 道。
function pick(list, want, balance, rng) {
  if (want <= 0 || !list.length) return [];
  if (!balance) return shuffled(list, rng).slice(0, want);
  const byMod = new Map();
  for (const q of list) {
    const k = q.moduleId == null || q.moduleId === '' ? '' : String(q.moduleId);
    if (!byMod.has(k)) byMod.set(k, []);
    byMod.get(k).push(q);
  }
  const queues = shuffled([...byMod.keys()], rng).map((k) => shuffled(byMod.get(k), rng));
  const out = [];
  while (out.length < want && queues.some((qq) => qq.length)) {
    for (const qq of queues) {
      if (out.length >= want) break;
      if (qq.length) out.push(qq.shift());
    }
  }
  return out;
}

const toCount = (v) => {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n > 0 ? n : 0;
};

export function drawPaper(bank, rules = {}, rng = Math.random) {
  const exclude = new Set((rules.exclude || []).map(String));
  const list = (bank || []).filter((q) => q && q.id != null && !q.unsupported && !exclude.has(String(q.id)));
  const order = Array.isArray(rules.order) && rules.order.length ? rules.order : DRAW_ORDER;
  const balance = rules.balance !== false;
  const ids = [];
  const short = [];
  const take = (key, pool, want) => {
    if (want <= 0) return;
    const got = pick(pool, want, balance, rng);
    for (const q of got) ids.push(q.id);
    if (got.length < want) short.push({ type: key, want, got: got.length });
  };
  if (rules.groups) {
    // 预览随机试卷：按分组抽（客观题各题型合池），与服务端 /api/exam/start 一致
    for (const g of ['objective', 'open', 'case']) {
      take(g, list.filter((q) => drawGroupOf(q.type) === g), toCount(rules.groups[g]));
    }
    return { ids, short };
  }
  const counts = { ...(rules.counts || {}) };
  if (rules.caseCount != null && counts.case == null) counts.case = rules.caseCount;
  const keys = [...order, ...Object.keys(counts).filter((k) => !order.includes(k))];
  for (const t of keys) take(t, list.filter((q) => q.type === t), toCount(counts[t]));
  return { ids, short };
}

// 固定种子的随机数（mulberry32）：预览「一套示例」时用同一个种子，重渲染不换题
export function seededRng(seed) {
  let a = (Number(seed) >>> 0) || 1;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
