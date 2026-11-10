// LibreOffice 的探测列表在三个文件里各有一份拷贝：server.js（权威实现）、
// scripts/convert-office-attachments.js（存量附件批量转换）、以及本目录的
// attachments.test.js（决定那条转换测试跑还是跳过）。三份之间没有共享模块 ——
// 这个项目是零依赖的，server 端和 scripts 不互相 require 这段逻辑。
//
// 为什么要专门写个测试盯着它们：一旦漂移，症状是**一个什么都没坏的红测试**，
// 而且只在特定机器上红。真实场景是 WOW64（32 位 node 进程跑在 64 位 Windows）：
// 那时 ProgramFiles 与 ProgramFiles(x86) 都指向 C:\Program Files (x86)，
// 而 64 位 LibreOffice 装在 C:\Program Files。如果 attachments.test.js 里多留一条
// 无条件的 "C:\Program Files\LibreOffice\..." 字面值，它就会认定「本机有转换器」→
// 不跳过 → 但 server.js 在同一环境下探不到 → 上传的 office 文件退化成下载 →
// assert kind === "pdf" 失败。排查的人会去查附件上传，而真正的问题在探测顺序。
//
// 反过来（环境被清干净、两个变量都没有、LibreOffice 只装在 (x86) 下）则是
// 静默丢覆盖：server 转得动，批量脚本却说 not found 并退出。
//
// 所以断言的不是「差不多一致」，而是这几行逐字一致，外加那条曾经真出过问题的
// 无条件字面值必须不存在。
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const FILES = {
  "server.js": path.join(ROOT, "server.js"),
  "scripts/convert-office-attachments.js": path.join(ROOT, "scripts", "convert-office-attachments.js"),
  "test/attachments.test.js": path.join(__dirname, "attachments.test.js"),
};

// 必须逐字出现在三份里的行（去掉首尾空白后比较，缩进不同没关系）。
const REQUIRED = [
  'const progDirs = [process.env.ProgramFiles, process.env["ProgramFiles(x86)"]].filter(Boolean);',
  'const winDirs = progDirs.length ? progDirs : ["C:\\\\Program Files", "C:\\\\Program Files (x86)"];',
  '...winDirs.map((d) => path.join(d, "LibreOffice", "program", "soffice.exe")),',
];

// 兜底字面值只允许出现在 winDirs 那一行里（且必须成对：少了 (x86) 就是上面第二种漏覆盖）。
const BARE_LITERAL = /"C:\\\\Program Files(?: \(x86\))?\\\\LibreOffice/;

const POSIX_ORDER = [
  "/usr/bin/soffice",
  "/usr/bin/libreoffice",
  "/opt/libreoffice/program/soffice",
  "/opt/homebrew/bin/soffice",
  "/Applications/LibreOffice.app/Contents/MacOS/soffice",
];

const linesOf = (p) => fs.readFileSync(p, "utf8").split(/\r?\n/).map((l) => l.trim());

test("all three soffice probes share the same env-derived Windows lines", () => {
  for (const [label, file] of Object.entries(FILES)) {
    const lines = linesOf(file);
    for (const want of REQUIRED) {
      assert.ok(
        lines.includes(want),
        `${label} is missing this line verbatim (the three probes must stay identical):\n  ${want}`,
      );
    }
  }
});

test("no probe keeps an unconditional C:\\Program Files literal", () => {
  for (const [label, file] of Object.entries(FILES)) {
    const offenders = linesOf(file).filter((l) => BARE_LITERAL.test(l) && !l.startsWith("const winDirs"));
    assert.deepEqual(
      offenders, [],
      `${label} pins a hard-coded LibreOffice path outside the winDirs fallback. ` +
      "On WOW64 this makes the probe disagree with server.js and produces a red test with nothing broken.",
    );
  }
});

test("LMS_SOFFICE outranks every guess, and the posix order matches", () => {
  for (const [label, file] of Object.entries(FILES)) {
    const lines = linesOf(file);
    const envAt = lines.findIndex((l) => l.startsWith("process.env.LMS_SOFFICE,"));
    const winAt = lines.findIndex((l) => l.startsWith("...winDirs.map("));
    assert.ok(envAt >= 0, `${label} does not list process.env.LMS_SOFFICE first in its candidates`);
    assert.ok(envAt < winAt, `${label} probes Program Files before LMS_SOFFICE — explicit config must win`);

    // 五条 posix 路径的相对顺序也要一致：它决定同时装了多份时用哪一个。
    const found = POSIX_ORDER.filter((p) => lines.some((l) => l.includes(`"${p}"`)));
    assert.deepEqual(found, POSIX_ORDER, `${label} lost or reordered the Linux/macOS candidates`);
  }
});
