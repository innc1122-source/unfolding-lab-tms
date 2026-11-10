// 语言按钮「中 / EN」（2026-09-28 负责人决定，批次 3 第 4 步唯一的 TMS 前端改动）：TMS 顶栏、TMS 登录页与 Action 3+3 挑战学员端页头
// 三处同一写法——两种语言都写出来，当前语言加粗并用品牌色，点击切换；手机上同样显示文字；无障碍名称「切换语言 / Switch language」；
// 仍共用 localStorage 的 'lms-lang'（web/src/i18n.jsx 与 modules/culture/public/api.js）。
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), "utf8");
const BTN = /<span className=\{lang === 'zh' \? 'on' : undefined\}>中<\/span><span className="sep" aria-hidden="true">\/<\/span><span className=\{lang === 'en' \? 'on' : undefined\}>EN<\/span>/;

test("TMS top bar and sign-in page: the language button shows 中 / EN, marks the current language and is labelled Switch language", () => {
  const top = read("web", "src", "components", "TopBar.jsx");
  assert.match(top, /<button className="icon-btn lang-toggle lang-pick" onClick=\{toggle\} aria-label=\{t\('switchLang'\)\}>/);
  assert.match(top, BTN);
  const login = read("web", "src", "pages", "Login.jsx");
  assert.match(login, /<button className="login-lang icon-btn lang-toggle lang-pick" onClick=\{toggle\} aria-label=\{t\('switchLang'\)\}>/);
  assert.match(login, BTN);
  for (const src of [top, login]) assert.doesNotMatch(src, /lang === 'zh' \? 'English' : '中文'/, "the old “English / 中文” label is gone");
  // 后台顶栏与重置密码页（1.16.9 遗留的两处）同一写法
  const adm = read("web", "src", "components", "AdminLayout.jsx");
  assert.match(adm, /<button className="icon-btn lang-toggle lang-pick" onClick=\{toggle\} aria-label=\{s\.langLabel\}>/);
  assert.match(adm, /langLabel: '切换语言'/);
  assert.match(adm, /langLabel: 'Switch language'/);
  const reset = read("web", "src", "pages", "ResetPassword.jsx");
  assert.match(reset, /<button className="login-lang icon-btn lang-toggle lang-pick" onClick=\{toggle\} aria-label=\{t\('switchLang'\)\}>/);
  for (const src of [adm, reset]) { assert.match(src, BTN); assert.doesNotMatch(src, /lang === 'zh' \? 'English' : '中文'/); }
  const i18n = read("web", "src", "i18n.jsx");
  assert.match(i18n, /switchLang: '切换语言'/);
  assert.match(i18n, /switchLang: 'Switch language'/);
});

test("TMS app.css: the current language is bold in the brand colour, and phones keep the 中 / EN text while other top-bar labels hide", () => {
  const css = read("web", "src", "app.css");
  assert.match(css, /\.lang-pick span\.on\{font-weight:700;color:var\(--brand\)\}/);
  const narrow = css.slice(css.indexOf("@media (max-width:900px){"), css.indexOf("}", css.indexOf(".top-right .icon-btn.lang-pick")) + 1);
  assert.match(narrow, /\.top-right \.icon-btn span:not\(\.notif-dot\)\{display:none\}\s*\/\*[^*]*\*\/\s*\.top-right \.icon-btn\.lang-pick span:not\(\.notif-dot\)\{display:inline\}/, "the exception follows the rule that hides top-bar labels and is more specific");
});


