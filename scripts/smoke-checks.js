'use strict';
// scripts/smoke-checks.js — the in-page half of the smoke test.
//
// Exports a STRING of browser code (an IIFE expression) that the driver hands to
// CDP Runtime.evaluate with returnByValue:true. Evaluating it yields
// { findings: [...], stats: {...} }, both JSON-serialisable.
//
// The browser half is written as a normal function below and stringified with
// Function.prototype.toString(), so it stays lintable/readable instead of living
// inside a giant template literal. That means it MUST be self-contained: it may
// not reference a single Node-side binding (no require, no module scope). Every
// constant it needs — including the whitelists — is declared inside it.
//
// WHAT IT LOOKS FOR, AND WHY ONLY THIS
// Three rounds of manual QA on this app produced bugs of only four shapes, so
// the script chases exactly those four and deliberately ignores everything else
// (spacing, wording, colour) — that is what the human reviewer is for.
//   fail  error-boundary  the React boundary card rendered instead of the page
//   fail  literal-null    a template string interpolated null/undefined/NaN
//   fail  blank-page      the content region rendered (almost) nothing
//   fail  page-overflow   the whole document scrolls sideways
//   warn  latin-in-zh     UI chrome untranslated under the Chinese locale
//   warn  cjk-in-en       UI chrome still Chinese under the English locale
//   warn  table-overflow  a table is wider than its scroll box
// console errors are NOT collected here — the driver subscribes to
// Runtime.consoleAPICalled, which sees errors this snapshot would miss.

// The browser-side entry point. Self-contained by contract (see header).
function pageChecks() {
  // ---------------------------------------------------------------- constants
  // Error-boundary copy, verbatim from web/src/main.jsx. The boundary sits
  // outside I18nProvider and picks its own language, so both variants can
  // appear regardless of the locale under test — match on either.
  var BOUNDARY_MARKERS = [
    '页面出错了',
    '刷新一下通常就能恢复',
    'Something went wrong',
    'A refresh usually fixes this',
  ];

  // Selectors that hold UI CHROME — strings that ship in the co-located
  // `const T = { zh, en }` dictionaries and therefore MUST be Chinese under zh.
  //   th ............... Semi table column headers (verified: 姓名/工号/部门…);
  //                      the row DATA lives in td, which we never scan.
  //   .semi-button, .btn, .icon-btn, .adm-exit — action labels (新增员工 /
  //                      导出 CSV …). NOTE: bare `button` is WRONG here. This app
  //                      uses <button> as a clickable data card — `button.pcard`
  //                      is a whole course card and `button.trev-emp` is a
  //                      person's name in a 9-box cell. A trial run with bare
  //                      `button` produced 15 findings on /admin/talent-review,
  //                      every one of them a Filipino employee name. Chrome
  //                      buttons all carry .btn (67 uses) or Semi's .semi-button;
  //                      every data-carrying one has a bespoke class
  //                      (trev-emp, pcard, um-item, orgl-row__main, me-mile,
  //                      ov-todo-item), so keying on the styled classes
  //                      separates the two cleanly.
  //   [placeholder] .... input + textarea placeholders (搜索姓名或工号…)
  //   .semi-select-selection-placeholder — Select's empty label (全部部门)
  //   .semi-empty-description — Semi Empty's caption, a classic missed string
  //   .semi-tabs-tab ... tab titles
  //   label, .semi-form-field-label, .ppl-flabel, .qb-fieldlabel — form labels
  //   .adm-nav-item, .adm-nav-label — console sidebar (see AdminLayout.jsx)
  //   .tset-lead, .tset-title, .ppl-sec-h, .ov-sec-h, .sec-h, .ml-lead,
  //   .tp-fieldhelp — page/section headings and lead paragraphs
  var CHROME_SELECTORS = [
    'th',
    '.semi-button',
    '.btn',
    '.icon-btn',
    '.adm-exit',
    '[placeholder]',
    '.semi-select-selection-placeholder',
    '.semi-empty-description',
    '.semi-tabs-tab',
    'label',
    '.semi-form-field-label',
    '.ppl-flabel',
    '.qb-fieldlabel',
    '.adm-nav-item',
    '.adm-nav-label',
    '.tset-lead',
    '.tset-title',
    '.ppl-sec-h',
    '.ov-sec-h',
    '.sec-h',
    '.ml-lead',
    '.tp-fieldhelp',
  ];
  //
  // DELIBERATELY NOT SCANNED, because in this database the data itself is
  // English and flagging it would bury the real findings:
  //   td / .semi-table-row-cell — department names ("Branch Operations Group"),
  //       position names ("Data Analyst Manager"), course titles ("DigiPlus New
  //       Hire Orientation"), people names. All genuinely English business data.
  //   h1 and card bodies (.card, .ppl-card, .ml-title, .emp-namelink, .cinfo) —
  //       same reason: they render the name of the record being viewed.
  //   .pill — status chips are chrome on some pages and raw data values
  //       (potential = High/Medium/Low, empStatus = regular/probation) on
  //       others; the mix makes it pure noise.
  //   card-shaped <button>s (.pcard, .trev-emp, .um-item, .me-mile,
  //       .ov-todo-item, .orgl-row__main) — clickable records, so their text is
  //       a person / course / milestone name. See the note on .btn above.
  //   [aria-label] — measured on /admin/employees: Semi's icon buttons carry
  //       the ICON NAME here ("briefcase", "export", "upload", "user_add"),
  //       which would produce a dozen false positives on every console page.

  // Tokens that are legitimately Latin inside a Chinese interface. Every entry
  // in the first group was confirmed present in a zh dictionary value or in the
  // test database (scanned web/src/**/*.jsx zh blocks + lms.db) — nothing here
  // is guessed. The second group is standard abbreviations kept as cheap
  // insurance; they cannot mask a translation bug because no sentence is made
  // of them.
  var PROPER_NOUNS = [
    // verified in zh dictionary values / UI chrome
    'digiplus', 'lark', 'hr', 'hris', 'ai', 'csv', 'xlsx', 'excel', 'word',
    'ppt', 'pdf', 'png', 'html', 'api', 'youtube', 'english', 'en', 'mp4',
    'webm', 'hipo', 'box', '9-box',
    // verified as data values in lms.db (potential / talent tags)
    'high', 'medium', 'low', 'star', 'diamond', 'core', 'solid', 'expert',
    'performer', 'risk', 'inconsistent', 'minor', 'regular', 'probation',
    'exited',
    // generic, safe
    'lms', 'tms', 'id', 'ok', 'url', 'kb', 'mb', 'gb', 'min', 'max', 'admin',
    // 「HRBP」is the agreed role name in the Chinese UI too (第二批 2.8 绩效申诉、HRBP 分工).
    'hrbp',
    // Brand-settings vocabulary (verified in BrandSettings.jsx zh copy): the zh
    // lead sentences name the config keys themselves — 「logo、favicon 与界面配色」
    // and 「直接编辑完整 colors 表」— on purpose, and 品牌资产 lists the accepted
    // formats as PNG / JPG / SVG.
    'logo', 'favicon', 'colors', 'jpg',
    // …and the token name in 「原样(navy 药丸)」: --navy is the config key the
    // radio is talking about, translating it would orphan it from the JSON.
    'navy',
    // Job-grade vocabulary, kept in English ON PURPOSE: the Chinese lead of
    // 职级体系 itself reads 「每个 Rank 带 Grade 和数字 Level」, so the column headers
    // match the prose above them. Translating them would make the page argue with
    // itself. Cost of whitelisting: a genuinely untranslated "Level" somewhere else
    // will not be reported either.
    'rank', 'grade', 'level',
    // 「HoD」(部门负责人) is the agreed term in the Chinese UI too — the employee-side
    // review copy and the console's cycle lead both say HoD on purpose (batch 2
    // terminology: HoD everywhere on the employee side). Cost: an untranslated
    // "Hod" token elsewhere would not be reported, and nothing else spells it.
    'hod',
    // Product name of the Behavior Practice learner app, fixed in both languages
    // by decision (「Action 3+3 挑战 / Action 3+3 Challenge」, modules/culture/CONTRACT.md §0):
    // the zh home entry card and top-bar link read 「Action 3+3 挑战」 on purpose.
    // Cost: an untranslated "Action" elsewhere in zh chrome is not reported.
    'action',
  ];

  // ------------------------------------------------------------------ helpers
  function clip(s, n) {
    s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
    n = n || 120;
    return s.length > n ? s.slice(0, n - 1) + '…' : s;
  }

  // A short, human-followable CSS-ish path. Without this a latin-in-zh finding
  // is unactionable — "Grade" tells you nothing, ".tset-wrap > th" tells you
  // which file to open.
  // App-authored classes name a component you can grep for in web/src;
  // framework classes only name a layout wrapper.
  function appClasses(node) {
    var cls = (node.getAttribute && node.getAttribute('class')) || '';
    return cls.split(/\s+/).filter(function (c) {
      return c && c.indexOf('semi-') !== 0 && c.indexOf('react-') !== 0;
    });
  }

  function pathOf(el) {
    if (!el || el.nodeType !== 1) return '';
    function seg(node, classes) {
      return node.tagName.toLowerCase() + (classes.length ? '.' + classes.slice(0, 2).join('.') : '');
    }
    // The target's own segment always shows, framework classes included — for a
    // Semi table `table.semi-table` is the honest description.
    var parts = [seg(el, appClasses(el).length ? appClasses(el) : ((el.getAttribute('class') || '').split(/\s+/).filter(Boolean)))];
    // Ancestors: emit ONLY app-authored ones and SKIP framework wrappers
    // entirely. Semi buries a table under .semi-table-wrapper >
    // .semi-table-container > .semi-table-body (and, when a Table has a loading
    // prop, under .semi-spin > .semi-spin-children too). Emitting those
    // produced a 120-char path of pure noise; skipping them yields
    // "div.emp-wrap > table.semi-table", which points straight at the source.
    var node = el.parentElement;
    for (var hop = 0; node && node.nodeType === 1 && hop < 12 && parts.length < 3; hop++) {
      if (node === document.body) break;
      var own = appClasses(node);
      if (own.length) parts.unshift(seg(node, own));
      node = node.parentElement;
    }
    return parts.join(' > ');
  }

  function isVisible(el) {
    if (!el || el.nodeType !== 1) return false;
    // offsetParent is null for display:none and for fixed elements; the rect
    // check covers the fixed case (the topbar is position:fixed here).
    var r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return false;
    var cs = window.getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none' || cs.opacity === '0') return false;
    return true;
  }

  // 「有意双语」标记类：两条语言检查唯一的正当例外。
  //   .lang-toggle — 语言切换器用目标语言写自己；
  //   .lang-pair   — 中英成对的编辑器/名称对，跨语言是本意（BrandSettings.jsx
  //                  的成对输入框、Roles.jsx 的角色中英名）。
  var LANG_PAIR_SEL = '.lang-pair, .lang-toggle';

  // innerText 减去被标记为有意双语的子树。
  // 为什么需要它：latin-in-zh / cjk-in-en 优先读元素自己的文本节点，只有当元素
  // 自己没有文本、且内部也没有别的受检节点时才退回 innerText。角色与授权页左侧
  // 的 .adm-nav-item 正是这种容器 —— 文字全在子 <span> 里，于是它退回 innerText，
  // 把「有意成对的中英角色名」和「内置 / N 名成员」一起卷进同一个字符串，
  // 每次冒烟固定产出 10 条噪音 warn。只在祖先上打 .lang-pair 会把整颗子树（含
  // 那些确实该受检的 T 文案）一并豁免，所以这里改成按子树相减：成对的那一半被
  // 剔除，同一容器里其余 chrome 文案照旧受检。
  function innerTextExcludingLangPairs(el) {
    if (!el || !el.querySelector || !el.querySelector(LANG_PAIR_SEL)) return (el && el.innerText) || '';
    var out = '';
    for (var i = 0; i < el.childNodes.length; i++) {
      var n = el.childNodes[i];
      if (n.nodeType === 3) { out += n.nodeValue; continue; }
      if (n.nodeType !== 1) continue;
      if (n.matches && n.matches(LANG_PAIR_SEL)) continue;
      out += ' ' + innerTextExcludingLangPairs(n);
    }
    return out;
  }

  // Nearest ancestor (or self) that is display:none / hidden — cached per call
  // because literal-null walks every text node and getComputedStyle is slow.
  function makeHiddenCache() {
    var cache = new WeakMap();
    return function hidden(el) {
      var chain = [];
      var node = el;
      while (node && node.nodeType === 1) {
        if (cache.has(node)) {
          var known = cache.get(node);
          for (var i = 0; i < chain.length; i++) cache.set(chain[i], known);
          return known;
        }
        var cs = window.getComputedStyle(node);
        if (cs.display === 'none' || cs.visibility === 'hidden') {
          for (var j = 0; j < chain.length; j++) cache.set(chain[j], true);
          cache.set(node, true);
          return true;
        }
        chain.push(node);
        node = node.parentElement;
      }
      for (var k = 0; k < chain.length; k++) cache.set(chain[k], false);
      return false;
    };
  }

  var findings = [];
  function add(severity, kind, message, sample) {
    findings.push({ severity: severity, kind: kind, message: message, sample: clip(sample, 120) });
  }

  // ---------------------------------------------------------- locale + regions
  // I18nProvider writes documentElement.lang ('zh-CN' | 'en'); localStorage is
  // the fallback for the instant before that effect runs.
  var lang = /^zh/i.test(document.documentElement.lang || '') ? 'zh' : 'en';
  try {
    if (!document.documentElement.lang) {
      var saved = localStorage.getItem('lms-lang');
      if (saved === 'zh' || saved === 'en') lang = saved;
    }
  } catch (e) { /* storage blocked; keep the <html lang> answer */ }

  var root = document.getElementById('root') || document.body;
  var bodyText = (document.body && document.body.innerText) || '';

  // Content = everything that is not persistent shell. Measuring the content
  // region (rather than body) is what makes blank-page sharp: the console shell
  // alone contributes ~200 chars of nav, which would mask an empty page.
  var CHROME_REGIONS = '.topbar, .adm-side, .tabbar, .tabbar-spacer';
  function norm(s) { return String(s || '').replace(/\s+/g, ' ').trim(); }
  // The console nests its routes under .adm-main, so that element IS the content
  // region and needs no subtraction. The employee app has no such wrapper, so
  // fall back to subtracting the shell's text LENGTH from the root's. Length
  // arithmetic on purpose: an earlier version tried to excise the shell text by
  // string split/join, which silently no-ops whenever innerText differs by a
  // whitespace character — and a stray empty separator made it delete nothing at
  // all. The count is all blank-page needs.
  var contentEl = document.querySelector('.adm-main') || document.querySelector('main');
  var contentText;
  var contentLen;
  if (contentEl) {
    contentText = norm(contentEl.innerText);
    contentLen = contentText.length;
  } else {
    contentText = norm(root.innerText);
    contentLen = contentText.length;
    var shell = root.querySelectorAll(CHROME_REGIONS);
    for (var si = 0; si < shell.length; si++) {
      contentLen -= norm(shell[si].innerText).length;
    }
    if (contentLen < 0) contentLen = 0;
  }

  // ------------------------------------------------- 1. error-boundary (fail)
  // The boundary replaces the whole subtree, so a body-text match is enough and
  // cannot be confused with the 404 page (different copy).
  for (var bi = 0; bi < BOUNDARY_MARKERS.length; bi++) {
    if (bodyText.indexOf(BOUNDARY_MARKERS[bi]) !== -1) {
      // The boundary prints error.message in a small grey line; carry it in the
      // sample because it usually names the bad hook or variable outright.
      var tail = bodyText.slice(bodyText.indexOf(BOUNDARY_MARKERS[bi]));
      add('fail', 'error-boundary', 'React error boundary rendered instead of the page.', tail);
      break;
    }
  }

  // -------------------------------------------------- 2. literal-null (fail)
  // Word-boundary-ish guard: reject a match touching [A-Za-z0-9_$] on either
  // side, so "annulled", "nullable", "NaNoWriMo" and "undefinedBehaviour" are
  // not matched, while "null 绩效", "(null)", "· undefined" and "NaN%" are.
  // Hyphen is NOT in the guard class on purpose: "non-null" in prose is
  // vanishingly rare here, whereas "T-00042 - null" style joins are exactly
  // the bug shape we are hunting.
  var NULLISH = /(^|[^A-Za-z0-9_$])(null|undefined|NaN)(?=$|[^A-Za-z0-9_$])/g;
  var hidden = makeHiddenCache();
  var nullHits = [];
  var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
    acceptNode: function (n) {
      var p = n.parentElement;
      if (!p) return NodeFilter.FILTER_REJECT;
      var tag = p.tagName;
      // Script/style/template text is source, not interface.
      if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT' || tag === 'TEMPLATE') {
        return NodeFilter.FILTER_REJECT;
      }
      if (!n.nodeValue || !n.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  var tn;
  while ((tn = walker.nextNode())) {
    NULLISH.lastIndex = 0;
    if (!NULLISH.test(tn.nodeValue)) continue;
    if (hidden(tn.parentElement)) continue; // offscreen menus etc. are not "rendered"
    nullHits.push({ el: tn.parentElement, text: tn.nodeValue });
  }
  for (var ni = 0; ni < nullHits.length && ni < 12; ni++) {
    add('fail', 'literal-null',
      'Visible text contains a literal null/undefined/NaN at ' + pathOf(nullHits[ni].el) + '.',
      nullHits[ni].text);
  }
  if (nullHits.length > 12) {
    add('fail', 'literal-null', 'and ' + (nullHits.length - 12) + ' more nullish text nodes on this route.', '');
  }

  // ---------------------------------------------------- 3. blank-page (fail)
  // Semi's Spin is always MOUNTED next to a Table and marks itself
  // .semi-spin-hidden when idle (confirmed on /admin/employees: the node exists
  // with that class on a fully loaded page). So "is loading" must exclude it,
  // or every fast page reads as still-loading.
  var spinners = document.querySelectorAll('.semi-spin:not(.semi-spin-hidden), .semi-table-placeholder, .semi-skeleton');
  var loading = false;
  for (var pi = 0; pi < spinners.length; pi++) {
    if (isVisible(spinners[pi])) { loading = true; break; }
  }
  // Threshold 6 chars, and it has to be this low because the copy is CHINESE —
  // CJK is dense, so a complete page is genuinely short. Measured over a
  // 21-route sweep under zh, the floor is /team at 15 chars (heading + lead +
  // "你目前没有直接下属", a perfectly healthy empty state), then /review 24,
  // /projects 74, /admin/reviews 171, everything else 270–5400.
  // Calibration history, since the number looks arbitrary otherwise: 40 flagged
  // /team and nearly /review — precisely the false positive that teaches a
  // reviewer to ignore the check. 6 clears the observed floor by 9 chars while
  // still catching the dead render this exists for (0–3 chars).
  // The cost: a page that renders its heading and nothing else slips through.
  // That case surfaces as error-boundary here, or as a console error in the
  // driver, so it is not actually unguarded.
  var BLANK_MIN = 6;
  if (contentLen < BLANK_MIN && !loading) {
    add('fail', 'blank-page',
      'Content region rendered ' + contentLen + ' chars (< ' + BLANK_MIN + ') with no visible loading indicator.',
      contentText || '(empty)');
  }

  // -------------------------------------------------- 4. page-overflow (fail)
  // Whole-document horizontal scroll is always a bug: the shell is a fixed
  // topbar + sidebar + fluid main, nothing is meant to push the document wide.
  // 2px tolerance: fractional layout widths (calc(), flex gap, devicePixelRatio
  // scaling) leave a sub-pixel residue and scrollWidth is rounded UP, so a
  // pixel-perfect page routinely reports a 1px difference.
  var de = document.documentElement;
  var docOver = de.scrollWidth - de.clientWidth;
  // A zero-width documentElement means the headless window had not realised its
  // viewport when this snapshot ran (observed once in integration: EVERY page
  // reported "scrollWidth 228 vs clientWidth 0", including pages that were
  // overflow-clean on the runs before and after). That is a driver artifact,
  // not 80 real overflows — name it for what it is so the rerun decision is
  // obvious, and skip the per-element hunt that would only add noise.
  if (de.clientWidth === 0) {
    add('fail', 'viewport-zero',
      'documentElement.clientWidth is 0 — the browser viewport never realised; treat every finding on this run as suspect and rerun.',
      'viewport=' + window.innerWidth + 'x' + window.innerHeight);
  } else if (docOver > 2) {
    // Name the widest offender so the finding is actionable.
    var widest = null;
    var all = document.body.querySelectorAll('*');
    for (var ai = 0; ai < all.length; ai++) {
      var r = all[ai].getBoundingClientRect();
      if (r.width === 0) continue;
      var right = r.right;
      if (right > de.clientWidth + 2 && (!widest || right > widest.right)) {
        widest = { right: right, el: all[ai] };
      }
    }
    add('fail', 'page-overflow',
      'Document scrolls horizontally by ' + docOver + 'px (scrollWidth ' + de.scrollWidth +
      ' vs clientWidth ' + de.clientWidth + ').',
      widest ? 'widest: ' + pathOf(widest.el) + ' right=' + Math.round(widest.right) : '');
  }

  // -------------------------------------------------- 5. latin-in-zh (warn)
  var chromeScanned = 0;
  var whitelistHits = 0;
  if (lang === 'zh') {
    var nouns = Object.create(null);
    for (var pn = 0; pn < PROPER_NOUNS.length; pn++) nouns[PROPER_NOUNS[pn]] = true;

    // Whitelist patterns, each verified against this database / UI:
    //   employee + record ids .... T-00001, T-00925, ADMIN, LK-9F2A1B, DP-1001
    //   job levels ............... PA1 PB3 PC2 PD6 PV1 V4 O1 O2 (lms.db)
    //   letter grades ............ A, A+, B-, C
    //   emails / domains ......... chelsea@digiplus.com.ph
    //   urls ..................... https://www.youtube.com/watch?v=...
    //   dates & clock ............ 2026-08-20, 2024/06/28, 3/25, 12:30
    //   numbers, percents, sizes . 925, 1,234, 92%, 4.5, 12MB
    //   quarters / halves ........ Q3, H2
    var WHITELIST_PATTERNS = [
      /^[A-Z]{1,4}-?\d{2,6}$/,          // T-00001 / DP-1001 / LK-... prefix form
      /^LK-[A-Z0-9]{4,10}$/,            // Lark just-in-time employee ids
      /^[A-Z]{1,2}\d{1,2}$/,            // PD2 / PV1 / V4 / O1 job levels
      /^[A-Z][+-]?$/,                   // A, A+, B-
      /^[QH]\d$/,                       // Q3, H2
      /^\S+@\S+\.\S+$/,                 // email
      /^https?:\/\//i,                  // url
      /^\d{4}[-/]\d{1,2}([-/]\d{1,2})?$/, // 2026-08-20, 2026/08
      /^\d{1,2}[-/:]\d{1,2}(:\d{2})?$/, // 3/25, 12:30
      /^[\d.,]+%?$/,                    // 925, 1,234, 92%, 4.5
      /^\d+(\.\d+)?(kb|mb|gb|s|ms|min|h|px)$/i, // 12MB, 30min
    ];

    var seenText = Object.create(null);
    var nodes = document.querySelectorAll(CHROME_SELECTORS.join(', '));
    for (var qi = 0; qi < nodes.length; qi++) {
      var el = nodes[qi];
      if (!isVisible(el)) continue;
      // 这两条检查的正当例外只有两类，各有一个标记类：
      //   .lang-toggle — 语言切换器用目标语言写自己；
      //   .lang-pair   — 品牌设置的中英成对输入框，占位符展示的是「另一种语言
      //                  的生效文案」，本来就该跨语言（见 BrandSettings.jsx）。
      if (el.closest && (el.closest('.lang-toggle') || el.closest('.lang-pair'))) continue;

      // Prefer the element's OWN text: a <button> wrapping a <span> would
      // otherwise be reported twice, and a nav item's badge count would be
      // glued onto its label ("培训项目3").
      var raw = '';
      for (var ci = 0; ci < el.childNodes.length; ci++) {
        var kid = el.childNodes[ci];
        if (kid.nodeType === 3) raw += kid.nodeValue;
      }
      // Falling back to innerText is needed for wrappers like Semi's
      // <button><span>label</span></button>, but only when no OTHER scoped node
      // sits inside — otherwise a container (.ppl-sec-h) and its own lead
      // (.tset-lead) both report the same sentence. Measured: this was the only
      // duplicate in the trial run.
      if (!raw.trim() && !el.querySelector(CHROME_SELECTORS.join(', '))) {
        raw = innerTextExcludingLangPairs(el);
      }
      // Placeholders live in an attribute, not in text.
      var ph = el.getAttribute && el.getAttribute('placeholder');
      if (ph) raw = ph;
      raw = raw.replace(/\s+/g, ' ').trim();
      if (!raw) continue;
      chromeScanned++;
      if (seenText[raw]) continue; // one report per distinct string per route
      seenText[raw] = true;

      // Residual test: drop CJK, punctuation and every whitelisted token, then
      // ask whether a real Latin WORD survives. This is stricter than "has no
      // CJK" (it also catches the half-translated "导出 Report") while staying
      // quiet on "导出 CSV".
      var residual = [];
      var tokens = raw.split(/[^0-9A-Za-z@:./+%,'’-]+/);
      for (var ti = 0; ti < tokens.length; ti++) {
        var tok = tokens[ti];
        if (!tok) continue;
        if (!/[A-Za-z]/.test(tok)) continue; // pure number / punctuation
        var bare = tok.replace(/^[^0-9A-Za-z]+|[^0-9A-Za-z%]+$/g, '');
        if (!bare) continue;
        if (nouns[bare.toLowerCase()]) { whitelistHits++; continue; }
        var matched = false;
        for (var wi = 0; wi < WHITELIST_PATTERNS.length; wi++) {
          if (WHITELIST_PATTERNS[wi].test(bare)) { matched = true; break; }
        }
        if (matched) { whitelistHits++; continue; }
        // An ALL-CAPS run of <=4 letters is an acronym, not prose. Unknown
        // acronyms (AUTO, EOD) are near-certainly intentional, and treating
        // them as findings was the single largest noise source in trial runs.
        if (/^[A-Z0-9+.-]{1,4}$/.test(bare)) { whitelistHits++; continue; }
        // Words shorter than 3 letters carry no translatable meaning.
        if (bare.replace(/[^A-Za-z]/g, '').length < 3) { whitelistHits++; continue; }
        if (residual.indexOf(bare) === -1) residual.push(bare); // "Level ... Level" once
      }
      if (!residual.length) continue;

      add('warn', 'latin-in-zh',
        'Chinese UI shows untranslated chrome text (' + residual.slice(0, 4).join(', ') +
        ') at ' + pathOf(el) + '.',
        raw);
    }
  }

  // ------------------------------------------------ 5b. cjk-in-en (warn)
  // The mirror of the check above, and it has caught real bugs in this codebase:
  // migration 39's fallback copied Chinese into the ENGLISH slot, so an English
  // reader saw 「同步更新当前职级」 as a field label. Same chrome-only scope — the
  // DATA is legitimately Chinese here (course titles like 「2026 合规必修年度轮训」,
  // HR-typed notes), so scanning anything wider would be pure noise.
  if (lang === 'en') {
    var seenEn = Object.create(null);
    var enNodes = document.querySelectorAll(CHROME_SELECTORS.join(', '));
    for (var ei = 0; ei < enNodes.length; ei++) {
      var enEl = enNodes[ei];
      if (!isVisible(enEl)) continue;
      // Same two sanctioned exceptions as latin-in-zh above.
      if (enEl.closest && (enEl.closest('.lang-toggle') || enEl.closest('.lang-pair'))) continue;
      var enRaw = '';
      for (var eci = 0; eci < enEl.childNodes.length; eci++) {
        var enKid = enEl.childNodes[eci];
        if (enKid.nodeType === 3) enRaw += enKid.nodeValue;
      }
      if (!enRaw.trim() && !enEl.querySelector(CHROME_SELECTORS.join(', '))) enRaw = innerTextExcludingLangPairs(enEl);
      var enPh = enEl.getAttribute && enEl.getAttribute('placeholder');
      if (enPh) enRaw = enPh;
      enRaw = enRaw.replace(/\s+/g, ' ').trim();
      if (!enRaw) continue;
      chromeScanned++;
      if (seenEn[enRaw]) continue;
      seenEn[enRaw] = true;
      var cjk = enRaw.match(/[\u4e00-\u9fff]+/g);
      if (!cjk) continue;
      add('warn', 'cjk-in-en',
        'English UI shows Chinese chrome text (' + cjk.slice(0, 3).join(' ') + ') at ' + pathOf(enEl) + '.',
        enRaw);
    }
  }

  // ------------------------------------------------ 6. table-overflow (warn)
  // Semi renders <table class="semi-table"> inside a scroll box
  // (.semi-table-body, overflow-x:auto — confirmed on /admin/employees). Wide
  // tables are a deliberate design here (the employee roster is ~1082px), so
  // this is a warn: the human decides whether the width is reasonable.
  // 8px tolerance rather than the 2px used for the document. Cell borders,
  // Semi's `table-layout:fixed` column rounding and scrollbar-gutter arithmetic
  // routinely leave a handful of stray pixels: /admin/exams reported a 3px
  // "overflow" that is invisible and unfixable. A real overflow is an order of
  // magnitude bigger — the injected fault above measured 383–398px, and the
  // employee roster is ~1083px in a ~1143px box.
  var TABLE_SLACK = 8;
  var tables = document.querySelectorAll('table.semi-table, table');
  var tableCount = 0;
  for (var tbi = 0; tbi < tables.length; tbi++) {
    var tbl = tables[tbi];
    if (!isVisible(tbl)) continue;
    tableCount++;

    var box = null;
    var anc = tbl.parentElement;
    while (anc && anc !== document.body) {
      var acs = window.getComputedStyle(anc);
      if (acs.overflowX === 'auto' || acs.overflowX === 'scroll') { box = anc; break; }
      anc = anc.parentElement;
    }

    var tableW = tbl.scrollWidth;
    if (!box) {
      // No scroll box at all: the extra width is clipped or it pushes the page
      // wide (page-overflow above will have caught the latter).
      var host = tbl.parentElement;
      var hostW = host ? host.clientWidth : 0;
      if (hostW && tableW > hostW + TABLE_SLACK) {
        add('warn', 'table-overflow',
          'Table is ' + (tableW - hostW) + 'px wider than its container and the container is NOT ' +
          'scrollable (overflow-x is ' + window.getComputedStyle(host).overflowX + ') — content is clipped, ' +
          'not scrollable.',
          pathOf(tbl) + ' table=' + tableW + 'px host=' + hostW + 'px');
      }
      continue;
    }

    var over = tableW - box.clientWidth;
    if (over <= TABLE_SLACK) continue;

    // The nasty variant: the scroll box ALSO scrolls vertically because it has
    // a max-height (app.css does exactly this: `.ck-roster .semi-table-body
    // {max-height:340px}`). The horizontal scrollbar is then pinned to the
    // BOTTOM of the scrollable content, i.e. below the fold of a long list —
    // users see clipped columns and no way to reach them. Detection: the same
    // box overflows vertically and its computed max-height is not `none`.
    var bcs = window.getComputedStyle(box);
    var vClipped = box.scrollHeight > box.clientHeight + 2;
    var capped = bcs.maxHeight && bcs.maxHeight !== 'none';
    var note = '';
    if (vClipped && capped) {
      note = ' HIDDEN SCROLLBAR: the box also scrolls vertically (max-height ' + bcs.maxHeight +
        ', ' + box.scrollHeight + 'px of content in ' + box.clientHeight +
        'px) so the horizontal scrollbar sits below the fold and is unreachable.';
    } else if (vClipped) {
      note = ' Note: the box scrolls vertically too, so the horizontal scrollbar may sit below the fold.';
    }

    add('warn', 'table-overflow',
      'Table overflows its scroll box by ' + over + 'px (table ' + tableW + 'px in ' +
      box.clientWidth + 'px).' + note,
      pathOf(tbl) + ' box=.' + String(box.className).split(/\s+/)[0]);
  }

  // -------------------------------------------------------------------- stats
  return {
    findings: findings,
    stats: {
      lang: lang,
      hash: location.hash || '#/',
      visibleTextLength: bodyText.replace(/\s+/g, ' ').trim().length,
      contentTextLength: contentLen,
      loadingIndicatorVisible: loading,
      tableCount: tableCount,
      thCount: document.querySelectorAll('th').length,
      buttonCount: document.querySelectorAll('button').length,
      chromeNodesScanned: chromeScanned,
      whitelistSuppressed: whitelistHits,
      docScrollWidth: de.scrollWidth,
      docClientWidth: de.clientWidth,
      viewport: window.innerWidth + 'x' + window.innerHeight,
      failCount: findings.filter(function (f) { return f.severity === 'fail'; }).length,
      warnCount: findings.filter(function (f) { return f.severity === 'warn'; }).length,
    },
  };
}

// ===========================================================================
// 版面检查（第二批 3.2，smoke.js --layout 才跑）
// ===========================================================================
// 与 pageChecks 同一写法：浏览器端函数，自包含（不引用 Node 侧任何绑定，白名单也写在里面），
// toString 后注入。并入了 QA 会话的 scripts/qa-layout-check.js（10/8 基线，docs/QA-20261006.md §15）
// 的三类检查：文字溢出容器、按钮文字不居中、正文行宽过长；它的「页面横向滚动」已由上面的
// page-overflow 覆盖，不重复。§15 判为误报的三处（通知角标、可横向滑动的筛选条、组织架构画布
// 视口外的节点）在这里是结构性排除，不进白名单。§15 V2（工号被拆成「(T-」「00858)」两行）
// 由 token-split 回归。
//
// 检查项（除 text-offscreen 在手机宽度下记 fail，其余一律 warn）：
//   text-overflow      文字超出自身框（被裁切或溢出），或被 overflow:hidden 的祖先裁掉（§15 V1）
//   ellipsis-no-title  省略号或多行截断了文字，但自身和父元素都没有 title
//   text-offscreen     文字超出视口左右边（横向滚动容器里的除外）；视口宽 ≤600 时记 fail
//   token-split        工号、编号、日期被折成两行（§15 V2）
//   off-center-x/-y    .btn / .semi-button / .semi-tag / .pill / .ppl-chip / 页签：内容（文字+图标）
//                      并集中心与内边距框中心横向差 >3px、纵向差 >2.5px（F4）
//   label-wrapped      短标签（<24 字）折成多行；行数按文字矩形的纵向重叠分组算，不按 top 取整
//                      （图标+文字、大小字号混排在原型里都被按 top 误判成两行）
//   line-too-long/-short  段落类：中文每行 >45 字、英文 >100 字符；≥3 行时中文 <10、英文 <22
//   column-imbalance   多栏行里最矮一栏的实际内容高 < 最高一栏的 40%，且最高 >320px（吸顶侧栏除外）
//   uneven-row         同一行的卡片高度差 >15%，且都 >200px（F3）
//   narrow-centered    ≥900px 的父容器里唯一的子块宽 <62% 且左右留白相等（F1）
//   narrow-content     宽 ≥700 的卡片里正文只占左侧 <60%、右侧空白 >300px（F2）
//   card-in-card       有边框或阴影、圆角 ≥6、有底色、宽 ≥120 的块，6 层祖先内还有同类块（F1）
//
// 每条结果带 sig（选择器签名：标签 + 应用类名，最多三段祖先；不用 nth-child，状态类 on/off/
// active/open… 去掉），同一路由里同一「检查项 × 签名」只报一条并计数，基线比对和跨页归并都按它。
// opts: { mark: true } 时给命中元素打 data-smoke-layout 属性，截图前由驱动加红框。
function layoutChecks(opts) {
  opts = opts || {};
  // 视口宽取布局视口（documentElement.clientWidth），不取 innerWidth：手机模拟下内容一旦横向溢出，
  // 浏览器会缩小页面去装下它，innerWidth（可视视口）随之变大（实测 390 → 533），出视口的文字
  // 反而「在视口里」了。clientWidth 始终是 device-width；桌面上它还扣掉了滚动条。
  var VW = opts.vw || document.documentElement.clientWidth || window.innerWidth;
  var VH = document.documentElement.clientHeight || window.innerHeight;
  var MOBILE = VW <= (opts.mobileMax || 600);
  var MAX_PER_KIND = 30;

  // 结构性排除：不是本页版面、或由别的检查负责的元素（命中元素自身或其祖先匹配即跳过）
  var SKIP_SEL = [
    'script', 'style', 'noscript', 'template', 'svg', 'canvas', 'iframe', 'video', 'img',
    'input', 'textarea', 'select', 'option',
    '.orgd2-stage',              // 组织架构画布：可平移，视口外有节点是常态（§15 误报）
    '.ProseMirror',              // 富文本编辑区：用户正文
    '.semi-portal',              // 浮层（下拉、气泡、弹窗），不在页面流里
    '.recharts-wrapper',
    '.notif-dot', '.notif-udot', '.adm-badge', '[class*="badge"]', // 角标故意压在别的元素上（§15 误报）
    '[data-smoke-skip]',
  ].join(',');

  // 设计如此的情况。confirmed:false = 候选，仍然报告，只在结果上注明理由；负责人确认后改成
  // true 才真正不报（第二批设计 3.6「白名单写明原因，待负责人确认后生效」）。
  var WHITELIST = [
    { kind: 'card-in-card', sel: '.trev-cell', reason: '人才盘点九宫格的格子是卡片里的格位（MAP 4 原型复核）', confirmed: false },
    { kind: 'card-in-card', sel: '.tset-frow, .tset-typebar, .tset-fcard', reason: '档案与职级设置：字段行、类型条是设置卡里的分组（MAP 4 原型复核）', confirmed: false },
    { kind: 'card-in-card', sel: '.ppl-ev-card', reason: '人才档案时间线的事件卡排在档案卡里（MAP 4 原型复核）', confirmed: false },
  ];

  var MSG = {
    'text-overflow': '文字超出自身框或被祖先裁掉',
    'ellipsis-no-title': '文字被省略号截断，但自身和父元素都没有 title',
    'text-offscreen': '文字超出视口',
    'token-split': '工号/编号/日期被折成两行',
    'off-center-x': '按钮或标签的内容水平不居中',
    'off-center-y': '按钮或标签的内容垂直不居中',
    'label-wrapped': '短标签折成了多行',
    'line-too-long': '正文每行字数过多',
    'line-too-short': '正文每行字数过少（栏太窄）',
    'column-imbalance': '多栏区域栏高失衡，留下大块空白',
    'uneven-row': '同一行的卡片高度不一',
    'narrow-centered': '宽容器里只有一块居中的窄内容',
    'narrow-content': '卡片正文只占左侧一窄条，右侧大块空白',
    'card-in-card': '卡片套卡片',
  };

  // ------------------------------------------------------------ helpers
  var STATE_CLS = /^(on|off|active|open|opened|closed|selected|current|disabled|focus|hover|tnum|is-.+|has-.+)$/;
  function cls(node, keepSemi) {
    var c = (node.getAttribute && node.getAttribute('class')) || '';
    return String(c).split(/\s+/).filter(function (x) {
      if (!x || STATE_CLS.test(x)) return false;
      if (x.indexOf('semi-') === 0) return !!keepSemi && !/\d|focus|hover|active|disabled|selected|checked/.test(x);
      return x.indexOf('react-') !== 0;
    });
  }
  function sigOf(el) {
    function seg(n, c) { return n.tagName.toLowerCase() + (c.length ? '.' + c.slice(0, 2).join('.') : ''); }
    var parts = [seg(el, cls(el, true))];
    var n = el.parentElement;
    for (var hop = 0; n && n !== document.body && hop < 12 && parts.length < 3; hop++) {
      var own = cls(n, false);
      if (own.length) parts.unshift(seg(n, own));
      n = n.parentElement;
    }
    return parts.join(' > ');
  }
  function lastSeg(el) { var s = sigOf(el).split(' > '); return s[s.length - 1]; }
  function clip(s, n) { s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; }
  function skipped(el) { return !!(el.closest && el.closest(SKIP_SEL)); }
  function vis(el) {
    var r = el.getBoundingClientRect();
    if (r.width <= 1 || r.height <= 1) return false;
    var cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none' && parseFloat(cs.opacity) >= 0.05;
  }
  function transparent(c) { return !c || c === 'transparent' || /rgba\([^)]*,\s*0\)$/.test(c); }
  function rectsOf(node) {
    var rg = document.createRange(); rg.selectNodeContents(node);
    var out = []; var rs = rg.getClientRects();
    for (var i = 0; i < rs.length; i++) if (rs[i].width > 0.5 && rs[i].height > 0.5) out.push(rs[i]);
    return out;
  }
  // 文字矩形：own = 只看直接文字子节点；否则整棵子树（跳过绝对定位的后代，例如计数角标）
  function textRects(el, own) {
    var out = [];
    if (own) {
      for (var i = 0; i < el.childNodes.length; i++) {
        var n = el.childNodes[i];
        if (n.nodeType === 3 && n.nodeValue.trim()) out = out.concat(rectsOf(n));
      }
      return out;
    }
    var tw = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    var t;
    while ((t = tw.nextNode())) {
      if (!t.nodeValue.trim()) continue;
      if (floated(t.parentElement, el)) continue;
      out = out.concat(rectsOf(t));
    }
    return out;
  }
  function floated(node, stop) {
    for (var n = node; n && n !== stop; n = n.parentElement) {
      var p = getComputedStyle(n).position;
      if (p === 'absolute' || p === 'fixed') return true;
    }
    return false;
  }
  function union(rs) {
    var u = { left: Infinity, right: -Infinity, top: Infinity, bottom: -Infinity };
    rs.forEach(function (r) { u.left = Math.min(u.left, r.left); u.right = Math.max(u.right, r.right); u.top = Math.min(u.top, r.top); u.bottom = Math.max(u.bottom, r.bottom); });
    return u;
  }
  // 行数 = 按纵向重叠分组的组数：同一行的字（不同字号、图标旁的字）纵向必然重叠一半以上
  function lineCount(rs) {
    var lines = [];
    rs.slice().sort(function (a, b) { return a.top - b.top; }).forEach(function (r) {
      for (var i = 0; i < lines.length; i++) {
        var L = lines[i];
        var ov = Math.min(L.bottom, r.bottom) - Math.max(L.top, r.top);
        if (ov > 0.5 * Math.min(L.bottom - L.top, r.height)) { L.top = Math.min(L.top, r.top); L.bottom = Math.max(L.bottom, r.bottom); return; }
      }
      lines.push({ top: r.top, bottom: r.bottom });
    });
    return lines.length;
  }
  function scrollAncestor(el) {
    for (var n = el.parentElement; n && n !== document.documentElement; n = n.parentElement) {
      var cs = getComputedStyle(n);
      if (/auto|scroll/.test(cs.overflowX)) return n;
    }
    return null;
  }
  // 最近的「裁切而不滚动」的祖先；先遇到可滚动祖先就不算（内容能滚到）
  function clipAncestor(el) {
    for (var n = el.parentElement; n && n !== document.body; n = n.parentElement) {
      var cs = getComputedStyle(n);
      if (/auto|scroll/.test(cs.overflowX)) return null;
      if (/hidden|clip/.test(cs.overflowX)) return (cs.textOverflow === 'ellipsis') ? null : n;
    }
    return null;
  }
  function titled(el) {
    return !!(el.getAttribute('title') || (el.parentElement && el.parentElement.getAttribute('title')));
  }
  function cardy(el, cs, r) {
    if (r.width < 120 || r.height < 44) return false;
    // 排除输入控件、标签、表格（含原生 table 与它的行：手机上卡片化的表格行不算卡片）、弹窗；
    // label 是带框的勾选行（例如「已完成 1 对 1 面谈」），属于表单控件。
    // 输入框外壳（例如密码框 .pwf：输入框 + 显示密码按钮）直接包着 input，也是控件不是卡片
    if (el.querySelector(':scope > input, :scope > textarea, :scope > select')) return false;
    if (el.matches('button.semi-button, .btn, label, .semi-input-wrapper, .semi-select, .semi-tag, .pill, .semi-checkbox, .semi-radio, .semi-tabs-bar, .semi-table, .semi-table *, table, table *, .semi-modal *, [role="dialog"] *')) return false;
    var border = parseFloat(cs.borderTopWidth) >= 1 && cs.borderTopStyle !== 'none' && !transparent(cs.borderTopColor);
    var shadow = cs.boxShadow && cs.boxShadow !== 'none';
    return (border || shadow) && parseFloat(cs.borderTopLeftRadius) >= 6 && !transparent(cs.backgroundColor);
  }

  // ------------------------------------------------------------ 结果归并
  var groups = Object.create(null);
  var order = [];
  var perKind = Object.create(null);
  var scanned = 0;
  var suppressed = 0;
  function hit(kind, el, extra, severity) {
    var proposal = null;
    for (var w = 0; w < WHITELIST.length; w++) {
      var e = WHITELIST[w];
      if (e.kind === kind && el.closest(e.sel)) {
        if (e.confirmed) { suppressed++; return; }
        proposal = e.reason;
        break;
      }
    }
    var sig = sigOf(el);
    var key = kind + '|' + sig;
    var g = groups[key];
    if (!g) {
      if ((perKind[kind] || 0) >= MAX_PER_KIND) return;
      perKind[kind] = (perKind[kind] || 0) + 1;
      g = groups[key] = { severity: severity || 'warn', kind: kind, sig: sig, count: 0, extra: extra || '', sample: clip(el.innerText || el.textContent, 80), whitelist: proposal };
      order.push(key);
    }
    g.count++;
    if (severity === 'fail') g.severity = 'fail';
    if (opts.mark) {
      var had = el.getAttribute('data-smoke-layout') || '';
      if ((' ' + had + ' ').indexOf(' ' + kind + ' ') < 0) el.setAttribute('data-smoke-layout', (had + ' ' + kind).trim());
    }
  }

  var all = Array.prototype.slice.call(document.body.querySelectorAll('*'));
  var main = document.querySelector('.adm-main') || document.querySelector('main') || document.querySelector('.wrap') || document.body;
  var mainW = main.getBoundingClientRect().width || VW;

  // ---------------------------------------- 1. 文字：溢出 / 截断 / 出视口 / 编号折行
  var TOKEN = /[A-Z]{1,5}-\d{2,6}|\d{4}-\d{2}-\d{2}|\d{4}\/\d{1,2}\/\d{1,2}/g;
  all.forEach(function (el) {
    var rs = textRects(el, true);
    if (!rs.length || skipped(el) || !vis(el)) return;
    scanned++;
    var cs = getComputedStyle(el);
    var r = el.getBoundingClientRect();
    var u = union(rs);
    var label = clip(el.innerText || el.textContent, 40);
    if (!scrollAncestor(el) && (u.right > VW + 1 || u.left < -1)) {
      hit('text-offscreen', el, (u.right > VW + 1 ? '右侧超出 ' + Math.round(u.right - VW) : '左侧超出 ' + Math.round(-u.left)) + 'px · 视口 ' + VW, MOBILE ? 'fail' : 'warn');
      return;
    }
    var clamp = cs.webkitLineClamp && cs.webkitLineClamp !== 'none';
    var ell = cs.textOverflow === 'ellipsis' || clamp;
    if (!/visible|auto|scroll/.test(cs.overflowX) && el.clientWidth > 0 && el.scrollWidth > el.clientWidth + 2) {
      if (ell) { if (!titled(el)) hit('ellipsis-no-title', el, '「' + label + '」'); }
      else hit('text-overflow', el, '裁掉 ' + (el.scrollWidth - el.clientWidth) + 'px');
      return;
    }
    if (clamp && !/visible/.test(cs.overflowY) && el.scrollHeight > el.clientHeight + 2) {
      if (!titled(el)) hit('ellipsis-no-title', el, '多行截断「' + label + '」');
      return;
    }
    if (cs.display !== 'inline' && cs.overflowX === 'visible' && (u.right > r.right + 2 || u.left < r.left - 2)) {
      hit('text-overflow', el, '溢出自身框 ' + Math.round(Math.max(u.right - r.right, r.left - u.left)) + 'px');
      return;
    }
    var ca = clipAncestor(el);
    if (ca) {
      var cr = ca.getBoundingClientRect();
      if (u.right > cr.right + 2 || u.left < cr.left - 2) { hit('text-overflow', el, '被 ' + lastSeg(ca) + ' 裁掉 ' + Math.round(Math.max(u.right - cr.right, cr.left - u.left)) + 'px'); return; }
    }
    for (var i = 0; i < el.childNodes.length; i++) {
      var tn = el.childNodes[i];
      if (tn.nodeType !== 3) continue;
      TOKEN.lastIndex = 0;
      var m;
      while ((m = TOKEN.exec(tn.nodeValue))) {
        var rg = document.createRange();
        rg.setStart(tn, m.index); rg.setEnd(tn, m.index + m[0].length);
        var parts = Array.prototype.filter.call(rg.getClientRects(), function (x) { return x.width > 0.5; });
        if (lineCount(parts) > 1) { hit('token-split', el, '「' + m[0] + '」'); return; }
      }
    }
  });

  // ---------------------------------------- 2. 按钮 / 标签：折行与居中
  var CHIP_SEL = '.btn, .semi-button, .semi-tag, .pill, .ppl-chip, [role="tab"], .semi-tabs-tab';
  Array.prototype.forEach.call(document.querySelectorAll(CHIP_SEL), function (el) {
    if (skipped(el) || !vis(el)) return;
    var b = el.getBoundingClientRect();
    if (b.width > 360 || b.height > 64) return;
    var trs = textRects(el, false);
    if (!trs.length) return;
    var txt = (el.innerText || '').replace(/\s+/g, ' ').trim();
    if (txt.length < 24 && lineCount(trs) > 1) { hit('label-wrapped', el, Math.round(b.width) + '×' + Math.round(b.height) + ' 折成 ' + lineCount(trs) + ' 行'); return; }
    var content = trs.slice();
    Array.prototype.forEach.call(el.querySelectorAll('svg, img'), function (ic) {
      if (floated(ic, el)) return;
      var q = ic.getBoundingClientRect();
      if (q.width > 0.5 && q.height > 0.5) content.push(q);
    });
    var u = union(content);
    var cs = getComputedStyle(el);
    var f = function (k) { return parseFloat(cs[k]) || 0; };
    var il = b.left + f('paddingLeft') + f('borderLeftWidth'), ir = b.right - f('paddingRight') - f('borderRightWidth');
    var it = b.top + f('paddingTop') + f('borderTopWidth'), ib = b.bottom - f('paddingBottom') - f('borderBottomWidth');
    var dx = (u.left + u.right) / 2 - (il + ir) / 2;
    var dy = (u.top + u.bottom) / 2 - (it + ib) / 2;
    // 有意左对齐的不算：flex 显式 flex-start/start/left/space-between；块级 text-align 左对齐。
    // 缺省的 justify-content:normal 照查 —— F4 的根因正是 .btn{display:inline-flex} 没设 justify-content。
    var flexish = /flex|grid/.test(cs.display);
    var leftOnPurpose = flexish ? /^(flex-start|start|left|space-between)$/.test(cs.justifyContent) : /^(left|start|justify)$/.test(cs.textAlign);
    var fills = (u.right - u.left) >= (ir - il) - 2;
    if (!leftOnPurpose && !fills && Math.abs(dx) > 3) hit('off-center-x', el, 'dx=' + dx.toFixed(1) + 'px「' + clip(txt, 20) + '」');
    else if (Math.abs(dy) > 2.5) hit('off-center-y', el, 'dy=' + dy.toFixed(1) + 'px「' + clip(txt, 20) + '」');
  });

  // ---------------------------------------- 3. 正文行宽
  var PARA_SEL = 'p, li, dd, .ml-lead, .tset-lead, .pg-desc, .emp-lead, .rec-sub, [class*="-lead"], [class*="-desc"], [class*="-hint"], [class*="-help"]';
  Array.prototype.forEach.call(document.querySelectorAll(PARA_SEL), function (el) {
    if (skipped(el) || el.closest('table, .semi-table, nav, button, .btn, .semi-select, [role="menu"]')) return;
    if (el.querySelector('p, li, div, ul, ol, table, section, dd')) return; // 只看叶子段落，容器交给它里面的段落
    if (!vis(el)) return;
    var t = (el.innerText || '').replace(/\s+/g, ' ').trim();
    if (t.length < 40) return;
    var rs = textRects(el, false);
    if (!rs.length) return;
    var lines = lineCount(rs);
    var cjk = (t.match(/[㐀-鿿豈-﫿]/g) || []).length;
    var isCjk = cjk / t.replace(/\s/g, '').length > 0.3;
    var cpl = t.length / lines;
    var unit = isCjk ? ' 字/行' : ' 字符/行';
    if (isCjk ? cpl > 45 : cpl > 100) hit('line-too-long', el, Math.round(cpl) + unit + ' × ' + lines + ' 行');
    else if (lines >= 3 && (isCjk ? cpl < 10 : cpl < 22)) hit('line-too-short', el, Math.round(cpl) + unit + ' × ' + lines + ' 行');
  });

  // ---------------------------------------- 4. 分栏：栏高失衡、同行卡片不等高
  var styleCache = new Map();
  function st(el) { var s = styleCache.get(el); if (!s) { s = getComputedStyle(el); styleCache.set(el, s); } return s; }
  function contentHeight(k) {
    var kr = k.getBoundingClientRect();
    var bottom = kr.top;
    Array.prototype.forEach.call(k.querySelectorAll('*'), function (c) {
      var q = c.getBoundingClientRect();
      if (q.height > 0 && q.width > 0) bottom = Math.max(bottom, q.bottom);
    });
    return Math.min(kr.height, bottom - kr.top);
  }
  all.forEach(function (el) {
    if (skipped(el)) return;
    var cs = st(el);
    var isGrid = cs.display.indexOf('grid') >= 0 && cs.gridTemplateColumns.split(' ').length > 1;
    var isRow = cs.display.indexOf('flex') >= 0 && cs.flexDirection.indexOf('row') === 0;
    if (!isGrid && !isRow) return;
    var r = el.getBoundingClientRect();
    if (r.width < mainW * 0.5 || !vis(el)) return;
    var kids = Array.prototype.filter.call(el.children, function (k) { var p = st(k).position; return p !== 'absolute' && p !== 'fixed' && vis(k); });
    if (kids.length < 2) return;
    var rows = [];
    kids.forEach(function (k) {
      var top = k.getBoundingClientRect().top;
      var row = rows.find(function (x) { return Math.abs(x.top - top) < 4; });
      if (row) row.kids.push(k); else rows.push({ top: top, kids: [k] });
    });
    rows.forEach(function (row) {
      if (row.kids.length < 2) return;
      var hs = row.kids.map(function (k) { return k.getBoundingClientRect().height; });
      var maxH = Math.max.apply(null, hs);
      if (maxH > 320 && !row.kids.some(function (k) { return /sticky|fixed/.test(st(k).position); })) {
        var ch = row.kids.map(contentHeight);
        var mx = Math.max.apply(null, ch), mn = Math.min.apply(null, ch);
        if (mx > 320 && mn < mx * 0.4) hit('column-imbalance', el, '各栏内容高 ' + ch.map(Math.round).join(' / ') + 'px');
      }
      var cards = row.kids.filter(function (k) { return cardy(k, st(k), k.getBoundingClientRect()); });
      if (cards.length >= 2) {
        var chs = cards.map(function (k) { return k.getBoundingClientRect().height; });
        var cmax = Math.max.apply(null, chs), cmin = Math.min.apply(null, chs);
        if (cmin > 200 && (cmax - cmin) / cmax > 0.15) hit('uneven-row', el, '卡片高 ' + chs.map(Math.round).join(' / ') + 'px');
      }
    });
  });

  // ---------------------------------------- 5. 居中窄条、卡片右侧大块空白
  all.forEach(function (p) {
    if (skipped(p)) return;
    var pr = p.getBoundingClientRect();
    if (pr.width < 900 || !vis(p)) return;
    var kids = Array.prototype.filter.call(p.children, function (k) { var ps = st(k).position; return ps !== 'absolute' && ps !== 'fixed' && vis(k); });
    if (kids.length !== 1) return; // 只在唯一子块时判：多栏里的某一栏窄是排版，不是留白
    var el = kids[0];
    if (skipped(el) || el.matches('.semi-empty, [role="dialog"], button, a, span')) return;
    var r = el.getBoundingClientRect();
    if (r.height < 80) return;
    var pcs = st(p);
    var left = r.left - (pr.left + (parseFloat(pcs.paddingLeft) || 0));
    var right = (pr.right - (parseFloat(pcs.paddingRight) || 0)) - r.right;
    if (r.width < pr.width * 0.62 && left > 120 && Math.abs(left - right) < 12) hit('narrow-centered', el, Math.round(r.width) + ' / ' + Math.round(pr.width) + 'px');
  });
  all.forEach(function (el) {
    if (skipped(el)) return;
    var r = el.getBoundingClientRect();
    if (r.width < 700 || r.height < 200 || !cardy(el, st(el), r) || !vis(el)) return;
    var t = (el.innerText || '').replace(/\s+/g, '');
    if (t.length < 200) return;
    var rs = textRects(el, false);
    if (rs.length < 4 || lineCount(rs) < 4) return;
    var u = union(rs);
    if (r.right - u.right > 300 && (u.right - r.left) < r.width * 0.6) hit('narrow-content', el, '正文宽 ' + Math.round(u.right - r.left) + ' / 卡片 ' + Math.round(r.width) + 'px');
  });

  // ---------------------------------------- 6. 卡片套卡片
  var cardSet = new Set(all.filter(function (el) { return !skipped(el) && cardy(el, st(el), el.getBoundingClientRect()) && vis(el); }));
  cardSet.forEach(function (el) {
    var a = el.parentElement;
    for (var depth = 0; a && a !== document.body && depth < 6; depth++, a = a.parentElement) {
      if (cardSet.has(a)) { hit('card-in-card', el, '外层 ' + lastSeg(a)); return; }
    }
  });

  var findings = order.map(function (k) {
    var g = groups[k];
    return {
      severity: g.severity, kind: g.kind, sig: g.sig, count: g.count,
      message: MSG[g.kind] + '：' + g.sig + (g.extra ? '（' + g.extra + '）' : '') + (g.count > 1 ? ' ×' + g.count : '') + (g.whitelist ? ' · 白名单候选（待负责人确认）：' + g.whitelist : ''),
      sample: g.sample,
      whitelist: g.whitelist || undefined,
    };
  });
  return {
    findings: findings,
    stats: { layoutTextNodes: scanned, layoutSuppressed: suppressed, layoutMobile: MOBILE, viewport: VW + 'x' + VH, fontsReady: !document.fonts || document.fonts.status === 'loaded' },
  };
}

// Runtime.evaluate with returnByValue needs an EXPRESSION, hence the wrapping
// parens and the trailing call.
const source = '(' + pageChecks.toString() + ')()';

// 版面检查要等字体：Inter 没加载完时按回退字体量出的行宽、折行、居中全不可信。所以默认表达式
// 先等 document.fonts.ready（最多 3 秒，字体请求挂住也不卡死整轮），再同步跑检查。
// 自检在「注入 + 检查」必须同一次求值、中间不能让出（React 会重渲染撤回注入），所以另给同步版，
// 由调用方先单独等一次字体。
const layoutExpr = (opts) => '(async () => { try { await Promise.race([document.fonts ? document.fonts.ready : null, new Promise(function (r) { setTimeout(r, 3000); })]); } catch (e) {} return (' + layoutChecks.toString() + ')(' + JSON.stringify(opts || {}) + '); })()';
const layoutSyncExpr = (opts) => '(' + layoutChecks.toString() + ')(' + JSON.stringify(opts || {}) + ')';
const layoutSource = layoutExpr({});
const LAYOUT_KINDS = ['text-overflow', 'ellipsis-no-title', 'text-offscreen', 'token-split', 'off-center-x', 'off-center-y', 'label-wrapped',
  'line-too-long', 'line-too-short', 'column-imbalance', 'uneven-row', 'narrow-centered', 'narrow-content', 'card-in-card'];
const LAYOUT_WHITELIST_NOTE = [
  '版面检查的排除分两种。结构性排除（写在 SKIP_SEL，不需要确认）：通知角标、组织架构画布、富文本编辑区、',
  'Semi 浮层、横向滚动容器里的内容（QA 10/8 基线 §15 判为误报的三处即属此类）。白名单（WHITELIST）：',
  '设计如此的版面，每条写明理由；confirmed:false 的是候选，结果照报并注明理由，负责人确认后改为 true 才不再报。',
  '当前候选：九宫格格子、档案与职级设置的字段行与类型条、档案时间线事件卡（都是 card-in-card）。',
].join('');

const WHITELIST_NOTE = [
  'latin-in-zh runs only when <html lang> starts with "zh".',
  'Scope is UI chrome only: th, styled buttons (.semi-button/.btn/.icon-btn/',
  '.adm-exit), [placeholder], Semi select-placeholder / empty-description /',
  'tabs-tab, label + form-field-label, .adm-nav-item, .adm-nav-label, and page',
  'lead/section headings.',
  'Never scanned: td/.semi-table-row-cell, h1, card bodies, .pill, [aria-label],',
  'and card-shaped buttons (.pcard, .trev-emp, .um-item, .me-mile, ...).',
  'Reason: in this test database the DATA is English on purpose (department',
  '"Branch Operations Group", position "Data Analyst Manager", course "DigiPlus',
  'New Hire Orientation"), Semi puts icon NAMES in aria-label ("briefcase",',
  '"export", "user_add"), and this app renders clickable records as <button>, so',
  'a bare `button` selector reported 15 employee names on /admin/talent-review',
  'in a trial run. Scanning those turns the report into noise.',
  'Suppressed as legitimate Latin: employee/record ids (T-00001, DP-1001, LK-*),',
  'job levels (PD2/PV1/V4/O1), letter grades (A+), emails, urls, dates, clock',
  'times, numbers/percents/byte sizes, quarters (Q3/H2), ALL-CAPS acronyms of',
  '<=4 chars, words under 3 letters, and a proper-noun list verified against the',
  'zh dictionaries and lms.db (DigiPlus, Lark, HR, HRIS, AI, CSV, xlsx, Excel,',
  'Word, PPT, PDF, PNG, HTML, API, YouTube, 9-box, HiPo, High/Medium/Low, ...).',
].join(' ');

module.exports = { source, WHITELIST_NOTE, layoutSource, layoutExpr, layoutSyncExpr, LAYOUT_KINDS, LAYOUT_WHITELIST_NOTE };

// 手工注入用（替代 scripts/qa-layout-check.js 的做法）：
//   runtime\node.exe scripts\smoke-checks.js --print-layout > layout.js
// 得到一段自包含的表达式（先等字体再检查），可以贴进浏览器控制台或经 CDP Runtime.evaluate
// （awaitPromise:true）执行，返回 { findings, stats }，与 smoke.js --layout 同一套检查和阈值。
if (require.main === module) {
  if (process.argv.includes('--print-layout')) process.stdout.write(layoutSource + '\n');
  else if (process.argv.includes('--print-page')) process.stdout.write(source + '\n');
  else console.log('用法：smoke-checks.js --print-layout | --print-page（输出可注入页面的检查表达式）');
}
