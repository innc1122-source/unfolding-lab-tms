// CX-166（10/11，3+3 勋章图丢失的宿主部分，契约 v39）：
//   每个模块一个数据目录 <附件目录>/_modules/<id>（或 LMS_MODULE_DATA_DIR/<id>），作为 services.dataDir；
//   serveModuleStatic 先查 <dataDir>/public/<相对路径>，存在就返回，否则读 modules/<id>/public/ 的原文件；防穿越不变。
"use strict";
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { startServer, tempDir } = require("./helpers.js");

let srv, overDir;
before(async () => {
  const dir = tempDir("cx166-");
  const cfg = path.join(dir, "config.json");
  fs.writeFileSync(cfg, JSON.stringify({ modules: { culture: true } }));   // 测试服务默认关闭 culture，挂载点要开着才有
  srv = await startServer({ dbPath: path.join(dir, "t.db"), env: { LMS_CONFIG_PATH: cfg } });
  overDir = path.join(path.dirname(srv.dbPath), "attachments", "_modules", "culture", "public", "badges");
  fs.mkdirSync(overDir, { recursive: true });
  fs.writeFileSync(path.join(overDir, "cx166-test.png"), Buffer.from("override-bytes"));
});
after(async () => { if (srv) await srv.stopAsync(); });



test("CX-166: the host passes services.dataDir to the module", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "kernel", "module-host.js"), "utf8");
  assert.match(src, /services\.dataDir = dd/);
  assert.match(fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8"), /moduleDataDir: \(id\) => moduleDataDir\(id\)/);
});
