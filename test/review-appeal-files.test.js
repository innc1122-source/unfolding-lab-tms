// 第二批 2.8（2026-10-08）绩效申诉的佐证材料（设计 §4.1 E5 / E6，§10.1 review-appeal-files；安全审查 #6、#8、#9，可行性审查 #13）。
//   · 按内容判定类型：PDF（允许 BOM）、PNG、JPG 收；SVG、DOCX、空文件、假 PDF、HTML 里夹 %PDF- 一律拒绝；
//   · 单个 10 MB 上限（413），24 小时内未绑定上传最多 10 个（429，并发上传同样守得住）；
//   · 未登录 401、临时密码 403、别人的项 404、期限已过 409（请求体还在传也能收到 JSON）；
//   · 未绑定的文件只有上传人能读；提交时用别人的文件 id → 400 且不建申诉；超过 5 个 → 400；
//   · 绑定后：申诉人与负责的 HRBP 200；征询人、监督、无关管理员、利益冲突的 HRBP 404；模块关闭 404。
"use strict";
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const W = require("./fixtures/appeal-world.js");
const { makeClient } = require("./helpers.js");

const NOW0 = "2026-10-09T10:00:00+08:00";
let w, Q;
const files = {};

const up = (eid, buf, name, item) => w.upload(eid, item || Q.items[eid], buf, name);
const expectErr = (r, status, code, msg) => {
  assert.equal(r.status, status, (msg || "") + " " + JSON.stringify(r.data));
  if (code) assert.equal(r.data.code, code, (msg || "") + " " + JSON.stringify(r.data));
};
const readAtt = async (eid, id) => (await (await w.as(eid)).raw("GET", "/api/attachments/" + id)).status;
const rows = (eid) => w.dbRead((d) => d.prepare("SELECT * FROM attachments WHERE ownerKind = 'review_appeal' AND uploadedBy = ?").all(w.id(eid)));

before(async () => {
  w = await W.bootWorld(new Date(NOW0).toISOString());
  await W.buildAppealWorld(w);
  await w.patch("H-A", { adminRoleId: w.roles.HRBP });           // HoD 同时是 HRBP：对 A 的申诉有利益冲突
  await w.cover("Dept A", ["HA", "H-A"]);
  await w.person("E-A2", "Ezra EmpA2", "Dept A", "M-A");
  await w.person("E-B2", "Elsa EmpB2", "Dept B", "M-B");
  Object.assign(w.managerOf, { "E-A2": "M-A", "E-B2": "M-B" });
  Object.assign(w.unitOf, { "E-A2": "Dept A", "E-B2": "Dept B" });
  Q = await w.runV2Cycle("2026Q3 Files", { "E-A": "B+", "E-A1": "B", "E-A2": "B", "E-B": "B", "E-B2": "B", "E-C": "B" });
});
after(async () => { if (w) await w.stop(); });

test("#1 PDF (with a BOM before %PDF-), PNG and JPG are accepted, typed by content; the stored name is a clean basename", async () => {
  const p = await up("E-A", W.PDF, "../../etc/证明材料.pdf");
  assert.equal(p.status, 200, JSON.stringify(p.data));
  assert.equal(p.data.ok, true);
  assert.equal(p.data.kind, "pdf");
  assert.equal(p.data.size, W.PDF.length);
  assert.equal(p.data.url, "/api/attachments/" + p.data.id);
  assert.match(p.data.id, /^att-/);
  assert.equal(p.data.name, "证明材料.pdf", "basename only");
  const g = await up("E-A", W.PNG, "screen.PNG");
  assert.equal(g.status, 200, JSON.stringify(g.data));
  assert.equal(g.data.kind, "image");
  // 扩展名不算数：JPG 内容起名 .pdf 也按图片收
  const j = await up("E-A", W.JPG, "photo.pdf");
  assert.equal(j.status, 200, JSON.stringify(j.data));
  assert.equal(j.data.kind, "image");
  const row = w.dbRead((d) => d.prepare("SELECT * FROM attachments WHERE id = ?").get(j.data.id));
  assert.equal(row.ownerKind, "review_appeal");
  assert.equal(row.ownerId, null, "unbound until submit");
  assert.equal(row.uploadedBy, w.id("E-A"));
  assert.match(row.storageKey, /\.jpg$/);
  // 控制字符与双向控制字符去掉（安全审查 #9）
  const n = await up("E-A", W.PNG, "a‮gnp.exe\u0001.png");
  assert.equal(n.status, 200);
  assert.ok(!/[\u0000-\u001f‪-‮⁦-⁩]/.test(n.data.name), JSON.stringify(n.data.name));
  Object.assign(files, { pdf: p.data.id, png: g.data.id, jpg: j.data.id, png2: n.data.id });
});

test("#2 SVG, DOCX, a fake .pdf and HTML with a %PDF- comment → 422 appeal_file_type; an empty body is rejected too", async () => {
  for (const [buf, name] of [[W.SVG, "x.svg"], [W.SVG, "x.png"], [W.DOCX, "x.docx"], [W.FAKE_PDF, "x.pdf"], [W.HTML_PDF, "x.pdf"]])
    expectErr(await up("E-A1", buf, name), 422, "appeal_file_type", name);
  const empty = await up("E-A1", Buffer.alloc(0), "empty.pdf");
  assert.ok([400, 422].includes(empty.status), JSON.stringify(empty.data));
  assert.equal(empty.data.code, "appeal_file_type");
  assert.equal(rows("E-A1").length, 0, "nothing stored");
});

test("#3 an 11 MB file → 413 appeal_file_too_large", async () => {
  const big = Buffer.concat([W.PDF, Buffer.alloc(11 * 1024 * 1024, 0x20)]);
  const r = await up("E-A1", big, "big.pdf").catch((e) => ({ status: "reset", data: String(e) }));
  assert.equal(r.status, 413, JSON.stringify(r.data));
  assert.equal(r.data.code, "appeal_file_too_large");
  assert.equal(rows("E-A1").length, 0);
});

test("#4 the 11th unattached upload within 24 h → 429; parallel uploads can't get past the limit", async () => {
  for (let i = 0; i < 10; i++) assert.equal((await up("E-C", W.PNG, `p${i}.png`)).status, 200, "upload " + i);
  expectErr(await up("E-C", W.PNG, "p10.png"), 429, "appeal_upload_rate");
  assert.equal(rows("E-C").length, 10);
  // 并发：12 个 1 MB 上传同时到达，库里最多 10 条，其余都是 429
  const body = Buffer.concat([W.PNG, Buffer.alloc(1024 * 1024, 0x41)]);
  const rs = await Promise.all(Array.from({ length: 12 }, (_, i) => up("E-A2", body, `c${i}.png`)));
  for (const r of rs) assert.ok(r.status === 200 || r.status === 429, JSON.stringify(r.data));
  for (const r of rs.filter((x) => x.status === 429)) assert.equal(r.data.code, "appeal_upload_rate");
  assert.ok(rows("E-A2").length <= 10, "at most 10 stored: " + rows("E-A2").length);
  assert.equal(rows("E-A2").length, rs.filter((x) => x.status === 200).length);
});

test("#5 401 without login; 403 password_change_required with a temporary password; 404 for someone else's item; 409 for an item that is not appealable", async () => {
  const anon = makeClient(w.base);
  const r = await anon.upload(`/api/me/reviews/appeal-files?item=${Q.items["E-B"]}&name=x.png`, W.PNG);
  assert.equal(r.status, 401, JSON.stringify(r.data));
  w.dbWrite((d) => d.prepare("UPDATE users SET mustChangePassword = 1 WHERE id = ?").run(w.id("E-B2")));
  try {
    expectErr(await up("E-B2", W.PNG, "x.png"), 403, "password_change_required");
  } finally { w.dbWrite((d) => d.prepare("UPDATE users SET mustChangePassword = 0 WHERE id = ?").run(w.id("E-B2"))); }
  const other = await up("E-B", W.PNG, "x.png", Q.items["E-A"]);
  assert.equal(other.status, 404, JSON.stringify(other.data));
  const nope = await up("E-B", W.PNG, "x.png", "ri-99999");
  assert.equal(nope.status, 404);
  assert.equal(rows("E-B").length, 0);
});

test("#6 an unattached file is readable only by its uploader", async () => {
  assert.equal(await readAtt("E-A", files.pdf), 200);
  for (const p of ["SA", "HA", "PT", "E-B", "M-A"]) assert.equal(await readAtt(p, files.pdf), 404, p);
});

test("#7 / #8 submit with another employee's file → 400 and no appeal row; more than 5 files → 400; duplicates → 400", async () => {
  const bFile = (await up("E-B", W.PNG, "b.png")).data.id;
  expectErr(await w.submit("E-A", Q.items["E-A"], { attachmentIds: [files.pdf, bFile] }), 400, "appeal_attachment", "foreign file");
  assert.equal(w.appealRow(Q.items["E-A"]), undefined, "no appeal created");
  assert.equal(w.dbRead((d) => d.prepare("SELECT ownerId FROM attachments WHERE id = ?").get(files.pdf)).ownerId, null, "own file stays unbound (whole batch rolled back)");
  expectErr(await w.submit("E-A", Q.items["E-A"], { attachmentIds: ["att-doesnotexist"] }), 400, "appeal_attachment", "unknown id");
  const six = [];
  for (let i = 0; i < 2; i++) six.push((await up("E-A", W.PNG, `s${i}.png`)).data.id);
  expectErr(await w.submit("E-A", Q.items["E-A"], { attachmentIds: [files.pdf, files.png, files.jpg, files.png2, ...six] }), 400, "appeal_attachment", "six files");
  expectErr(await w.submit("E-A", Q.items["E-A"], { attachmentIds: [files.pdf, files.pdf] }), 400, "appeal_attachment", "duplicate ids");
  assert.equal(w.appealRow(Q.items["E-A"]), undefined);
  // 5 个：成功
  const ok = await w.submit("E-A", Q.items["E-A"], { attachmentIds: [files.pdf, files.png, files.jpg, files.png2, six[0]] });
  assert.equal(ok.status, 201, JSON.stringify(ok.data));
  assert.equal(ok.data.appeal.attachments.length, 5);
  const apId = ok.data.appeal.id;
  w.apA = apId;
  assert.equal(w.dbRead((d) => d.prepare("SELECT COUNT(*) AS n FROM attachments WHERE ownerKind = 'review_appeal' AND ownerId = ?").get(apId)).n, 5);
  const au = w.audits("review.appeal.submit").find((a) => a.after.appealId === apId);
  assert.equal(au.after.attachments, 5);
  // 已绑定的文件不能再拿去提交别的申诉（E-A 的年度周期等没有；用 E-B 拿 E-A 已绑定的文件）
  expectErr(await w.submit("E-B", Q.items["E-B"], { attachmentIds: [files.pdf] }), 400, "appeal_attachment", "someone else's bound file");
  assert.equal(w.appealRow(Q.items["E-B"]), undefined);
});

test("#9 bound file: appellant and covering HRBP 200; consultee, oversight, LA, AU and a conflicted HRBP 404; module off 404", async () => {
  const id = files.pdf;
  assert.equal(await readAtt("E-A", id), 200, "appellant");
  assert.equal(await readAtt("HA", id), 200, "covering HRBP");
  const res = await (await w.as("HA")).raw("GET", "/api/attachments/" + id);
  assert.match(res.headers.get("cache-control") || "", /private/);
  assert.match(res.headers.get("cache-control") || "", /no-store/);
  assert.match(res.headers.get("content-security-policy") || "", /sandbox/, "served sandboxed (security #9)");
  assert.equal(Buffer.from(await res.arrayBuffer()).equals(W.PDF), true, "the bytes are the upload");
  // 征询人
  assert.equal((await w.admin.post(`/api/admin/review-appeals/${w.apA}/start`, {})).status, 403, "SA is oversight here");
  assert.equal((await (await w.as("HA")).post(`/api/admin/review-appeals/${w.apA}/start`, {})).status, 200);
  assert.equal((await (await w.as("HA")).post(`/api/admin/review-appeals/${w.apA}/consult`, { consulteeId: w.id("M-A") })).status, 200);
  for (const p of ["M-A", "SA", "AD", "PT", "PR", "PS", "HB", "LA", "AU", "P-EMP", "E-B", "H-A"]) assert.equal(await readAtt(p, id), 404, p);
  w.writeConfig({ modules: { performance: false } });
  try {
    assert.equal(await readAtt("E-A", id), 404, "appellant, module off");
    assert.equal(await readAtt("HA", id), 404, "HRBP, module off");
  } finally { w.writeConfig(null); }
  assert.equal(await readAtt("E-A", id), 200);
});

test("#5b after the deadline an upload gets 409 JSON even while a 2 MB body is still being sent", async () => {
  await w.restart(new Date("2026-10-17T09:00:00+08:00").toISOString());
  const body = Buffer.concat([W.PNG, Buffer.alloc(2 * 1024 * 1024, 0x42)]);
  const r = await up("E-B2", body, "late.png");
  assert.equal(r.status, 409, JSON.stringify(r.data));
  assert.equal(r.data.code, "appeal_window_closed");
});
