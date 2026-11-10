// 「结果算不算通过」这条判定有两份，分处前后端，而且没有共享模块可以 require：
//   server.js  applyRecordSideEffects 里的 passOk —— 决定要不要真的改员工主数据；
//   web/src/pages/admin/People.jsx 里的 PASS_RE —— 决定表单里提不提示「这次保存不会
//   同步」、时间线上写「已同步」还是「未同步」。
// 一边改了另一边不会报错、不会构建失败，界面提示就开始与实际行为脱节 —— 而「勾了
// 同步、保存成功、员工状态其实没变，界面还一言不发」正是本组测试要钉住的那类 bug。
// 所以这里比对的是源码里的正则字面量本身（不是行为），字面量一变就红。
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const SERVER = path.join(ROOT, "server.js");
const PEOPLE = path.join(ROOT, "web", "src", "pages", "admin", "People.jsx");
const read = (p) => fs.readFileSync(p, "utf8");

// A single-line /…/i literal. [^/] keeps a match from running past its own
// closing slash into the next literal on the same line.
const LITERAL = "\\/[^/\\r\\n]+\\/i";

// server.js keeps both halves of the rule on the one passOk line: the pass
// pattern first, the veto pattern second.
function serverRule() {
  const lines = read(SERVER).split(/\r?\n/).filter((l) => l.includes("const passOk ="));
  assert.equal(lines.length, 1, "expected exactly one 'const passOk =' in server.js — if the pass rule moved or was duplicated, re-point this test at it");
  const found = lines[0].match(new RegExp(LITERAL, "g")) || [];
  assert.equal(found.length, 2, "expected a pass literal and a veto literal on the passOk line: " + lines[0].trim());
  return { pass: found[0], fail: found[1] };
}

function peopleRule() {
  const src = read(PEOPLE);
  const pass = (src.match(new RegExp("const PASS_RE = (" + LITERAL + ");")) || [])[1];
  const fail = (src.match(new RegExp("const FAIL_RE = (" + LITERAL + ");")) || [])[1];
  assert.ok(pass && fail, "People.jsx no longer declares PASS_RE and FAIL_RE as plain /…/i constants — the UI hint has to keep judging the STORED value by the same rule as the server");
  return { pass, fail };
}

test("the pass rule is one and the same on both sides of the wire", () => {
  const server = serverRule();
  const people = peopleRule();
  assert.equal(people.pass, server.pass, "People.jsx PASS_RE drifted from server.js passOk — the form hint and the timeline would now disagree with what the server actually writes");
  assert.equal(people.fail, server.fail, "People.jsx FAIL_RE drifted from the veto regex in server.js passOk");
});

test("neither side grew a second copy of the pass rule", () => {
  // Counted on the pattern text, not on a whole literal: the timeline's tone
  // regex legitimately extends the veto side (major/重大), so only the pass half
  // is safe to count. A third copy is how these two would drift apart again.
  const needle = "通过|passed";
  for (const pair of [["server.js", SERVER], ["People.jsx", PEOPLE]]) {
    const hits = read(pair[1]).split(needle).length - 1;
    assert.equal(hits, 1, pair[0] + " should carry the pass pattern exactly once (in the shared constant), found " + hits);
  }
});

test("延期转正 / Extended is not a pass — the case the UI used to hide", () => {
  const rule = serverRule();
  const re = (lit) => new RegExp(lit.slice(1, -2), "i");
  const passOk = (v) => re(rule.pass).test(String(v || "")) && !re(rule.fail).test(String(v || ""));
  // Stored values (record_fields.options), never the localized labels.
  assert.equal(passOk("On time"), true, "按期转正 does sync the employee status");
  assert.equal(passOk("Extended"), false, "延期转正 must NOT sync — not regular yet, a later record carries the real thing");
  assert.equal(passOk("Failed"), false);
  assert.equal(passOk("Passed"), true);
  assert.equal(passOk("通过"), true);
  assert.equal(passOk("未通过"), false);
  assert.equal(passOk(""), false, "an unanswered result never syncs");
});
