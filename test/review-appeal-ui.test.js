// 第二批 2.8（2026-10-08）绩效申诉前端（设计 §3.8、§8，§10.1 review-appeal-ui）：
//   · web/src/reviewappeal.js 纯函数（去掉 export 后 vm 求值）：卡片状态 → 色调、词典键、动作；字数、文件检查；
//   · 源码检查：Review.jsx VIEWS 含 consult、viewsOf 按 appealConsults.total；新的后台页不用 SideSheet（负责人原则：不用抽屉）；
//     放 DeptFilter 的 Semi Modal 带 dpfModalProps 与 u-modal-visible；
//   · rbac.js appealDeskVisible 真值表，canSeeAdminPath / adminRedirect 按它判定；HRBP 分工页仅超管（domain roles）。
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { pathToFileURL } = require("url");

const ROOT = path.join(__dirname, "..");
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), "utf8").replace(/\r\n/g, "\n");
const pure = () => {
  const src = read("web", "src", "reviewappeal.js");
  assert.doesNotMatch(src, /^\s*import\s/m, "reviewappeal.js stays import-free");
  const body = src.replace(/^export\s+/gm, "");
  const names = [...src.matchAll(/^export\s+(?:const|function)\s+(\w+)/gm)].map((m) => m[1]);
  return vm.runInNewContext(body + `\n;({ ${names.join(", ")} })`, {});
};

test("reviewappeal.js: card state → tone, label key and action; unknown → null", () => {
  const R = pure();
  const exp = {
    open: ["cardOpen", "file"], submitted: ["stSubmitted", "view"], in_review: ["stInReview", "view"],
    maintained: ["stMaintained", "outcome"], adjusted: ["stAdjusted", "outcome"], withdrawn: ["stWithdrawn", null], expired: ["stExpired", null],
  };
  for (const [state, [labelKey, action]] of Object.entries(exp)) {
    const c = R.appealCardState({ state });
    assert.equal(c.labelKey, labelKey, state);
    assert.equal(c.action, action, state);
    assert.ok("tone" in c, state);
  }
  assert.equal(R.appealCardState({ state: "nope" }), null);
  assert.equal(R.appealCardState(null), null, "state none → history gives appeal: null → no block");
  assert.equal(R.appealDecided("adjusted"), true);
  assert.equal(R.appealDecided("in_review"), false);
  // 字数按 trim 后字符数，中英文一样
  assert.equal(R.reasonOk("说".repeat(50)), true);
  assert.equal(R.reasonOk("  " + "x".repeat(49) + "  "), false);
  assert.equal(R.reasonOk("x".repeat(4001)), false);
  // 文件：类型、空文件、大小、名额
  assert.equal(R.fileCheck({ name: "a.pdf", size: 10 }), null);
  assert.equal(R.fileCheck({ name: "a.svg", size: 10 }), "appeal_file_type");
  assert.equal(R.fileCheck({ name: "a.png", size: 0 }), "appeal_file_type");
  assert.equal(R.fileCheck({ name: "a.jpg", size: 10485761 }), "appeal_file_too_large");
  assert.equal(R.canAddFile([{}, {}, {}, {}, { error: "x" }]), true, "a failed upload frees its slot");
  assert.equal(R.canAddFile([{}, {}, {}, {}, {}]), false);
  assert.equal(R.limitsOf(null).filesMax, 5);
});

test("the expired state words it as 'deemed acknowledged' in both languages; error codes of §4.8 have zh and en text", () => {
  const src = read("web", "src", "pages", "ReviewAppeal.jsx");
  assert.match(src, /stExpired: '已过申诉期限，视为认可评级'/);
  assert.match(src, /stExpired: '[^']*deemed acknowledged[^']*'/i);
  for (const code of ["appeal_unavailable", "appeal_window_closed", "appeal_exists", "not_in_service", "appeal_reason", "appeal_attachment", "appeal_file_type", "appeal_file_too_large", "appeal_upload_rate", "appeal_in_review", "appeal_state", "consult_answered", "consult_closed", "opinion_length"]) {
    const n = (src.match(new RegExp(`\\b${code}:`, "g")) || []).length;
    assert.ok(n >= 2, `${code} has zh and en copy in ReviewAppeal.jsx (${n})`);
  }
  const admin = read("web", "src", "pages", "admin", "ReviewAppeals.jsx");
  for (const code of ["appeal_no_permission", "appeal_reply", "appeal_note", "rating_invalid", "rating_changed", "record_missing", "consultee_invalid", "consult_exists", "consult_limit", "assignee_invalid"]) {
    const n = (admin.match(new RegExp(`\\b${code}:`, "g")) || []).length;
    assert.ok(n >= 2, `${code} has zh and en copy in ReviewAppeals.jsx (${n})`);
  }
  const cov = read("web", "src", "pages", "admin", "HrbpCoverage.jsx");
  for (const code of ["super_admin_only", "hrbp_not_eligible", "dept_not_found", "dept_inactive", "too_many_hrbps"]) {
    const n = (cov.match(new RegExp(`\\b${code}:`, "g")) || []).length;
    assert.ok(n >= 2, `${code} has zh and en copy in HrbpCoverage.jsx (${n})`);
  }
});

test("Review.jsx: VIEWS includes consult; viewsOf lists it only when appealConsults.total > 0", () => {
  const src = read("web", "src", "pages", "Review.jsx");
  assert.match(src, /export const VIEWS = \['mine', 'team', 'hod', 'history', 'consult', 'org', 'orgrec', 'orgres'\];/);   // org / orgrec / orgres：组织绩效三个页签（2026-10-12）
  const vo = src.slice(src.indexOf("export function viewsOf"), src.indexOf("\n}\n", src.indexOf("export function viewsOf")) + 3);
  assert.match(vo, /appealConsults/);
  const viewsOf = vm.runInNewContext(vo.replace(/^export\s+/, "") + "\n;viewsOf", {});
  assert.ok(viewsOf({ appealConsults: { open: 0, total: 2 } }).includes("consult"));
  assert.ok(!viewsOf({ appealConsults: { open: 0, total: 0 } }).includes("consult"));
  assert.ok(!viewsOf({}).includes("consult"));
});

test("new admin pages: no SideSheet (no drawers); Semi Modals that host a DeptFilter carry dpfModalProps and u-modal-visible", () => {
  for (const f of ["ReviewAppeals.jsx", "HrbpCoverage.jsx"]) {
    const src = read("web", "src", "pages", "admin", f);
    assert.doesNotMatch(src, /SideSheet/, f + " uses no SideSheet");
    // 顶层函数里同时有 <Modal 与 <DeptFilter 的，Modal 必须带共享助手
    const fns = [...src.matchAll(/^(?:export\s+default\s+)?function\s+(\w+)\s*\(/gm)].map((m) => m.index);
    fns.push(src.length);
    for (let i = 0; i < fns.length - 1; i++) {
      const b = src.slice(fns[i], fns[i + 1]);
      if (!/<Modal\b/.test(b) || !/<DeptFilter\b/.test(b)) continue;
      for (const m of b.matchAll(/<Modal\b[^>]*/g)) {
        assert.match(m[0], /\{\.\.\.dpfModalProps\(\)\}/, `${f}: ${m[0].slice(0, 80)}`);
        assert.match(m[0], /className="u-modal-visible"/, `${f}: ${m[0].slice(0, 80)}`);
      }
    }
  }
  const emp = read("web", "src", "pages", "ReviewAppeal.jsx");
  assert.doesNotMatch(emp, /SideSheet/, "employee pages use no SideSheet");
});

test("rbac.js: appealDeskVisible truth table; canSeeAdminPath and adminRedirect honour it; HRBP coverage is a super-admin (roles) page", async () => {
  const rbac = await import(pathToFileURL(path.join(ROOT, "web", "src", "rbac.js")).href);
  const g = (grants, extra) => ({ role: "employee", adminRoleId: 9, isSuperAdmin: false, grants: { people: "none", learning: "none", performance: "none", talent: "none", roles: "none", ...grants }, modules: { performance: true }, ...(extra || {}) });
  assert.equal(rbac.appealDeskVisible({ role: "admin" }), true, "old server without grants → super-admin");
  assert.equal(rbac.appealDeskVisible(g({ performance: "read" })), true, "performance read");
  assert.equal(rbac.appealDeskVisible(g({}, { appealDesk: { hrbp: true } })), true, "HRBP assignment");
  assert.equal(rbac.appealDeskVisible(g({}, { appealDesk: { hrbp: false } })), false);
  assert.equal(rbac.appealDeskVisible(g({ people: "manage" })), false, "people manage alone is not enough");
  assert.equal(rbac.appealDeskVisible(g({}, { isSuperAdmin: true })), true);
  const hrbp = g({ people: "manage" }, { appealDesk: { hrbp: true } });
  assert.equal(rbac.canSeeAdminPath(hrbp, "/admin/review-appeals"), true);
  assert.equal(rbac.adminRedirect(hrbp, "/admin/review-appeals"), null);
  const none = g({ people: "manage" });
  assert.equal(rbac.canSeeAdminPath(none, "/admin/review-appeals"), false);
  assert.equal(rbac.adminRedirect(none, "/admin/review-appeals"), "/admin");
  // 模块关闭时不出现
  assert.equal(rbac.canSeeAdminPath({ ...hrbp, modules: { performance: false } }, "/admin/review-appeals"), false);
  // HRBP 分工页：仅超管
  assert.equal(rbac.canSeeAdminPath(hrbp, "/admin/hrbp-coverage"), false);
  assert.equal(rbac.canSeeAdminPath(g({ performance: "manage", people: "manage" }), "/admin/hrbp-coverage"), false);
  assert.equal(rbac.canSeeAdminPath(g({}, { isSuperAdmin: true }), "/admin/hrbp-coverage"), true);
  assert.equal(rbac.adminRedirect(hrbp, "/admin/hrbp-coverage"), "/admin");
});
