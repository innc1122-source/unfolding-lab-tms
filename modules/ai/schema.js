// AI 输出结构：三种协议共用的 JSON Schema 子集、按协议转换、本地结构校验（零依赖，纯函数）。
//
// 为什么只用子集（方案 3.2「上游 schema 的公共子集」）：
//   · Anthropic 结构化输出不支持 minimum / maximum / minLength 等约束，并要求对象写 additionalProperties:false；
//   · OpenAI strict 模式要求每个属性都列进 required；
//   · Gemini 不接受 additionalProperties，可空类型要写 nullable:true。
// 所以各功能的 schema 只写：type、properties、required、items、enum、additionalProperties:false；
// 所有属性都必填，可空字段写成 ["string","null"]。数值范围、正确项个数、字符串长度这类约束
// 一律放在各功能的「语义校验」里（本地执行，不依赖上游）。
"use strict";

const ALLOWED_KEYS = new Set(["type", "properties", "required", "items", "enum", "additionalProperties", "description"]);
const TYPES = new Set(["string", "number", "integer", "boolean", "object", "array", "null"]);

// 写 schema 时自查：只用了子集、对象都写了 additionalProperties:false、属性全部必填。
// 返回问题列表（空 = 合格）。测试逐一跑一遍各功能的 schema。
function lintSchema(schema, at = "$") {
  const out = [];
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return [`${at}: schema must be an object`];
  for (const k of Object.keys(schema)) if (!ALLOWED_KEYS.has(k)) out.push(`${at}: keyword "${k}" is outside the shared subset`);
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  for (const t of types) if (!TYPES.has(t)) out.push(`${at}: unknown type ${JSON.stringify(t)}`);
  if (types.includes("object")) {
    if (schema.additionalProperties !== false) out.push(`${at}: objects must set additionalProperties:false`);
    const props = Object.keys(schema.properties || {});
    const req = new Set(schema.required || []);
    for (const p of props) if (!req.has(p)) out.push(`${at}.${p}: every property must be listed in required`);
    for (const p of props) out.push(...lintSchema(schema.properties[p], `${at}.${p}`));
  }
  if (types.includes("array")) {
    if (!schema.items) out.push(`${at}: arrays need items`);
    else out.push(...lintSchema(schema.items, `${at}[]`));
  }
  return out;
}

// 按协议转换（发给上游的形状）。anthropic-messages / openai-chat 原样；gemini 去掉 additionalProperties，
// 把 ["x","null"] 改写为 { type: "x", nullable: true }（Gemini 的 OpenAPI 风格子集）。
function toProtocol(schema, protocol) {
  const clone = JSON.parse(JSON.stringify(schema));
  if (protocol !== "gemini") return clone;
  (function walk(o) {
    if (Array.isArray(o)) return o.forEach(walk);
    if (!o || typeof o !== "object") return;
    delete o.additionalProperties;
    if (Array.isArray(o.type)) {
      const nonNull = o.type.filter((t) => t !== "null");
      if (o.type.includes("null")) o.nullable = true;
      o.type = nonNull.length === 1 ? nonNull[0] : nonNull[0] || "string";
    }
    for (const v of Object.values(o)) walk(v);
  })(clone);
  return clone;
}

function typeOf(v) {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  if (typeof v === "number") return Number.isInteger(v) ? "integer" : "number";
  return typeof v;
}
function typeOk(want, v) {
  const got = typeOf(v);
  if (want === got) return true;
  if (want === "number" && got === "integer") return true;
  return false;
}

// 结构校验：值是否符合（子集）schema。返回第一处问题的描述，符合时返回 null。
// 描述只含路径与期望的类型，不含值本身（值来自模型输出，可能夹带员工数据，不进日志）。
function validate(schema, value, at = "$") {
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  if (!types.some((t) => typeOk(t, value))) return `${at}: expected ${types.join("|")}, got ${typeOf(value)}`;
  if (schema.enum && !schema.enum.includes(value)) return `${at}: value not in enum`;
  const t = typeOf(value);
  if (t === "object" && schema.properties) {
    for (const r of schema.required || []) if (!(r in value)) return `${at}.${r}: missing`;
    if (schema.additionalProperties === false)
      for (const k of Object.keys(value)) if (!(k in schema.properties)) return `${at}.${k}: unexpected property`;
    for (const [k, sub] of Object.entries(schema.properties)) {
      if (!(k in value)) continue;
      const e = validate(sub, value[k], `${at}.${k}`);
      if (e) return e;
    }
  }
  if (t === "array" && schema.items) {
    for (let i = 0; i < value.length; i++) {
      const e = validate(schema.items, value[i], `${at}[${i}]`);
      if (e) return e;
    }
  }
  return null;
}

// 模型输出文本 → JSON：容忍前后的 ```json 围栏与多余空白（json_object / none 两档能力下常见）。
// 解析失败返回 undefined（调用方按 ai_output_invalid 走补救调用）。
function parseJsonText(text) {
  let s = String(text || "").trim();
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(s);
  if (fence) s = fence[1].trim();
  try { return JSON.parse(s); } catch { /* fall through */ }
  const a = s.indexOf("{"), b = s.lastIndexOf("}");
  if (a >= 0 && b > a) { try { return JSON.parse(s.slice(a, b + 1)); } catch { /* ignore */ } }
  return undefined;
}

module.exports = { lintSchema, toProtocol, validate, parseJsonText };
