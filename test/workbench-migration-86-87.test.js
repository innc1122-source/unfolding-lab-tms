// 12.2 工作台改版 迁移 86（结构）与 87（数据），设计 b12-design 第 6.1–6.3 节：
//   · 迁移 86 建 key_positions、talent_tag_events、workbench_snapshots 三张表（幂等）；
//   · 迁移 87 把存量标签里能映射到「高潜 / 关键人才 / 流失风险」的写法规范为 canonical 值、同一人重复的合并、映射不了的保留，
//     对持有受控标签却没有任何事件的 (人, 标签) 补一条 add 事件（source migration、操作人为空、effectiveOn 为空 = 日期不详），
//     已保存筛选里 talentTag 叶子的取值同样映射去重并 version + 1，有改动时写一条系统审计 talent.tags.controlled-map；
//   · 新库：演示种子在数据迁移之后写入 u-1001 的两个标签，随后补跑同一映射 → 2 条 migration 事件、1 条审计；
//   · 再执行一次不改数据、不写审计。
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { DatabaseSync } = require("node:sqlite");
const { startServer } = require("./helpers.js");

const withDb = (p, fn, readOnly = true) => { const d = new DatabaseSync(p, { readOnly }); try { return fn(d); } finally { d.close(); } };
const tagsOf = (d, id) => JSON.parse(d.prepare("SELECT talentTags FROM users WHERE id = ?").get(id).talentTags || "[]");
const auditRows = (d) => d.prepare("SELECT * FROM audit_logs WHERE action = 'talent.tags.controlled-map' ORDER BY id").all();
const eventsOf = (d, id) => d.prepare("SELECT * FROM talent_tag_events WHERE userId = ? ORDER BY tagKey").all(id).map((r) => ({ ...r }));
const tables = (d) => d.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('key_positions','talent_tag_events','workbench_snapshots') ORDER BY name").all().map((r) => r.name);

test("migrations 86 + 87: fresh database, then a rewound old database (map, merge, keep, rewrite filters, back-fill events, audit once), then idempotent", async () => {
  const s1 = await startServer();
  const ids = ["u-b12-a", "u-b12-b", "u-b12-c"];
  try {
    withDb(s1.dbPath, (d) => {
      assert.ok(d.prepare("SELECT 1 FROM schema_migrations WHERE version = 86 AND name = 'workbench-key-positions-tag-events'").get(), "migration 86 recorded");
      assert.ok(d.prepare("SELECT 1 FROM schema_migrations WHERE version = 87 AND name = 'talent-tags-controlled-map'").get(), "migration 87 recorded");
      assert.deepEqual(tables(d), ["key_positions", "talent_tag_events", "workbench_snapshots"], "the three new tables exist");
      assert.deepEqual(tagsOf(d, "u-1001"), ["高潜 HiPo", "关键人才 Key talent"], "demo tags already canonical: unchanged");
      const ev = eventsOf(d, "u-1001");
      assert.deepEqual(ev.map((e) => [e.tagKey, e.action, e.source, e.actorId, e.effectiveOn]), [["hipo", "add", "migration", null, null], ["key", "add", "migration", null, null]],
        "fresh database: two migration events for the demo employee (date unknown, system actor)");
      assert.equal(auditRows(d).length, 1, "fresh database: one system audit row");
      assert.equal(auditRows(d)[0].actorId, null);
    });
    await s1.stopAsync();

    // 倒回到「旧库」：删掉三张表与 86 / 87 的记录，写入各种写法的标签与一条按「HiPo」筛选的保存筛选
    const now = new Date().toISOString();
    const def = { v: 1, logic: "and", items: [{ id: "l1", field: "talentTag", op: "anyOf", value: ["HiPo", "高潜", "Mobile"] },
      { logic: "or", items: [{ id: "l2", field: "talentTag", op: "anyOf", value: ["Flight risk"] }] }] };
    withDb(s1.dbPath, (d) => {
      d.exec("DROP TABLE key_positions; DROP TABLE talent_tag_events; DROP TABLE workbench_snapshots; DELETE FROM schema_migrations WHERE version IN (86, 87); DELETE FROM audit_logs WHERE action = 'talent.tags.controlled-map';");
      const mk = d.prepare("INSERT INTO users (id, employeeId, name, role, passwordHash, createdAt) VALUES (?, ?, ?, 'employee', 'x', ?)");
      ids.forEach((id, i) => mk.run(id, "B12M-" + i, "B12 M " + i, now));
      const set = d.prepare("UPDATE users SET talentTags = ? WHERE id = ?");
      set.run(JSON.stringify(["HiPo", "高潜", "🌟 高潜 HiPo", "关键人才", "Flight risk", "高潜 HiPo（2025）"]), "u-1001");
      set.run(JSON.stringify(["Hi-Po", "离职风险", "骨干 Core performer"]), ids[0]);
      set.run(JSON.stringify(["高潜 HiPo", "Retention risk"]), ids[1]);   // 已是 canonical：不改写，但补事件
      set.run(JSON.stringify(["核心人才"]), ids[2]);                       // 映射不了：原样
      d.prepare(`INSERT INTO talent_filters (id, name, name_zh, builtinKey, definition, columns, sort, visibility, ownerId, version, createdAt, updatedAt, updatedBy)
                 VALUES ('tf-b12', 'HiPo', '高潜', NULL, ?, '["name"]', NULL, 'shared', NULL, 2, ?, ?, NULL)`).run(JSON.stringify(def), now, now);
    }, false);

    const s2 = await startServer({ dbPath: s1.dbPath });
    await s2.stopAsync();
    let firstAudit;
    withDb(s1.dbPath, (d) => {
      assert.deepEqual(tables(d), ["key_positions", "talent_tag_events", "workbench_snapshots"], "86 re-creates the tables");
      assert.deepEqual(tagsOf(d, "u-1001"), ["高潜 HiPo", "关键人才 Key talent", "流失风险 Flight risk", "高潜 HiPo（2025）"],
        "three spellings of HiPo merged into one canonical value (first position kept); 关键人才 / Flight risk mapped; 「高潜 HiPo（2025）」 kept as a free tag");
      assert.deepEqual(tagsOf(d, ids[0]), ["高潜 HiPo", "流失风险 Flight risk", "骨干 Core performer"], "Hi-Po and 离职风险 mapped; free tag kept");
      assert.deepEqual(tagsOf(d, ids[1]), ["高潜 HiPo", "Retention risk"], "canonical list untouched; Retention risk is not a controlled tag");
      assert.deepEqual(tagsOf(d, ids[2]), ["核心人才"], "unmappable tag kept");
      const ev = eventsOf(d, "u-1001");
      assert.deepEqual(ev.map((e) => [e.tagKey, e.action, e.source, e.effectiveOn, e.actorId]),
        [["flight", "add", "migration", null, null], ["hipo", "add", "migration", null, null], ["key", "add", "migration", null, null]]);
      assert.match(ev.find((e) => e.tagKey === "hipo").reason, /^存量标签纳入受控标签（原写法：HiPo、高潜、🌟 高潜 HiPo）$/, "reason lists the original spellings");
      assert.equal(eventsOf(d, ids[0]).length, 2);
      assert.equal(eventsOf(d, ids[1]).length, 1, "a canonical holder without events also gets one");
      assert.equal(eventsOf(d, ids[2]).length, 0);
      const f = d.prepare("SELECT definition, version FROM talent_filters WHERE id = 'tf-b12'").get();
      const fd = JSON.parse(f.definition);
      assert.deepEqual(fd.items[0].value, ["高潜 HiPo", "Mobile"], "filter leaf: HiPo and 高潜 mapped and merged, free value kept");
      assert.deepEqual(fd.items[1].items[0].value, ["流失风险 Flight risk"], "nested leaf mapped too");
      assert.equal(f.version, 3, "filter version bumped once");
      const rows = auditRows(d);
      assert.equal(rows.length, 1, "one audit row");
      firstAudit = rows[0];
      assert.equal(firstAudit.actorId, null, "system actor");
      const after = JSON.parse(firstAudit.afterJson);
      assert.deepEqual({ migration: after.migration, people: after.people, events: after.events, filters: after.filters }, { migration: 87, people: 2, events: 6, filters: 1 });
      assert.equal(after.renamed["Hi-Po"], "高潜 HiPo");
      assert.equal(after.renamed["Flight risk"], "流失风险 Flight risk");
    });

    // 再跑一次（删掉 87 的记录）：没有可映射的写法、持有者都有事件 → 不改数据、不写审计
    const snap = withDb(s1.dbPath, (d) => ({
      users: d.prepare("SELECT id, talentTags FROM users ORDER BY id").all().map((r) => ({ ...r })),
      events: d.prepare("SELECT count(*) n FROM talent_tag_events").get().n,
    }));
    withDb(s1.dbPath, (d) => d.prepare("DELETE FROM schema_migrations WHERE version = 87").run(), false);
    const s3 = await startServer({ dbPath: s1.dbPath });
    await s3.stopAsync();
    withDb(s1.dbPath, (d) => {
      assert.ok(d.prepare("SELECT 1 FROM schema_migrations WHERE version = 87").get(), "re-recorded");
      assert.deepEqual(d.prepare("SELECT id, talentTags FROM users ORDER BY id").all().map((r) => ({ ...r })), snap.users, "second run changes no tag");
      assert.equal(d.prepare("SELECT count(*) n FROM talent_tag_events").get().n, snap.events, "no new event");
      assert.equal(d.prepare("SELECT version FROM talent_filters WHERE id = 'tf-b12'").get().version, 3, "filter untouched on the second run");
      assert.deepEqual(auditRows(d).map((r) => r.id), [firstAudit.id], "no second audit row");
    });
  } finally {
    try { await s1.stopAsync(); } catch {}
  }
});
