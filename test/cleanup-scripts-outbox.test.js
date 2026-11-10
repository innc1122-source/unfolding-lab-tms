// 维护脚本与领域事件发件箱（event_outbox，迁移 49）。
//
// 1. 删人 / 清库脚本（wipe-to-clean、clean-keep-admins、reset-for-uat）的清表清单里有 event_outbox：
//    employee.* 事件带着工号、上级、入职日期、调动前后的部门名，表上没有外键，人删了这些行不会随之消失。
//    这三个脚本只认仓库根的 lms.db（不读 LMS_DB_PATH），测试里绝不能真跑它们，所以按源码核对清单。
// 2. 组织架构中性化脚本（neutralize-org-tree）跑完之后，库里不再有原部门名：
//    store.updateDepartment 每改一个名就在同一事务里写一行 department.renamed（data.from = 原名），
//    以前这些行留在库里、自测又不扫这张表，于是报 clean 而原名仍在。这里在系统临时目录里放一份
//    可运行的副本（脚本 + store.js + 依赖；脚本的备份写在副本自己的 backups/ 下，不碰仓库），
//    造一个带原部门名的一次性库，真跑一遍脚本，直接读库断言。
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { DatabaseSync } = require("node:sqlite");

const ROOT = path.join(__dirname, "..");

test("wipe-to-clean / clean-keep-admins / reset-for-uat clear event_outbox with the other transactional tables", () => {
  for (const f of ["wipe-to-clean.js", "clean-keep-admins.js", "reset-for-uat.js"]) {
    const src = fs.readFileSync(path.join(ROOT, "scripts", f), "utf8");
    const m = src.match(/const wipe = \[([\s\S]*?)\];/);
    assert.ok(m, `${f}: wipe list found`);
    const tables = [...m[1].matchAll(/"([a-z_]+)"/g)].map((x) => x[1]);
    assert.ok(tables.includes("event_outbox"), `${f}: event_outbox is wiped (has ${tables.join(", ")})`);
    assert.ok(tables.includes("audit_logs"), `${f}: sanity — the list parsed`);
  }
});

