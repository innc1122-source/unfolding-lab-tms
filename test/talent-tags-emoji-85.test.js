// F48 数据迁移 85（talent-tags-strip-emoji，负责人 2026-10-09 定：界面文字与标签不用 emoji）：
//   · users.talentTags 里每条标签去掉首尾 emoji 及相邻空白；清洗后与同一人已有标签重名的合并为一个；只剩 emoji 的去掉；
//     不带 emoji 的列表原样不动（哪怕本身有重复）。
//   · talent_filters 里「人才标签」条件（field = talentTag）的取值同样清洗，筛选版本号 +1。
//   · 有改动时写一条系统审计 talent.tags.strip-emoji（actorId / actorName 为空）；第二次执行不改数据、不写审计。
//   · 新库：演示员工的种子标签本身不带 emoji，迁移 85 无事可做、不写审计。
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { DatabaseSync } = require("node:sqlite");
const { startServer } = require("./helpers.js");

const withDb = (p, fn, readOnly = true) => { const d = new DatabaseSync(p, { readOnly }); try { return fn(d); } finally { d.close(); } };
const tagsOf = (d, id) => JSON.parse(d.prepare("SELECT talentTags FROM users WHERE id = ?").get(id).talentTags || "[]");
const auditRows = (d) => d.prepare("SELECT * FROM audit_logs WHERE action = 'talent.tags.strip-emoji' ORDER BY id").all();

test("migration 85: strips emoji from stored talent tags, merges duplicates, cleans tag filters, audits once, and is idempotent", async () => {
  const s1 = await startServer();
  const ids = ["u-f48-a", "u-f48-b", "u-f48-c"];
  try {
    withDb(s1.dbPath, (d) => {
      assert.ok(d.prepare("SELECT 1 FROM schema_migrations WHERE version = 85 AND name = 'talent-tags-strip-emoji'").get(), "migration 85 recorded");
      assert.deepEqual(tagsOf(d, "u-1001"), ["高潜 HiPo", "关键人才 Key talent"], "fresh database: demo tags seeded without emoji");
      assert.equal(auditRows(d).length, 0, "fresh database: nothing to clean, no audit row");
    });
    await s1.stopAsync();

    // 倒回到「旧库」：写入带 emoji 的标签与一条按标签筛选的保存筛选，删掉迁移 85 的记录
    const now = new Date().toISOString();
    const def = { v: 1, logic: "and", items: [{ id: "l1", field: "talentTag", op: "anyOf", value: ["🌟 高潜 HiPo", "高潜 HiPo", "Mobile"] }] };
    withDb(s1.dbPath, (d) => {
      const mk = d.prepare("INSERT INTO users (id, employeeId, name, role, passwordHash, createdAt) VALUES (?, ?, ?, 'employee', 'x', ?)");
      ids.forEach((id, i) => mk.run(id, "F48-" + i, "F48 " + i, now));
      const set = d.prepare("UPDATE users SET talentTags = ? WHERE id = ?");
      set.run(JSON.stringify(["🌟 高潜 HiPo", "高潜 HiPo", "🔑 关键人才 Key talent", "Mobile"]), "u-1001");
      set.run(JSON.stringify(["🎤 内部讲师 Internal trainer", "👍🏽", "Successor 🌟"]), ids[0]);
      set.run(JSON.stringify(["Plain", "Plain"]), ids[1]);
      set.run(JSON.stringify(["© Copyright team"]), ids[2]);
      d.prepare(`INSERT INTO talent_filters (id, name, name_zh, builtinKey, definition, columns, sort, visibility, ownerId, version, createdAt, updatedAt, updatedBy)
                 VALUES ('tf-f48', 'HiPo', '高潜', NULL, ?, '["name"]', NULL, 'shared', NULL, 3, ?, ?, NULL)`).run(JSON.stringify(def), now, now);
      d.prepare("DELETE FROM schema_migrations WHERE version = 85").run();
    }, false);

    const s2 = await startServer({ dbPath: s1.dbPath });
    await s2.stopAsync();
    let firstAudit;
    withDb(s1.dbPath, (d) => {
      assert.deepEqual(tagsOf(d, "u-1001"), ["高潜 HiPo", "关键人才 Key talent", "Mobile"], "stripped, and 「🌟 高潜 HiPo」 merged into the existing 「高潜 HiPo」");
      assert.deepEqual(tagsOf(d, ids[0]), ["内部讲师 Internal trainer", "Successor"], "leading and trailing emoji stripped; an emoji-only tag (with skin tone) is dropped");
      assert.deepEqual(tagsOf(d, ids[1]), ["Plain", "Plain"], "a list without emoji is left exactly as it was");
      assert.deepEqual(tagsOf(d, ids[2]), ["© Copyright team"], "© is a typographic symbol, not emoji");
      const f = d.prepare("SELECT definition, version FROM talent_filters WHERE id = 'tf-f48'").get();
      assert.deepEqual(JSON.parse(f.definition).items[0].value, ["高潜 HiPo", "Mobile"], "talent-tag filter values cleaned and merged");
      assert.equal(f.version, 4, "filter version bumped");
      const rows = auditRows(d);
      assert.equal(rows.length, 1, "one audit row");
      firstAudit = rows[0];
      assert.equal(firstAudit.actorId, null, "system actor");
      assert.equal(firstAudit.actorName, null, "system actor");
      const after = JSON.parse(firstAudit.afterJson);
      assert.deepEqual({ migration: after.migration, people: after.people, filters: after.filters, duplicatesMerged: after.duplicatesMerged },
        { migration: 85, people: 2, filters: 1, duplicatesMerged: 2 });
      assert.equal(after.renamed["🌟 高潜 HiPo"], "高潜 HiPo");
      assert.equal(after.renamed["👍🏽"], "");
    });

    // 再跑一次：没有带 emoji 的标签 → 不改数据、不写审计
    const snap = withDb(s1.dbPath, (d) => d.prepare("SELECT id, talentTags FROM users ORDER BY id").all().map((r) => ({ ...r })));
    withDb(s1.dbPath, (d) => d.prepare("DELETE FROM schema_migrations WHERE version = 85").run(), false);
    const s3 = await startServer({ dbPath: s1.dbPath });
    await s3.stopAsync();
    withDb(s1.dbPath, (d) => {
      assert.ok(d.prepare("SELECT 1 FROM schema_migrations WHERE version = 85").get(), "re-recorded");
      assert.deepEqual(d.prepare("SELECT id, talentTags FROM users ORDER BY id").all().map((r) => ({ ...r })), snap, "second run changes no tag");
      assert.equal(d.prepare("SELECT version FROM talent_filters WHERE id = 'tf-f48'").get().version, 4, "filter untouched on the second run");
      assert.deepEqual(auditRows(d).map((r) => r.id), [firstAudit.id], "no second audit row");
    });
  } finally {
    try { await s1.stopAsync(); } catch {}
  }
});
