// 上线前全覆盖 M 组 CX-126（高，10/11）：工作台「去处理」链接跳 404。
// 服务端写死的后台链接（link: "/admin/…" 与通知里的 link: "#/admin/…"）都必须能匹配 web/src/App.jsx 里 /admin 下的某条前端路由；
// 原来 7 处写的 /admin/people（前端只有 people/:id）和 /admin/org-diagnostics（没有这条前端路由）。
"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");

function adminRoutes() {
  const app = read("web/src/App.jsx");
  const start = app.indexOf('path="/admin"');
  assert.ok(start > 0, "App.jsx has the /admin route");
  return [...app.slice(start).matchAll(/path="([^"/][^"]*)"/g)].map((m) => m[1]).filter((p) => p !== "*");
}
const matches = (route, sub) => {
  const a = route.split("/"), b = sub.split("/");
  return a.length === b.length && a.every((seg, i) => seg.startsWith(":") ? !!b[i] : seg === b[i]);
};

test("CX-126: every hard-coded admin link on the server resolves to a front-end route", () => {
  const routes = adminRoutes();
  assert.ok(routes.includes("employees") && routes.includes("org-chart") && routes.includes("people/:id"), routes.join(","));
  const files = ["server.js", ...fs.readdirSync(path.join(ROOT, "modules")).flatMap((d) => {
    const f = path.join("modules", d, "routes.js");
    return fs.existsSync(path.join(ROOT, f)) ? [f] : [];
  })];
  const links = [];
  for (const f of files) for (const m of read(f).matchAll(/link:\s*"#?(\/admin[^"]*)"/g)) links.push({ f, link: m[1] });
  assert.ok(links.length >= 20, "found the workbench links: " + links.length);
  const bad = links.filter(({ link }) => {
    const p = link.split("?")[0].replace(/^\/admin\/?/, "");
    return p !== "" && !routes.some((r) => matches(r, p));
  });
  assert.deepEqual(bad, [], "links without a front-end route");
});

test("CX-126: the people-list and span links point at the employee list and the org-chart diagnostics view", () => {
  const s = read("server.js");
  assert.ok(!/link:\s*"\/admin\/people"/.test(s), "no bare /admin/people");
  assert.ok(!/link:\s*"\/admin\/org-diagnostics"/.test(s), "no /admin/org-diagnostics");
  assert.ok(/link:\s*"\/admin\/org-chart\?tab=diag"/.test(s));
  assert.ok(/searchParams|URLSearchParams[\s\S]{0,120}get\('tab'\) === 'diag'/.test(read("web/src/pages/admin/OrgChart.jsx")), "OrgChart opens the diagnostics tab from ?tab=diag");
});
