// 第三批 5.6 课件查看人水印（2026-10-08）：watermark.js 纯函数；PdfViewer 把水印画进 canvas；
// 课程页所有视频走 WatermarkedVideo（不下载、不画中画、右键关闭、覆盖层不挡点击）。
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const WEB = path.join(__dirname, "..", "web", "src");
const read = (...p) => fs.readFileSync(path.join(WEB, ...p), "utf8");
const W = vm.runInNewContext(read("watermark.js").replace(/^export /gm, "") + "\n;({ watermarkText, tileGrid, localDay, WM_TILE_W, WM_TILE_H })", { Date, Math, Number, String, Map });

test("watermark text: name · employee ID · local date; without an ID it is name · date", () => {
  const d = new Date(2026, 9, 8, 23, 30);
  assert.equal(W.watermarkText({ name: "Ana Cruz", employeeId: "T-00012" }, d), "Ana Cruz · T-00012 · 2026-10-08");
  assert.equal(W.watermarkText({ name: "系统管理员", employeeId: "" }, d), "系统管理员 · 2026-10-08");
  assert.equal(W.watermarkText(null, d), "2026-10-08");
});

test("tile grid covers the rotated page with margin and staggers every second row", () => {
  for (const [w, h] of [[960, 540], [390, 220], [1600, 900]]) {
    const pts = W.tileGrid(w, h);
    const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
    const half = Math.sqrt(w * w + h * h) / 2;
    assert.ok(Math.min(...xs) <= -half && Math.max(...xs) >= half - W.WM_TILE_W, `${w}x${h} x span`);
    assert.ok(Math.min(...ys) <= -half && Math.max(...ys) >= half - W.WM_TILE_H, `${w}x${h} y span`);
    const rows = [...new Set(ys)];
    const firstX = (y) => Math.min(...pts.filter((p) => p[1] === y).map((p) => p[0]));
    assert.notEqual(firstX(rows[0]), firstX(rows[1]), "rows are offset");
  }
});

test("PdfViewer: identity from useAuth, watermark drawn right after page.render, opt-in prop; T dictionary", () => {
  const src = read("components", "PdfViewer.jsx");
  assert.match(src, /import \{ useAuth \} from '\.\.\/auth\.jsx';/);
  assert.match(src, /import \{ drawWatermark, watermarkText \} from '\.\.\/watermark\.js';/);
  assert.match(src, /await page\.render\(\{ canvasContext: ctx, viewport: vp \}\)\.promise;\r?\n\s*\/\/[^\n]*\r?\n\s*if \(wmRef\.current\) drawWatermark\(ctx, vp\.width \/ dpr, vp\.height \/ dpr, dpr, wmRef\.current\);/);
  assert.match(src, /export default function PdfViewer\(\{ url, note, media, watermark = false \}\)/);
  assert.match(src, /wmRef\.current = watermark \? watermarkText\(user\) : '';/);
  assert.match(src, /^const T = \{/m, "dictionary renamed to T so dict-pairs covers it");
  assert.doesNotMatch(src, /const PV = /);
});

test("Course page: every video is a WatermarkedVideo; PdfViewer gets media + watermark", () => {
  const src = read("pages", "Course.jsx");
  assert.doesNotMatch(src, /<video\b/, "no raw <video> on the learner course page");
  assert.match(src, /<WatermarkedVideo src=\{sec\.video\}/);
  assert.match(src, /<WatermarkedVideo src=\{href\}/);
  assert.match(src, /<PdfViewer url=\{href\} note=\{s\.viewOnly\} media=\{a\.slideMedia\} watermark \/>/);
});

test("WatermarkedVideo: no download / playback-rate / native fullscreen / PiP, context menu off, overlay is aria-hidden", () => {
  const src = read("components", "WatermarkedVideo.jsx");
  assert.match(src, /controlsList="nodownload noplaybackrate nofullscreen"/);
  assert.match(src, /disablePictureInPicture/);
  assert.match(src, /onContextMenu=\{\(e\) => e\.preventDefault\(\)\}/);
  assert.match(src, /<div className="wm-layer" aria-hidden="true"/);
  assert.match(src, /watermarkTile\(text, user && user\.id \? String\(user\.id\) : ''\)/, "tile cache keyed by user, not only by day");
  assert.match(src, /requestFullscreen/);
  // once G6 has appended the G5 CSS block, the overlay must not block clicks
  const css = fs.readFileSync(path.join(WEB, "app.css"), "utf8");
  const at = css.indexOf("第三批 B3-G5");
  if (at >= 0) assert.match(css.slice(at), /\.wm-layer\{[^}]*pointer-events:none/);
});
