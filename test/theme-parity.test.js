// Theme-parity guards for the white-label pipeline. brand.colors from config
// is applied as inline CSS custom properties on document.documentElement, so
// a configured brand can only reach Semi components if every
// --semi-color-primary* / --semi-color-link* override in web/src/app.css is
// written as var(--token). These tests read app.css as text (no server, no
// build) and pin three facts:
//
//   1. :root default guard — the shipped ink-gold defaults --brand:#23304a and
//      --navy:#1b2438 (adopted 2026-08-26; the electric-blue originals now live
//      only in the config.json.example DigiPlus preset) stay byte-identical.
//      Changing a default is a product
//      decision made on purpose, never a side effect of a refactor.
//   2. pipeline guard — every --semi-color-primary*/--semi-color-link*
//      assignment is var(--...) form, and `html body` re-declares the COMPLETE
//      --semi-* set from :root with identical values (the re-declaration is
//      what outranks Semi's own body palette on load order, so dropping or
//      drifting even one prop — say -hover — snaps that state back to stock
//      Semi blue). One literal here silently disconnects white-labeling:
//      buttons/links/tables freeze on DigiPlus blue no matter what the config
//      says.
//   3. leak guard — the RETIRED DigiPlus family #2000f7 / #4a30ff / #1a00c9 /
//      #00c8ff / #181f32 must not appear anywhere in app.css, :root included
//      (case-insensitive); such spots must reference tokens.
//      Comment text is exempt, so a comment may quote a hex as an example.
//
// All scanning is done on a comment-blanked copy of the file (offsets and
// newlines preserved), so failures report real line numbers and comment
// examples can never trip a guard.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const APP_CSS = path.join(__dirname, "..", "web", "src", "app.css");
const raw = fs.readFileSync(APP_CSS, "utf8");

// Blank every /* ... */ comment with spaces, keeping newlines, so the text
// keeps its exact length: indexes and line numbers still match the file.
const css = raw.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));

const lineOf = (idx) => css.slice(0, idx).split("\n").length;

// Find every top-level `<selector>{...}` block for a selector regex, by brace
// matching from the block's opening brace. Returns [{from, open, close}]
// where from..close spans selector through closing brace inclusive.
function findBlocks(selectorRe) {
  const blocks = [];
  const re = new RegExp(selectorRe.source, "g");
  let m;
  while ((m = re.exec(css))) {
    const open = css.indexOf("{", m.index);
    if (open === -1) break;
    let depth = 0;
    let close = -1;
    for (let i = open; i < css.length; i++) {
      if (css[i] === "{") depth++;
      else if (css[i] === "}" && --depth === 0) {
        close = i;
        break;
      }
    }
    assert.ok(close > open, `unclosed block for ${selectorRe} in app.css`);
    blocks.push({ from: m.index, open, close });
    re.lastIndex = close;
  }
  return blocks;
}

// All declarations of one custom property inside a text span:
// returns the trimmed values, e.g. declsOf(text, "--brand") -> ["#23304a"].
// The [^\w-] left boundary keeps --brand from matching inside --brand-050.
function declsOf(text, prop) {
  const re = new RegExp(`(^|[^\\w-])${prop}\\s*:\\s*([^;}]*)`, "g");
  const out = [];
  let m;
  while ((m = re.exec(text))) out.push(m[2].trim());
  return out;
}

const rootBlocks = findBlocks(/(^|[^\w-]):root\s*\{/);
assert.ok(rootBlocks.length >= 1, "app.css has no :root block");
const rootText = rootBlocks
  .map((b) => css.slice(b.open + 1, b.close))
  .join("\n");

test(":root default guard — --brand stays #23304a and --navy stays #1b2438, byte-identical: the shipped ink-gold palette may only change by explicit decision, never as a refactor side effect", () => {
  const brand = declsOf(rootText, "--brand");
  const navy = declsOf(rootText, "--navy");
  assert.ok(brand.length >= 1, ":root no longer declares --brand");
  assert.ok(navy.length >= 1, ":root no longer declares --navy");
  assert.deepEqual(
    brand,
    brand.map(() => "#23304a"),
    `:root --brand drifted from #23304a: [${brand.join(", ")}]`
  );
  assert.deepEqual(
    navy,
    navy.map(() => "#1b2438"),
    `:root --navy drifted from #1b2438: [${navy.join(", ")}]`
  );
});

test("pipeline guard — every --semi-color-primary*/--semi-color-link* assignment in app.css is var(--...) form: one hard-coded literal disconnects brand.colors from Semi buttons/links/tables", () => {
  const re = /(^|[^\w-])(--semi-color-(?:primary|link)[\w-]*)\s*:\s*([^;}]*)/g;
  let found = 0;
  const bad = [];
  let m;
  while ((m = re.exec(css))) {
    found++;
    const value = m[3].trim();
    if (!/^var\(\s*--/.test(value)) {
      bad.push(`  line ${lineOf(m.index)}: ${m[2]}:${value}`);
    }
  }
  assert.ok(
    found > 0,
    "no --semi-color-primary*/--semi-color-link* assignments found at all — the Semi recolor block was removed, Semi falls back to its stock blue"
  );
  assert.deepEqual(
    bad,
    [],
    `literal Semi overrides break the white-label pipeline (must be var(--token)):\n${bad.join("\n")}`
  );
});

test("pipeline guard — `html body` re-declares the COMPLETE --semi-* set from :root with identical values: the re-declaration is what outranks Semi's own body palette on load order, so deleting the block, dropping one prop (e.g. -hover), or drifting a value snaps that state back to stock Semi blue", () => {
  const bodyBlocks = findBlocks(/(^|[^\w-])html\s+body\s*\{/);
  assert.ok(
    bodyBlocks.length >= 1,
    "app.css has no `html body` block — Semi's stylesheet loads after app.css and wins on `body`, so the :root overrides alone never reach Semi components"
  );
  const bodyText = bodyBlocks
    .map((b) => css.slice(b.open + 1, b.close))
    .join("\n");
  const semiProps = (text) => {
    const re = /(^|[^\w-])(--semi-[\w-]+)\s*:/g;
    const set = new Set();
    let m;
    while ((m = re.exec(text))) set.add(m[2]);
    return set;
  };
  const rootSet = semiProps(rootText);
  const bodySet = semiProps(bodyText);
  for (const prop of ["--semi-color-primary", "--semi-color-link"]) {
    assert.ok(rootSet.has(prop), `:root no longer declares ${prop}`);
  }
  const missing = [...rootSet].filter((p) => !bodySet.has(p));
  const extra = [...bodySet].filter((p) => !rootSet.has(p));
  assert.deepEqual(
    missing,
    [],
    `html body no longer re-declares [${missing.join(", ")}] — Semi's own body palette wins those props on load order and that state snaps back to stock Semi blue`
  );
  assert.deepEqual(
    extra,
    [],
    `html body declares [${extra.join(", ")}] that :root does not — the :root block is the documented palette; add the prop there too or the two copies drift`
  );
  const drift = [];
  for (const prop of rootSet) {
    const rootVals = declsOf(rootText, prop).join(" | ");
    const bodyVals = declsOf(bodyText, prop).join(" | ");
    if (rootVals !== bodyVals) {
      drift.push(`  ${prop}: :root has "${rootVals}" but html body has "${bodyVals}"`);
    }
  }
  assert.deepEqual(
    drift,
    [],
    `the html body Semi re-declaration drifted from :root (the two copies are one palette by design):\n${drift.join("\n")}`
  );
});

test("pipeline guard — every token referenced by a Semi override resolves in :root: a typo'd var() name computes to nothing and un-styles Semi in the default (no-config) theme", () => {
  const re = /(^|[^\w-])--semi-color-(?:primary|link)[\w-]*\s*:\s*(var\(\s*(--[\w-]+)[^;}]*)/g;
  const bad = [];
  let m;
  while ((m = re.exec(css))) {
    const token = m[3];
    if (declsOf(rootText, token).length === 0) {
      bad.push(`  line ${lineOf(m.index)}: references ${token}, not declared in :root`);
    }
  }
  assert.deepEqual(
    bad,
    [],
    `Semi overrides reference tokens that :root never defines:\n${bad.join("\n")}`
  );
});

test("STOCK parity guard — BrandSettings.jsx's STOCK map matches app.css :root for every core token: STOCK is what the brand-settings pickers/preview show as the un-configured default, so a drifted entry displays a palette the app does not actually ship (exactly how the retired electric blue survived the 2026-08-26 ink-gold flip on that page)", () => {
  const jsx = fs.readFileSync(
    path.join(__dirname, "..", "web", "src", "pages", "admin", "BrandSettings.jsx"),
    "utf8"
  );
  const m = jsx.match(/const STOCK = \{([\s\S]*?)\};/);
  assert.ok(m, "BrandSettings.jsx no longer declares `const STOCK = {...};` — if the fallback moved, move this guard with it");
  const entries = [...m[1].matchAll(/'(--[\w-]+)':\s*'([^']*)'/g)];
  assert.ok(entries.length >= 6, `STOCK parsed only ${entries.length} entries — expected the six core tokens`);
  const drift = [];
  for (const [, token, val] of entries) {
    const rootVals = declsOf(rootText, token);
    if (rootVals.length === 0) {
      drift.push(`  ${token}: in STOCK but never declared in app.css :root`);
    } else if (rootVals.some((v) => v.toLowerCase() !== val.toLowerCase())) {
      drift.push(`  ${token}: STOCK has "${val}" but :root has "${rootVals.join(" | ")}"`);
    }
  }
  assert.deepEqual(
    drift,
    [],
    `BrandSettings STOCK drifted from app.css :root (the pickers/preview would show defaults the app does not ship):\n${drift.join("\n")}`
  );
});

test("leak guard — the retired DigiPlus hex family (#2000f7/#4a30ff/#1a00c9/#00c8ff/#181f32) appears NOWHERE in app.css, :root included: since the 2026-08-26 ink-gold flip those colors live only in the config preset (comment examples exempt)", () => {
  // Since the ink-gold flip the retired family is banned file-wide — :root now
  // holds the new palette, so there is nothing to mask; comments are already
  // blanked, so a hex quoted in a comment cannot trip this.
  const outside = css;
  // Optional trailing [0-9a-f]{2} also catches the 8-digit alpha forms
  // (#2000f7cc etc.) — brand color with transparency is still a leak.
  const re = /#(?:2000f7|4a30ff|1a00c9|00c8ff|181f32)(?:[0-9a-f]{2})?\b/gi;
  const leaks = [];
  let m;
  while ((m = re.exec(outside))) {
    leaks.push(`  line ${lineOf(m.index)}: ${m[0]}`);
  }
  assert.deepEqual(
    leaks,
    [],
    `brand hex literals leaked outside :root — replace with var(--token) so white-label configs recolor them:\n${leaks.join("\n")}`
  );
});
