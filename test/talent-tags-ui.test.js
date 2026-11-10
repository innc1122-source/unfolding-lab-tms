// 12.2 工作台改版 组 4 前端人才（设计 b12 §4 / §5 / §7.4 / §7.5；2026-10-09）：
// 关键岗位清单页、受控人才标签（高潜 / 关键人才 / 流失风险）的编辑与档案时间线、审计动作名、路由登记、继任卡入口。
// 不起浏览器、不打包：KeyPositions.jsx 的「导入解析纯函数」与 ControlledTags.jsx 的「受控标签适配纯函数」两段按源码截取后
// 直接跑（后者注入组 1 的 web/src/controlledTags.js）；rbac.js 用动态 import 直接调用；其余做源码断言。
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { pathToFileURL } = require("url");

const ROOT = path.join(__dirname, "..");
const WEB = path.join(ROOT, "web", "src");
const ADMIN = path.join(WEB, "pages", "admin");
const read = (...p) => fs.readFileSync(path.join(...p), "utf8").replace(/\r\n/g, "\n");
const KP = () => read(ADMIN, "KeyPositions.jsx");
const CTX = () => read(ADMIN, "ControlledTags.jsx");
const PEOPLE = () => read(ADMIN, "People.jsx");

// 两条注释标记之间的源码（无 import、无 JSX）
function block(src, a, b) {
  const i = src.indexOf(a), j = src.indexOf(b);
  assert.ok(i >= 0 && j > i, "marked block present: " + a);
  return src.slice(i, j).replace(/^export /gm, "");
}
// 页面词典按源码求值（与 dict-pairs 同法）
function dictOf(src) {
  const i = src.indexOf("const T = {");
  const end = src.indexOf("\n};", i);
  return vm.runInNewContext("(" + src.slice(i + "const T = ".length, end + 2) + ")", { Math, Number, String });
}

async function controlledAdapter() {
  const CT = await import(pathToFileURL(path.join(WEB, "controlledTags.js")).href);
  const src = block(CTX(), "// ---- 受控标签适配纯函数", "// ---- /受控标签适配纯函数 ----");
  const ctx = vm.createContext({ ...CT });
  vm.runInContext(src + "\n;this.api = { reservedKeyOf, splitTags, canonicalValues, tagName };", ctx);
  return ctx.api;
}

/* ---------------- 路由与入口 ---------------- */

test("key positions: the page is routed inside the talent switch and registered in ADMIN_PAGES (nav:false, talent domain)", async () => {
  const app = read(WEB, "App.jsx");
  assert.match(app, /const KeyPositions = lazy\(\(\) => import\('\.\/pages\/admin\/KeyPositions\.jsx'\)\);/);
  assert.match(app, /\{on\('talent'\) && <Route path="talent-review\/key-positions" element=\{<KeyPositions \/>\} \/>\}/);
  const rbac = await import(pathToFileURL(path.join(WEB, "rbac.js")).href);
  const page = rbac.findAdminPage("/admin/talent-review/key-positions");
  assert.ok(page, "findAdminPage knows the key positions page");
  assert.equal(page.path, "/admin/talent-review/key-positions");
  assert.equal(page.module, "talent");
  assert.equal(page.domain, "talent");
  assert.equal(page.nav, false, "no sidebar entry; reached from the succession card");
  assert.ok(!rbac.navPages("performance").some((p) => p.path === "/admin/talent-review/key-positions"), "not listed in the sidebar");
});

test("key positions: the succession card offers the entry next to Import, for every talent reader", () => {
  const tr = read(ADMIN, "TalentReview.jsx");
  const card = tr.slice(tr.indexOf("function SuccessionCard("));
  const head = card.slice(0, card.indexOf("{/* 新增继任条目"));
  assert.match(head, /navigate\('\/admin\/talent-review\/key-positions'\)/, "entry button in the card header");
  assert.doesNotMatch(head.slice(0, head.indexOf("key-positions")), /\{canEdit && \(\s*<Button[^]*key-positions/, "the entry is not hidden behind talent write");
  const d = dictOf(tr);
  assert.equal(d.zh.scKeyPositions, "关键岗位清单");
  assert.equal(d.en.scKeyPositions, "Key positions");
});

/* ---------------- 审计动作名 ---------------- */

test("audit labels: controlled-tag and key-position actions have Chinese and English labels", () => {
  const src = read(ADMIN, "Audit.jsx");
  const want = {
    "talent.tag.add": ["打上受控标签", "Add controlled talent tag"],
    "talent.tag.remove": ["取消受控标签", "Remove controlled talent tag"],
    "talent.tags.controlled-map": ["存量标签纳入受控标签", "Map existing tags to controlled talent tags"],
    "keyposition.create": ["新增关键岗位", "Add key position"],
    "keyposition.update": ["更新关键岗位", "Update key position"],
    "keyposition.delete": ["删除关键岗位", "Delete key position"],
    "keyposition.import": ["批量导入关键岗位", "Import key positions"],
  };
  for (const [a, [zh, en]] of Object.entries(want)) {
    const re = new RegExp("^\\s*'" + a.replace(/\./g, "\\.") + "': \\{ zh: '" + zh + "', en: '" + en + "', color: '(green|amber|red|blue|grey)' \\},$", "m");
    assert.match(src, re, a);
  }
});

/* ---------------- 关键岗位页 ---------------- */

function kpPure() {
  const src = block(KP(), "// ---- 导入解析纯函数", "// ---- /导入解析纯函数 ----");
  const ctx = vm.createContext({ KP_MAX_ROWS: 1000 });
  vm.runInContext(src + "\n;this.api = { kpParseGrid, kpPayloadRows, rowsFromSuccession, posKey, readyN, isKeyRow, KP_TEMPLATE_HEADERS };", ctx);
  return ctx.api;
}

test("key positions import: the template header is recognized, rows keep Excel line numbers, blanks are skipped", () => {
  const { kpParseGrid, KP_TEMPLATE_HEADERS } = kpPure();
  const out = kpParseGrid([
    [...KP_TEMPLATE_HEADERS],
    ["Team Lead - Sales", "Sales", "是", "华南区"],
    ["", "", "", ""],
    [" Finance Manager ", "Finance", "", ""],
  ]);
  assert.equal(out.headerCols, 4);
  assert.equal(out.overCap, false);
  assert.deepEqual(JSON.parse(JSON.stringify(out.rows)), [
    { line: 2, name: "Team Lead - Sales", dept: "Sales", deptId: "", isKey: "是", note: "华南区" },
    { line: 4, name: "Finance Manager", dept: "Finance", deptId: "", isKey: "", note: "" },
  ]);
});

test("key positions import: English or reordered headers map by meaning; no header falls back to the template column order", () => {
  const { kpParseGrid } = kpPure();
  const a = kpParseGrid([["Notes", "Department", "Position", "Key (Y/N)"], ["n1", "HR", "HRBP Lead", "N"]]);
  assert.deepEqual(JSON.parse(JSON.stringify(a.rows[0])), { line: 2, name: "HRBP Lead", dept: "HR", deptId: "", isKey: "N", note: "n1" });
  const b = kpParseGrid([["HRBP Lead", "HR", "1", "x"]]);
  assert.equal(b.headerCols, 0);
  assert.deepEqual(JSON.parse(JSON.stringify(b.rows[0])), { line: 1, name: "HRBP Lead", dept: "HR", deptId: "", isKey: "1", note: "x" });
});

test("key positions import: over 1,000 data rows is flagged, not truncated", () => {
  const { kpParseGrid } = kpPure();
  const grid = [["岗位名称", "所属部门"]];
  for (let i = 0; i < 1001; i++) grid.push(["P" + i, "D"]);
  const out = kpParseGrid(grid);
  assert.equal(out.rows.length, 1001);
  assert.equal(out.overCap, true);
});

test("key positions: bring-in rows from succession accept names or objects; payload carries only the agreed fields", () => {
  const { rowsFromSuccession, kpPayloadRows } = kpPure();
  const rows = rowsFromSuccession(["Plant Manager", { name: "Head of Risk", deptId: "d-9", deptName: "Risk" }, "", { positionName: "CFO" }]);
  assert.deepEqual(JSON.parse(JSON.stringify(rows)), [
    { line: 1, name: "Plant Manager", dept: "", deptId: "", isKey: "", note: "" },
    { line: 2, name: "Head of Risk", dept: "Risk", deptId: "d-9", isKey: "", note: "" },
    { line: 4, name: "CFO", dept: "", deptId: "", isKey: "", note: "" },
  ]);
  const p = kpPayloadRows([{ line: 3, name: "A", dept: "B", isKey: undefined, note: null, extra: 1 }]);
  assert.deepEqual(JSON.parse(JSON.stringify(p)), [{ line: 3, name: "A", dept: "B", deptId: "", isKey: "", note: "" }]);
});

test("key positions: successors are matched by the same position key as the server (filter-model positionKey)", () => {
  const { posKey, readyN, isKeyRow } = kpPure();
  const { positionKey } = require(path.join(ROOT, "modules", "talent", "filter-model.js"));
  for (const s of ["Team Lead - Sales", "team  lead–sales", "ＴＥＡＭ ＬＥＡＤ", "Head‐of−Risk", "CFO", "", "A_B"]) assert.equal(posKey(s), positionKey(s), s);
  assert.equal(readyN({ coverage: { ready: 1, oneYear: 2, twoYears: 5, total: 8 } }), 3, "ready within 1 year = ready + oneYear");
  assert.equal(isKeyRow({ isKey: 0 }), false);
  assert.equal(isKeyRow({ isKey: 1 }), true);
});

test("key positions page: CRUD, import (preview then confirm, stale re-preview) and bring-in use the designed endpoints; writes need talent write", () => {
  const src = KP();
  assert.match(src, /api\.get\('\/api\/admin\/key-positions'\)/);
  assert.match(src, /api\.post\('\/api\/admin\/key-positions', body\)/);
  assert.match(src, /api\.put\(`\/api\/admin\/key-positions\/\$\{form\.id\}`, body\)/);
  assert.match(src, /api\.del\(`\/api\/admin\/key-positions\/\$\{r\.id\}`\)/);
  assert.match(src, /api\.post\('\/api\/admin\/key-positions\/import\/preview', \{ rows: kpPayloadRows\(rows\), source \}\)/);
  assert.match(src, /api\.post\('\/api\/admin\/key-positions\/import', \{ rows: kpPayloadRows\(imp\.rows\), source: imp\.source, previewHash: preview\.previewHash \}\)/);
  assert.match(src, /err\.status === 409 && code === 'preview_stale'[^]*?runPreview\(imp\.rows, imp\.source\)/, "a stale preview is re-run automatically");
  assert.match(src, /err\.status === 409 && d\.code === 'position_exists'/, "duplicate position names are reported, with a jump to the existing row");
  assert.match(src, /dept_out_of_scope/);
  assert.match(src, /import \{ succSplitCsv, succSheetGrid, succSummary, SUCC_READINESS_TEXT \} from '\.\/successionImport\.js';/, "reuses the succession import readers");
  assert.match(src, /const SCOPE_CODES = \['dept_out_of_scope', 'position_out_of_scope'\];/, "either scope code blocks the whole import");
  assert.match(src, /rowsFromSuccession\(succRows \|\| unmatched\)/, "server-filled bring-in rows (department from incumbents) are preferred");
  assert.match(src, /source: 'succession'/, "bring-in from succession plans goes through the same preview");
  assert.match(src, /unmatchedSuccessionPositions/);
  assert.match(src, /const canWrite = canWriteDomain\(user, 'talent'\);/);
  assert.match(src, /\{canWrite && \(\s*<span className="u-filterbar-end"[^]*?openFromSucc[^]*?openFileImport[^]*?openAdd/, "Add / Import / Bring in only for talent write");
  assert.match(src, /\.\.\.\(canWrite \? \[\{ title: s\.colOps/, "edit / delete column only for talent write");
  assert.match(src, /\{!canWrite && <ReadOnlyPill tip=\{s\.roTip\} \/>\}/, "read-only pill right of the title");
  assert.match(src, /\{\.\.\.resizableTable\(dataTableColumns\(columns, \{ titleKey: 'name', opsKey: 'ops' \}\), \{ extra: 48 \}\)\}/, "cardified on phones, no sideways scrolling (DataTable column rules, 2026-10-10)");
  const d = dictOf(src);
  assert.equal(d.zh.title, "关键岗位清单");
  assert.equal(d.zh.fromSucc, "从继任计划带入");
  assert.equal(d.en.fromSucc, "Bring in from succession plans");
});

test("key positions import: every validation code of modules/talent/key-positions.js has zh / en text, with its level", () => {
  const KPL = require(path.join(ROOT, "modules", "talent", "key-positions.js"));
  const src = KP();
  const i = src.indexOf("const KP_CODE_TEXT = {");
  const lit = src.slice(i + "const KP_CODE_TEXT = ".length, src.indexOf("\n};", i) + 2);
  const text = vm.runInNewContext("(" + lit + ")", { NAME_MAX: 80, NOTE_MAX: 300 });
  for (const code of Object.keys(KPL.CODES)) {
    assert.ok(text.zh[code] && /[一-鿿]/.test(text.zh[code]), "zh: " + code);
    assert.ok(text.en[code] && !/[一-鿿]/.test(text.en[code]), "en: " + code);
  }
  assert.deepEqual(Object.keys(text.zh).sort(), Object.keys(text.en).sort());
  const info = Object.keys(KPL.CODES).filter((c) => KPL.CODES[c] === "info");
  assert.match(src, new RegExp("const KP_INFO_CODES = " + JSON.stringify(info).replace(/"/g, "'").replace(/[[\]]/g, "\\$&") + ";"), "info codes match the library");
});

test("key positions import: rows parsed in the browser are exactly what validateRows expects", () => {
  const KPL = require(path.join(ROOT, "modules", "talent", "key-positions.js"));
  const { kpParseGrid, kpPayloadRows, KP_TEMPLATE_HEADERS } = kpPure();
  const parsed = kpParseGrid([[...KP_TEMPLATE_HEADERS], ["team lead sales", "Sales", "否", ""], ["New Role", "Ops", "", "n"], ["New Role", "Ops", "", ""]]);
  const depts = { Sales: { id: "d-s", name: "Sales" }, Ops: { id: "d-o", name: "Ops" } };
  const out = KPL.validateRows(JSON.parse(JSON.stringify(kpPayloadRows(parsed.rows))), {
    resolveDept: (t) => depts[t] || null,
    deptAllows: () => true,
    existing: [{ id: "kp-1", name: "Team Lead - Sales", deptId: "d-s", deptName: "Sales", isKey: 1, note: "" }],
  });
  const byLine = Object.fromEntries(out.rows.map((r) => [r.line, r]));
  assert.equal(byLine[2].action, "update");
  assert.equal(byLine[2].name, "Team Lead - Sales");
  assert.ok(byLine[2].codes.some((c) => c.code === "name_merged" && c.level === "info"));
  assert.equal(byLine[3].action, "create");
  assert.deepEqual(byLine[4].codes.map((c) => c.code), ["dup_in_file"]);
  assert.equal(out.summary.create, 1);
});

/* ---------------- 受控标签 ---------------- */

test("controlled tags: any spelling of the three tags maps to its key through controlledTags.js; other tags stay free", async () => {
  const { reservedKeyOf } = await controlledAdapter();
  const want = {
    hipo: ["高潜 HiPo", "高潜", "HiPo", "Hi-Po", "High potential", "HiPo 高潜", "高潜力"],
    key: ["关键人才 Key talent", "关键人才", "Key talent", "Key Talents"],
    flight: ["流失风险 Flight risk", "流失风险", "Flight risk", "离职风险"],
  };
  for (const [k, list] of Object.entries(want)) for (const t of list) assert.equal(reservedKeyOf(t), k, t);
  for (const t of ["继任候选 Successor", "核心人才", "Retention risk", "高潜 HiPo（2025）", "", null]) assert.equal(reservedKeyOf(t), null, String(t));
});

test("controlled tags: split gives held controlled values as canonical (any spelling) and keeps free tags in order; names follow the design table", async () => {
  const { splitTags, canonicalValues, tagName } = await controlledAdapter();
  const canon = canonicalValues();
  assert.deepEqual([...canon], ["高潜 HiPo", "关键人才 Key talent", "流失风险 Flight risk"]);
  const sp = splitTags(["继任候选 Successor", "流失风险 Flight risk", "骨干", "高潜 HiPo"]);
  assert.deepEqual([...sp.controlled], ["高潜 HiPo", "流失风险 Flight risk"]);
  assert.deepEqual([...sp.free], ["继任候选 Successor", "骨干"]);
  // 迁移前的写法：持有判定与服务端 heldKeysOf 一致，保存时带回 canonical 值（PUT 的受控集合与当前一致）
  const old = splitTags(["HiPo", "核心人才"]);
  assert.deepEqual([...old.controlled], ["高潜 HiPo"]);
  assert.deepEqual([...old.free], ["核心人才"]);
  assert.deepEqual(JSON.parse(JSON.stringify(splitTags(undefined))), { controlled: [], free: [] });
  assert.deepEqual(["hipo", "key", "flight"].map((k) => tagName(k, "zh")), ["高潜", "关键人才", "流失风险"]);
  assert.deepEqual(["hipo", "key", "flight"].map((k) => tagName(k, "en")), ["High potential", "Key talent", "Flight risk"]);
});

test("controlled tags editor: preset toggles only, a 4–300 character reason in a modal, posted to the controlled-tags endpoint", () => {
  const src = CTX();
  assert.match(src, /import \{[^}]*\bkeyOf\b[^}]*\breasonOf\b[^}]*\} from '\.\.\/\.\.\/controlledTags\.js';/, "the whitelist and the reason rule come from group 1's mirror");
  for (const v of ["高潜 HiPo", "关键人才 Key talent", "流失风险 Flight risk", "Hi-Po", "highpotential"]) assert.ok(!src.includes(v), "no whitelist copy: " + v);
  assert.doesNotMatch(src, /allowCreate/, "no free text entry for controlled tags");
  assert.match(src, /const reasonErr = reasonOf\(reason\) \? '' : len < REASON_MIN \? s\.reasonShort : s\.reasonLong;/, "4–300 characters, judged by controlledTags reasonOf");
  assert.match(src, /maxCount=\{REASON_MAX\}/, "live character count");
  assert.match(src, /disabled=\{!!reasonErr\} onClick=\{submit\}/, "confirm stays disabled until the reason is valid");
  assert.match(src, /api\.post\(`\/api\/admin\/employees\/\$\{encodeURIComponent\(userId\)\}\/controlled-tags`, \{ tag: ask\.key, action: ask\.action, reason: reasonOf\(reason\) \}\)/);
  assert.match(src, /if \(!canWrite\) \{\s*return <div className="ppl-id-tags"><ControlledTagPills/, "read-only roles see pills, not toggles");
  assert.match(src, /hideFlight && k === 'flight'/);
  const d = dictOf(src);
  assert.equal(d.zh.tlDateUnknown, "打标日期不详（存量标签）");
  assert.equal(d.zh.addTitle("高潜"), "打上受控标签：高潜");
  assert.equal(d.zh.removeTitle("流失风险"), "取消受控标签：流失风险");
});

test("profile: free-tag picker excludes controlled values and blocks reserved spellings; saving carries the current controlled values", () => {
  const src = PEOPLE();
  const preset = JSON.parse(JSON.stringify(vm.runInNewContext(src.match(/const PRESET_TAGS = (\[[^\]]*\]);/)[1])));
  assert.deepEqual(preset, ["继任候选 Successor"], "controlled values are no longer free presets");
  assert.match(src, /import \{[^}]*ControlledTagsEditor[^}]*\} from '\.\/ControlledTags\.jsx';/);
  assert.match(src, /talentTags: splitTags\(u\.talentTags\)\.free,/, "the free-tag field starts without controlled values");
  assert.match(src, /body\.talentTags = \[\.\.\.ctl, \.\.\.form\.talentTags\];/, "PUT carries the controlled values unchanged");
  assert.match(src, /\.filter\(\(x\) => !reservedKeyOf\(x\)\)/, "a reserved spelling cannot be created as a free tag");
  assert.match(src, /onSearch=\{\(v\) => setTagHint\(!!reservedKeyOf\(v\)\)\}/, "typing a reserved spelling shows the hint at once");
  assert.match(src, /<ControlledTagsEditor userId=\{u\.id\} tags=\{ctl\} canWrite hideFlight=\{selfView\}/, "edit page: controlled section");
  assert.match(src, /\{talentWrite && \(\s*<ControlledTagsEditor userId=\{u\.id\} tags=\{u\.talentTags\} canWrite hideFlight=\{selfView\}/, "profile: talent writers without people write can still tag");
  assert.match(src, /<ControlledTagPills tags=\{u\.talentTags\} hideFlight=\{selfView\} \/>/, "identity row: controlled pills first");
  assert.match(src, /const selfView = !!\(me && String\(me\.id\) === String\(id\) && !isSuperAdmin\(me\)\);/, "own profile hides flight risk");
});

test("profile timeline: tag events render with title, reason and actor, no edit / delete, unknown dates, and their own filter chip", () => {
  const src = PEOPLE();
  assert.match(src, /if \(e\.source === 'tag'\) return <TagEventBody e=\{e\} \/>;/);
  assert.match(src, /e\.source === 'tag' \? tagEventTitle\(e, lang\) : \(loc\(e, 'title'\) \|\| loc\(t, 'label'\)\)/);
  assert.match(src, /e\.source === 'tag'\s*\? null/, "tag events have no edit / delete");
  assert.match(src, /e\.dateUnknown \? ctS\.tlDateUnknown : e\.date/);
  assert.match(src, /hasTagEvents && \(/, "the talent-tag chip appears only when such events exist");
  assert.match(src, /!\(selfView && e\.source === 'tag' && e\.tagKey === 'flight'\)/, "own profile never shows flight-risk events");
});

test("line-manager view: the report profile never shows the flight-risk tag", () => {
  const src = read(WEB, "pages", "ReportProfile.jsx");
  assert.match(src, /import \{ keyOf \} from '\.\.\/controlledTags\.js';/);
  const tags = src.match(/const shownTags = (.+);/);
  assert.ok(tags, "the tag list is filtered once, before rendering");
  assert.equal(tags[1], "(u.talentTags || []).filter((t) => keyOf(t) !== 'flight')");
  assert.doesNotMatch(src, /u\.talentTags\.map/, "nothing renders the unfiltered list");
});
