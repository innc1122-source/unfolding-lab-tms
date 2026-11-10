"use strict";
// 题型注册表单元测试的共用工具：带种子的随机数与 Fisher-Yates 打乱（与 server.js shuffle 同一写法，只是随机源可复现）。
function rngOf(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function shuffleOf(rng) {
  return (arr) => {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  };
}
// 深度扫描：返回对象里出现的禁用键路径
function findKeys(obj, banned, at = "$", out = []) {
  if (Array.isArray(obj)) obj.forEach((v, i) => findKeys(v, banned, `${at}[${i}]`, out));
  else if (obj && typeof obj === "object") {
    for (const [k, v] of Object.entries(obj)) {
      if (banned.includes(k)) out.push(`${at}.${k}`);
      findKeys(v, banned, `${at}.${k}`, out);
    }
  }
  return out;
}
module.exports = { rngOf, shuffleOf, findKeys };
