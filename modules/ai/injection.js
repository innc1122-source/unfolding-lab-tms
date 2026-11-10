// 不可信输入的两道防线（方案 2.2.1 第 6 条、4.3 第 4 条）：
//   1) dataBlock()：每次调用随机生成 128 位边界串，把员工写的文本放进 <<<DATA 边界>>> … <<<END 边界>>> 之间；
//      写入前删除文本里出现的边界串，并把 < > 转义为 &lt; &gt;。员工先写 </answer> 再接指令的做法因此无效。
//   2) detectInjection()：服务端确定性检测，不依赖模型自报。命中即不采用 AI 分数（转 HR），画像中该条文本不发送。
// 词表随提示词版本一起维护；误报的代价只是多一次人工复核。
"use strict";
const crypto = require("crypto");

const PATTERNS = [
  // 英文
  /ignore\s+(?:all\s+|the\s+|any\s+)?(?:previous|above|prior|earlier)\s+(?:instructions?|rules?|prompts?)/i,
  /disregard\s+(?:all\s+|the\s+|any\s+)?(?:previous|above|prior)\s+(?:instructions?|rules?)/i,
  /give\s+(?:me\s+|this\s+(?:answer\s+)?)?(?:full|maximum|max|perfect)\s+(?:marks?|scores?|points?)/i,
  /system\s+prompt/i,
  /you\s+are\s+now\b/i,
  // 中文
  /忽略(?:以上|之前|前面|上述|所有)/,
  /给(?:我|这个答案|本题)?(?:打)?满分/,
  /系统提示/,
  /你现在是/,
  // 菲律宾语
  /huwag\s+pansinin\s+ang\s+(?:mga\s+)?(?:naunang|nakaraang)/i,
  /bigyan\s+(?:mo\s+)?(?:ako\s+)?ng\s+(?:buong|perpektong)\s+(?:marka|puntos)/i,
  // 数据区块标记与形似系统标签的文本
  /<<<\s*(?:DATA|END)/i,
  /<\/?\s*(?:system|assistant|user|answer|instructions?|prompt|module_content|data)\s*>/i,
];

function detectInjection(text) {
  const s = String(text || "");
  return PATTERNS.some((re) => re.test(s));
}

function newBoundary() {
  return crypto.randomBytes(16).toString("hex");
}
// label：给模型看的区块说明（如 "TRAINEE_ANSWER"），只含大写字母与下划线
function dataBlock(text, label, boundary) {
  const b = boundary || newBoundary();
  const clean = String(text == null ? "" : text).split(b).join("").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const tag = String(label || "DATA").replace(/[^A-Z_]/g, "");
  return { boundary: b, block: `<<<DATA ${b} ${tag}>>>\n${clean}\n<<<END ${b}>>>` };
}

module.exports = { detectInjection, dataBlock, newBoundary, PATTERNS };
