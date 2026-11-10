// Shared test harness: boots the real server against a THROWAWAY SQLite file
// in the OS temp dir (via LMS_DB_PATH) so tests can never touch lms.db, with
// LMS_DISABLE_AI=1 so an exam submit never calls the real Claude API, with
// LMS_TEST_AI_LOCAL_ONLY=1 so modules/ai/provider.js refuses any non-loopback AI endpoint
// (a test that turns AI on points it at test/fixtures/fake-ai-server.js), and with
// LMS_DISABLE_OFFICE_CONVERT=1 so the Office→PDF converter counts as "not installed"
// (state "disabled": Office uploads are refused with office_converter_unavailable)
// whether or not LibreOffice is on the host — deterministic tests. A test that needs
// conversion passes { LMS_DISABLE_OFFICE_CONVERT: "0", LMS_SOFFICE: FAKE_SOFFICE }
// (test/fixtures/fake-soffice.js, a node stand-in for soffice; P0 1.3/1.4).
// Likewise LMS_DISABLE_VIDEO_TRANSCODE=1 makes the PPT-video transcoder (ffmpeg)
// count as "disabled" (batch 3, 5.7): embedded videos are still extracted and stay
// pending. A test that needs transcoding passes { LMS_DISABLE_VIDEO_TRANSCODE: "0",
// LMS_FFMPEG: FAKE_FFMPEG } (test/fixtures/fake-ffmpeg.js).
//
// Run all tests:  node --test test/        (or test.bat on Windows)

const { spawn } = require("child_process");
const path = require("path");
const os = require("os");
const fs = require("fs");
const crypto = require("crypto");

const ROOT = path.join(__dirname, "..");
// 职级目录测试夹具（Unfolding Lab 版 2026-10-12）：产品新库播种通用职级表 P1–P10 / M1–M7；
// 测试断言按双通道夹具写（PA2、MB1…），所以测试进程及其启动的服务一律用 fixtures/job-grades-test.json 播种。
process.env.LMS_TEST_JOB_GRADES = process.env.LMS_TEST_JOB_GRADES || path.join(__dirname, "fixtures", "job-grades-test.json");
// soffice 测试替身（见文件头）：LMS_SOFFICE 指向它即可，不需要装 LibreOffice
const FAKE_SOFFICE = path.join(__dirname, "fixtures", "fake-soffice.js");
// ffmpeg 测试替身（第三批 5.7）：LMS_FFMPEG 指向它即可，不需要装 ffmpeg
const FAKE_FFMPEG = path.join(__dirname, "fixtures", "fake-ffmpeg.js");

// Temp-dir hygiene. Every directory made by tempDir() — including the one each
// startServer() creates for its throwaway DB — is removed when this test
// process exits, after any server child still running is killed. Windows keeps
// a SQLite file locked until the owning process is gone, so the removal
// retries for a moment (fs.rmSync maxRetries) instead of silently leaving the
// directory behind. A test that removes its own directory earlier is fine:
// force: true ignores what is already gone.
const TEMP_DIRS = new Set();
const CHILDREN = new Set();
function tempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix || "lms-test-"));
  TEMP_DIRS.add(dir);
  return dir;
}
process.on("exit", () => {
  for (const c of CHILDREN) { if (c.exitCode === null && c.signalCode === null) { try { c.kill(); } catch {} } }
  for (const d of TEMP_DIRS) { try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 }); } catch {} }
});

// Seeded demo credentials (store.js seedFresh) — the test DB is always fresh.
const ADMIN = { employeeId: "ADMIN", password: "unfolding888" };
const DEMO_ADMIN = { employeeId: "DEMO-ADMIN", password: "manage2026" };
const EMPLOYEE = { employeeId: "DP-1001", password: "test1234" };

// startServer() boots on a fresh throwaway DB; pass { dbPath } to reuse an
// existing test DB (e.g. to verify migrations are idempotent across restarts).
// Pass { root } to boot a server COPY (a temp directory holding server.js,
// store.js, kernel/, modules/ … — e.g. with a test-only demo module installed)
// instead of the repo; everything else (throwaway config, fingerprint check,
// port retry) is the same. The returned object also has stderr() (what the
// child printed so far) and stopAsync() (kill and wait for exit — Windows keeps
// the SQLite file locked until the process is gone). A start that fails throws
// an Error carrying .exitCode and .stderr.
async function startServer(opts = {}) {
  const dbPath = opts.dbPath || path.join(tempDir("lms-test-"), "test.db");
  // Uploads land next to the test DB — never in the real data/attachments.
  const attachDir = path.join(path.dirname(dbPath), "attachments");
  // Config defaults to a (non-existent) file next to the test DB, so a test
  // server never reads or writes the repo-root config.json — that file is the
  // owner's live config. A test that needs a config passes its own
  // LMS_CONFIG_PATH in opts.env, which wins over this default.
  const configPath = path.join(path.dirname(dbPath), "config.json");
  const port = 18000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, ["server.js"], {
    cwd: opts.root || ROOT,
    env: { ...process.env, LMS_DB_PATH: dbPath, LMS_ATTACH_DIR: attachDir, LMS_CONFIG_PATH: configPath, PORT: String(port), LMS_DISABLE_AI: "1", LMS_TEST_AI_LOCAL_ONLY: "1", LMS_DISABLE_OFFICE_CONVERT: "1", LMS_DISABLE_VIDEO_TRANSCODE: "1", ...(opts.env || {}) },
    stdio: ["ignore", "ignore", "pipe"],
  });
  CHILDREN.add(child);
  child.once("exit", () => CHILDREN.delete(child));
  let stderr = "";
  child.stderr.on("data", (d) => { stderr += d; });
  const base = `http://127.0.0.1:${port}`;
  // /api/env reports the instance fingerprint (sha256 of the resolved DB path).
  // Matching it proves we reached OUR child, not another test file's server
  // that happened to draw the same random port (then our child dies with
  // EADDRINUSE while the stranger answers — tests would silently hit it).
  const expectedInstance = crypto.createHash("sha256").update(path.resolve(dbPath)).digest("hex").slice(0, 8);
  const deadline = Date.now() + 15000;
  let stranger = false;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) break;
    try {
      // Bounded probe: if the random port belongs to some non-HTTP local process
      // that accepts the connection and never answers, an unbounded fetch waits
      // for undici's 300-second header timeout (seen once in a full run) before
      // the collision retry below gets a chance.
      const res = await fetch(base + "/api/env", { signal: AbortSignal.timeout(2000) });
      if (res.ok) {
        const env = await res.json();
        if (env.instance === expectedInstance) {
          const exited = new Promise((resolve) => { if (child.exitCode !== null) resolve(); else child.once("exit", () => resolve()); });
          return { child, base, dbPath, stop: () => child.kill(), stopAsync: () => { child.kill(); return exited; }, stderr: () => stderr };
        }
        stranger = true; // someone else owns this port
        break;
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  child.kill();
  // The child's last stderr lines can arrive after its exit status: wait (briefly) for the pipe to close.
  if (!child.stderr.readableEnded) await Promise.race([new Promise((r) => child.stderr.once("close", r)), new Promise((r) => setTimeout(r, 2000))]);
  // Port collision (stranger answered, or our child died with EADDRINUSE) →
  // retry on a fresh random port with the same DB. Any other failure throws.
  const collided = stranger || /EADDRINUSE/.test(stderr);
  if (collided && (opts._attempt || 0) < 5)
    return startServer({ ...opts, dbPath, _attempt: (opts._attempt || 0) + 1 });
  const err = new Error("Test server failed to start. stderr:\n" + stderr);
  err.exitCode = child.exitCode;
  err.stderr = stderr;
  throw err;
}

// Minimal API client with a session-cookie jar. get/post/put/del return
// { status, data } (data = parsed JSON). raw() returns the Response for
// non-JSON endpoints like CSV exports.
function makeClient(base) {
  let sid = null;
  // extraHeaders lets a test add request headers (a Range probe, say) while
  // keeping the session cookie this client already holds.
  async function raw(method, pathname, body, extraHeaders) {
    const res = await fetch(base + pathname, {
      method,
      headers: { "content-type": "application/json", ...(sid ? { cookie: "sid=" + sid } : {}), ...(extraHeaders || {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    for (const c of res.headers.getSetCookie()) {
      const m = c.match(/^sid=([^;]*)/);
      if (m) sid = m[1] || null;
    }
    return res;
  }
  async function call(method, pathname, body) {
    const res = await raw(method, pathname, body);
    return { status: res.status, data: await res.json() };
  }
  // Raw binary upload (attachment/video endpoints take the body as file bytes).
  async function upload(pathname, buffer) {
    const res = await fetch(base + pathname, {
      method: "POST",
      headers: sid ? { cookie: "sid=" + sid } : {},
      body: buffer,
    });
    return { status: res.status, data: await res.json() };
  }
  return {
    get: (p) => call("GET", p),
    post: (p, b) => call("POST", p, b ?? {}),
    put: (p, b) => call("PUT", p, b ?? {}),
    del: (p, b) => call("DELETE", p, b ?? {}),
    raw,
    upload,
    login: async (creds) => call("POST", "/api/auth/login", creds),
  };
}

async function loginAs(base, creds) {
  const c = makeClient(base);
  const r = await c.login(creds);
  if (r.status !== 200) throw new Error(`login as ${creds.employeeId} failed: ${JSON.stringify(r.data)}`);
  return c;
}

// Completes every module of every course in a program for the logged-in
// employee client — unlocks the program exam.
async function completeAllModules(client, programId) {
  const { data: program } = await client.get("/api/programs/" + programId);
  for (const course of program.courses) {
    const { data: full } = await client.get("/api/courses/" + course.id);
    for (const m of full.modules) {
      const r = await client.post(`/api/courses/${course.id}/modules/${m.id}/complete`);
      if (r.status !== 200) throw new Error(`complete ${course.id}/${m.id} failed: ${JSON.stringify(r.data)}`);
    }
  }
}

// 简化 10/11：handleApi 的接口处理按模块搬到 modules/<模块>/routes.js。读服务端源码做静态检查时用这份合并文本。
const SERVER_ROUTE_FILES = ["modules/core/routes.js", "modules/learning/routes.js", "modules/performance/routes.js", "modules/talent/routes.js"];
function serverSource() {
  return ["server.js", ...SERVER_ROUTE_FILES].map((f) => fs.readFileSync(path.join(ROOT, f), "utf8")).join("\n");
}

module.exports = { serverSource, SERVER_ROUTE_FILES, ROOT, ADMIN, DEMO_ADMIN, EMPLOYEE, FAKE_SOFFICE, FAKE_FFMPEG, startServer, makeClient, loginAs, completeAllModules, tempDir };
