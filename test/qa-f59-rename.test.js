// F59 全站命名（负责人 2026-10-09）：「课程」→「我的课程 / My courses」（员工端 /learning 入口与页面标题）、
// 「课程目录」→「公开课 / Public courses」、「培养项目」→「发展项目 / Development programs」。
// 验收用例 docs/QA-acceptance-f58-61.md 59-1 ～ 59-5。只读源码，不起服务、不打包。
//   · 扫描 web/src（页面、组件、词典、JSX 文字）与服务端（server.js、notify.js、modules/** 除 culture）去掉注释后的代码行：
//     不得再出现「培养项目」「课程目录」「Course Catalog」。
//   · 允许清单（精确到文件 + 原文片段）：AI 翻译术语表保留旧称，供翻译历史内容时对上新名。
//     代码注释、「课程库」、docs 下的历史记录与一次性导入脚本（scripts/）不在扫描范围内。
//   · 新名在导航、页头路径、页面标题、后台菜单、通知、审计标签里一致；路由与接口地址不变。
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const OLD = [/培养项目/, /课程目录/, /\bCourse Catalog\b/];
const ALLOW = [
  { file: "modules/ai/prompts.js", text: "发展项目 (older name 培养项目) = development program" },
];

const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), "utf8");

// 去掉 /* */、整行 // 与行尾 // 注释（行尾注释只在前面引号成对时才去，避免误切字符串里的 //）
function codeLines(src) {
  const noBlock = src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
  return noBlock.split("\n").map((l) => {
    if (/^\s*\/\//.test(l)) return "";
    const i = l.search(/\s\/\/\s/);
    if (i >= 0) {
      const head = l.slice(0, i);
      if (["'", '"', "`"].every((q) => (head.split(q).length - 1) % 2 === 0)) return head;
    }
    return l;
  });
}
function walk(d, out = []) {
  for (const f of fs.readdirSync(d)) {
    const p = path.join(d, f);
    if (fs.statSync(p).isDirectory()) { if (f !== "culture" && f !== "node_modules") walk(p, out); }
    else if (/\.(jsx|js)$/.test(f)) out.push(p);
  }
  return out;
}
function scan(files) {
  const hits = [];
  for (const f of files) {
    const rel = path.relative(ROOT, f).replace(/\\/g, "/");
    codeLines(fs.readFileSync(f, "utf8")).forEach((line, i) => {
      if (!OLD.some((re) => re.test(line))) return;
      if (ALLOW.some((a) => a.file === rel && line.includes(a.text))) return;
      hits.push(`${rel}:${i + 1} ${line.trim().slice(0, 90)}`);
    });
  }
  return hits;
}

test("F59 59-4: web/src (dictionaries, JSX text, notifications built in the page) no longer says 培养项目 / 课程目录 / Course Catalog", () => {
  assert.deepEqual(scan(walk(path.join(ROOT, "web", "src"))), []);
});

test("F59 59-3/59-4: server notifications, emails and API messages no longer say 培养项目 / 课程目录 / Course Catalog", () => {
  const files = [path.join(ROOT, "server.js"), path.join(ROOT, "notify.js"), ...walk(path.join(ROOT, "modules"))];
  assert.ok(files.every((f) => !/[\\/]modules[\\/]culture[\\/]/.test(f)), "modules/culture is out of scope");
  assert.deepEqual(scan(files), []);
});

test("F59 allow-list is exact: every allowed line still exists (no stale exceptions)", () => {
  for (const a of ALLOW) assert.ok(read(a.file).includes(a.text), a.file + " still carries the allowed glossary line");
});

function learningItems() {
  const src = read("web", "src", "learningnav.js").replace(/^import .*$/gm, "").replace(/^export /gm, "");
  return new Function("useEffect", "useState", "api", "fetchMyProjects", src + "\nreturn LEARNING_ITEMS;")(() => {}, (v) => [v, () => {}], {}, () => Promise.resolve({}));
}

test("F59 59-1/59-5: employee navigation and breadcrumbs use the new names; routes unchanged", () => {
  const byId = Object.fromEntries(learningItems().map((x) => [x.id, [x.to, x.zh, x.en]]));
  assert.deepEqual(byId.courses, ["/learning", "我的课程", "My Courses"]);
  assert.deepEqual(byId.catalog, ["/catalog", "公开课", "Public Courses"]);
  assert.deepEqual(byId.programs, ["/projects", "发展项目", "Development Programs"]);
  // 页头路径「培训 › 〈入口〉」直接取这张表的 zh / en
  assert.match(read("web", "src", "components", "ModuleTrail.jsx"), /label: lang === 'zh' \? it\.zh : it\.en, to: it\.to/);
  const i18n = read("web", "src", "i18n.jsx");
  assert.match(i18n, /navLearning: '我的课程'/);
  assert.match(i18n, /navLearning: 'My Courses'/);
});

test("F59 59-1: page titles match the navigation names", () => {
  for (const [f, zh, en] of [["MyLearning.jsx", "我的课程", "My Courses"], ["Catalog.jsx", "公开课", "Public Courses"], ["MyProjects.jsx", "发展项目", "Development Programs"]]) {
    const src = read("web", "src", "pages", f);
    assert.match(src, new RegExp("title: '" + zh + "'"), f);
    assert.match(src, new RegExp("title: '" + en + "'"), f);
  }
  // 负责人 10/9 追加：首页课程区块标题与导航同名
  const home = read("web", "src", "pages", "Home.jsx");
  assert.match(home, /learnTitle: '我的课程', electTitle:/);
  assert.match(home, /learnTitle: 'My Courses', electTitle:/);
  for (const f of ["Course.jsx", "ProgramDetail.jsx", "ExamPrep.jsx"]) {
    const src = read("web", "src", "pages", f);
    assert.match(src, /backToLearning: '返回我的课程'/, f);
    assert.match(src, /backToLearning: 'Back to My Courses'/, f);
  }
});

test("F59 59-2: admin menu and page title say 发展项目 / Development Programs; 课程库 / Course Library unchanged; admin route unchanged", () => {
  const layout = read("web", "src", "components", "AdminLayout.jsx");
  assert.match(layout, /projects: '发展项目', content: '课程库'/);
  assert.match(layout, /projects: 'Development Programs', content: 'Course Library'/);
  const proj = read("web", "src", "pages", "admin", "Projects.jsx");
  assert.match(proj, /title: '发展项目', lead:/);
  assert.match(proj, /title: 'Development Programs', lead:/);
  assert.match(read("web", "src", "rbac.js"), /\{ path: '\/admin\/projects', group: 'learning'/);
});

test("F59 59-3: notifications and audit labels carry the new names", () => {
  const server = require("./helpers.js").serverSource();   // server.js + modules/*/routes.js
  assert.match(server, /title_zh: `发展项目申请已通过：《/);
  assert.match(server, /body: "See the schedule under Learning › Development Programs\.", body_zh: "可在「培训 › 发展项目」中查看安排。"/);
  assert.match(server, /title_zh: `你已加入发展项目《/);
  assert.match(server, /body_zh: `期次：\$\{cohort\.name\}。可在「培训 › 发展项目」中查看。`/);
  assert.match(server, /error_zh: "该课程为公开课程，可在「公开课」直接开始学习。", code: "use_catalog"/, "API code unchanged");
  const audit = read("web", "src", "pages", "admin", "Audit.jsx");
  for (const zh of ["创建发展项目", "更新发展项目", "删除发展项目", "申请参加发展项目", "通过发展项目申请", "驳回发展项目申请"]) assert.ok(audit.includes(`zh: '${zh}'`), zh);
  assert.ok(audit.includes("en: 'Approve development program application'"));
});
