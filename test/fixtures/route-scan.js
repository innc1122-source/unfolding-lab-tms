// M0 route scanner — static inventory of every /api route branch in server.js.
//
// Used by test/m0-route-guard.test.js (every branch must be claimed by a
// manifest, and every manifest route must have a branch) and by
// test/m0-registry-equivalence.test.js (the probe list). Pure text scan: it
// never requires server.js, so it cannot start a server or open a database.
//
// Recognised forms inside handleApi (one route per line, as server.js writes them):
//   pathname === "/api/x" [&& req.method === "M"]                    string route
//   const v = pathname.match(/^…$/);  if (v [&& req.method === "M"])  regex route
//   pathname.startsWith("/api/…")                                     prefix
// Any OTHER reference to `pathname` inside handleApi is reported as
// `unrecognized`, so a branch written in a new style fails the guard instead
// of slipping past it. That check runs on what is LEFT of a line after the
// recognised fragments are cut out, so a compound condition such as
//   if (pathname === "/api/a" || pathname.endsWith("/b"))
// is still reported (the endsWith half), and any req.url / originalUrl test
// inside handleApi is reported too (routing must go through `pathname`).
// Outside handleApi, `pathname` may only appear in the kernel functions listed
// in OUTSIDE_ALLOWED; a reference anywhere else (e.g. a second dispatcher or a new top-level
// helper that tests the path) is reported as `outside`, so a route cannot be added beside handleApi unseen.
"use strict";
const fs = require("fs");
const path = require("path");
const { samplePath: registrySample } = require("../../kernel/registry.js");

const SERVER = path.join(__dirname, "..", "..", "server.js");

// References to `pathname` inside handleApi that are NOT route branches.
const BENIGN = [
  /moduleOfPath\(pathname\)/,
  /rbacGate\(user, pathname, req\.method\)/,
  /BULK_BODY_PATHS\.has\(pathname\)/,
  /\]\.includes\(pathname\)\)/,                  // mustChangePassword allow-list
  /revalidateBulkActor\(req, res, pathname\)/,
  /"Not found: " \+ pathname/,
  /^async function handleApi\(req, res, pathname, query\)/,
  // 第二段：带 handler 路由的模块（culture）的 gate 内请求由内核按 manifest 分发（kernel/module-host.js），
  // 这些路由不在 server.js 里写分支；分发调用本身不是路由分支。
  /^if \(dispatchModuleRoute\(req, res, pathname, query, body, user, requestId\)\) return;$/,
  // 简化 10/11：接口处理按模块拆到 modules/<模块>/routes.js —— handleApi 里调用各段、各段开头取 handleApi 局部变量，都不是路由分支
  /^\{ const routeResult = await TMS_ROUTES\.\w+\.\w+\(\{[^}]*\}\); if \(routeResult !== ROUTE_NEXT\) return routeResult; \}/,
  /^const \{[^}]*\bpathname\b[^}]*\} = C;$/,
];
// 简化 10/11：handleApi 的接口分支按模块搬到这些文件的各段方法里（async xxx(C) { … }），扫描规则与 handleApi 相同
const ROUTE_FILES = ["modules/core/routes.js", "modules/learning/routes.js", "modules/performance/routes.js", "modules/talent/routes.js"];

// Top-level functions (or the createServer callback) outside handleApi that may
// read `pathname`: module gate, RBAC gate, bulk revalidation, static files, and
// the one dispatcher that hands /api/* to handleApi and everything else to
// serveStatic. serveStatic's own special cases (/videos gate, /next) are
// decided by the manifests' `static` lists and the SPA fallback, not by routes.
// The module-route dispatcher (dispatchModuleRoute) and the module static mount
// (serveModuleStatic) take the path under another name on purpose, so they never
// show up here: which paths they serve comes from the manifests (handler routes,
// static dir / entry), not from path tests written in server.js.
const OUTSIDE_ALLOWED = new Set(["moduleOfPath", "revalidateBulkActor", "rbacGate", "serveStatic", "http.createServer"]);
// The dispatcher and serveStatic are pinned line by line (trimmed text, prefix
// match): a new path test there — a "/healthz" branch in the createServer
// callback, a new special-cased static prefix in serveStatic — is a route or a
// gate that no manifest knows about, so it is reported as `outside` until it is
// reviewed and added here (and, if it is module content, to a manifest `static`).
const OUTSIDE_LINES = {
  "http.createServer": [
    "let url, pathname;",
    "pathname = decodeURIComponent(url.pathname);",
    'if (pathname.startsWith("/api/")) {',
    "handleApi(req, res, pathname, url.searchParams)",
    // 外层 catch：gate 内（带 handler 路由的模块）的非法 JSON 改回 400 bad_body（CONTRACT.md 3.5 第 3 步）。不是路由。
    "if (e && e.invalidJson && MODULE_HOST.isHandlerPath(pathname)) return send(res, 400, MODULE_HOST.FIXED.badBody",
    "serveStatic(req, res, pathname);",
  ],
  serveStatic: [
    "function serveStatic(req, res, pathname) {",
    'const norm = path.normalize(pathname).replace(/\\\\/g, "/");',
    'const isNext = pathname === "/next" || pathname.startsWith("/next/");',
    'if (pathname === "/next" || pathname === "/next/") file = "/dist/index.html";',
    'else if (isNext) file = "/dist/" + pathname.slice(6);',
    'else if (pathname === "/") file = "/dist/index.html";',
    "else file = pathname;",
    "if (path.extname(pathname)) {",
    "const immutable = /\\/assets\\//.test(pathname) && ",
  ],
};

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function scanServerRoutes(file = SERVER) {
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
  const start = lines.findIndex((l) => /^async function handleApi\(/.test(l));
  if (start < 0) throw new Error("route-scan: handleApi not found in server.js");
  let end = -1;
  for (let i = start + 1; i < lines.length; i++) if (/^}\s*$/.test(lines[i])) { end = i; break; }
  if (end < 0) throw new Error("route-scan: end of handleApi not found");

  const routes = [];       // { kind: "string"|"regex", path | source+flags, methods:Set, lines:[] }
  const prefixes = [];     // { prefix, line }
  const unrecognized = []; // { line, text }
  const outside = [];      // { line, fn, text } — pathname use outside handleApi and OUTSIDE_ALLOWED
  const byKey = new Map();

  const add = (kind, p, flags, line) => {
    const key = kind === "string" ? "s:" + p : "r:" + p + "/" + flags;
    let r = byKey.get(key);
    if (!r) {
      r = kind === "string" ? { kind, path: p, methods: new Set(), lines: [] } : { kind, source: p, flags, methods: new Set(), lines: [] };
      byKey.set(key, r); routes.push(r);
    }
    r.lines.push(line);
    return r;
  };
  const methodsOn = (text) => [...text.matchAll(/req\.method === "([A-Z]+)"/g)].map((m) => m[1]);

  // one region = handleApi in server.js, or one route-file method; lines numbered as in their own file
  const regions = [{ lines, start, end, at: (i) => i + 1 }];
  for (const rf of ROUTE_FILES) {
    const p = path.join(path.dirname(SERVER), rf);
    if (!fs.existsSync(p)) continue;
    const L = fs.readFileSync(p, "utf8").split(/\r?\n/);
    for (let i = 0; i < L.length; i++) {
      if (!/^    async \w+\(C\) \{$/.test(L[i])) continue;
      let j = i + 1; while (j < L.length && !/^    \},$/.test(L[j])) j++;
      regions.push({ lines: L, start: i, end: j, at: (k) => `${rf}:${k + 1}` });
      i = j;
    }
  }
  for (const R of regions) scanRegion(R.lines, R.start, R.end, R.at);
  function scanRegion(lines, start, end, at) {
  for (let i = start; i <= end; i++) {
    const raw = lines[i];
    const t = raw.trim();
    if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) continue;
    const lineNo = at(i);
    if (/\breq\.(url|originalUrl)\b/.test(raw)) unrecognized.push({ line: lineNo, text: t + "   <- routes must test `pathname`, not req.url" });
    if (!/\bpathname\b/.test(raw)) continue;
    let hit = false;
    let rest = raw; // what remains once the recognised fragments are cut out
    for (const m of raw.matchAll(/pathname === "([^"]+)"/g)) {
      hit = true;
      const r = add("string", m[1], "", lineNo);
      const ms = methodsOn(raw);
      if (ms.length) ms.forEach((x) => r.methods.add(x)); else r.methods.add("*");
    }
    rest = rest.replace(/pathname === "[^"]+"/g, "");
    const mm = raw.match(/const (\w+) = pathname\.match\(\/(.+)\/([gimsuy]*)\);/);
    if (mm) {
      hit = true;
      const r = add("regex", mm[2], mm[3], lineNo);
      // methods come from the `if (v && req.method === "M")` / `if (v)` lines below
      const v = escapeRe(mm[1]);
      const test = new RegExp("^\\s*if \\(" + v + "(?: && req\\.method === \"([A-Z]+)\")?\\)");
      const redecl = new RegExp("\\bconst " + v + " = ");
      // the match variable used as a boolean operand in any other `if (…)` shape —
      // `if (v && req.method === "POST" && x)`, `if (req.method === "GET" && v)`,
      // `if (v && (req.method === "PUT" || …))` — would hide a method from the
      // guard, so it is reported instead of silently skipped.
      const boolUse = new RegExp("\\bif \\(.*(?<![\\w.$])" + v + "(?=\\s*(?:&&|\\|\\||\\)))");
      let found = false;
      for (let j = i + 1; j <= end; j++) {
        if (redecl.test(lines[j])) break;
        const u = lines[j].match(test);
        if (u) { r.methods.add(u[1] || "*"); found = true; }
        else if (boolUse.test(lines[j])) unrecognized.push({ line: at(j), text: lines[j].trim() + "   <- write it as `if (" + mm[1] + ")` or `if (" + mm[1] + " && req.method === \"M\")`" });
      }
      // a match variable declared in handleApi may be tested in a route-file method that receives it from handleApi (… } = C;)
      if (!found && lines === regions[0].lines) {
        for (const R of regions.slice(1)) {
          if (!R.lines.slice(R.start, R.end + 1).some((l) => new RegExp("^\\s*const \\{[^}]*\\b" + v + "\\b[^}]*\\} = C;").test(l))) continue;
          for (let j = R.start; j <= R.end; j++) {
            const u = R.lines[j].match(test);
            if (u) { r.methods.add(u[1] || "*"); found = true; }
            else if (boolUse.test(R.lines[j])) unrecognized.push({ line: R.at(j), text: R.lines[j].trim() + "   <- write it as `if (" + mm[1] + ")` or `if (" + mm[1] + " && req.method === \"M\")`" });
          }
        }
      }
      if (!found) unrecognized.push({ line: lineNo, text: t + "   <- match variable never tested with `if (" + mm[1] + " ...)`" });
      rest = rest.replace(mm[0], "");
    }
    for (const m of raw.matchAll(/pathname\.startsWith\("([^"]+)"\)/g)) { hit = true; prefixes.push({ prefix: m[1], line: lineNo }); }
    rest = rest.replace(/pathname\.startsWith\("[^"]+"\)/g, "");
    if (!/\bpathname\b/.test(rest)) continue;
    if (BENIGN.some((b) => b.test(t))) continue;
    unrecognized.push({ line: lineNo, text: hit ? t + "   <- recognised route plus an unrecognised pathname test on the same line" : t });
  }
  }

  // Outside handleApi: which top-level function (or createServer callback) each pathname use sits in.
  let fn = null;
  for (let i = 0; i < lines.length; i++) {
    if (i >= start && i <= end) { fn = null; continue; }
    const raw = lines[i];
    const d = raw.match(/^(?:async )?function (\w+)\(/) || raw.match(/^(?:const|let|var) \w+ = (http\.createServer)\(/);
    if (d) fn = d[1];
    else if (/^\S/.test(raw) && !/^[}\])]/.test(raw) && !/^\/[/*]/.test(raw)) fn = null; // another top-level statement ends it
    const t = raw.trim();
    if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) continue;
    if (!/\bpathname\b/.test(raw)) continue;
    if (fn && OUTSIDE_ALLOWED.has(fn) && (!OUTSIDE_LINES[fn] || OUTSIDE_LINES[fn].some((p) => t.startsWith(p)))) continue;
    outside.push({ line: i + 1, fn: fn || "(top level)", text: t });
  }
  return { routes, prefixes, unrecognized, outside, range: [start + 1, end + 1] };
}

// A concrete path the route pattern matches — used as a probe. Same derivation
// the registry uses for its gate-consistency check (capture groups → "123").
function samplePath(route) {
  if (route.kind === "string") return route.path;
  if (route.kind === "regex") return registrySample(new RegExp(route.source, route.flags));
  return registrySample(route.path);
}

module.exports = { scanServerRoutes, samplePath, SERVER, OUTSIDE_ALLOWED, OUTSIDE_LINES };
