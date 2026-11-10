// SQLite data layer for the DigiPlus LMS/TMS.
//
// Uses Node's BUILT-IN node:sqlite (no npm install, no native build — keeps the
// "double-click start.bat" portability). Every write is a synchronous,
// transactional SQLite statement: no debounced in-memory buffer, so a crash can
// no longer lose a just-submitted exam, and we never rewrite a whole file.
//
// One-time migration: on first run, if an old db.json exists it is imported,
// then renamed to db.json.migrated so it is never imported twice.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

// node:sqlite is still marked experimental and prints a warning on load.
// Silence just that one warning; leave all other warnings intact.
const _emitWarning = process.emitWarning;
process.emitWarning = function (warning, ...args) {
  const type = args[0] && (typeof args[0] === "string" ? args[0] : args[0].type);
  if (type === "ExperimentalWarning" && String(warning).includes("SQLite")) return;
  return _emitWarning.call(process, warning, ...args);
};
const { DatabaseSync } = require("node:sqlite");

const { QUESTIONS, PROGRAMS, COURSES } = require("./content.js");
// 领域事件的信封与请求上下文（kernel/events.js，机制）；部门层级（modules/core/org.js，纯函数）
// 给事件 data 算一级/二级部门。两者都不 require 本文件。
const events = require("./kernel/events.js");
const orgLib = require("./modules/core/org.js");
// 第四批 6.1 题型注册表（纯函数、零依赖、不 require 本文件）：题库行 ⇄ 题目对象按题型走注册表（迁移 73 的 data 列）
const QTYPES = require("./modules/learning/qtypes/index.js");
// 第五批 8.1 人才筛选条件模型（纯函数、零依赖、不 require 本文件）：数据迁移 81 用 promotionFilterRow 生成内置晋升筛选
const TALENT_FILTER_MODEL = require("./modules/talent/filter-model.js");

const ROOT = __dirname;
const DEMO_ADMIN = { id: "u-demo-admin", employeeId: "DEMO-ADMIN", name: "Demo Administrator", password: "manage2026" };
const DEMO_GUIDE_ID = "att-demo-unfolding-guide";
const DEMO_GUIDE_KEY = DEMO_GUIDE_ID + ".pdf";
// LMS_DB_PATH lets tests (and future deployments) point at a different database
// file. Production keeps the default lms.db next to server.js — start.bat is
// unaffected. Tests MUST set this so they never touch the real database.
const DB_PATH = process.env.LMS_DB_PATH ? path.resolve(process.env.LMS_DB_PATH) : path.join(ROOT, "lms.db");
const LEGACY_JSON = path.join(ROOT, "db.json");

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days, matches the cookie

let db;
// 热路径预编译语句缓存。node:sqlite 的 db.prepare() 每次都要重新编译 SQL（实测每次
// 20–50µs），批量导入 4,000 行时 getUserById / createUser / getDepartmentByName 这几条
// 每行各编译一两次，光编译就占了同步事务阶段的大半（约 0.6 秒）。stmt(sql) 按 SQL 文本
// 缓存 StatementSync 并复用：node:sqlite 每次 run/get/all 后自动 reset 语句，绑定参数
// 不会串；表结构变更后 SQLite 会自动重新编译（sqlite3_prepare_v2 语义）。缓存绑定在当前
// db 连接上，连接换了（只有 init 会赋值）就整体作废。只给固定 SQL 用，不给拼接出来的 SQL。
let STMT_DB = null;
let STMT_CACHE = new Map();
function stmt(sql) {
  if (STMT_DB !== db) { STMT_CACHE = new Map(); STMT_DB = db; }
  let s = STMT_CACHE.get(sql);
  if (!s) { s = db.prepare(sql); STMT_CACHE.set(sql, s); }
  return s;
}

// ---------- schema ----------
function createSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id                 TEXT PRIMARY KEY,
      employeeId         TEXT UNIQUE NOT NULL,
      name               TEXT NOT NULL,
      role               TEXT NOT NULL,
      passwordHash       TEXT NOT NULL,
      lastLoginAt        TEXT,
      createdAt          TEXT NOT NULL,
      mustChangePassword INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token     TEXT PRIMARY KEY,
      userId    TEXT NOT NULL,
      createdAt TEXT NOT NULL,
      expiresAt TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(userId);
    CREATE TABLE IF NOT EXISTS progress (
      userId      TEXT NOT NULL,
      courseId    TEXT NOT NULL,
      moduleId    TEXT NOT NULL,
      completedAt TEXT NOT NULL,
      PRIMARY KEY (userId, courseId, moduleId)
    );
    CREATE TABLE IF NOT EXISTS attempts (
      id          TEXT PRIMARY KEY,
      userId      TEXT NOT NULL,
      programId   TEXT NOT NULL,
      startedAt   TEXT NOT NULL,
      submittedAt TEXT,
      questions   TEXT,
      answers     TEXT,
      percent     INTEGER,
      passed      INTEGER,
      detail      TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_attempts_user ON attempts(userId);
    CREATE TABLE IF NOT EXISTS questions (
      id             TEXT PRIMARY KEY,
      courseId       TEXT NOT NULL,
      moduleId       TEXT,
      type           TEXT NOT NULL,
      question       TEXT NOT NULL,
      question_zh    TEXT,
      options        TEXT,
      explanation    TEXT,
      explanation_zh TEXT,
      rubric         TEXT,
      rubric_zh      TEXT,
      maxPoints      INTEGER
    );
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE IF NOT EXISTS assignments (
      userId     TEXT NOT NULL,
      programId  TEXT NOT NULL,
      dueAt      TEXT,
      assignedAt TEXT NOT NULL,
      PRIMARY KEY (userId, programId)
    );
    CREATE TABLE IF NOT EXISTS content (
      kind      TEXT NOT NULL,   -- 'program' | 'course'
      id        TEXT NOT NULL,
      json      TEXT NOT NULL,
      updatedAt TEXT NOT NULL,
      PRIMARY KEY (kind, id)
    );
    -- Exams are first-class objects (Batch 1). A program can have several; each
    -- exam draws its question pool from the courses linked via exam_courses.
    CREATE TABLE IF NOT EXISTS exams (
      id                   TEXT PRIMARY KEY,
      programId            TEXT NOT NULL,
      title                TEXT NOT NULL,
      title_zh             TEXT,
      status               TEXT NOT NULL DEFAULT 'published',  -- draft | published | archived
      passingScore         INTEGER NOT NULL DEFAULT 80,
      mcqCount             INTEGER NOT NULL DEFAULT 8,
      openCount            INTEGER NOT NULL DEFAULT 1,
      timeLimitMinutes     INTEGER,
      maxAttempts          INTEGER NOT NULL DEFAULT 0,
      retakeCooldownHours  INTEGER NOT NULL DEFAULT 0,
      showAnswersAfterExam INTEGER NOT NULL DEFAULT 1,
      createdAt            TEXT NOT NULL,
      updatedAt            TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_exams_program ON exams(programId);
    CREATE TABLE IF NOT EXISTS exam_courses (
      examId    TEXT NOT NULL,
      courseId  TEXT NOT NULL,
      sortOrder INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (examId, courseId)
    );
    -- Course attachments (Batch 4). Files live OUTSIDE public/ (data/attachments)
    -- and are served through an authenticated endpoint only.
    CREATE TABLE IF NOT EXISTS attachments (
      id           TEXT PRIMARY KEY,
      courseId     TEXT NOT NULL,
      kind         TEXT NOT NULL,      -- video | audio | pdf | doc
      storageKey   TEXT NOT NULL,      -- filename inside data/attachments/
      originalName TEXT NOT NULL,
      mime         TEXT NOT NULL,
      size         INTEGER NOT NULL,
      uploadedBy   TEXT,
      createdAt    TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_attachments_course ON attachments(courseId);
    -- Audit trail of admin actions (Batch 5). Append-only: there is no API to
    -- delete or edit entries.
    CREATE TABLE IF NOT EXISTS audit_logs (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      actorId    TEXT,
      actorName  TEXT,
      action     TEXT NOT NULL,
      target     TEXT,
      beforeJson TEXT,
      afterJson  TEXT,
      requestId  TEXT,
      createdAt  TEXT NOT NULL
    );
    -- Version snapshots of programs / courses / exams, taken on every admin
    -- save so any change can be traced and recovered.
    CREATE TABLE IF NOT EXISTS content_versions (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      kind      TEXT NOT NULL,
      contentId TEXT NOT NULL,
      version   INTEGER NOT NULL,
      json      TEXT NOT NULL,
      actorId   TEXT,
      createdAt TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_versions_content ON content_versions(kind, contentId);
    -- Employee requests to enrol in an elective program; HR approves/rejects.
    CREATE TABLE IF NOT EXISTS enrollment_requests (
      id          TEXT PRIMARY KEY,
      userId      TEXT NOT NULL,
      programId   TEXT NOT NULL,
      status      TEXT NOT NULL DEFAULT 'pending',  -- pending | approved | rejected
      note        TEXT,     -- employee's reason (optional)
      decidedBy   TEXT,
      decideNote  TEXT,     -- HR's reason (esp. on reject)
      requestedAt TEXT NOT NULL,
      decidedAt   TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_enroll_user ON enrollment_requests(userId);
    CREATE INDEX IF NOT EXISTS idx_enroll_status ON enrollment_requests(status);
    -- In-app notifications (bilingual). Email delivery is a separate, pluggable
    -- hook (see server sendEmail) that reads config — off until configured.
    CREATE TABLE IF NOT EXISTS notifications (
      id        TEXT PRIMARY KEY,
      userId    TEXT NOT NULL,
      type      TEXT NOT NULL,
      title     TEXT NOT NULL,
      title_zh  TEXT,
      body      TEXT,
      body_zh   TEXT,
      link      TEXT,
      readAt    TEXT,
      createdAt TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_notif_user ON notifications(userId, createdAt);
    -- Unified approval engine (Phase A): one table for every approval kind
    -- (enroll | nomination | leave | budget | …). The subject of the approval
    -- is a small JSON blob whose shape is owned by the kind.
    CREATE TABLE IF NOT EXISTS approvals (
      id           TEXT PRIMARY KEY,
      kind         TEXT NOT NULL,
      subjectJson  TEXT NOT NULL,
      requesterId  TEXT NOT NULL,   -- who filed it
      targetUserId TEXT,            -- who it is about (beneficiary), often = requester
      note         TEXT,
      status       TEXT NOT NULL DEFAULT 'pending',  -- pending | approved | rejected | cancelled
      decidedBy    TEXT,
      decideNote   TEXT,
      requestedAt  TEXT NOT NULL,
      decidedAt    TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_approvals_kind ON approvals(kind, status);
    CREATE INDEX IF NOT EXISTS idx_approvals_target ON approvals(targetUserId, kind);
    -- Project-scoped roles (Phase A groundwork; used by the training-projects
    -- module from Phase B): owner | admin | class_head | mentor | learner.
    CREATE TABLE IF NOT EXISTS project_members (
      projectId TEXT NOT NULL,
      cohortId  TEXT,
      userId    TEXT NOT NULL,
      role      TEXT NOT NULL,
      addedAt   TEXT NOT NULL,
      PRIMARY KEY (projectId, userId, role)
    );
    CREATE INDEX IF NOT EXISTS idx_pm_user ON project_members(userId);
    -- Per-learner state for training-project activities. Content-referencing
    -- activity types (course/program/exam) DERIVE completion from existing
    -- progress/attempts (an in-person course from its own attendance row,
    -- projectId '__course__', activityId 'course:<id>'); this table records
    -- what has no other home: offline-activity attendance
    -- (attended | late | excused | absent) and online-activity completion
    -- (stored type 'online': completed | excused, written by the learner,
    -- the trainer or HR under projectId = the project id).
    CREATE TABLE IF NOT EXISTS activity_state (
      projectId  TEXT NOT NULL,
      cohortId   TEXT NOT NULL,
      activityId TEXT NOT NULL,
      userId     TEXT NOT NULL,
      status     TEXT NOT NULL,
      at         TEXT NOT NULL,
      by         TEXT,
      note       TEXT,
      PRIMARY KEY (activityId, userId)
    );
    CREATE INDEX IF NOT EXISTS idx_actstate_user ON activity_state(userId, projectId);
  `);
}

// ---------- schema migrations ----------
// Every schema change beyond the base createSchema() is a numbered migration.
// Applied versions are recorded in schema_migrations, so each runs exactly once
// per database; each migration is also individually idempotent (guarded by
// columnExists/tableExists) so databases created before this table existed are
// adopted without errors. A failing migration rolls back and aborts startup —
// never leaves a half-migrated database.
function columnExists(table, col) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col);
}

const MIGRATIONS = [
  // Migrations 1–4 predate schema_migrations (were ad-hoc column adds); the
  // guards make them no-ops on databases that already have the columns.
  { version: 1, name: "users-mustChangePassword", up() {
    // Existing rows default to 0 (don't force legacy/demo accounts to change).
    if (!columnExists("users", "mustChangePassword")) db.exec("ALTER TABLE users ADD COLUMN mustChangePassword INTEGER NOT NULL DEFAULT 0");
  } },
  { version: 2, name: "users-department", up() {
    if (!columnExists("users", "department")) db.exec("ALTER TABLE users ADD COLUMN department TEXT");
  } },
  { version: 3, name: "users-active", up() {
    if (!columnExists("users", "active")) db.exec("ALTER TABLE users ADD COLUMN active INTEGER NOT NULL DEFAULT 1");
  } },
  { version: 4, name: "attempts-blurCount", up() {
    if (!columnExists("attempts", "blurCount")) db.exec("ALTER TABLE attempts ADD COLUMN blurCount INTEGER NOT NULL DEFAULT 0");
  } },
  { version: 5, name: "attempts-examId-and-draft", up() {
    // examId ties an attempt to a first-class exam (backfilled by migration 7);
    // draftAnswers/lastSavedAt power exam recovery (used from Batch 3).
    if (!columnExists("attempts", "examId")) db.exec("ALTER TABLE attempts ADD COLUMN examId TEXT");
    if (!columnExists("attempts", "draftAnswers")) db.exec("ALTER TABLE attempts ADD COLUMN draftAnswers TEXT");
    if (!columnExists("attempts", "lastSavedAt")) db.exec("ALTER TABLE attempts ADD COLUMN lastSavedAt TEXT");
  } },
  { version: 8, name: "users-email", up() {
    // Optional contact email — powers the planned one-click email notifications.
    if (!columnExists("users", "email")) db.exec("ALTER TABLE users ADD COLUMN email TEXT");
  } },
  { version: 9, name: "users-managerId", up() {
    // Direct manager (org master data, Phase A) — powers nomination, reminder
    // escalation and L3 evaluation in the training-projects module.
    if (!columnExists("users", "managerId")) db.exec("ALTER TABLE users ADD COLUMN managerId TEXT");
  } },
  { version: 10, name: "attachments-owner", up() {
    // Generalise attachments beyond courses (Phase A): ownerKind/ownerId tell
    // whose file this is (course | project | activity | closure | …).
    if (!columnExists("attachments", "ownerKind")) db.exec("ALTER TABLE attachments ADD COLUMN ownerKind TEXT");
    if (!columnExists("attachments", "ownerId")) db.exec("ALTER TABLE attachments ADD COLUMN ownerId TEXT");
    db.exec("UPDATE attachments SET ownerKind = 'course', ownerId = courseId WHERE ownerKind IS NULL");
  } },
  { version: 12, name: "project-members-class-state", up() {
    // Phase B: class/group placement and lifecycle state (active | withdrawn)
    // for training-project members. Withdrawals keep the row for records.
    if (!columnExists("project_members", "classId")) db.exec("ALTER TABLE project_members ADD COLUMN classId TEXT");
    if (!columnExists("project_members", "groupId")) db.exec("ALTER TABLE project_members ADD COLUMN groupId TEXT");
    if (!columnExists("project_members", "state")) db.exec("ALTER TABLE project_members ADD COLUMN state TEXT NOT NULL DEFAULT 'active'");
  } },
  { version: 13, name: "users-larkUserId", up() {
    // Lark (Feishu) SSO: the stable Lark identity a user signed in with.
    // First Lark login either links an existing account or JIT-creates one.
    if (!columnExists("users", "larkUserId")) db.exec("ALTER TABLE users ADD COLUMN larkUserId TEXT");
  } },
  { version: 14, name: "attempts-voided", up() {
    // HR "reset attempts" escape hatch for capped exams that were all failed:
    // voided attempts stop counting toward limits/best score but stay stored
    // (and visible, flagged, in the admin Results view) for the audit trail.
    if (!columnExists("attempts", "voided")) db.exec("ALTER TABLE attempts ADD COLUMN voided INTEGER NOT NULL DEFAULT 0");
  } },
  { version: 15, name: "exams-autoRetrain", up() {
    // Per-exam switch: when the last allowed attempt is failed, automatically
    // void the attempts and clear linked course progress (重修重考). Default ON.
    if (!columnExists("exams", "autoRetrain")) db.exec("ALTER TABLE exams ADD COLUMN autoRetrain INTEGER NOT NULL DEFAULT 1");
  } },
  { version: 16, name: "users-phone", up() {
    // Optional contact number (HR asked for it; also lets us de-duplicate on
    // phone the way we do on email).
    if (!columnExists("users", "phone")) db.exec("ALTER TABLE users ADD COLUMN phone TEXT");
  } },
  // Talent layer (DigiPlus TMS). Numbered from 30 so upstream LMS migrations
  // (which keep counting 8, 9, 10, …) never collide with these versions.
  { version: 30, name: "talent-hris-foundation", up() {
    // Talent-management layer (HRIS groundwork). Employee master data grows
    // employment fields; record types & fields are CONFIG rows so HR customises
    // everything in the console; record data itself is JSON keyed by field key,
    // so adding a field never needs an ALTER TABLE.
    if (!columnExists("users", "position")) db.exec("ALTER TABLE users ADD COLUMN position TEXT");
    if (!columnExists("users", "jobLevel")) db.exec("ALTER TABLE users ADD COLUMN jobLevel TEXT");
    if (!columnExists("users", "hireDate")) db.exec("ALTER TABLE users ADD COLUMN hireDate TEXT");          // YYYY-MM-DD
    if (!columnExists("users", "talentTags")) db.exec("ALTER TABLE users ADD COLUMN talentTags TEXT");      // JSON array
    if (!columnExists("users", "potential")) db.exec("ALTER TABLE users ADD COLUMN potential TEXT");        // High|Medium|Low (9-box axis)
    if (!columnExists("users", "empStatus")) db.exec("ALTER TABLE users ADD COLUMN empStatus TEXT");        // probation|regular|exited
    if (!columnExists("users", "extras")) db.exec("ALTER TABLE users ADD COLUMN extras TEXT");              // JSON — custom employee fields (typeKey 'user')
    db.exec(`
      CREATE TABLE IF NOT EXISTS record_types (
        key     TEXT PRIMARY KEY,
        label   TEXT NOT NULL,
        color   TEXT,
        builtin INTEGER NOT NULL DEFAULT 0,
        active  INTEGER NOT NULL DEFAULT 1,
        sort    INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS record_fields (
        id             TEXT PRIMARY KEY,   -- "rf-<n>"
        typeKey        TEXT NOT NULL,      -- record_types.key, or reserved 'user' for employee custom fields
        key            TEXT NOT NULL,      -- key inside talent_records.detail / users.extras JSON
        label          TEXT NOT NULL,
        input          TEXT NOT NULL DEFAULT 'text', -- text|number|date|select|suggest|textarea|checkbox
        options        TEXT,               -- JSON array for select/suggest
        required       INTEGER NOT NULL DEFAULT 0,
        showInTimeline INTEGER NOT NULL DEFAULT 1,
        filterable     INTEGER NOT NULL DEFAULT 0,
        sort           INTEGER NOT NULL DEFAULT 0,
        active         INTEGER NOT NULL DEFAULT 1
      );
      CREATE INDEX IF NOT EXISTS idx_rf_type ON record_fields(typeKey);
      CREATE TABLE IF NOT EXISTS talent_records (
        id        TEXT PRIMARY KEY,        -- "tr-<token>"
        userId    TEXT NOT NULL,
        type      TEXT NOT NULL,           -- record_types.key
        date      TEXT NOT NULL,           -- YYYY-MM-DD
        title     TEXT NOT NULL,
        detail    TEXT,                    -- JSON {fieldKey: value}
        programId TEXT,
        createdBy TEXT NOT NULL,
        createdAt TEXT NOT NULL,
        updatedAt TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_talent_user ON talent_records(userId);
      CREATE TABLE IF NOT EXISTS departments (
        id       TEXT PRIMARY KEY,         -- "d-<n>"
        name     TEXT UNIQUE NOT NULL,
        parentId TEXT,                     -- org-tree ready; unused by the UI for now
        active   INTEGER NOT NULL DEFAULT 1,
        sort     INTEGER NOT NULL DEFAULT 0
      );
    `);
  } },
  { version: 32, name: "performance-review-flow", up() {
    // Phase 3: reporting line + review cycles. managerId is the org edge
    // (self-eval routes to this person); review_items snapshot the manager at
    // participation time so mid-cycle reorgs don't reroute submitted work.
    if (!columnExists("users", "managerId")) db.exec("ALTER TABLE users ADD COLUMN managerId TEXT");
    db.exec(`
      CREATE TABLE IF NOT EXISTS review_cycles (
        id        TEXT PRIMARY KEY,        -- "rc-<n>"
        name      TEXT NOT NULL,           -- e.g. "2026-H2 绩效评估"
        status    TEXT NOT NULL DEFAULT 'open',  -- open | closed
        createdAt TEXT NOT NULL,
        closedAt  TEXT
      );
      CREATE TABLE IF NOT EXISTS review_items (
        id            TEXT PRIMARY KEY,    -- "ri-<n>"
        cycleId       TEXT NOT NULL,
        userId        TEXT NOT NULL,
        managerId     TEXT,                -- snapshot; NULL = HR rates directly in calibration
        selfText      TEXT,
        selfAt        TEXT,
        managerRating TEXT,
        managerText   TEXT,
        managerAt     TEXT,
        finalRating   TEXT,                -- HR calibration override; defaults to managerRating on close
        recordId      TEXT,                -- talent record written when the cycle closes
        createdAt     TEXT NOT NULL,
        UNIQUE (cycleId, userId)
      );
      CREATE INDEX IF NOT EXISTS idx_ri_cycle ON review_items(cycleId);
      CREATE INDEX IF NOT EXISTS idx_ri_user ON review_items(userId);
      CREATE INDEX IF NOT EXISTS idx_ri_manager ON review_items(managerId);
    `);
  } },
  { version: 33, name: "succession-plans", up() {
    // Phase 4: succession. One row per (key position, successor candidate).
    // Promotion-pipeline criteria live in meta ("promotionConfig" JSON) — they
    // are a single configurable rule set, not relational data.
    db.exec(`
      CREATE TABLE IF NOT EXISTS succession (
        id           TEXT PRIMARY KEY,    -- "sc-<n>"
        positionName TEXT NOT NULL,       -- the key position being covered
        userId       TEXT NOT NULL,       -- successor candidate
        readiness    TEXT NOT NULL,       -- ready | oneYear | twoYears
        note         TEXT,
        createdAt    TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_succ_pos ON succession(positionName);
    `);
  } },
  { version: 35, name: "job-grades-and-review-flow", up() {
    // ① Job grade system 职级体系: dual-track catalog (M management /
    // P professional), each rank carrying a Grade letter and a numeric Level.
    // Stored as meta JSON; the promotion ladder is DERIVED from it per track.
    if (!getMeta("jobGradeConfig")) {
      setMeta("jobGradeConfig", JSON.stringify({ ranks: seedJobGrades() }));
    }
    // ② Rename 晋级 → 晋升晋级 and switch level/department fields from free
    // text to catalog-backed selects (input types resolved by the client).
    db.exec("UPDATE record_types SET label = '晋升晋级 Promotion' WHERE key = 'promotion' AND label LIKE '晋级%'");
    db.exec("UPDATE record_fields SET input = 'level' WHERE typeKey = 'promotion' AND key IN ('fromLevel','toLevel')");
    db.exec("UPDATE record_fields SET input = 'department' WHERE typeKey = 'transfer' AND key IN ('fromDept','toDept')");
    // ③ Review flow rebuilt to the real DigiPlus 4-step cycle: outcomes against
    // last quarter's goals → next-quarter goals → manager 1-on-1 → rating.
    for (const col of ["prevGoals", "selfOutcomes", "selfChallenges", "selfFeedback", "selfExtra", "goalsNext", "oneOnOneAt", "oneOnOneNotes"]) {
      if (!columnExists("review_items", col)) db.exec(`ALTER TABLE review_items ADD COLUMN ${col} TEXT`);
    }
  } },
  { version: 36, name: "secondary-reporting-lines", up() {
    // users.managerId is the SOLID line: exactly one primary manager per person.
    // Real orgs also carry matrix relationships a single column cannot express —
    // a dotted-line manager in another function, or a second post someone holds
    // concurrently (兼任). Those live here, many per person, and never affect the
    // primary tree the org chart is built from.
    db.exec(`
      CREATE TABLE IF NOT EXISTS secondary_lines (
        id         TEXT PRIMARY KEY,      -- "sl-<n>"
        userId     TEXT NOT NULL,         -- the person
        managerId  TEXT,                  -- dotted-line manager (optional for a post with no separate manager)
        kind       TEXT NOT NULL,         -- dotted 虚线汇报 | concurrent 兼任
        position   TEXT,                  -- the concurrent post, or the dotted responsibility
        department TEXT,                  -- where that post sits
        note       TEXT,
        createdAt  TEXT NOT NULL,
        createdBy  TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_sl_user ON secondary_lines(userId);
      CREATE INDEX IF NOT EXISTS idx_sl_mgr ON secondary_lines(managerId);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_sl_uniq
        ON secondary_lines(userId, kind, ifnull(managerId,''), ifnull(position,''));
    `);
  } },
  { version: 34, name: "record-types-employee-visible", up() {
    // Phase 5: employees can see their own growth timeline. WHICH record types
    // they see is per-type config (HR toggles it in Settings). Sensitive types
    // (violation / exit / internal notes) default to hidden; the rest show.
    if (!columnExists("record_types", "employeeVisible")) {
      db.exec("ALTER TABLE record_types ADD COLUMN employeeVisible INTEGER NOT NULL DEFAULT 0");
      db.exec("UPDATE record_types SET employeeVisible = 1 WHERE key IN ('performance','training','award','promotion','regularization','transfer')");
    }
  } },
  { version: 37, name: "attempt-appeals", up() {
    // An employee who thinks a paper was mis-marked needs a way to say so, and
    // HR needs a queue to work through. A row per appeal (not a column on
    // attempts) so a second appeal after a rejection keeps the first on record —
    // the history is the point when someone disputes a grade twice.
    db.exec(`
      CREATE TABLE IF NOT EXISTS attempt_appeals (
        id         TEXT PRIMARY KEY,      -- "ap-<n>"
        attemptId  TEXT NOT NULL,
        userId     TEXT NOT NULL,         -- who filed it (always the attempt's owner)
        reason     TEXT NOT NULL,         -- what they say is wrong
        status     TEXT NOT NULL,         -- open 申诉中 | accepted 已受理 | rejected 已驳回
        createdAt  TEXT NOT NULL,
        resolvedAt TEXT,
        resolvedBy TEXT,                  -- users.id of the HR/admin who closed it
        resolution TEXT                   -- reply shown back to the employee
      );
      CREATE INDEX IF NOT EXISTS idx_ap_attempt ON attempt_appeals(attemptId);
      CREATE INDEX IF NOT EXISTS idx_ap_user ON attempt_appeals(userId);
      CREATE INDEX IF NOT EXISTS idx_ap_status ON attempt_appeals(status);
      -- Only one appeal may be open per attempt; resolved ones stay for history.
      CREATE UNIQUE INDEX IF NOT EXISTS idx_ap_one_open
        ON attempt_appeals(attemptId) WHERE status = 'open';
    `);
  } },
  { version: 38, name: "cycle-due-dept-owner-exam-blur", up() {
    // Three columns the UI has been asking for and could not fake:
    //
    // review_cycles.dueAt — the self-review deadline. Both the employee's todo
    //   strip and the review card show "截止 <date>"; with no column the date had
    //   to be omitted, which is the one fact that makes a todo actionable.
    // departments.ownerId — the department head. The Departments page has a
    //   负责人 column in the design and nothing to put in it.
    // exams.recordBlur — whether this exam records tab-switching. Today every
    //   exam collects blurCount unconditionally, so HR cannot turn off
    //   invigilation for a low-stakes quiz. Default 1 keeps current behaviour.
    if (!columnExists("review_cycles", "dueAt")) db.exec("ALTER TABLE review_cycles ADD COLUMN dueAt TEXT");
    if (!columnExists("departments", "ownerId")) db.exec("ALTER TABLE departments ADD COLUMN ownerId TEXT");
    if (!columnExists("exams", "recordBlur")) db.exec("ALTER TABLE exams ADD COLUMN recordBlur INTEGER NOT NULL DEFAULT 1");
  } },
  { version: 39, name: "split-bilingual-record-labels", up() {
    // "绩效 Performance" was one column doing two jobs, so both languages printed
    // side by side in the type list, the timeline chips and every field row.
    // Everything else in this app is bilingual through loc(obj, "x"), which reads
    // x_zh when the UI is Chinese and falls back to x — so labels get that same
    // shape: label = English, label_zh = Chinese.
    const split = (s) => {
      const raw = String(s || "").trim();
      const m = raw.match(/^([^A-Za-z]+?)\s+([A-Za-z][A-Za-z0-9 &/\-'.()]*)$/);
      if (m) return { zh: m[1].trim(), en: m[2].trim() };
      // No split point. A single-language label goes in BOTH slots rather than
      // leaving one blank — an HR-created Chinese-only type must not render as
      // an empty string for an English user.
      return { zh: raw, en: raw };
    };
    for (const table of ["record_types", "record_fields"]) {
      if (!columnExists(table, "label_zh")) db.exec(`ALTER TABLE ${table} ADD COLUMN label_zh TEXT`);
      const key = table === "record_types" ? "key" : "id";
      for (const row of db.prepare(`SELECT ${key} AS k, label FROM ${table}`).all()) {
        const { zh, en } = split(row.label);
        db.prepare(`UPDATE ${table} SET label = ?, label_zh = ? WHERE ${key} = ?`).run(en, zh, row.k);
      }
    }
  } },
  { version: 40, name: "english-names-for-chinese-only-fields", up() {
    // 39 could not split a label with no English half, so it copied the Chinese
    // into BOTH slots — better than a blank, but it means the four sync checkboxes
    // still print Chinese to an English user, and the imported "Lark 名称 Lark name"
    // kept its whole string in both (that one starts with Latin, which the regex
    // in 39 does not accept as a Chinese half). Named here to match the seed.
    const EN = [
      ["promotion", "syncLevel", "Update current level", "同步更新当前职级"],
      ["regularization", "syncStatus", "Set status to regular", "同步员工状态为正式"],
      ["transfer", "syncDept", "Update current dept/position", "同步更新当前部门/职位"],
      ["exit", "syncStatus", "Set exited & deactivate account", "同步状态为离职并停用账号"],
      ["user", "c42", "Lark name", "Lark 名称"],
      // A bare "Type" collides with the CSV importer's fixed 「Type 类型」 column.
      ["exit", "exitType", "Exit type", "离职类型"],
    ];
    const cjk = /[\u4e00-\u9fff]/;
    const get = db.prepare("SELECT label, label_zh FROM record_fields WHERE typeKey = ? AND key = ?");
    const upd = db.prepare("UPDATE record_fields SET label = ?, label_zh = ? WHERE typeKey = ? AND key = ?");
    for (const [typeKey, key, en, zh] of EN) {
      const row = get.get(typeKey, key);
      if (!row) continue;
      // Only touch a row still holding Chinese in its English slot (or the bare
      // "Type"), so an HR rename is never overwritten.
      const labelNow = String(row.label || "");
      if (!cjk.test(labelNow) && labelNow !== "Type") continue;
      // Keep a Chinese-only label_zh as it stands; replace one that still carries
      // the English half.
      const zhNow = String(row.label_zh || "");
      upd.run(en, cjk.test(zhNow) && !/[A-Za-z]{3,}/.test(zhNow) ? zhNow : zh, typeKey, key);
    }
  } },
  { version: 41, name: "split-bilingual-record-options", up() {
    // 39/40 split the LABELS; option lists stayed bilingual single strings
    // ("通过 Passed"), so both languages still read a mixed list. Options carry one
    // constraint labels do not: an option string is also the VALUE written into
    // talent_records.detail — matched by applyRecordSideEffects' passOk regex and
    // grouped by the talent-search facets. So `options` keeps that double duty
    // (stored value AND English display name, one string) and `options_zh` is a
    // display-only parallel array: same length, same order. Nothing matches on
    // options_zh; the client renders options_zh[i] but submits options[i].
    if (!columnExists("record_fields", "options_zh")) db.exec("ALTER TABLE record_fields ADD COLUMN options_zh TEXT");
    // Built-ins are spelled out instead of regex-split: the English halves are
    // product wording ("结业" → "Completed", not "Graduation") and three of these
    // lists never had an English half to split off in the first place.
    // [typeKey, key, seeded options, new options (EN + stored value), options_zh]
    const BUILTIN = [
      ["performance", "rating", ["A+", "A", "B+", "B", "C", "D"], ["A+", "A", "B+", "B", "C", "D"], ["A+", "A", "B+", "B", "C", "D"]],
      ["training", "result", ["结业", "优秀", "未完成"], ["Completed", "Distinction", "Incomplete"], ["结业", "优秀", "未完成"]],
      ["award", "awardName", ["优秀学员", "优秀团队成员", "最佳进步"], ["Top learner", "Best team member", "Most improved"], ["优秀学员", "优秀团队成员", "最佳进步"]],
      ["violation", "severity", ["Minor 轻微", "Major 重大"], ["Minor", "Major"], ["轻微", "重大"]],
      ["promotion", "method", ["答辩 Defense", "直接 Direct"], ["Defense", "Direct"], ["答辩", "直接"]],
      ["promotion", "result", ["通过 Passed", "未通过 Failed"], ["Passed", "Failed"], ["通过", "未通过"]],
      ["regularization", "result", ["按期转正 On time", "延期转正 Extended", "未通过 Failed"], ["On time", "Extended", "Failed"], ["按期转正", "延期转正", "未通过"]],
      ["exit", "exitType", ["主动离职 Voluntary", "被动离职 Involuntary", "合同到期 Contract end"], ["Voluntary", "Involuntary", "Contract end"], ["主动离职", "被动离职", "合同到期"]],
    ];
    const parseArr = (s) => { try { const a = JSON.parse(s || "[]"); return Array.isArray(a) ? a.map(String) : []; } catch { return []; } };
    const sameArr = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
    // (typeKey|key) → { oldValue: newValue }, filled only for lists this migration
    // actually rewrote; drives the stored-value remap at the bottom.
    const renames = new Map();
    const addRenames = (typeKey, key, from, to) => {
      const m = {};
      from.forEach((v, i) => { if (to[i] !== undefined && to[i] !== v) m[v] = to[i]; });
      if (Object.keys(m).length) renames.set(typeKey + "|" + key, m);
    };
    const rows = db.prepare("SELECT id, typeKey, key, options, options_zh FROM record_fields").all();
    const upd = db.prepare("UPDATE record_fields SET options = ?, options_zh = ? WHERE id = ?");
    const builtinKeys = new Set(BUILTIN.map(([t, k]) => t + "|" + k));
    for (const [typeKey, key, seeded, en, zh] of BUILTIN) {
      const row = rows.find((r) => r.typeKey === typeKey && r.key === key);
      if (!row) continue;
      const now = parseArr(row.options);
      // Rewrite only a list still holding the seeded strings — or already holding
      // the new ones, so a re-run just tops up options_zh. A list HR has edited is
      // theirs: overwriting it would silently drop options they added.
      if (!sameArr(now, seeded) && !sameArr(now, en)) continue;
      upd.run(JSON.stringify(en), JSON.stringify(zh), row.id);
      addRenames(typeKey, key, seeded, en);
    }
    // HR-created lists get the mechanical 39-style「中文 English」split. No product
    // knowledge is available here, so an item that will not split keeps its single
    // string in BOTH slots: a monolingual option shown to both languages is
    // acceptable, a blank one is not.
    const splitOpt = (s) => {
      const raw = String(s || "").trim();
      const m = raw.match(/^([^A-Za-z]+?)\s+([A-Za-z][A-Za-z0-9 &/\-'.()]*)$/);
      // The head must actually be Chinese, not merely "not Latin": a numeric or
      // punctuation-led option ("2024 Q1 target") would otherwise be split into a
      // bogus pair — and because options[i] IS the stored value, a wrong split
      // renames live data rather than just a label.
      if (!m || !/[\u4e00-\u9fff]/.test(m[1])) return { zh: raw, en: raw };
      return { zh: m[1].trim(), en: m[2].trim() };
    };
    for (const row of rows) {
      if (builtinKeys.has(row.typeKey + "|" + row.key)) continue;
      const now = parseArr(row.options);
      if (!now.length || row.options_zh) continue;
      const en = [], zh = [];
      for (const o of now) { const p = splitOpt(o); en.push(p.en); zh.push(p.zh); }
      if (sameArr(en, now)) { upd.run(row.options, JSON.stringify(zh), row.id); continue; }
      upd.run(JSON.stringify(en), JSON.stringify(zh), row.id);
      addRenames(row.typeKey, row.key, now, en);
    }
    if (!renames.size) return;
    // Fallback remap of values already stored under the OLD strings. On THIS
    // database it rewrites 0 rows: the only option value ever written into
    // talent_records.detail is performance.rating, whose A+/A/B+/B are neutral and
    // unchanged by the split. It is here for the other copies of this schema (the
    // real-roster backup, an HR sandbox) where a saved "通过 Passed" would otherwise
    // stop matching its own field's option list — the record would render as an
    // unknown value and drop out of the facet counts.
    const trUpd = db.prepare("UPDATE talent_records SET detail = ? WHERE id = ?");
    const remap = (json, prefix) => {
      let d;
      try { d = JSON.parse(json || "{}"); } catch { return null; }
      if (!d || typeof d !== "object" || Array.isArray(d)) return null;
      let hit = false;
      for (const [k, v] of Object.entries(d)) {
        const m = renames.get(prefix + k);
        if (m && typeof v === "string" && m[v] !== undefined) { d[k] = m[v]; hit = true; }
      }
      return hit ? JSON.stringify(d) : null;
    };
    for (const r of db.prepare("SELECT id, type, detail FROM talent_records").all()) {
      const next = remap(r.detail, r.type + "|");
      if (next) trUpd.run(next, r.id);
    }
    // users.extras stores the same option values for typeKey 'user' custom fields,
    // so it needs the same treatment — a split that renamed one of those lists
    // without this would leave employee profiles holding dead values.
    const uUpd = db.prepare("UPDATE users SET extras = ? WHERE id = ?");
    for (const u of db.prepare("SELECT id, extras FROM users WHERE extras IS NOT NULL AND extras != ''").all()) {
      const next = remap(u.extras, "user|");
      if (next) uUpd.run(next, u.id);
    }
  } },
  { version: 45, name: "password-resets", up() {
    // 自助找回密码（B1）的令牌表。**只存令牌的 sha256**，明文只出现在那一封邮件里：
    // 库被读走（备份泄露、SQL 注入、误发的导出）也换不出一个能用的重置链接。
    // 为什么是 sha256 而不是 scrypt：令牌是 crypto.randomBytes(32) 的高熵随机串，不是
    // 人选的口令，字典/暴破无从下手；scrypt 那种慢哈希是给低熵口令用的，这里只会白白
    // 拖慢每一次链接校验。
    // usedAt 非空 = 已经用过（单次使用），expiresAt 到点即失效 —— 两种情况都保留行，
    // 服务端才分得清「用过/过期」与「根本不存在」（对外一律回同一句话，见 /api/auth/reset）。
    // requestedFor 记下当时提交的工号，事后查「谁在给谁发重置信」不用去 join 用户表。
    db.exec(`
      CREATE TABLE IF NOT EXISTS password_resets (
        id           TEXT PRIMARY KEY,
        userId       TEXT NOT NULL,
        tokenHash    TEXT NOT NULL UNIQUE,   -- sha256(token) 的 hex；UNIQUE 顺带就是查询用的索引
        expiresAt    TEXT NOT NULL,
        usedAt       TEXT,
        createdAt    TEXT NOT NULL,
        requestedFor TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_pwreset_user ON password_resets(userId);
    `);
  } },
  { version: 47, name: "users-lower-employeeId-index", up() {
    // 按工号查人一律是 `lower(employeeId) = lower(?)`（getUserByEmployeeId /
    // employeeIdExists，大小写不敏感是有意的：HR 粘贴的工号大小写不一）。employeeId 上
    // 那条 UNIQUE 自动索引按原值排序，lower() 表达式用不上它，于是每次查人都是全表扫描
    // —— 4,000 行的 records/bulk 就是 4,000 × 4,000 次比较。表达式索引让它变回一次 B 树
    // 查找（EXPLAIN QUERY PLAN 显示 SEARCH users USING INDEX idx_users_lower_empid，
    // 见 test/bulk-perf.test.js）。
    // 刻意**不加 UNIQUE**：历史库里可能已有仅大小写不同的两个工号（UNIQUE 原值约束
    // 放行了它们），唯一索引会让这条迁移在那种库上失败、进而中止启动。
    // 邮箱不建：邮箱查重在 JS 里做（规范化规则是 trim+lower，批量导入先一次性建 Map），
    // 没有按 lower(email) 查询的 SQL，建了也用不上。
    db.exec("CREATE INDEX IF NOT EXISTS idx_users_lower_empid ON users(lower(employeeId))");
  } },
  { version: 48, name: "talent-records-dedupe-index", up() {
    // records/bulk 逐行查重走 talentRecordExists：
    //   SELECT 1 FROM talent_records WHERE userId = ? AND type = ? AND date = ? AND title = ?
    // 四列都是**原值等值比较**（没有 lower()/trim()：type 已由 resolveRecordType 归一成
    // record_types.key，date 已截成 YYYY-MM-DD，title 已 trim + 截 200 字），所以这里建
    // 普通列索引即可、不用表达式索引。原来只有 idx_talent_user(userId)，同一人名下记录
    // 越多，每次查重扫得越多 —— 20 人共 10,000 行的导入，第二批起事务阶段从 1 秒涨到
    // 8–19 秒。四列复合索引让每次查重是一次 B 树定位（EXPLAIN QUERY PLAN 显示
    // SEARCH talent_records USING COVERING INDEX idx_talent_dedupe，见
    // test/bulk-atomic.test.js）。
    // 刻意**不加 UNIQUE**：历史库里可能已有完全相同的记录（手工录入、老版本导入），
    // 唯一索引会让这条迁移在那种库上失败、进而中止启动。
    // idx_talent_user 保留：它更窄，按人列记录（listTalentRecords）照常用它。
    db.exec("CREATE INDEX IF NOT EXISTS idx_talent_dedupe ON talent_records(userId, type, date, title)");
  } },
  { version: 49, name: "event-outbox", up() {
    // 领域事件发件箱（ARCHITECTURE-MODULAR.md §5.3；机制见 kernel/events.js，写入见本文件
    // 「领域事件」一节）。每一行在引起它的数据变更的**同一事务**里写入，回滚时一起消失；
    // 提交之后进程内同步分发，结果写回。四种状态：
    //   dispatchedAt 有值、attempts 0   该类型没有订阅方，写入时即记为已分发（dispatchedAt = occurredAt）
    //   dispatchedAt 有值、attempts ≥1  已分发给订阅方且全部成功（dispatchedAt = 回写时刻）
    //   dispatchedAt 空、attempts ≥1    有订阅方处理失败，lastError 记模块与异常文本（成功后清空）
    //   dispatchedAt 空、attempts 0     从未分发（经 store.js 写库、但没接分发器的脚本进程）
    // data 是事件 data 的 JSON（只含 id、部门名、状态等，不含密码/会话/联系方式，
    // kernel/events.js 在写入前校验）。行只增不删；按人查走 subjectUserId，按类型与时间
    // 段读（将来的 Webhook 中继）走 (type, occurredAt)，全表顺序即 rowid 顺序。
    db.exec(`
      CREATE TABLE IF NOT EXISTS event_outbox (
        id            TEXT PRIMARY KEY,
        type          TEXT NOT NULL,
        occurredAt    TEXT NOT NULL,
        actorId       TEXT,
        subjectUserId TEXT,
        subjectDeptId TEXT,
        data          TEXT NOT NULL,
        version       INTEGER NOT NULL DEFAULT 1,
        dispatchedAt  TEXT,
        attempts      INTEGER NOT NULL DEFAULT 0,
        lastError     TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_outbox_type_time ON event_outbox(type, occurredAt);
      CREATE INDEX IF NOT EXISTS idx_outbox_subject_user ON event_outbox(subjectUserId);
    `);
  } },
  { version: 50, name: "module-migrations", up() {
    // 模块迁移记录（modules/culture/CONTRACT.md 第 8 节；执行器见本文件 runModuleMigrations）。
    // 一行 = 某个模块的一个迁移文件已执行：id 形如 "culture-0001"（文件名去掉 .sql），sha256 按「去掉 UTF-8 BOM、
    // CRLF 换成 LF」之后的文本计算 —— 行尾转换不算改动，内容改了则拒绝启动。表随永开的 core 登记；模块的业务表
    // 由模块自己的 migrations/*.sql 建，不写在本文件里。
    // 注意：schema_migrations 由 MIGRATIONS 与 DATA_MIGRATIONS 共用同一个版本号空间（数据迁移 6、7、11、31、42–44、46
    // 与结构迁移交错），新增任何一条迁移都要取两者之外的新号（51 已由数据迁移 culture-program-record-type、
    // 52 已由数据迁移 rbac-culture-domain、53 已由数据迁移 culture-program-employee-visible、54 已由数据迁移 culture-program-record-options、55 已由数据迁移 terminology-record-labels、56 已由结构迁移 record-option-descriptions、
    // 57 已由数据迁移 terminology-record-labels-2、58 已由结构迁移 ai-governance-schema、59 已由数据迁移 record-fields-ai-share 使用，
    // 下一个可用为 63；59–61 为数据迁移、62 为结构迁移 question-points）。
    db.exec(`
      CREATE TABLE IF NOT EXISTS module_migrations (
        id        TEXT PRIMARY KEY,
        module    TEXT NOT NULL,
        file      TEXT NOT NULL,
        sha256    TEXT NOT NULL,
        appliedAt TEXT NOT NULL
      );
    `);
  } },
  { version: 56, name: "record-option-descriptions", up() {
    // 2026-09-29 批次 3 S5（IA 4.8、D-14，计划 G-09 / R-1115）：选择字段的每个选项可带一句说明（中英各一），用于绩效评级刻度
    // A+…D 的定义 —— 上级评级与 HR 校准的评级按钮悬停显示。两列都是 JSON 数组，与 options 按位置对齐（空串 = 该项没有说明）；
    // 旧库与新库都只加列、不写内容：具体表述由负责人按公司绩效制度提供，在「档案与职级设置」的字段对话框里填写（界面以 IA 4.8
    // 的建议文字作灰色占位提示，不写入数据库）。结构迁移，在 seeding 之前执行。
    if (!columnExists("record_fields", "options_desc")) db.exec("ALTER TABLE record_fields ADD COLUMN options_desc TEXT");
    if (!columnExists("record_fields", "options_desc_zh")) db.exec("ALTER TABLE record_fields ADD COLUMN options_desc_zh TEXT");
  } },
  { version: 58, name: "ai-governance-schema", up() {
    // 2026-09-29 AI 治理（NEXT-WORK/specs/03-ai-governance-spec.md v1.1 第 5.2 节 M-a 至 M-f，合为一条结构迁移）：
    //   M-a record_fields.aiShare：字段是否发给 AI（send 原样 / mask 脱敏 / omit 不发；NULL 按 omit）。内置字段的值由
    //       数据迁移 59 回填（seeding 之后执行，新库与旧库同一路径）；culture-program 类型不回填、不读取（3+3 不涉及 AI）。
    //   M-b talent_portraits（talent 所有）：人才画像草稿与已确认版本。丢弃或到期失效时 content 置空，只留来源信息与处理记录。
    //   M-c attempts.gradingStatus：grading | pending_review | manual_pending | final；历史答卷为 NULL，视同 final。
    //   M-d questions.origin：AI 起草并被采纳的题目的来源信息（JSON）。
    //   M-e ai_calls（core 所有）：每次 AI 调用一行，只记元数据与用量，**不存原文**。
    //   M-f ai_notice_acks（core 所有）：员工对 AI 告知的确认记录，每人每个告知版本一行（不写 audit_logs，见方案 2.6）。
    // 版本号：58 起。schema_migrations 由结构迁移与数据迁移共用一个号空间（59 record-fields-ai-share、60、61 为数据迁移，62 为结构迁移 question-points；下一个可用为 63）。
    if (!columnExists("record_fields", "aiShare")) db.exec("ALTER TABLE record_fields ADD COLUMN aiShare TEXT");
    if (!columnExists("attempts", "gradingStatus")) db.exec("ALTER TABLE attempts ADD COLUMN gradingStatus TEXT");
    if (!columnExists("questions", "origin")) db.exec("ALTER TABLE questions ADD COLUMN origin TEXT");
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_attempts_grading ON attempts(gradingStatus) WHERE gradingStatus IN ('grading','pending_review','manual_pending');
      CREATE TABLE IF NOT EXISTS ai_calls (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        createdAt       TEXT NOT NULL,
        requestId       TEXT,
        actorId         TEXT,
        actorKind       TEXT NOT NULL,
        feature         TEXT NOT NULL,
        subjectUserId   TEXT,
        refId           TEXT,
        providerId      TEXT,
        protocol        TEXT,
        endpointHost    TEXT,
        configHash      TEXT,
        modelRequested  TEXT,
        modelReturned   TEXT,
        promptVersion   TEXT,
        status          TEXT NOT NULL,
        errorCode       TEXT,
        httpStatus      INTEGER,
        attempts        INTEGER NOT NULL DEFAULT 1,
        latencyMs       INTEGER,
        inChars         INTEGER,
        outChars        INTEGER,
        inTokens        INTEGER,
        outTokens       INTEGER,
        tokensEstimated INTEGER NOT NULL DEFAULT 0,
        redactions      TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_ai_calls_created ON ai_calls(createdAt);
      CREATE INDEX IF NOT EXISTS idx_ai_calls_feature ON ai_calls(feature, createdAt);
      CREATE INDEX IF NOT EXISTS idx_ai_calls_actor ON ai_calls(actorId, createdAt);
      CREATE INDEX IF NOT EXISTS idx_ai_calls_subject ON ai_calls(subjectUserId);
      CREATE TABLE IF NOT EXISTS ai_notice_acks (
        userId   TEXT NOT NULL,
        notice   TEXT NOT NULL,
        version  INTEGER NOT NULL,
        ackedAt  TEXT NOT NULL,
        PRIMARY KEY (userId, notice, version)
      );
      CREATE TABLE IF NOT EXISTS talent_portraits (
        id               TEXT PRIMARY KEY,
        userId           TEXT NOT NULL,
        status           TEXT NOT NULL,
        content          TEXT,
        unsupportedCount INTEGER NOT NULL DEFAULT 0,
        providerId       TEXT,
        protocol         TEXT,
        model            TEXT,
        modelReturned    TEXT,
        promptVersion    TEXT,
        callId           INTEGER,
        inputDigest      TEXT,
        demo             INTEGER NOT NULL DEFAULT 0,
        generatedBy      TEXT,
        generatedAt      TEXT NOT NULL,
        confirmedBy      TEXT,
        confirmedAt      TEXT,
        discardedBy      TEXT,
        discardedAt      TEXT,
        discardReason    TEXT,
        objections       TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_talent_portraits_user ON talent_portraits(userId, generatedAt);
    `);
  } },
  { version: 62, name: "question-points", up() {
    // 版本号：schema_migrations 由结构迁移与数据迁移共用一个号空间，59–61 已被数据迁移占用，本条取 62（Milan 10/6 说明里预留给 TMS 侧的编号；下一个可用为 63）。
    // 每题分值（2026-10-06 需求单 #4）：题目可单独设分值（points，空 = 按考试的题型默认分值）；
    // 考试按题型设默认分值（typePoints JSON {mcq,multi,fill,open}，空 = 旧口径：客观题 1 分、简答按满分/10 折算），
    // 以及「多选题部分正确给一半分」开关（multiPartial，默认开 = 原规则）。旧考试与旧答卷口径不变。
    if (!columnExists("questions", "points")) db.exec("ALTER TABLE questions ADD COLUMN points INTEGER");
    if (!columnExists("exams", "typePoints")) db.exec("ALTER TABLE exams ADD COLUMN typePoints TEXT");
    if (!columnExists("exams", "multiPartial")) db.exec("ALTER TABLE exams ADD COLUMN multiPartial INTEGER NOT NULL DEFAULT 1");
  } },
  { version: 63, name: "exam-fixed-questions", up() {
    // 固定题目模式（2026-10-06 需求单 #4 第二步）：mode = 'random'（缺省，按抽题数随机）| 'fixed'（整卷 = questionIds 里的题，按顺序）。
    // 版本号：号空间与数据迁移共用，62 为 question-points，本条 63（64 = rbac-roles-consolidate，65 = review-flow-v2，下一个可用为 66）。
    if (!columnExists("exams", "mode")) db.exec("ALTER TABLE exams ADD COLUMN mode TEXT");
    if (!columnExists("exams", "questionIds")) db.exec("ALTER TABLE exams ADD COLUMN questionIds TEXT");
  } },
  { version: 65, name: "review-flow-v2", up() {
    // 绩效流程 v2（2026-10-06 负责人决定）：员工填表 → 1 对 1 面谈（员工与上级各自确认）→ 上级评级
    // → HoD 按一级部门比例校准并提交 → HR 按部门确认或退回 → 关闭归档。年度周期：HoD 提评级、HR 审核。
    // 版本号：号空间与数据迁移共用，64 = rbac-roles-consolidate，本条 65（下一个可用为 66）。
    //   review_cycles.kind        'quarter'（缺省）| 'annual'
    //   review_cycles.flow        NULL = 旧流程（HR 直接校准、关闭即生效）；'v2' = 走 HoD 校准与 HR 确认，关闭前须各部门已确认
    //   review_cycles.quota       JSON {"A+":2,"A":8,"B+":15,"B":70,"C/D":5}（百分比，按一级部门人数折算名额）
    //   review_cycles.dueRateAt / dueCalibAt  上级评级、HoD 校准截止日（dueAt 仍是自评截止）
    //   review_items.employeeOneOnOneAt  员工确认已面谈；highlights 关键亮点（A+/A 与 C/D 必填）
    //   review_items.hodText / hodAt / hodId  HoD 调整理由与时间（HoD 校准值仍存 finalRating）
    //   review_dept_status        一级部门 × 周期一行：HoD 提交、HR 确认或退回
    for (const [col, type] of [["kind", "TEXT"], ["flow", "TEXT"], ["quota", "TEXT"], ["dueRateAt", "TEXT"], ["dueCalibAt", "TEXT"]]) {
      if (!columnExists("review_cycles", col)) db.exec(`ALTER TABLE review_cycles ADD COLUMN ${col} ${type}`);
    }
    for (const col of ["employeeOneOnOneAt", "highlights", "hodText", "hodAt", "hodId"]) {
      if (!columnExists("review_items", col)) db.exec(`ALTER TABLE review_items ADD COLUMN ${col} TEXT`);
    }
    db.exec(`
      CREATE TABLE IF NOT EXISTS review_dept_status (
        cycleId        TEXT NOT NULL,
        dept1Id        TEXT NOT NULL,
        dept1Name      TEXT,
        hodId          TEXT,
        hodSubmittedAt TEXT,
        hrConfirmedAt  TEXT,
        hrId           TEXT,
        returnedAt     TEXT,
        returnReason   TEXT,
        PRIMARY KEY (cycleId, dept1Id)
      );
    `);
  } },
  { version: 66, name: "project-member-cohort-log", up() {
    // 期次轨迹（负责人 2026-10-07「退训后不再提醒」）：判定「这条指派是不是项目派的」要知道学员在本项目里
    // 待过哪些期次、各从何时到何时。只看当前 cohortId 与 addedAt 不够：调期（moveProjectMember）会改写 cohortId，
    // 重新加入（addProjectMember 的 upsert）保留最初的 addedAt —— 调期前期次派的课退训后照常提醒，
    // 两段之间 HR 另派的课反而被算成项目派的。
    //   project_members.cohortLog  JSON [{ cohortId, enteredAt, leftAt }]，按时间顺序；leftAt 为空 = 这一段还没结束。
    // 由 addProjectMember（新加入、退训后重新加入、在训时换期次）、moveProjectMember（换期次）、withdrawProjectMember
    // （退训：给当前一段收尾）维护。旧行为空，读取时按「当前期次、addedAt 起、未结束」一段处理（调期历史已无从得知），不回填。
    // 版本号：号空间与数据迁移共用，65 = review-flow-v2，本条 66（下一个可用为 67）。
    if (!columnExists("project_members", "cohortLog")) db.exec("ALTER TABLE project_members ADD COLUMN cohortLog TEXT");
  } },
  { version: 67, name: "users-potential-at", up() {
    // 第二批 2.4（2026-10-08，波次 2）：九宫格要判断「潜力评定是否过期」（12 个月，负责人默认 M5），必须知道评定日期；
    // 现有审计没有逐人记录潜力，无从回填。
    //   users.potentialAt  ISO 时间或 NULL。只由 store.updateUser 维护：potential 的值真的变了才写（新值非空 = 当前时间，
    //                      清空 = NULL）；PUT /api/admin/employees/:id 与 bulk-update 都经过它。不回填：迁移前评定的潜力一律
    //                      算「评定日期不详」，九宫格归入过期。
    // 版本号：号空间与数据迁移共用，66 = project-member-cohort-log，68 = perf-talent-people-read（数据迁移），69 = review-hod-proxy，
    // 本条 67（第二批波次 1 预留；下一个可用为 70）。
    if (!columnExists("users", "potentialAt")) db.exec("ALTER TABLE users ADD COLUMN potentialAt TEXT");
  } },
  { version: 69, name: "review-hod-proxy", up() {
    // 第二批 2.2 / 2.7（2026-10-08；负责人已定「上级未评时 HoD 可代评，须写理由、标记、留审计」）：HoD 代评显式记录，
    // 不再由「有终评、没有上级评级、有 hodAt」推导 —— 无 HoD 的组里 HR 评级同样写 hodAt / hodId，推导会把 HR 的评级
    // 误判为代评并挡住上级（审查 P0-2）。
    //   review_items.hodProxy  JSON { by, at, reason } 或 NULL。只由 HoD 代评（季度周期、上级未评时 HoD 定评级）写入；
    //                          HoD 清空评级或改为调整时置 NULL；HR 的各条路径从不写。代评成立 = 季度周期、managerRating 为空、
    //                          finalRating 有值、hodProxy.by = hodId（HR 事后改评级会换掉 hodId，代评标记随之失效）。
    // 版本号：号空间与数据迁移共用，66 = project-member-cohort-log；67、68 预留给第二批波次 2（67 users.potentialAt、
    // 68 perf-talent-people-read，见 docs/HANDOVER-STATUS.md 1.46），本条 69（下一个可用为 70）。不回填：存量的「HoD 评级」
    // 一律按调整处理，上级不会因此被挡住。
    if (!columnExists("review_items", "hodProxy")) db.exec("ALTER TABLE review_items ADD COLUMN hodProxy TEXT");
  } },
  { version: 70, name: "review-appeals", up() {
    // 第二批 2.8（2026-10-08，负责人已定）：绩效申诉 + 部门 → HRBP 分工。
    //   review_cycles.resultsAt       结果正式告知时刻（ISO，取 nowMs()）。关闭周期且「绩效记录」对员工可见、已通知员工时写入；
    //                                 否则由 POST /api/admin/review-cycles/:id/communicate 补写。为空 = 结果尚未正式告知。
    //   review_cycles.appealDeadline  申诉截止日 YYYY-MM-DD（马尼拉日），与 resultsAt 同一笔 UPDATE 写入（审查：截止日不随
    //                                 之后改节假日而变，与通知里写的一致）。resultsAt 有值而 appealDeadline 为空 = 上线前已告知
    //                                 的周期（见下方回填），不开放系统内申诉（负责人：逾期申诉不予处理）。
    //   review_items.closeDept        关闭归档时员工所在部门名（申诉按它路由，审查：关闭后调部门不改变负责的 HRBP）。
    //   review_items.appealFrom / appealDeadline  周期归档的评级在告知之后被 2.6 修改 = 重新告知：修改时刻与新的申诉截止日。
    //   hrbp_assignments              部门（departments.id）→ HRBP（users.id），多对多；向下继承，最近的已指定上级生效。
    //   review_appeals                每个 review_items 最多一行（含已撤回）= 每人每周期一次申诉。conflictIds = 提交时的利益
    //                                 回避名单（JSON 数组），之后只增不减（审查：改上级 / 改部门负责人不能解除回避）。
    //   review_appeal_consults        HRBP 征询部门负责人 / 直属上级的意见（仅内部可见）。
    //   review_appeal_events          处理记录（仅内部可见）。
    // 回填（负责人 2026-10-08「逾期申诉不予处理」）：上线前已关闭、且关闭时已通知员工的周期（发过「评估结果已记入你的成长档案」
    // 通知）resultsAt = closedAt、appealDeadline 留空 → 不开放申诉，也不能再「通知员工并开放申诉」。关闭时结果对员工隐藏、
    // 从未通知过的周期保持 resultsAt 为空，可由 HR 补发通知并开放申诉。
    // 版本号：号空间与数据迁移共用，69 = review-hod-proxy，本条 70（71 = record-type-manager-visible，下一个可用为 72）。
    for (const col of ["resultsAt", "appealDeadline"])
      if (!columnExists("review_cycles", col)) db.exec(`ALTER TABLE review_cycles ADD COLUMN ${col} TEXT`);
    for (const col of ["closeDept", "appealFrom", "appealDeadline"])
      if (!columnExists("review_items", col)) db.exec(`ALTER TABLE review_items ADD COLUMN ${col} TEXT`);
    db.exec(`
      CREATE TABLE IF NOT EXISTS hrbp_assignments (
        deptId    TEXT NOT NULL,
        userId    TEXT NOT NULL,
        createdAt TEXT NOT NULL,
        createdBy TEXT,
        PRIMARY KEY (deptId, userId)
      );
      CREATE INDEX IF NOT EXISTS idx_hrbp_user ON hrbp_assignments(userId);

      CREATE TABLE IF NOT EXISTS review_appeals (
        id              TEXT PRIMARY KEY,
        itemId          TEXT NOT NULL,
        cycleId         TEXT NOT NULL,
        userId          TEXT NOT NULL,
        recordId        TEXT NOT NULL,
        deptId          TEXT,
        deptName        TEXT,
        ratingAtSubmit  TEXT NOT NULL,
        reason          TEXT NOT NULL,
        status          TEXT NOT NULL DEFAULT 'submitted'
                        CHECK (status IN ('submitted','in_review','withdrawn','maintained','adjusted')),
        submittedAt     TEXT NOT NULL,
        windowDeadline  TEXT NOT NULL,
        slaDueOn        TEXT NOT NULL,
        conflictIds     TEXT NOT NULL DEFAULT '[]',
        withdrawnAt     TEXT,
        handlerId       TEXT,
        startedAt       TEXT,
        decidedAt       TEXT,
        decidedBy       TEXT,
        ratingBefore    TEXT,
        newRating       TEXT,
        reply           TEXT,
        internalNote    TEXT,
        remindSoonAt    TEXT,
        remindOverdueOn TEXT,
        escalatedAt     TEXT,
        CHECK (status NOT IN ('in_review','maintained','adjusted') OR handlerId IS NOT NULL),
        CHECK (status NOT IN ('maintained','adjusted') OR (decidedAt IS NOT NULL AND reply IS NOT NULL)),
        CHECK (status <> 'adjusted' OR newRating IS NOT NULL)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_rap_item    ON review_appeals(itemId);
      CREATE INDEX        IF NOT EXISTS idx_rap_cycle   ON review_appeals(cycleId);
      CREATE INDEX        IF NOT EXISTS idx_rap_user    ON review_appeals(userId);
      CREATE INDEX        IF NOT EXISTS idx_rap_status  ON review_appeals(status);
      CREATE INDEX        IF NOT EXISTS idx_rap_dept    ON review_appeals(deptId);
      CREATE INDEX        IF NOT EXISTS idx_rap_handler ON review_appeals(handlerId);
      CREATE INDEX        IF NOT EXISTS idx_rap_record  ON review_appeals(recordId);

      CREATE TABLE IF NOT EXISTS review_appeal_consults (
        id          TEXT PRIMARY KEY,
        appealId    TEXT NOT NULL,
        consulteeId TEXT NOT NULL,
        relation    TEXT NOT NULL CHECK (relation IN ('manager','hod')),
        askedBy     TEXT NOT NULL,
        askedAt     TEXT NOT NULL,
        question    TEXT,
        opinion     TEXT,
        answeredAt  TEXT,
        CHECK ((opinion IS NULL) = (answeredAt IS NULL))
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_rac_pair ON review_appeal_consults(appealId, consulteeId);
      CREATE INDEX        IF NOT EXISTS idx_rac_user ON review_appeal_consults(consulteeId);

      CREATE TABLE IF NOT EXISTS review_appeal_events (
        id       INTEGER PRIMARY KEY AUTOINCREMENT,
        appealId TEXT NOT NULL,
        at       TEXT NOT NULL,
        actorId  TEXT,
        kind     TEXT NOT NULL,
        data     TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_rae_appeal ON review_appeal_events(appealId);
    `);
    db.exec(`UPDATE review_cycles SET resultsAt = COALESCE(closedAt, createdAt)
      WHERE status = 'closed' AND resultsAt IS NULL AND EXISTS (
        SELECT 1 FROM notifications n WHERE n.type = 'review' AND (
          n.title_zh = '「' || review_cycles.name || '」评估结果已记入你的成长档案'
          OR n.title = 'Your ' || review_cycles.name || ' review result has been added to your Development Record'
          OR (n.link = '/record' AND instr(n.title, review_cycles.name) > 0)))`);
  } },
  { version: 71, name: "record-type-manager-visible", up() {
    // 第二批 8.3（F25，2026-10-08）：记录类型「经理可见」开关。关闭 = 该类型的记录不出现在汇报线上级看下属的档案里
    // （GET /api/me/reports/:userId 的时间线、统计与绩效历史），只在后台可见。已有类型默认开；note（备注）原本就对上级隐藏，
    // 默认关，行为不变。新建库由数据迁移 31 按 SEED_RECORD_TYPES 的 mgrVis 种入（结构迁移先于种子，此时表为空）。
    // 版本号：号空间与数据迁移共用，70 = review-appeals，本条 71（下一个可用为 72）。
    if (!columnExists("record_types", "managerVisible")) {
      db.exec("ALTER TABLE record_types ADD COLUMN managerVisible INTEGER NOT NULL DEFAULT 1");
      db.exec("UPDATE record_types SET managerVisible = 0 WHERE key = 'note'");
    }
  } },
  { version: 72, name: "attachment-media", up() {
    // 第三批 5.7（2026-10-08）：PPT 内嵌视频。一份 .pptx 转成 PDF 后，从原文件里取出的每段视频（或外链）一行，
    // 记它在第几页（slides，JSON [{ slideNo, pageNo|null }]）、转码状态与原因；学员翻到该页时在幻灯片下方播放。
    // 读写只经 store 下面这组函数（createAttachmentMedia … listMediaFileKeys），转码引擎在 modules/learning/video-transcode.js。
    // status：pending | transcoding | ready | failed | external | skipped。(attachmentId, seq) 唯一：同一份课件重复提取不会插出重复行。
    // 版本号：号空间与数据迁移共用，70 = review-appeals，71 = record-type-manager-visible，本条 72（下一个可用为 73）。
    db.exec(`
      CREATE TABLE IF NOT EXISTS attachment_media (
        id           TEXT PRIMARY KEY,
        attachmentId TEXT NOT NULL,
        seq          INTEGER NOT NULL,
        kind         TEXT NOT NULL,
        source       TEXT NOT NULL,
        name         TEXT NOT NULL,
        url          TEXT,
        slides       TEXT NOT NULL,
        srcKey       TEXT,
        srcExt       TEXT,
        srcSize      INTEGER,
        storageKey   TEXT,
        size         INTEGER,
        durationSec  REAL,
        status       TEXT NOT NULL,
        reason       TEXT,
        detail       TEXT,
        attempts     INTEGER NOT NULL DEFAULT 0,
        createdAt    TEXT NOT NULL,
        updatedAt    TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_attachment_media_att_seq ON attachment_media(attachmentId, seq);
      CREATE INDEX IF NOT EXISTS idx_attachment_media_status ON attachment_media(status);
    `);
  } },
  { version: 73, name: "question-types-and-exam-options", up() {
    // 第四批 6.1 / 6.2 / 10.6（2026-10-08）：题型注册表与考试选项。
    //   questions.data：新题型（排序 / 匹配 / 分类 / 判断 / 多空填空 / 情境案例）的结构 JSON；旧四种题型（单选 / 多选 / 填空 / 简答）恒为 NULL，
    //     仍用 options / rubric / maxPoints 列，旧行逐字节不变（读写见 rowToQuestion / questionColumns 与 modules/learning/qtypes/）。
    //   exams.shuffleOptions：选项顺序每次随机（1，默认 = 原行为）或按题库顺序固定（0）。排序题与匹配题右栏始终打乱，判断题从不打乱。
    //   exams.partialCredit：排序 / 匹配 / 分类 / 多空填空按答对比例给分（1，默认）或全对才得分（0）。
    //   exams.caseCount：随机抽题时抽几组情境案例（默认 0 = 不抽，旧考试不变）。
    // 版本号：号空间与数据迁移共用，70 = review-appeals，71 = record-type-manager-visible，72 = attachment-media，本条 73（74 = assignment-source，下一个可用为 75）。
    if (!columnExists("questions", "data")) db.exec("ALTER TABLE questions ADD COLUMN data TEXT");
    if (!columnExists("exams", "shuffleOptions")) db.exec("ALTER TABLE exams ADD COLUMN shuffleOptions INTEGER NOT NULL DEFAULT 1");
    if (!columnExists("exams", "partialCredit")) db.exec("ALTER TABLE exams ADD COLUMN partialCredit INTEGER NOT NULL DEFAULT 1");
    if (!columnExists("exams", "caseCount")) db.exec("ALTER TABLE exams ADD COLUMN caseCount INTEGER NOT NULL DEFAULT 0");
  } },
  { version: 74, name: "assignment-source", up() {
    // 第四批 7（2026-10-08）：公开课程。assignments.source：NULL = 指派（HR 单个 / 批量指派、新员工默认、培养项目、选修申请通过），
    //   'self' = 员工在「课程目录」自主加入（自主学习：没有截止日、不进必修完成率、不逾期、不提醒）。
    //   不回填：现有每一行都是指派。HR / 项目 / 审批再指派同一门课时 setAssignment 把 self 改回 NULL（保留原 assignedAt）。
    // 版本号：号空间与数据迁移共用，73 = question-types-and-exam-options，本条 74（下一个可用为 75；第五批预留 80–84）。
    if (!columnExists("assignments", "source")) db.exec("ALTER TABLE assignments ADD COLUMN source TEXT");
  } },
  { version: 80, name: "talent-filters", up() {
    // 第五批 8.1 / 8.2（2026-10-09，设计 b5-design 第 4.1 节）：人才筛选的保存与人工名单，继任行补留痕列。
    //   talent_filters：保存的筛选（definition / columns / sort 为 JSON 文本；builtinKey = 'promotion' 是内置「晋升评审候选」，
    //     由数据迁移 81 写入；version 为乐观锁，每次修改 +1）。
    //   talent_filter_members：只用于内置晋升筛选的人工名单（include 手动加入 / exclude 排除，exclude 必须写 note）。
    //   succession.updatedAt / createdBy / source（manual | import | filter；旧行为 NULL，按 manual 处理）。
    //   succession 不建 (岗位, 继任人) 唯一索引：旧库可能已有重复行，建索引会让迁移失败；去重在应用层做。
    // 版本号：号空间与数据迁移共用，73–79 归第四批，80–84 归第五批（81 = promotion-default-filter；下一个可用为 82）。
    db.exec(`
      CREATE TABLE IF NOT EXISTS talent_filters (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        name_zh     TEXT,
        builtinKey  TEXT UNIQUE,
        definition  TEXT NOT NULL,
        columns     TEXT NOT NULL,
        sort        TEXT,
        visibility  TEXT NOT NULL DEFAULT 'private',
        ownerId     TEXT,
        version     INTEGER NOT NULL DEFAULT 1,
        createdAt   TEXT NOT NULL,
        updatedAt   TEXT NOT NULL,
        updatedBy   TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_tf_owner ON talent_filters(ownerId);
      CREATE TABLE IF NOT EXISTS talent_filter_members (
        filterId  TEXT NOT NULL,
        userId    TEXT NOT NULL,
        mode      TEXT NOT NULL,
        note      TEXT,
        addedBy   TEXT NOT NULL,
        addedAt   TEXT NOT NULL,
        PRIMARY KEY (filterId, userId)
      );
    `);
    if (!columnExists("succession", "updatedAt")) db.exec("ALTER TABLE succession ADD COLUMN updatedAt TEXT");
    if (!columnExists("succession", "createdBy")) db.exec("ALTER TABLE succession ADD COLUMN createdBy TEXT");
    if (!columnExists("succession", "source")) db.exec("ALTER TABLE succession ADD COLUMN source TEXT");
  } },
  { version: 86, name: "workbench-key-positions-tag-events", up() {
    // 12.2 工作台改版（2026-10-09，设计 b12-design 第 4.1、5.3、2.8、6.1 节）：三张新表，全部 IF NOT EXISTS（幂等），不种子数据。
    //   key_positions：关键岗位清单。nameKey = positionKey(name)（modules/talent/filter-model.js，NFKC、小写、去空白与连字符），
    //     全局唯一 —— 继任表的 positionName 不带部门，按名归并才能一一对应；isKey = 1 计入继任覆盖率分母，0 留在清单但不计入；
    //     deptName 记写入时的部门名（部门被删后仍能显示与做范围判定）。归 talent。
    //   talent_tag_events：受控人才标签（高潜 / 关键人才 / 流失风险）的打标留痕，只追加。当前状态的唯一来源仍是 users.talentTags，
    //     本表用于留痕与历史重建（工作台「离职当天是否持有」）；effectiveOn 为 NULL = 打标日期不详（数据迁移 87 写入的存量）。归 talent。
    //   workbench_snapshots：工作台没有历史数据的指标（继任覆盖、管理幅度、流失风险人数）的每日快照，按主体存行（不存汇总数），
    //     读取上期时按查看者的数据范围重算；只保留最近 8 个季度。无对外接口。归 core。
    // 版本号：号空间与数据迁移共用，85 = talent-tags-strip-emoji，本条 86，87 = talent-tags-controlled-map（数据迁移），
    // 88–89 预留给 12.2 返工（90 = exam-pre-notice，91 = talent-filter-role-type-to-track，下一个可用为 92）。
    db.exec(`
      CREATE TABLE IF NOT EXISTS key_positions (
        id         TEXT PRIMARY KEY,
        name       TEXT NOT NULL,
        nameKey    TEXT NOT NULL,
        deptId     TEXT,
        deptName   TEXT,
        isKey      INTEGER NOT NULL DEFAULT 1,
        note       TEXT,
        source     TEXT,
        createdAt  TEXT NOT NULL,
        createdBy  TEXT,
        updatedAt  TEXT,
        updatedBy  TEXT
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_kp_namekey ON key_positions(nameKey);
      CREATE INDEX IF NOT EXISTS idx_kp_dept ON key_positions(deptId);
      CREATE TABLE IF NOT EXISTS talent_tag_events (
        id          TEXT PRIMARY KEY,
        userId      TEXT NOT NULL,
        tagKey      TEXT NOT NULL CHECK (tagKey IN ('hipo','key','flight')),
        action      TEXT NOT NULL CHECK (action IN ('add','remove')),
        reason      TEXT NOT NULL,
        source      TEXT NOT NULL,
        actorId     TEXT,
        actorName   TEXT,
        at          TEXT NOT NULL,
        effectiveOn TEXT,
        requestId   TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_tte_user ON talent_tag_events(userId, at);
      CREATE INDEX IF NOT EXISTS idx_tte_key ON talent_tag_events(tagKey, at);
      CREATE TABLE IF NOT EXISTS workbench_snapshots (
        periodKey TEXT NOT NULL,
        metric    TEXT NOT NULL,
        subjectId TEXT NOT NULL,
        deptName  TEXT,
        data      TEXT NOT NULL,
        takenOn   TEXT NOT NULL,
        PRIMARY KEY (periodKey, metric, subjectId)
      );
    `);
  } },
  { version: 90, name: "exam-pre-notice", up() {
    // F58（负责人 10/9 定）：考试设置「考前须知（选填）」，HR 填写的补充须知，员工考前说明页显示在系统固定须知之后。
    //   exams.preNotice（英文）/ exams.preNotice_zh（中文）：纯文本，各不超过 1000 字，保留换行；NULL = 未填，只显示系统须知。
    //   只加结构、不回填：现有考试一律为 NULL。简答题 AI 初评告知仍写死在 ExamPrep.jsx，不进这两列。
    // 版本号：号空间与数据迁移共用，85 = talent-tags-strip-emoji，86–89 预留给工作台 12.2，本条 90（91 = talent-filter-role-type-to-track，下一个可用为 92）。
    if (!columnExists("exams", "preNotice")) db.exec("ALTER TABLE exams ADD COLUMN preNotice TEXT");
    if (!columnExists("exams", "preNotice_zh")) db.exec("ALTER TABLE exams ADD COLUMN preNotice_zh TEXT");
  } },
  { version: 94, name: "deactivate-demo-admin", up() {
    // CX-048（2026-10-09 上线验收）：DEMO-ADMIN 演示超管在真实库里仍启用、密码公开（manage2026）→ 停用（active = 0，登录 401 disabled，
    // 现有会话作废），一条系统审计 account.deactivate { migration: 94 }。只处理已存在且启用的行：没有这个账号的库不动。
    // 新库：本条放在 MIGRATIONS（createSchema 后、seedFresh / ensureDemoAdmin 之前执行），所以本地开发 / 测试库仍会按 isProduction /
    // LMS_NO_DEMO_USERS 播种演示超管；线上（LMS_NO_DEMO_USERS=1）只有旧库里已存在的行会被停用。幂等。下一个可用 95。
    const row = db.prepare("SELECT id, active FROM users WHERE employeeId = ?").get(DEMO_ADMIN.employeeId);
    if (!row || row.active === 0) return;
    db.prepare("UPDATE users SET active = 0 WHERE id = ?").run(row.id);
    db.prepare("DELETE FROM sessions WHERE userId = ?").run(row.id);
    addAudit({ actorId: null, actorName: null, action: "account.deactivate", target: row.id,
      before: { employeeId: DEMO_ADMIN.employeeId, active: 1 }, after: { active: 0, migration: 94, reason: "CX-048" }, requestId: null });
    console.log("[migration 94] DEMO-ADMIN deactivated (CX-048)");
  } },
  { version: 95, name: "org-performance", up() {
    // 组织绩效（负责人 2026-10-10）：一级部门负责人不走个人绩效，用组织绩效。
    //   orgperf_rounds   互评轮次（按季度）：draft → open → closed；dims = 本轮的评分维度与行为参照（JSON，开轮时定下）
    //   orgperf_targets  开轮时的一级部门快照（被评部门）
    //   orgperf_raters   开轮时的评分人快照：每个有负责人的一级部门一行（raterId = 当时的负责人）；submittedAt = 已提交
    //   orgperf_answers  答卷，按「评分部门 × 被评部门」存（不按人存）：scores = { 维度键: 0–10 }，0 = 不适用；issue = 最需解决的卡点
    //   orgperf_results  季度组织绩效结果（HR 导入的评级），recordId = 写进当时负责人本人档案的绩效记录
    // 匿名（负责人 10/10 定）：任何读接口都不把答卷与评分人对应起来；raters 只用于催办与「谁已提交」。下一个可用迁移号 96。
    db.exec(`
      CREATE TABLE IF NOT EXISTS orgperf_rounds (
        id        TEXT PRIMARY KEY,
        quarter   TEXT NOT NULL,
        name      TEXT NOT NULL,
        status    TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','open','closed')),
        dueOn     TEXT,
        dims      TEXT NOT NULL,
        createdBy TEXT,
        createdAt TEXT NOT NULL,
        openedAt  TEXT,
        closedAt  TEXT
      );
      CREATE TABLE IF NOT EXISTS orgperf_targets (
        roundId  TEXT NOT NULL,
        dept1Id  TEXT NOT NULL,
        dept1    TEXT,
        PRIMARY KEY (roundId, dept1Id)
      );
      CREATE TABLE IF NOT EXISTS orgperf_raters (
        roundId     TEXT NOT NULL,
        dept1Id     TEXT NOT NULL,
        raterId     TEXT NOT NULL,
        submittedAt TEXT,
        remindedAt  TEXT,
        PRIMARY KEY (roundId, dept1Id)
      );
      CREATE INDEX IF NOT EXISTS idx_orgperf_raters_user ON orgperf_raters(raterId);
      CREATE TABLE IF NOT EXISTS orgperf_answers (
        roundId        TEXT NOT NULL,
        raterDept1Id   TEXT NOT NULL,
        targetDept1Id  TEXT NOT NULL,
        scores         TEXT NOT NULL DEFAULT '{}',
        issue          TEXT,
        updatedAt      TEXT NOT NULL,
        PRIMARY KEY (roundId, raterDept1Id, targetDept1Id)
      );
      CREATE TABLE IF NOT EXISTS orgperf_results (
        quarter    TEXT NOT NULL,
        dept1Id    TEXT NOT NULL,
        dept1      TEXT,
        rating     TEXT NOT NULL,
        note       TEXT,
        hodId      TEXT,
        recordId   TEXT,
        importedBy TEXT,
        importedAt TEXT NOT NULL,
        PRIMARY KEY (quarter, dept1Id)
      );
    `);
  } },
  { version: 96, name: "orgperf-issue-required", up() {
    // 组织互评逐部门一屏（负责人 2026-10-10）：「最需解决的卡点」默认选填，HR 建轮时可设为必填（轮次级开关，默认关）。下一个可用迁移号 97。
    if (!columnExists("orgperf_rounds", "issueRequired")) db.exec("ALTER TABLE orgperf_rounds ADD COLUMN issueRequired INTEGER NOT NULL DEFAULT 0");
  } },
  { version: 97, name: "review-appeal-category", up() {
    // 绩效看板第二期（负责人 2026-10-10「原因可分类」）：申诉原因分类，键见 server.js APPEAL_CATEGORIES；旧申诉为 NULL（统计记「未分类」）。
    // 员工提交时选，HRBP 处理时可改正。下一个可用迁移号 98。
    if (!columnExists("review_appeals", "reasonCategory")) db.exec("ALTER TABLE review_appeals ADD COLUMN reasonCategory TEXT");
  } },
  { version: 98, name: "review-appeal-category-submitted", up() {
    // CX-065（负责人 2026-10-11「员工端显示本人原选项」）：员工提交时选的原因另存一列，HRBP 改正只改 reasonCategory（统计口径）。
    // 已有申诉：被改正过的，从审计 review.appeal.category 最早一条的改前值恢复；没改过的，原选项就是现值。下一个可用迁移号 99。
    if (!columnExists("review_appeals", "reasonCategorySubmitted")) db.exec("ALTER TABLE review_appeals ADD COLUMN reasonCategorySubmitted TEXT");
    const first = new Map();
    for (const a of db.prepare("SELECT beforeJson, afterJson FROM audit_logs WHERE action = 'review.appeal.category' ORDER BY id").all()) {
      let before = null, after = null;
      try { before = JSON.parse(a.beforeJson || "null"); after = JSON.parse(a.afterJson || "null"); } catch { continue; }
      const id = after && after.appealId;
      if (id && !first.has(id)) first.set(id, before && before.category ? before.category : null);
    }
    const set = db.prepare("UPDATE review_appeals SET reasonCategorySubmitted = ? WHERE id = ? AND reasonCategorySubmitted IS NULL");
    for (const r of db.prepare("SELECT id, reasonCategory FROM review_appeals").all()) set.run(first.has(r.id) ? first.get(r.id) : r.reasonCategory || null, r.id);
  } },
  { version: 99, name: "orgperf-publish", up() {
    // 组织互评结果发布（负责人 2026-10-12）：HR 结束互评后另行「发布结果」，被评部门负责人才看到本部门得分；
    // 发布后各维度不再按「至少 3 个评分部门」隐藏，卡点只给文字（匿名）。旧轮次为 NULL = 未发布。下一个可用迁移号 100。
    if (!columnExists("orgperf_rounds", "publishedAt")) db.exec("ALTER TABLE orgperf_rounds ADD COLUMN publishedAt TEXT");
  } },
];

// Data migrations run AFTER seeding (see init), so a fresh database gets its
// seed content first and is then migrated exactly like an existing one.
const DATA_MIGRATIONS = [
  { version: 6, name: "programs-to-exams", up() {
    // Every program's legacy exam config becomes a real exam: "{Title} Final
    // Exam", linked to all of the program's courses. Deterministic id
    // (exam-<programId>) + INSERT OR IGNORE make re-runs harmless.
    const now = new Date().toISOString();
    const insExam = db.prepare(
      `INSERT OR IGNORE INTO exams (id, programId, title, title_zh, status, passingScore, mcqCount, openCount, timeLimitMinutes, maxAttempts, retakeCooldownHours, showAnswersAfterExam, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, 'published', ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const insLink = db.prepare("INSERT OR IGNORE INTO exam_courses (examId, courseId, sortOrder) VALUES (?, ?, ?)");
    for (const r of db.prepare("SELECT json FROM content WHERE kind = 'program'").all()) {
      const p = JSON.parse(r.json);
      const examId = "exam-" + p.id;
      insExam.run(
        examId, p.id, `${p.title} Final Exam`, p.title_zh ? `${p.title_zh}结业考试` : null,
        p.passingScore || 80, p.examMcqCount || 8, p.examOpenCount ?? 1,
        p.examTimeLimitMinutes || null, p.maxAttempts || 0, p.retakeCooldownHours || 0,
        p.showAnswersAfterExam === false ? 0 : 1, now, now
      );
      (p.courseIds || []).forEach((cid, i) => insLink.run(examId, cid, i));
    }
  } },
  { version: 7, name: "attempts-backfill-examId", up() {
    // Historic attempts keep programId (reports) and gain the migrated examId.
    db.exec("UPDATE attempts SET examId = 'exam-' || programId WHERE examId IS NULL");
  } },
  { version: 11, name: "enroll-requests-into-approvals", up() {
    // Phase A: the elective-enrollment approval becomes the first kind on the
    // unified approvals engine. Copy legacy rows (idempotent via PK); the old
    // enrollment_requests table is kept as an archive and no longer written.
    const ins = db.prepare(`INSERT OR IGNORE INTO approvals
      (id, kind, subjectJson, requesterId, targetUserId, note, status, decidedBy, decideNote, requestedAt, decidedAt)
      VALUES (?, 'enroll', ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const r of db.prepare("SELECT * FROM enrollment_requests").all())
      ins.run(r.id, JSON.stringify({ programId: r.programId }), r.userId, r.userId, r.note, r.status, r.decidedBy, r.decideNote, r.requestedAt, r.decidedAt);
  } },
  { version: 31, name: "talent-config-seed", up() {
    // Built-in record types & fields are system CONFIG (production needs them
    // too — they are not demo data). Seeded once here; afterwards HR owns them
    // in the console: edits are never overwritten, deletions never resurrected.
    // Lifecycle types (入转调离) make the timeline a full employee history:
    // hire is the timeline anchor (users.hireDate), the rest are records.
    // managerVisible（迁移 71）：结构迁移先于本条执行，新建库此时已有该列，按种子的 mgrVis 写入（note = 0）。
    const insT = db.prepare("INSERT OR IGNORE INTO record_types (key, label, label_zh, color, builtin, active, sort, employeeVisible, managerVisible) VALUES (?, ?, ?, ?, 1, 1, ?, ?, ?)");
    SEED_RECORD_TYPES.forEach((t, i) => insT.run(t.key, t.label, t.label_zh, t.color, i, t.empVis, t.mgrVis));
    const insF = db.prepare("INSERT OR IGNORE INTO record_fields (id, typeKey, key, label, label_zh, input, options, options_zh, required, showInTimeline, filterable, sort, active) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)");
    const optCsv = (s) => (s ? JSON.stringify(String(s).split(",").map((x) => x.trim())) : null);
    SEED_RECORD_FIELDS.forEach((f, i) => {
      const options = optCsv(f[5]);
      // The seed ships the lists already split, so a brand-new database is born
      // correct and migration 41 finds nothing to do there. options_zh mirrors
      // options item-for-item when a seed row carries no separate Chinese list.
      const optionsZh = options ? optCsv(f[6]) || options : null;
      insF.run("rf-" + (i + 1), f[0], f[1], f[2], f[3], f[4], options, optionsZh, f[7], f[8], f[9], i);
    });
    setMeta("nextRF", SEED_RECORD_FIELDS.length + 1);
    // Register every department name already present on users as a managed
    // departments row. New names arriving later are auto-registered on write.
    for (const r of db.prepare("SELECT DISTINCT department AS d FROM users WHERE department IS NOT NULL AND department != ''").all())
      ensureDepartment(r.d);
  } },
  { version: 42, name: "unfreeze-auto-derived-record-titles", up() {
    // deriveRecordTitle used to fall back to the record TYPE's label when there was
    // nothing data-derived to name a record with — and talent_records has no
    // title_zh, so that froze one language into the row forever (a record created
    // from a Chinese screen reads "Note" in every UI, and vice versa). The server
    // now stores an empty title for that case and every surface prints the type
    // name in the reader's own language instead. These are the rows already frozen.
    // Only an EXACT match on either label is cleared: an HR-typed title that merely
    // contains the type name is their words, not ours.
    const types = db.prepare("SELECT key, label, label_zh FROM record_types").all();
    const clear = db.prepare("UPDATE talent_records SET title = '' WHERE id = ?");
    let n = 0;
    for (const r of db.prepare("SELECT id, type, title FROM talent_records").all()) {
      const t = types.find((x) => x.key === r.type);
      if (!t) continue;
      const title = String(r.title || "").trim();
      if (!title) continue;
      if (title === String(t.label || "").trim() || title === String(t.label_zh || "").trim()) { clear.run(r.id); n++; }
    }
    if (n) console.log(`[migration 42] cleared ${n} auto-derived record title(s)`);
  } },
  { version: 43, name: "drop-record-type-icon", up() {
    // 去 emoji 之后这一列全库是 NULL，界面上也不再有输入入口，读写路径已经拆掉。
    // 留着一个死列的坏处不是占空间，是下一个人会以为「图标」是个功能，并且它是
    // 重新引入 emoji 的现成入口。
    // SQLite 3.35+ 支持 DROP COLUMN；这一列不是主键也没有索引，可以直接删。
    if (columnExists("record_types", "icon")) db.exec("ALTER TABLE record_types DROP COLUMN icon");
  } },
  { version: 44, name: "rbac-roles-foundation", up() {
    // RBAC P1 的数据地基：一张 roles 表 + users.adminRoleId 外键列 + 6 个内置角色。
    // 放在 DATA_MIGRATIONS（seeding 之后）而非 MIGRATIONS，是为了让「把现有 admin
    // 映射成超管」那一步在全新库上也命中 —— 全新库的 ADMIN 是 seedFresh 建的，早于
    // 本迁移；既有库的 admin 本就在库里。两种库走同一条 UPDATE，一视同仁。
    // 全程幂等：表用 IF NOT EXISTS、列用 pragma 守卫、角色按 key OR IGNORE、映射带
    // adminRoleId IS NULL 前提，再跑一遍什么都不改。
    db.exec(`
      CREATE TABLE IF NOT EXISTS roles (
        id        INTEGER PRIMARY KEY AUTOINCREMENT,
        key       TEXT UNIQUE,            -- 内置角色的稳定 slug；自定义角色为 NULL（UNIQUE 容许多个 NULL）
        name      TEXT NOT NULL,
        name_zh   TEXT,
        grants    TEXT NOT NULL,          -- JSON：能力域各一档 {manage|read|none}，全列（P1 为 8 域，D6/迁移 46 起 9 域）
        scope     TEXT NOT NULL DEFAULT '{}', -- JSON：数据范围，空 {} = 全公司；P1 只存不强制
        builtin   INTEGER NOT NULL DEFAULT 0,
        createdAt TEXT NOT NULL
      );
    `);
    // users 加 adminRoleId（→ roles.id，NULL=普通员工）。role 列保留做向后兼容。
    if (!columnExists("users", "adminRoleId")) db.exec("ALTER TABLE users ADD COLUMN adminRoleId INTEGER");
    // 6 个内置角色，按 key 幂等 seed（编辑过的行不会被覆盖，删掉的也不会复活）。
    const now = new Date().toISOString();
    const insRole = db.prepare("INSERT OR IGNORE INTO roles (key, name, name_zh, grants, scope, builtin, createdAt) VALUES (?, ?, ?, ?, '{}', 1, ?)");
    for (const r of SEED_ROLES) insRole.run(r.key, r.name, r.name_zh, JSON.stringify(fullGrants(r.grants)), now);
    // 既有/新建的 admin（role='admin'）→ 内置超管。带 adminRoleId IS NULL 前提，
    // 已被指派过其它角色的人不动。
    const sa = db.prepare("SELECT id FROM roles WHERE key = 'super-admin'").get();
    if (sa) db.prepare("UPDATE users SET adminRoleId = ? WHERE role = 'admin' AND adminRoleId IS NULL").run(sa.id);
  } },
  { version: 46, name: "rbac-split-accounts-roles", up() {
    // D6（2026-08-28）：能力域从 8 拆到 9。原「账号与角色 accounts」一域拆为
    // accounts（员工账号，可授予+受范围约束）与 roles（角色与授权，恒超管、不可授予）。
    // 给已有的 roles 行补第 9 键 roles：super-admin → manage（真正的提权面仍归超管），
    // 其余一律 none。accounts 键原样保留（原来只有 super-admin 是 manage，其余 none，
    // 因为拆分前 accounts 从不可授予；拆分后 accounts 的含义变窄为「员工账号」，旧值
    // 语义仍成立）。放在 DATA_MIGRATIONS（seeding 之后）确保 v44 的 roles 表与内置角色
    // 已就位。全程幂等：把每行 grants 过一遍 fullGrants（9 域全列）+ 按 key 重置 roles
    // 键，再跑一遍结果不变。rowToRole/resolveGrants 对缺键本就按 none 兜底，此迁移是把
    // super-admin 的 roles=manage 显式落库、并让存储形态与 9 域契约一致（供角色页矩阵）。
    const rows = db.prepare("SELECT id, key, grants FROM roles").all();
    const upd = db.prepare("UPDATE roles SET grants = ? WHERE id = ?");
    let n = 0;
    for (const r of rows) {
      let g; try { g = JSON.parse(r.grants || "{}"); } catch { g = {}; }
      g.roles = r.key === "super-admin" ? "manage" : "none";
      upd.run(JSON.stringify(fullGrants(g)), r.id);
      n++;
    }
    if (n) console.log(`[migration 46] backfilled roles domain on ${n} role row(s)`);
  } },
  { version: 51, name: "culture-program-record-type", up() {
    // 人才记录类型 culture-program「行为实践 / Behavior Practice」及其字段（modules/culture/CONTRACT.md 6.1；
    // PHASE2-KERNEL.md 1.6）。core 订阅 culture.program.completed，在计分冻结时为每名参与者写一条正式人才记录
    // （modules/core/hooks.js），字段取自事件 data；记录日期取 data.endDate（第 W 周宽限结束日），不取事件时间。
    // 版本号：schema_migrations 由结构迁移与数据迁移共用一个号空间（50 已被 module_migrations 占用），本条取 51；
    // culture 能力域的授权补齐（原计划的 47）留给登记 culture 的那一步，取 52。
    // builtin = 1：core 的订阅依赖它，界面上不可删除（可停用）。employeeVisible 在这里按 0 种入；2026-09-28 负责人定为
    // 员工本人可见，由数据迁移 53 改为 1（已执行过本条的库同样被改到）；track 与 participantStatus 的选项在这里按内部键种入，由数据迁移 54
    // 改为可读的英文（Leader / Team member、Full program / Left early）。本条保持原样，不再改动。
    // 所属模块：culture 关闭时这个类型不出现在字段设置与新建记录的类型选择里，已有记录照常显示（server.js RECORD_TYPE_MODULE）。
    // 只增不改：类型或字段已存在（HR 手工建过同 key 的类型、或重跑）时保留原样。
    // 字段标签与档案「行为实践」页签、学员端同一叫法（行为实践记录 / Practice records；2026-09-26 评审修正，此前的
    // 「周五真事」是内部叫法）。本迁移尚未在正式库执行（活库停在 v46），所以直接改这里，不另加迁移。
    const insT = db.prepare("INSERT OR IGNORE INTO record_types (key, label, label_zh, color, builtin, active, sort, employeeVisible) VALUES (?, ?, ?, ?, 1, 1, ?, 0)");
    const sort = db.prepare("SELECT COALESCE(MAX(sort), -1) + 1 AS n FROM record_types").get().n;
    insT.run("culture-program", "Behavior Practice", "行为实践", "#d9480f", sort);
    // [key, label(EN), label_zh, input, options, options_zh, required, showInTimeline, filterable]
    const fields = [
      ["programName", "Program", "项目名称", "text", null, null, 1, 1, 1],
      ["startDate", "Start date", "开始日期", "date", null, null, 0, 0, 0],
      ["track", "Track", "轨道", "select", ["leader", "employee"], ["领导者", "追随者"], 0, 1, 1],
      ["participantStatus", "Participation", "参与状态", "select", ["active", "left"], ["全程参与", "中途离开"], 0, 0, 1],
      ["dept1", "Level-1 department", "一级部门", "text", null, null, 0, 0, 1],
      ["weeksMet", "Weeks met", "达标周数", "number", null, null, 0, 1, 0],
      ["weeksRequired", "Weeks required", "要求周数", "number", null, null, 0, 0, 0],
      ["totalPoints", "Total points", "总积分", "number", null, null, 0, 1, 0],
      ["tasksSubmitted", "Practice records submitted", "行为实践记录提交数", "number", null, null, 0, 0, 0],
      ["tasksWitnessed", "Practice records witnessed", "行为实践记录被见证数", "number", null, null, 0, 0, 0],
      ["cardsGiven", "Cards given", "送出认可卡", "number", null, null, 0, 0, 0],
      ["cardsReceived", "Cards received", "收到认可卡", "number", null, null, 0, 0, 0],
    ];
    const has = db.prepare("SELECT 1 FROM record_fields WHERE typeKey = 'culture-program' AND key = ?");
    const insF = db.prepare("INSERT OR IGNORE INTO record_fields (id, typeKey, key, label, label_zh, input, options, options_zh, required, showInTimeline, filterable, sort, active) VALUES (?, 'culture-program', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)");
    let next = Number(getMeta("nextRF") || 1);
    fields.forEach((f, i) => {
      if (has.get(f[0])) return;
      while (db.prepare("SELECT 1 FROM record_fields WHERE id = ?").get("rf-" + next)) next++;
      insF.run("rf-" + next, f[0], f[1], f[2], f[3], f[4] ? JSON.stringify(f[4]) : null, f[5] ? JSON.stringify(f[5]) : null, f[6], f[7], f[8], i);
      next++;
    });
    setMeta("nextRF", next);
  } },
  { version: 52, name: "rbac-culture-domain", up() {
    // 登记 culture 模块（2026-09-26）：能力域从 9 个变为 10 个，新增 culture「行为实践 / Behavior Practice」。
    // 仿照迁移 46，给已有的 roles 行补 culture 键：super-admin → manage、内置 hrbp → read（modules/culture/CONTRACT.md
    // 2.1 的授权口径），其余角色（含自定义角色）→ none。HR/TD 项目运营人员的 culture: manage 由超管在角色页用自定义
    // 角色授予，本迁移不替任何人授权。
    // 只补缺键：行里已有合法的 culture 档（全新库由迁移 44 按新种子写入）时原样保留；super-admin 恒为 manage
    // （锁定角色，与种子一致）。每行过一遍 fullGrants，存储形态与 10 域清单一致、键序与 RBAC_DOMAINS 相同。
    // 版本号：schema_migrations 由结构迁移与数据迁移共用一个号空间，50、51 已占用，本条取 52。
    const rows = db.prepare("SELECT id, key, grants FROM roles").all();
    const upd = db.prepare("UPDATE roles SET grants = ? WHERE id = ?");
    let n = 0;
    for (const r of rows) {
      let g; try { g = JSON.parse(r.grants || "{}"); } catch { g = {}; }
      if (!g || typeof g !== "object" || Array.isArray(g)) g = {};
      if (r.key === "super-admin") g.culture = "manage";
      else if (g.culture !== "manage" && g.culture !== "read" && g.culture !== "none") g.culture = r.key === "hrbp" ? "read" : "none";
      upd.run(JSON.stringify(fullGrants(g)), r.id);
      n++;
    }
    if (n) console.log(`[migration 52] backfilled culture domain on ${n} role row(s)`);
  } },
  { version: 53, name: "culture-program-employee-visible", up() {
    // 2026-09-28 负责人拍板：人才记录类型 culture-program「行为实践」改为员工本人可见 —— 员工在「我的记录」（GET /api/me/growth，
    // 只列 employeeVisible = 1 的类型）里能看到自己的行为实践结业记录。沿用迁移 34 的 employeeVisible 机制；迁移 51 仍按 0 种入，
    // 由本条把已有库（含已经执行过 51 的库）一并改为 1。本条只执行一次，HR 之后关掉的选择不会被改回来。
    // 关掉的入口：culture 开启时在「字段设置」里关（类型的「员工可见」开关，或逐个字段的「时间线显示」）；culture 关闭时字段设置
    // 按负责人决定不列出这个类型（server.js RECORD_TYPE_MODULE），而已有记录照常显示给员工 —— 这时要收回，由 IT 临时开启 culture
    // 后在字段设置里关，或由管理员调 POST /api/admin/config/record-types（带 employeeVisible: false），见 HANDOVER-STATUS 1.15.2。
    // 版本号：schema_migrations 由结构迁移与数据迁移共用一个号空间，50–52 已占用，本条取 53。
    const r = db.prepare("UPDATE record_types SET employeeVisible = 1 WHERE key = 'culture-program' AND employeeVisible = 0").run();
    if (r.changes) console.log("[migration 53] culture-program records are now visible to the employee");
  } },
  { version: 54, name: "culture-program-record-options", up() {
    // 2026-09-28 评审修正：迁移 51 按内部键种入了 culture-program 的两个选择字段 —— 轨道 track 的 options 为 ["leader","employee"]，
    // 参与状态 participantStatus 为 ["active","left"]。options 同时是存储值与英文显示名（迁移 41），所以英文界面的档案时间线与
    // 「我的记录」显示「Track employee」，而同一页的「行为实践」页签写的是 Team member track；迁移 53 之后员工本人也看得到这条记录。
    // 本条把英文改为产品用语（与档案「行为实践」页签、学员端同一叫法），中文不变、按位置对齐：
    //   track：Leader / Team member（领导者 / 追随者）；participantStatus：Full program / Left early（全程参与 / 中途离开）。
    // 与迁移 41 同一口径：只改仍是种子原样的清单（或已是新值 —— 重跑时只补中文与记录）；HR 改过的清单是 HR 的，不动。改了清单的
    // 字段，已写入的 culture-program 记录里存的旧键一并换成新值，否则记录与自己字段的选项对不上（显示为原始键、编辑时报
    // field_option、人才检索的分面把同一选项算成两个）。新记录由 modules/core/hooks.js 在写入时把事件里的 leader / employee、
    // active / left 换成这里的值（两处的值由 test/culture-record-options.test.js 核对一致）；事件 data（CONTRACT.md 6.1）不变。
    // 迁移 51 保持原样。
    // 版本号：schema_migrations 由结构迁移与数据迁移共用一个号空间，50–53 已占用，本条取 54（下一个可用为 55）。
    // [字段 key, 种子 options, 新 options（英文显示名 = 存储值）, 种子 options_zh]
    const LISTS = [
      ["track", ["leader", "employee"], ["Leader", "Team member"], ["领导者", "追随者"]],
      ["participantStatus", ["active", "left"], ["Full program", "Left early"], ["全程参与", "中途离开"]],
    ];
    const parseArr = (s) => { try { const a = JSON.parse(s || "[]"); return Array.isArray(a) ? a.map(String) : []; } catch { return []; } };
    const sameArr = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
    const getF = db.prepare("SELECT id, options, options_zh FROM record_fields WHERE typeKey = 'culture-program' AND key = ?");
    const updF = db.prepare("UPDATE record_fields SET options = ?, options_zh = ? WHERE id = ?");
    const renames = {};   // 字段 key → { 旧键: 新值 }，只含本条认领了清单的字段
    for (const [key, seeded, en, seededZh] of LISTS) {
      const row = getF.get(key);
      if (!row) continue;
      const now = parseArr(row.options);
      if (!sameArr(now, seeded) && !sameArr(now, en)) continue;
      // 中文名可能被 HR 单独改过（清单本身没动）：等长且不缺项就保留，否则用种子
      const zhNow = parseArr(row.options_zh);
      const zh = zhNow.length === en.length && zhNow.every((z) => z.trim()) ? zhNow : seededZh;
      updF.run(JSON.stringify(en), JSON.stringify(zh), row.id);
      renames[key] = Object.fromEntries(seeded.map((v, i) => [v, en[i]]));
    }
    if (!Object.keys(renames).length) return;
    const updR = db.prepare("UPDATE talent_records SET detail = ? WHERE id = ?");
    let n = 0;
    for (const r of db.prepare("SELECT id, detail FROM talent_records WHERE type = 'culture-program'").all()) {
      let d;
      try { d = JSON.parse(r.detail || "{}"); } catch { continue; }
      if (!d || typeof d !== "object" || Array.isArray(d)) continue;
      let hit = false;
      for (const [key, m] of Object.entries(renames)) {
        if (typeof d[key] === "string" && Object.hasOwn(m, d[key])) { d[key] = m[d[key]]; hit = true; }
      }
      if (hit) { updR.run(JSON.stringify(d), r.id); n++; }
    }
    if (n) console.log(`[migration 54] rewrote track / participation values on ${n} culture-program record(s)`);
  } },
  { version: 55, name: "terminology-record-labels", up() {
    // 2026-09-28 第三批用语（信息架构与用语方案 A-50、B-C06、B-C07；负责人拍板 B）：culture-program 两个选择字段的英文与学员端、
    // 档案「行为实践」页签统一 —— track：Team member → Team Member；participantStatus：Full program → Full participation。
    // 中文不变（追随者 / 全程参与），Leader、Left early 不变。口径与迁移 54 相同：只改仍为迁移 54 结果的清单（或已是本条的新值 ——
    // 重跑时只补记录）；HR 改过的清单不动。认领了清单的字段，已写入的 culture-program 记录里的旧值一并换成新值；新记录由
    // modules/core/hooks.js › OPTION_VALUES 在写入时给出同一值（test/culture-record-options.test.js 核对两处一致）。事件 data 不变。
    // 本条按 2026-09-28 16:20 的范围调整只含这两个选项；计划 R-372 中其余 TMS 记录类型与字段标签的改名未做，留给后续批次，
    // 届时另起新号（56 起），不改本条。迁移 54 保持原样。
    // [字段 key, 迁移 54 的 options, 新 options（英文显示名 = 存储值）]
    const LISTS = [
      ["track", ["Leader", "Team member"], ["Leader", "Team Member"]],
      ["participantStatus", ["Full program", "Left early"], ["Full participation", "Left early"]],
    ];
    const parseArr = (s) => { try { const a = JSON.parse(s || "[]"); return Array.isArray(a) ? a.map(String) : []; } catch { return []; } };
    const sameArr = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
    const getF = db.prepare("SELECT id, options FROM record_fields WHERE typeKey = 'culture-program' AND key = ?");
    const updF = db.prepare("UPDATE record_fields SET options = ? WHERE id = ?");
    const renames = {};   // 字段 key → { 旧值: 新值 }，只含本条认领了清单的字段
    for (const [key, prev, next] of LISTS) {
      const row = getF.get(key);
      if (!row) continue;
      const now = parseArr(row.options);
      if (!sameArr(now, prev) && !sameArr(now, next)) continue;
      if (!sameArr(now, next)) updF.run(JSON.stringify(next), row.id);
      renames[key] = Object.fromEntries(prev.map((v, i) => [v, next[i]]).filter(([a, b]) => a !== b));
    }
    if (!Object.keys(renames).length) return;
    const updR = db.prepare("UPDATE talent_records SET detail = ? WHERE id = ?");
    let n = 0;
    for (const r of db.prepare("SELECT id, detail FROM talent_records WHERE type = 'culture-program'").all()) {
      let d;
      try { d = JSON.parse(r.detail || "{}"); } catch { continue; }
      if (!d || typeof d !== "object" || Array.isArray(d)) continue;
      let hit = false;
      for (const [key, m] of Object.entries(renames)) {
        if (typeof d[key] === "string" && Object.hasOwn(m, d[key])) { d[key] = m[d[key]]; hit = true; }
      }
      if (hit) { updR.run(JSON.stringify(d), r.id); n++; }
    }
    if (n) console.log(`[migration 55] rewrote Team Member / Full participation values on ${n} culture-program record(s)`);
  } },
  { version: 57, name: "terminology-record-labels-2", up() {
    // 2026-09-29 批次 3 S5（IA 5.4、B-S01–B-S03、B-C18、D-27；计划 R-372 的其余部分）：内置记录类型与字段标签改名。
    // 只改仍等于旧默认值（种子或迁移 51 写入的原样）的行，HR 在「档案与职级设置」里改过的名称不动；中英两列同时等于旧值才改。
    //   绩效 → 绩效记录 / Performance Record：成长轨迹上的这一条是周期关闭后的结果，与「绩效评估」（流程与员工端入口）区分；
    //   四个字段 评估周期 / 绩效评级 / 绩效得分 / 评语（Summary → Comments）；绩效得分评估流程不写入，仍为种子原样（名称未改、
    //   仍启用）时一并停用，HR 手工录入仍可在字段设置里重新启用；
    //   晋升晋级 → 晋升；违规 → 违纪记录 / Disciplinary Record（D-27 ①）；
    //   行为实践记录（culture-program）三个字段：期次名称 / Cohort、必修周数 / Required weeks、发出认可卡 / Cards given。
    // 只改标签（显示名），不动选项、不动已写入的记录 —— 记录 detail 以字段 key 存值，标签不进数据。
    // 种子（SEED_RECORD_TYPES、SEED_RECORD_FIELDS、迁移 51）保持原样：新建库在 seeding 之后同样执行本条，得到相同结果。
    // [key, [旧 label, 旧 label_zh], [新 label, 新 label_zh]]
    const TYPES = [
      ["performance", ["Performance", "绩效"], ["Performance Record", "绩效记录"]],
      ["promotion", ["Promotion", "晋升晋级"], ["Promotion", "晋升"]],
      ["violation", ["Violation", "违规"], ["Disciplinary Record", "违纪记录"]],
    ];
    // [typeKey, key, [旧 label, 旧 label_zh], [新 label, 新 label_zh]]
    const FIELDS = [
      ["performance", "period", ["Period", "期间"], ["Review Cycle", "评估周期"]],
      ["performance", "rating", ["Rating", "评级"], ["Performance Rating", "绩效评级"]],
      ["performance", "score", ["Score", "分数"], ["Performance Score", "绩效得分"]],
      ["performance", "summary", ["Summary", "评语"], ["Comments", "评语"]],
      ["culture-program", "programName", ["Program", "项目名称"], ["Cohort", "期次名称"]],
      ["culture-program", "weeksRequired", ["Weeks required", "要求周数"], ["Required weeks", "必修周数"]],
      ["culture-program", "cardsGiven", ["Cards given", "送出认可卡"], ["Cards given", "发出认可卡"]],
    ];
    const updT = db.prepare("UPDATE record_types SET label = ?, label_zh = ? WHERE key = ? AND label = ? AND label_zh = ?");
    for (const [key, [oe, oz], [ne, nz]] of TYPES) updT.run(ne, nz, key, oe, oz);
    const getF = db.prepare("SELECT id, label, label_zh, input, active FROM record_fields WHERE typeKey = ? AND key = ?");
    const updF = db.prepare("UPDATE record_fields SET label = ?, label_zh = ? WHERE id = ?");
    for (const [typeKey, key, [oe, oz], [ne, nz]] of FIELDS) {
      const row = getF.get(typeKey, key);
      if (!row || row.label !== oe || (row.label_zh || "") !== oz) continue;
      updF.run(ne, nz, row.id);
      // 绩效得分：评估流程不写入；仍为种子原样（数字字段、启用中）时停用
      if (typeKey === "performance" && key === "score" && row.input === "number" && row.active) db.prepare("UPDATE record_fields SET active = 0 WHERE id = ?").run(row.id);
    }
  } },
  { version: 59, name: "record-fields-ai-share", up() {
    // 2026-09-29 AI 治理（方案 2.2.3 D、5.2 M-a）：内置记录字段「是否发给 AI」的上线基线。只写 aiShare 仍为 NULL 的行
    // （重复执行无害）。自由文本（评语、描述、评委意见、试用期评价、原因、颁发方）一律 omit；调动的部门名为 mask（按部门占位
    // 发送）。离职（exit）与备注（note）两类在画像输入构建器里整条硬编码排除，这里同样写 omit；HR 自定义类型的字段写 omit
    // （放宽只限超级管理员，并须先经法务在 DPIA 中确认）。行为实践（culture-program）类型的字段不回填、也不读取（3+3 不涉及 AI）。
    const BASE = {
      performance: { period: "send", rating: "send", score: "send", summary: "omit" },
      training: { programName: "send", period: "send", result: "send", score: "send", rank: "send" },
      award: { awardName: "send", programName: "send", issuer: "omit" },
      violation: { severity: "send", description: "omit", action: "omit" },
      promotion: { fromLevel: "send", toLevel: "send", method: "send", result: "send", score: "send", comments: "omit", syncLevel: "omit" },
      regularization: { result: "send", review: "omit", syncStatus: "omit" },
      transfer: { fromDept: "mask", toDept: "mask", fromPosition: "send", toPosition: "send", reason: "omit", syncDept: "omit" },
    };
    const upd = db.prepare("UPDATE record_fields SET aiShare = ? WHERE typeKey = ? AND key = ? AND aiShare IS NULL");
    for (const [typeKey, fields] of Object.entries(BASE))
      for (const [key, v] of Object.entries(fields)) upd.run(v, typeKey, key);
    db.prepare("UPDATE record_fields SET aiShare = 'omit' WHERE aiShare IS NULL AND typeKey != 'culture-program'").run();
  } },
  { version: 60, name: "culture-track-follower", up() {
    // 2026-09-30 负责人提供 Action 挑战的标准英文版本（Digiplus 3+3 Code of Conduct），追随者的英文统一为 Follower：
    // culture-program 的 track 选项 Team Member → Follower（中文「追随者」不变，Leader 不变）。口径与迁移 55 相同：只改仍为迁移 55
    // 结果的清单（或已是本条的新值 —— 重跑时只补记录）；HR 改过的清单不动。认领了清单时，已写入的 culture-program 记录里的旧值一并
    // 换成新值；新记录由 modules/core/hooks.js › OPTION_VALUES 写入同一值。事件 data 不变（仍是内部键 employee）。迁移 55 保持原样。
    const PREV = ["Leader", "Team Member"], NEXT = ["Leader", "Follower"];
    const parseArr = (s) => { try { const a = JSON.parse(s || "[]"); return Array.isArray(a) ? a.map(String) : []; } catch { return []; } };
    const sameArr = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
    const row = db.prepare("SELECT id, options FROM record_fields WHERE typeKey = 'culture-program' AND key = 'track'").get();
    if (!row) return;
    const now = parseArr(row.options);
    if (!sameArr(now, PREV) && !sameArr(now, NEXT)) return;
    if (!sameArr(now, NEXT)) db.prepare("UPDATE record_fields SET options = ? WHERE id = ?").run(JSON.stringify(NEXT), row.id);
    const updR = db.prepare("UPDATE talent_records SET detail = ? WHERE id = ?");
    let n = 0;
    for (const r of db.prepare("SELECT id, detail FROM talent_records WHERE type = 'culture-program'").all()) {
      let d;
      try { d = JSON.parse(r.detail || "{}"); } catch { continue; }
      if (!d || typeof d !== "object" || Array.isArray(d) || d.track !== "Team Member") continue;
      d.track = "Follower";
      updR.run(JSON.stringify(d), r.id); n++;
    }
    if (n) console.log(`[migration 60] rewrote Team Member → Follower on ${n} culture-program record(s)`);
  } },
  { version: 61, name: "performance-rating-descriptions", up() {
    // Unfolding Lab 版（2026-10-12）：原为 DigiPlus 绩效制度各档评级的正式说明（英文原文 + 中文译文），本产品不预置任何公司的制度文字。
    // 保留版本号（迁移号空间连续），不写任何内容：各档说明由 HR 在「系统设置 › 档案与职级设置 › 绩效」里自行填写。
  } },
  { version: 64, name: "rbac-roles-consolidate", up() {
    // 负责人 2026-10-06：内置角色收敛为 4 个（见 SEED_ROLES 注释）。版本号：号空间与结构迁移共用，63 为 exam-fixed-questions，
    // 本条 64（65 = review-flow-v2，下一个可用为 66）。全程幂等，再跑一遍什么都不改：
    //   1) performance-admin 行就地改为 performance-talent-admin（沿用 id，成员不动，grants 加 talent=manage）；
    //      talent-admin 的成员并入后删行；
    //   2) 按 SEED_ROLES 补种缺失的内置角色（admin，以及 1) 没能就地改出来时的 performance-talent-admin）；
    //   3) auditor 的成员改挂 admin（负责人：「不需要审计员，换成管理员」），删行；
    //   4) hrbp：有成员 → 转为自定义角色（builtin=0、key=NULL，名称与数据范围原样保留，超管可在角色页删除），不给成员扩权；
    //      没成员 → 删行。
    const now = new Date().toISOString();
    const byKey = (k) => db.prepare("SELECT id, grants FROM roles WHERE key = ?").get(k);
    const parse = (t) => { try { const g = JSON.parse(t || "{}"); return g && typeof g === "object" && !Array.isArray(g) ? g : {}; } catch { return {}; } };
    const members = (id) => db.prepare("SELECT COUNT(*) AS n FROM users WHERE adminRoleId = ?").get(id).n;
    const moveMembers = db.prepare("UPDATE users SET adminRoleId = ? WHERE adminRoleId = ?");
    const delRole = db.prepare("DELETE FROM roles WHERE id = ?");
    const log = [];
    const perf = byKey("performance-admin");
    if (perf && !byKey("performance-talent-admin")) {
      const g = parse(perf.grants); g.performance = "manage"; g.talent = "manage";
      db.prepare("UPDATE roles SET key = 'performance-talent-admin', name = ?, name_zh = ?, grants = ? WHERE id = ?")
        .run("Performance & Talent Admin", "绩效与人才管理员", JSON.stringify(fullGrants(g)), perf.id);
      log.push("performance-admin -> performance-talent-admin");
    }
    const insRole = db.prepare("INSERT OR IGNORE INTO roles (key, name, name_zh, grants, scope, builtin, createdAt) VALUES (?, ?, ?, ?, '{}', 1, ?)");
    for (const r of SEED_ROLES) { if (insRole.run(r.key, r.name, r.name_zh, JSON.stringify(fullGrants(r.grants)), now).changes) log.push("seeded " + r.key); }
    const pt = byKey("performance-talent-admin"), tal = byKey("talent-admin");
    if (tal && pt) { const n = moveMembers.run(pt.id, tal.id).changes; delRole.run(tal.id); log.push("talent-admin merged (" + n + " member(s))"); }
    const adm = byKey("admin"), aud = byKey("auditor");
    if (aud && adm) { const n = moveMembers.run(adm.id, aud.id).changes; delRole.run(aud.id); log.push("auditor -> admin (" + n + " member(s))"); }
    const hr = byKey("hrbp");
    if (hr) {
      if (members(hr.id) > 0) { db.prepare("UPDATE roles SET key = NULL, builtin = 0 WHERE id = ?").run(hr.id); log.push("hrbp kept as custom role"); }
      else { delRole.run(hr.id); log.push("hrbp removed"); }
    }
    if (log.length) console.log("[migration 64] " + log.join("; "));
  } },
  { version: 68, name: "perf-talent-people-read", up() {
    // 第二批 2.3（负责人 2026-10-07 定「绩效与人才管理员开员工档案只读权限」，方案 A = 给角色加 people:read，见
    // RBAC-DESIGN.md §7 的 10/7 补记）：内置角色由 INSERT OR IGNORE 种入（SEED_ROLES），已有库不会自动补上新授权，
    // 所以这里把 key = performance-talent-admin 的那一行 people 从 none 改为 read。已是 read / manage 的不动（不降级）；
    // 角色行不存在（超管删过或从未种入）什么也不做。幂等：再跑一遍什么都不改。写回用 fullGrants 保证全部能力域全列。
    // 版本号：号空间与结构迁移共用，67 = users-potential-at，69 = review-hod-proxy，本条 68（第二批波次 1 预留；下一个可用为 70）。
    const row = db.prepare("SELECT id, grants FROM roles WHERE key = 'performance-talent-admin'").get();
    if (!row) return;
    let g = {};
    try { const p = JSON.parse(row.grants || "{}"); if (p && typeof p === "object" && !Array.isArray(p)) g = p; } catch {}
    if (g.people === "read" || g.people === "manage") return;
    g.people = "read";
    db.prepare("UPDATE roles SET grants = ? WHERE id = ?").run(JSON.stringify(fullGrants(g)), row.id);
    console.log("[migration 68] performance-talent-admin: people none -> read");
  } },
  { version: 81, name: "promotion-default-filter", up() {
    // 第五批 8.1（2026-10-09，设计 b5-design 第 5.1 节）：旧的五项晋升规则（meta promotionConfig，与 PROMO_DEFAULTS 合并）
    // 转为内置筛选「晋升评审候选」（builtinKey = 'promotion'，共享）。条件叶子带标签（nextLevel / rating / tenure / trainings /
    // violations），GET/PUT /api/admin/promotion-config 靠标签读写。在种子之后执行，所以评级字段的选项已经存在。
    // 口径按设置页文案统一（负责人 2026-10-08 确认）：必修课程全部完成（选修、自主学习不计）；近 N 个月无违纪记录不限严重度，
    // 除非设置了只看重大违纪。meta promotionConfig 保留不删（回退版本时还能用）。旧 minRating 不在评级选项中时去掉这条叶子
    // （旧代码此时 minIdx = -1，也等于不设门槛）。幂等：builtinKey 已存在就跳过。
    // 版本号：号空间与结构迁移共用，80 = talent-filters，本条 81（82–84 预留给第五批返工）。
    if (db.prepare("SELECT 1 FROM talent_filters WHERE builtinKey = 'promotion'").get()) return;
    let cfg = {};
    try { const p = JSON.parse(getMeta("promotionConfig") || "{}"); if (p && typeof p === "object" && !Array.isArray(p)) cfg = p; } catch {}
    const rf = listRecordFields("performance").find((f) => f.key === "rating");
    const row = TALENT_FILTER_MODEL.promotionFilterRow(cfg, rf ? rf.options : []);
    if (row.dropped) console.log(`[migration 81] minRating "${cfg.minRating}" is not a configured rating option — rating condition dropped`);
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO talent_filters (id, name, name_zh, builtinKey, definition, columns, sort, visibility, ownerId, version, createdAt, updatedAt, updatedBy)
                VALUES ('tf-promotion', ?, ?, 'promotion', ?, ?, ?, 'shared', NULL, 1, ?, ?, NULL)`)
      .run(row.name, row.name_zh, JSON.stringify(row.definition), JSON.stringify(row.columns), JSON.stringify(row.sort), now, now);
  } },
  { version: 85, name: "talent-tags-strip-emoji", up() {
    // F48（负责人 2026-10-09 定：界面文字与标签不用 emoji）：清洗已存进库里的人才标签。演示数据（seedTalentDemo、
    // scripts/seed-demo-complete.js）曾写入「🌟 高潜 HiPo」「🔑 关键人才 Key talent」「🧭 骨干 Core performer」等。
    // 标签存在 users.talentTags（JSON 字符串数组），另有人才筛选里「人才标签」条件的取值（talent_filters.definition 中
    // field = "talentTag" 的叶子 value）——两处一起清洗，筛选才不会因改名而失配。没有单独的标签字典表（预设标签在前端
    // People.jsx 的 PRESET_TAGS，本就没有 emoji）。
    // 规则：去掉标签首尾的 emoji（含肤色修饰、ZWJ、VS16、旗帜）及其后/前的空白；© ® ™ ↔ ↕ 这类排版符号不算 emoji。
    // 清洗后与同一人已有的标签重名 → 合并为一个（保留首次出现的位置）；整条只剩 emoji → 清洗后为空，去掉。
    // 有改动时写一条系统审计（actorId / actorName 为空 = 界面显示「系统」，与 server.js auditSystem 同一写法）。
    // 幂等：第二次执行找不到带 emoji 的标签，不改数据、不写审计。版本号：82–84 预留给第五批返工，本条 85。
    const EMOJI = "[[\\p{Extended_Pictographic}\\p{Emoji_Modifier}\\p{Regional_Indicator}\\u200D\\uFE0F\\u20E3]--[\\u00A9\\u00AE\\u2122\\u2194\\u2195]]";
    const LEAD = new RegExp("^\\s*" + EMOJI + "+\\s*", "v");
    const TRAIL = new RegExp("\\s*" + EMOJI + "+\\s*$", "v");
    const renamed = {};
    // 只有真的去掉了 emoji 的列表才改写（并在该列表内去重）；不带 emoji 的列表原样不动。
    const clean = (list) => {
      let stripped = false;
      const vals = list.map((t) => {
        if (typeof t !== "string" || !(LEAD.test(t) || TRAIL.test(t))) return t;
        const v = t.replace(LEAD, "").replace(TRAIL, "").trim();
        renamed[t] = v;
        stripped = true;
        return v;
      });
      if (!stripped) return { dirty: false };
      const out = [], seen = new Set();
      let merged = 0;
      for (const v of vals) {
        if (v === "") continue;
        const k = typeof v === "string" ? v : JSON.stringify(v);
        if (seen.has(k)) { merged++; continue; }
        seen.add(k);
        out.push(v);
      }
      return { dirty: true, out, merged };
    };
    let people = 0, merged = 0, filters = 0;
    const upd = db.prepare("UPDATE users SET talentTags = ? WHERE id = ?");
    for (const u of db.prepare("SELECT id, talentTags FROM users WHERE talentTags IS NOT NULL AND talentTags NOT IN ('', '[]')").all()) {
      let tags;
      try { tags = JSON.parse(u.talentTags); } catch { continue; }
      if (!Array.isArray(tags)) continue;
      const r = clean(tags);
      if (!r.dirty) continue;
      upd.run(JSON.stringify(r.out), u.id);
      people++;
      merged += r.merged;
    }
    const now = new Date().toISOString();
    for (const f of db.prepare("SELECT id, definition FROM talent_filters").all()) {
      let def;
      try { def = JSON.parse(f.definition); } catch { continue; }
      let dirty = false;
      TALENT_FILTER_MODEL.walkLeaves(def, (leaf) => {
        if (!leaf || leaf.field !== "talentTag" || !Array.isArray(leaf.value)) return;
        const r = clean(leaf.value);
        if (r.dirty) { leaf.value = r.out; dirty = true; merged += r.merged; }
      });
      if (!dirty) continue;
      db.prepare("UPDATE talent_filters SET definition = ?, version = version + 1, updatedAt = ? WHERE id = ?").run(JSON.stringify(def), now, f.id);
      filters++;
    }
    if (!people && !filters) return;
    addAudit({ actorId: null, actorName: null, action: "talent.tags.strip-emoji", target: "talentTags",
      before: null, after: { migration: 85, people, filters, duplicatesMerged: merged, renamed }, requestId: null });
    console.log(`[migration 85] talent tags: emoji stripped for ${people} people and ${filters} filters, ${merged} duplicates merged`);
  } },
  { version: 87, name: "talent-tags-controlled-map", up() {
    // 12.2 受控人才标签（2026-10-09，设计 b12-design 第 5.2、6.2 节）：存量标签中能映射到「高潜 / 关键人才 / 流失风险」的写法
    // （「🌟 高潜 HiPo」「HiPo」「Hi-Po」「高潜」「Key talent」「离职风险」……，白名单只在 modules/talent/controlled-tags.js）规范为
    // canonical 值（「高潜 HiPo」「关键人才 Key talent」「流失风险 Flight risk」），同一人重复的合并；映射不了的保留为普通标签。
    // 对「当前持有某受控标签、事件表里没有该人该标签任何事件」的人补写一条 add 事件（source migration、操作人为空 = 系统、
    // effectiveOn 为空 = 打标日期不详）；已保存筛选里 talentTag 叶子的取值同样映射、去重（version + 1）；有改动时写一条系统审计
    // talent.tags.controlled-map。实现在 controlledTagsMap（seedTalentDemo 写入演示标签后也调用它）。幂等。
    // 版本号：号空间与结构迁移共用，86 = workbench-key-positions-tag-events，本条 87（88–89 预留给 12.2 返工；90、91 已用，下一个可用为 92）。
    controlledTagsMap(87);
  } },
  { version: 91, name: "talent-filter-role-type-to-track", up() {
    // F61（负责人 2026-10-09「一起删除，track 就是 role type」）：人才筛选的「管理者 / 个人贡献者」条件（field = "isManager"）
    // 停用，改由职级通道（jobTrack）表达。已保存的筛选里这类叶子按 filter-model.js retiredLeafToTrack 改写：
    //   isTrue（管理者）→ jobTrack in ["M"]（管理通道）；isFalse（个人贡献者）→ jobTrack in ["P"]（专业通道）。
    // 对应不了的叶子（运算符不认识，或当前职级体系 meta jobGradeConfig 里没有该通道）原样保留：校验降为警告 field_retired，
    // 运行时忽略，界面提示「该条件已停用，请改用岗位序列」。有改写的筛选 version + 1（乐观锁，打开着的编辑页保存时会提示刷新）。
    // 有改写时写一条系统审计（actorId / actorName 为空 = 「系统」，同迁移 85；对应不了而保留的叶子列在 retiredLeft）。
    // 幂等：第二次执行找不到可改写的叶子，不改数据、不写审计。
    // 版本号：号空间与结构迁移共用，85 = talent-tags-strip-emoji，86–89 预留给工作台 12.2，90 = exam-pre-notice，本条 91（下一个可用为 92）。
    let ranks = null;
    try { const g = JSON.parse(getMeta("jobGradeConfig") || "null"); if (g && Array.isArray(g.ranks)) ranks = g.ranks; } catch {}
    const now = new Date().toISOString();
    const changed = [], kept = [];
    let leaves = 0;
    for (const f of db.prepare("SELECT id, name, definition FROM talent_filters").all()) {
      let def;
      try { def = JSON.parse(f.definition); } catch { continue; }
      if (!def || !Array.isArray(def.items)) continue;
      let dirty = 0, left = 0;
      const map = (leaf) => {
        if (!leaf || leaf.field !== "isManager") return leaf;
        const t = TALENT_FILTER_MODEL.retiredLeafToTrack(leaf, ranks || []);
        if (!t) { left++; return leaf; }
        dirty++;
        return t;
      };
      def.items = def.items.map((it) => (it && Array.isArray(it.items) ? { ...it, items: it.items.map(map) } : map(it)));
      if (left) kept.push({ id: f.id, name: f.name, leaves: left });
      if (!dirty) continue;
      leaves += dirty;
      db.prepare("UPDATE talent_filters SET definition = ?, version = version + 1, updatedAt = ? WHERE id = ?").run(JSON.stringify(def), now, f.id);
      changed.push({ id: f.id, name: f.name, leaves: dirty });
    }
    if (!changed.length) {
      if (kept.length) console.log(`[migration 91] talent filters: ${kept.reduce((n, k) => n + k.leaves, 0)} role-type condition(s) could not be mapped to a career track and stay retired`);
      return;
    }
    addAudit({ actorId: null, actorName: null, action: "talent.filter.role-type-to-track", target: "talent_filters",
      before: null, after: { migration: 91, filters: changed.length, leaves, changed, retiredLeft: kept }, requestId: null });
    console.log(`[migration 91] talent filters: ${leaves} role-type condition(s) in ${changed.length} filter(s) moved to career track; ${kept.reduce((n, k) => n + k.leaves, 0)} left as retired`);
  } },
  { version: 92, name: "promotion-threshold-f62", up() {
    // F62（负责人 2026-10-09 定：晋升评审候选按公司晋升门槛重设内置条件）。新默认见 filter-model.js PROMO_DEFAULTS：
    //   ① 有下一职级；② 过去 12 个月绩效无 C / D（perfRecent + withinMonths:12，窗内各期均 ≥ B）；③ 近 2 期任一期 ≥ B+；
    //   ④ 现职级任职满 12 个月（新字段 levelTenureMonths）；⑤ 近 12 个月无违纪记录（所有严重度）。去掉「必修课程全部完成」与司龄。
    // 内置筛选「晋升评审候选」（builtinKey = promotion）：
    //   · 从未被改过（updatedBy 为空，且定义与 F62 之前的默认逐条相同）→ 直接换成新默认（定义；列若仍是旧默认列也换成新默认列），version + 1；
    //   · 被 HR 改过 → 原样保留，写 meta promotionDefaultsPending = "92"，界面提示「默认条件已更新，可恢复默认」；
    //     HR 恢复默认（或保存的定义与新默认相同）时 server.js 清掉这个 meta。
    //   · 已经是新默认（新库：迁移 81 直接按新默认建行）→ 不改、不写审计。
    // meta promotionConfig 同步为新定义推出的配置（与 PUT /promotion-config 一致）。有动作时写一条系统审计 promotion.defaults-update。
    // 幂等：第二次执行时定义已是新默认（或 pending 已写）→ 不改数据、不写审计。
    // 版本号：号空间与结构迁移共用，91 = talent-filter-role-type-to-track，本条 92（下一个可用为 93）。
    const row = db.prepare("SELECT id, definition, columns, version, updatedBy FROM talent_filters WHERE builtinKey = 'promotion'").get();
    if (!row) return;
    let def;
    try { def = JSON.parse(row.definition); } catch { return; }
    const rf = listRecordFields("performance").find((f) => f.key === "rating");
    const opts = rf ? rf.options : [];
    if (TALENT_FILTER_MODEL.isPromotionDefault(def, opts)) return;
    const now = new Date().toISOString();
    const untouched = !row.updatedBy && TALENT_FILTER_MODEL.isLegacyPromotionDefault(def, opts);
    if (untouched) {
      const fresh = TALENT_FILTER_MODEL.promotionFilterRow(TALENT_FILTER_MODEL.PROMO_DEFAULTS, opts);
      let cols = null;
      try { cols = JSON.parse(row.columns); } catch {}
      const legacyCols = JSON.stringify(cols) === JSON.stringify(TALENT_FILTER_MODEL.LEGACY_PROMO_COLUMNS);
      db.prepare("UPDATE talent_filters SET definition = ?, columns = ?, version = version + 1, updatedAt = ? WHERE id = ?")
        .run(JSON.stringify(fresh.definition), legacyCols ? JSON.stringify(fresh.columns) : row.columns, now, row.id);
      setMeta("promotionConfig", JSON.stringify(TALENT_FILTER_MODEL.promotionConfigOf(fresh.definition)));
      setMeta("promotionDefaultsPending", "");
      addAudit({ actorId: null, actorName: null, action: "promotion.defaults-update", target: row.id,
        before: { summary: "legacy default" }, after: { migration: 92, applied: true, columnsUpdated: legacyCols }, requestId: null });
      console.log("[migration 92] promotion panel criteria: built-in filter was untouched → replaced with the F62 defaults");
      return;
    }
    if (getMeta("promotionDefaultsPending") === "92") return;
    setMeta("promotionDefaultsPending", "92");
    addAudit({ actorId: null, actorName: null, action: "promotion.defaults-update", target: row.id,
      before: null, after: { migration: 92, applied: false, reason: row.updatedBy ? "modified_by_hr" : "definition_differs" }, requestId: null });
    console.log("[migration 92] promotion panel criteria: built-in filter was modified → kept as is; the page offers 'restore defaults'");
  } },
  { version: 93, name: "promotion-threshold-f62-missing-fail", up() {
    // F62 补充（负责人 2026-10-09 改口径）：条件 ②「近 12 个月无 C / D」窗内没有评级 → 不通过；条件 ③「近 2 期任一期 ≥ B+」只有 1 期 → 不通过
    // （两条叶子的 missing 由 ignore 改为 fail）。迁移 92 已按首版（ignore）写入的库：内置筛选仍是首版默认且未被人改过（updatedBy 为空）
    // → 换成修正后的默认，version + 1，审计 promotion.defaults-update { migration: 93, applied: true }；其余（被 HR 改过、或已是修正后默认）不动。
    // 新库：迁移 81 直接按修正后的默认建行 → 不改、不写审计。幂等。版本号：本条 93（下一个可用为 94）。
    const row = db.prepare("SELECT id, definition, updatedBy FROM talent_filters WHERE builtinKey = 'promotion'").get();
    if (!row) return;
    let def;
    try { def = JSON.parse(row.definition); } catch { return; }
    const rf = listRecordFields("performance").find((f) => f.key === "rating");
    const opts = rf ? rf.options : [];
    if (TALENT_FILTER_MODEL.isPromotionDefault(def, opts)) return;
    if (row.updatedBy || !TALENT_FILTER_MODEL.isInterimPromotionDefault(def, opts)) return;
    const fresh = TALENT_FILTER_MODEL.promotionFilterRow(TALENT_FILTER_MODEL.PROMO_DEFAULTS, opts);
    db.prepare("UPDATE talent_filters SET definition = ?, version = version + 1, updatedAt = ? WHERE id = ?").run(JSON.stringify(fresh.definition), new Date().toISOString(), row.id);
    setMeta("promotionConfig", JSON.stringify(TALENT_FILTER_MODEL.promotionConfigOf(fresh.definition)));
    addAudit({ actorId: null, actorName: null, action: "promotion.defaults-update", target: row.id,
      before: { summary: "F62 interim default (missing: ignore)" }, after: { migration: 93, applied: true }, requestId: null });
    console.log("[migration 93] promotion panel criteria: F62 interim default → no rating in the window / fewer than 2 periods now fail");
  } },
];

// Built-in talent record types (入转调离 + 绩效/培训/荣誉/违规/晋级/备注).
// Job-grade catalog seed (Unfolding Lab 版通用职级，2026-10-12): [rank, grade, level, track].
// Dual track — P 专业通道 P1–P10、M 管理通道 M1–M7；grade = 职等（D 初级 / C 中级 / B 高级 / A 专家 / E 高管与首席），
// level = 序号，跨通道同序号即同级（M1≈P4、M2≈P5 … M7≈P10）。HR edits the live catalog in Settings (meta jobGradeConfig).
// 测试库改用 test/fixtures/job-grades-test.json（test/helpers.js 设 LMS_TEST_JOB_GRADES），测试断言按那套写。
const JOB_GRADES = [
  ["P1", "D", 1, "P"], ["P2", "D", 2, "P"],
  ["P3", "C", 3, "P"], ["P4", "C", 4, "P"],
  ["P5", "B", 5, "P"], ["P6", "B", 6, "P"],
  ["P7", "A", 7, "P"], ["P8", "A", 8, "P"],
  ["P9", "E", 9, "P"], ["P10", "E", 10, "P"],
  ["M1", "C", 4, "M"],
  ["M2", "B", 5, "M"], ["M3", "B", 6, "M"],
  ["M4", "A", 7, "M"], ["M5", "A", 8, "M"],
  ["M6", "E", 9, "M"], ["M7", "E", 10, "M"],
];
function seedJobGrades() {
  const fx = process.env.LMS_TEST_JOB_GRADES;
  if (fx) {
    try { const j = JSON.parse(fs.readFileSync(fx, "utf8")); if (j && Array.isArray(j.ranks) && j.ranks.length) return j.ranks; } catch {}
  }
  return JOB_GRADES.map(([rank, grade, level, track]) => ({ rank, grade, level, track }));
}

// empVis: shows in the employee's own growth timeline (violation/exit/note
// stay HR-only by default; HR can flip any of these in Settings).
// mgrVis（迁移 71，第二批 8.3）：shows in the reporting line's view of the person (GET /api/me/reports/:userId);
// note stays hidden from managers, as it always was.
// label = English, label_zh = Chinese, matching loc(obj, "label") everywhere else.
// They used to be one bilingual string ("绩效 Performance"), which printed both
// languages at once. icon is empty on purpose: the console carries no emoji, and a
// type is identified by its name and colour.
const SEED_RECORD_TYPES = [
  { key: "performance",    label: "Performance",    label_zh: "绩效",     color: "#4636e3", empVis: 1, mgrVis: 1 },
  { key: "training",       label: "Training",       label_zh: "培训",     color: "#7c5cff", empVis: 1, mgrVis: 1 },
  { key: "award",          label: "Award",          label_zh: "荣誉",     color: "#b8860b", empVis: 1, mgrVis: 1 },
  { key: "violation",      label: "Violation",      label_zh: "违规",     color: "#e0453f", empVis: 0, mgrVis: 1 },
  { key: "promotion",      label: "Promotion",      label_zh: "晋升晋级", color: "#009a29", empVis: 1, mgrVis: 1 },
  { key: "regularization", label: "Regularization", label_zh: "转正",     color: "#0e7c66", empVis: 1, mgrVis: 1 },
  { key: "transfer",       label: "Transfer",       label_zh: "调动",     color: "#00a2c8", empVis: 1, mgrVis: 1 },
  { key: "exit",           label: "Exit",           label_zh: "离职",     color: "#7a4a2b", empVis: 0, mgrVis: 1 },
  { key: "note",           label: "Note",           label_zh: "备注",     color: "#86909c", empVis: 0, mgrVis: 0 },
];
// [typeKey, key, label(EN), label_zh(中文), input, optionsCsv(EN=存储值), optionsCsv_zh(中文显示), required, showInTimeline, filterable]
// 两种语言分列存放（标签的形状由 migration 39 定下，选项由 41）。种子必须自己就是
// 拆好的：schema migration 在 seeding 之前跑，所以 39/41 在全新库上处理的是一张空表，
// 混排的标签与选项都会被这份种子重新插回去。
// options 的每一项同时是写进 talent_records.detail 的值 —— applyRecordSideEffects 的
// passOk 正则和人才检索的 facets 都按它匹配，所以「英文显示名」与「存储值」必须是同一
// 个字符串。options_zh 只负责显示：等长、同序，没有独立中文形态的（A+、B）与 options
// 逐项相同。
const SEED_RECORD_FIELDS = [
  ["performance", "period", "Period", "期间", "text", "", "", 1, 1, 1],
  ["performance", "rating", "Rating", "评级", "select", "A+,A,B+,B,C,D", "A+,A,B+,B,C,D", 0, 1, 1],
  ["performance", "score", "Score", "分数", "number", "", "", 0, 1, 0],
  ["performance", "summary", "Summary", "评语", "textarea", "", "", 0, 1, 0],
  ["training", "programName", "Program", "项目名称", "text", "", "", 1, 1, 1],
  ["training", "period", "Period", "期间", "text", "", "", 0, 1, 0],
  ["training", "result", "Result", "结果", "suggest", "Completed,Distinction,Incomplete", "结业,优秀,未完成", 0, 1, 1],
  ["training", "score", "Score", "成绩", "number", "", "", 0, 1, 0],
  ["training", "rank", "Rank", "排名", "text", "", "", 0, 1, 0],
  ["award", "awardName", "Award", "奖项", "suggest", "Top learner,Best team member,Most improved", "优秀学员,优秀团队成员,最佳进步", 1, 1, 1],
  ["award", "programName", "Program", "关联项目", "text", "", "", 0, 1, 1],
  ["award", "issuer", "Issuer", "颁发方", "text", "", "", 0, 1, 0],
  ["violation", "severity", "Severity", "严重度", "select", "Minor,Major", "轻微,重大", 1, 1, 1],
  ["violation", "description", "Description", "描述", "textarea", "", "", 0, 1, 0],
  ["violation", "action", "Action", "处理", "text", "", "", 0, 1, 0],
  ["promotion", "fromLevel", "From", "原职级", "level", "", "", 0, 1, 1],
  ["promotion", "toLevel", "To", "新职级", "level", "", "", 1, 1, 1],
  ["promotion", "method", "Method", "方式", "select", "Defense,Direct", "答辩,直接", 0, 1, 1],
  ["promotion", "result", "Result", "结果", "select", "Passed,Failed", "通过,未通过", 1, 1, 1],
  ["promotion", "score", "Score", "答辩评分", "number", "", "", 0, 1, 0],
  ["promotion", "comments", "Comments", "评委意见", "textarea", "", "", 0, 1, 0],
  ["promotion", "syncLevel", "Update current level", "同步更新当前职级", "checkbox", "", "", 0, 0, 0],
  ["regularization", "result", "Result", "结果", "select", "On time,Extended,Failed", "按期转正,延期转正,未通过", 1, 1, 1],
  ["regularization", "review", "Review", "试用期评价", "textarea", "", "", 0, 1, 0],
  ["regularization", "syncStatus", "Set status to regular", "同步员工状态为正式", "checkbox", "", "", 0, 0, 0],
  ["transfer", "fromDept", "From dept", "原部门", "department", "", "", 0, 1, 1],
  ["transfer", "toDept", "To dept", "新部门", "department", "", "", 1, 1, 1],
  ["transfer", "fromPosition", "From position", "原职位", "text", "", "", 0, 1, 0],
  ["transfer", "toPosition", "To position", "新职位", "text", "", "", 0, 1, 0],
  ["transfer", "reason", "Reason", "原因", "textarea", "", "", 0, 1, 0],
  ["transfer", "syncDept", "Update current dept/position", "同步更新当前部门/职位", "checkbox", "", "", 0, 0, 0],
  ["exit", "exitType", "Exit type", "离职类型", "select", "Voluntary,Involuntary,Contract end", "主动离职,被动离职,合同到期", 1, 1, 1],
  ["exit", "lastDay", "Last day", "最后工作日", "date", "", "", 0, 1, 0],
  ["exit", "reason", "Reason", "原因", "textarea", "", "", 0, 1, 0],
  ["exit", "syncStatus", "Set exited & deactivate account", "同步状态为离职并停用账号", "checkbox", "", "", 0, 0, 0],
  ["note", "text", "Text", "内容", "textarea", "", "", 1, 1, 0],
];

// RBAC P1/D6（角色与授权）。10 个能力域，每域一档 level ∈ manage|read|none。授权档
// 存进 roles.grants 的 JSON 时必须全部能力域全列 —— fullGrants 把任何半写对象补齐成
// 全列，读取端（rowToRole）也过一遍它，容忍历史/半写行。JSON key 用这些英文 slug，
// 与 server.js / 前端契约逐字一致。
// D6（2026-08-28）：原「账号与角色 accounts」一域拆为二 —— accounts（员工账号：
// 建号/重置/停用，可授予且受部门范围约束）与 roles（角色与授权：建/改/删角色、指派
// adminRoleId，恒超管、不可授予，接管原 accounts 的锁定语义）。
// 2026-09-26：登记 culture 模块，新增能力域 culture「行为实践 / Behavior Practice」（manifest order 45，
// 排在 talent 与 fields 之间；受数据范围约束，由模块按 rbac.scopePredicate 等逐人过滤）。这份清单与
// modules/*/manifest.js 生成的 RBAC_DOMAINS、web/src/rbac.js、Roles.jsx 必须逐项相等（test/m0-route-guard.test.js）。
const RBAC_DOMAINS = ["people", "learning", "performance", "talent", "fields", "brand", "audit", "accounts", "roles"];
function fullGrants(partial) {
  const g = {};
  const p = partial && typeof partial === "object" ? partial : {};
  for (const d of RBAC_DOMAINS) g[d] = p[d] === "manage" || p[d] === "read" ? p[d] : "none";
  return g;
}
// 4 个内置角色（builtin=1，按 key seed）。grants 只写非 none 的域，其余由 fullGrants 补成 none。
// 负责人 2026-10-06 定「每个模块一个管理员角色，其余由超管自建」：
//   super-admin 超级管理员：全部能力域 manage（含 accounts 与 roles；roles 恒超管专属、不可授予），锁定不可编辑删除；
//   admin 管理员：除 roles 外全部能力域 manage（含 culture、audit、accounts），取代原「只读审计员」；
//   learning-admin 培训管理员：learning manage；
//   performance-talent-admin 绩效与人才管理员：performance + talent manage（原「绩效管理员」与「人才管理员」合并），
//     另带 people read（负责人 2026-10-07：员工档案只读，第二批 2.3；已有库由数据迁移 68 补上）。
// 原 auditor / performance-admin / talent-admin / hrbp 四个内置角色由数据迁移 64 收敛（成员随迁、HRBP 有成员时转为自定义角色）。
// culture（modules/culture/CONTRACT.md 2.1）：HR/TD 项目运营人员若不该拿「管理员」的全部权限，仍由超管建自定义角色授予
// culture: manage。已有库的角色行由数据迁移 52 补齐 culture 键。
const SEED_ROLES = [
  { key: "super-admin",      name: "Super Admin",       name_zh: "超级管理员", grants: { people: "manage", learning: "manage", performance: "manage", talent: "manage", culture: "manage", fields: "manage", brand: "manage", audit: "manage", accounts: "manage", roles: "manage" } },
  { key: "admin",            name: "Admin",             name_zh: "管理员",     grants: { people: "manage", learning: "manage", performance: "manage", talent: "manage", culture: "manage", fields: "manage", brand: "manage", audit: "manage", accounts: "manage" } },
  { key: "learning-admin",   name: "Learning Admin",    name_zh: "培训管理员", grants: { learning: "manage" } },
  { key: "performance-talent-admin", name: "Performance & Talent Admin", name_zh: "绩效与人才管理员", grants: { people: "read", performance: "manage", talent: "manage" } },
];

function runMigrations(list) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version   INTEGER PRIMARY KEY,
      name      TEXT NOT NULL,
      appliedAt TEXT NOT NULL
    );
  `);
  const applied = new Set(db.prepare("SELECT version FROM schema_migrations").all().map((r) => r.version));
  const pending = list.filter((m) => !applied.has(m.version));
  if (!pending.length) return;
  backupBeforeMigration(pending.map((m) => m.version).join("-"));
  for (const m of pending) {
    db.exec("BEGIN");
    try {
      m.up();
      db.prepare("INSERT INTO schema_migrations (version, name, appliedAt) VALUES (?, ?, ?)")
        .run(m.version, m.name, new Date().toISOString());
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw new Error(`Migration ${m.version} (${m.name}) failed and was rolled back: ${e.message}`);
    }
  }
}
function migrateSchema() {
  runMigrations(MIGRATIONS);
}

// Safety net required by the Phase 1 spec: snapshot the database before any
// pending migration touches it. Skipped for brand-new (empty) databases.
function backupBeforeMigration(tag) {
  const hasUsers = db.prepare("SELECT COUNT(*) AS n FROM users").get().n > 0;
  if (!hasUsers) return;
  try {
    const dir = path.join(path.dirname(DB_PATH), "backups");
    fs.mkdirSync(dir, { recursive: true });
    const now = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    const dest = path.join(dir, `lms-${stamp}-pre-migration-v${tag}.db`);
    if (!fs.existsSync(dest)) db.exec(`VACUUM INTO '${dest.replace(/'/g, "''")}'`);
    console.log(`Pre-migration backup: ${dest}`);
  } catch (e) {
    console.warn("Pre-migration backup failed (continuing): " + e.message);
  }
}

// ---------- 模块迁移（modules/culture/CONTRACT.md 第 8 节；PHASE2-KERNEL.md 1.2） ----------
// runModuleMigrations(list) —— server.js 在 store.init() 之后、调用模块工厂与开始监听之前调用一次；调用 store.init()
// 的脚本（notify-due 等）不调用它。list 即 kernel/registry.js 的 MIGRATIONS：[{ module, dir, tables? }]，按
// modules/index.js 的顺序。
//   · 每个模块按文件名顺序执行尚未执行的 <module>-NNNN.sql（与模块开关无关：安装即迁移，关闭只关入口、不删数据）。
//   · 先核对全部模块的已执行记录：sha256（去掉 BOM、CRLF 换成 LF 之后的文本，行尾转换不算改动）对不上，或记录对应的
//     文件已不存在 → 抛错并写明文件名，一个文件都不执行（服务拒绝启动）。已执行的文件不得修改，改结构只能新增文件。
//   · 本次有待执行文件时，在第一个文件之前做**一次**迁移前备份（backupBeforeMigration，标签 modules-<各文件 id>，即
//     backups/lms-<时间>-pre-migration-vmodules-culture-0001.db）。VACUUM INTO 不能在事务里执行，所以备份在任何 BEGIN
//     之前，本函数也拒绝在事务里被调用；空库跳过、备份失败只告警（与 TMS 迁移前备份同一口径）；一个进程最多备份一次。
//     同一次启动 TMS 也有待执行迁移时，backups/ 里会多出不止一份：TMS 的结构迁移（MIGRATIONS）与数据迁移
//     （DATA_MIGRATIONS）各自在有待执行项时备份一次（前者在任何迁移之前 —— 回退到升级前用这份，也就是版本号最小的
//     一份；后者在结构迁移之后），模块迁移再备份一次（在全部 TMS 迁移之后）。从 v46 升级即 v47-48-49-50、v51-52-53-54、
//     vmodules-culture-0001 三份。
//   · 每个文件一个事务（执行 SQL + 写 module_migrations），失败回滚并抛错；修正后重启从失败的文件继续。
//   · 文件只许建表、建索引、改表与数据修正：BEGIN / COMMIT / PRAGMA / ATTACH / VACUUM 等语句、触发器、视图与
//     CREATE TABLE … AS SELECT 一律拒绝；给了 tables 时，建表 / 改表 / 删表 / 建索引 / 写入的目标表必须是本模块的表，
//     语句里也不得出现别的表名（库里已有的其它表、同批其它模块的表）以及 sqlite_ / pragma_ 开头的名称 —— 不能从 TMS
//     表取数；带库名前缀的名称（main.x、temp.x）一律拒绝。检查用与 moduleDb 相同的单遍词法扫描（sqlTokens）：
//     带引号的标识符里的 -- 或 /* 不会被当成注释而把后面的语句藏起来。全部执行完后 tables 里的每张表都必须存在。
// 返回本次执行的文件 id 列表（如 ["culture-0001"]）。
let MODULE_MIGRATION_BACKUP_DONE = false;
const MODULE_ID_RE = /^[a-z][a-z0-9-]*$/;
function moduleMigrationText(raw) { return String(raw).replace(/^﻿/, "").replace(/\r\n/g, "\n"); }
function moduleMigrationSha256(raw) { return crypto.createHash("sha256").update(moduleMigrationText(raw), "utf8").digest("hex"); }
// ---------- 模块 SQL 的词法扫描（moduleDb 与模块迁移共用；modules/culture/test/harness.js 有逐条相同的一份） ----------
// sqlTokens(sql) → [{ t, v, q }]。单遍、按出现顺序识别，先到先得：
//   -- 行注释（到换行）、/* */ 块注释（没有结束符时到文末，与 SQLite 相同）→ 丢弃；
//   '…'（'' 转义）→ t "str"；x'…' → t "blob"；"…" / `…`（重写引号转义）与 […] → t "id"、q true（去掉引号后按普通
//   标识符参与比对：FROM "users" 与 FROM users 是同一张表）；? ?NNN :x @x $x #x → t "param"；数字 → t "num"；
//   标识符（ASCII 字母、下划线、0x80 以上的字符开头，后跟字母数字、_、$、0x80 以上）→ t "id"、q false；其余单个字符 → t "punct"。
// 注释里的引号、带引号标识符里的 -- 与 /* 都不会改变后面的切分（先整体换掉字符串再去注释的写法会被这两种写法骗过）。
// 引号或方括号没有闭合时抛错（SQLite 同样拒绝编译）。
function sqlTokens(sql) {
  const s = String(sql);
  const out = [];
  const idStart = (c) => (c >= "A" && c <= "Z") || (c >= "a" && c <= "z") || c === "_" || c > "\x7f";
  const idChar = (c) => idStart(c) || (c >= "0" && c <= "9") || c === "$";
  const digit = (c) => c >= "0" && c <= "9";
  const quoted = (i, q) => {   // s[i] 是开引号 → [内容, 闭引号之后的位置]
    let v = "";
    for (let j = i + 1; j < s.length; j++) {
      if (s[j] === q) { if (s[j + 1] === q) { v += q; j++; continue; } return [v, j + 1]; }
      v += s[j];
    }
    throw new Error(`unterminated ${q} quote`);
  };
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\f" || c === "\v") { i++; continue; }
    if (c === "-" && s[i + 1] === "-") { const j = s.indexOf("\n", i + 2); i = j < 0 ? s.length : j + 1; continue; }
    if (c === "/" && s[i + 1] === "*") { const j = s.indexOf("*/", i + 2); i = j < 0 ? s.length : j + 2; continue; }
    if ((c === "x" || c === "X") && s[i + 1] === "'") { const [v, j] = quoted(i + 1, "'"); out.push({ t: "blob", v, q: true }); i = j; continue; }
    if (c === "'" || c === "\"" || c === "`") { const [v, j] = quoted(i, c); out.push({ t: c === "'" ? "str" : "id", v, q: true }); i = j; continue; }
    if (c === "[") {
      const j = s.indexOf("]", i + 1);
      if (j < 0) throw new Error("unterminated [ quote");
      out.push({ t: "id", v: s.slice(i + 1, j), q: true }); i = j + 1; continue;
    }
    if (c === "?") { let j = i + 1; while (j < s.length && digit(s[j])) j++; out.push({ t: "param", v: s.slice(i, j), q: false }); i = j; continue; }
    if ((c === ":" || c === "@" || c === "$" || c === "#") && i + 1 < s.length && idChar(s[i + 1])) {
      let j = i + 1; while (j < s.length && idChar(s[j])) j++;
      out.push({ t: "param", v: s.slice(i, j), q: false }); i = j; continue;
    }
    if (digit(c) || (c === "." && digit(s[i + 1] || ""))) {
      let j = i + 1;
      while (j < s.length && (idChar(s[j]) || s[j] === "." || ((s[j] === "+" || s[j] === "-") && /[eE]/.test(s[j - 1])))) j++;
      out.push({ t: "num", v: s.slice(i, j), q: false }); i = j; continue;
    }
    if (idStart(c)) { let j = i + 1; while (j < s.length && idChar(s[j])) j++; out.push({ t: "id", v: s.slice(i, j), q: false }); i = j; continue; }
    out.push({ t: "punct", v: c, q: false }); i++;
  }
  return out;
}
const sqlKw = (x, kw) => !!x && x.t === "id" && !x.q && x.v.toUpperCase() === kw;
const sqlPunct = (x, p) => !!x && x.t === "punct" && x.v === p;
// 标识符不能用的名字：sqlite_ 开头（系统表，如 sqlite_master）、pragma_ 开头（PRAGMA 表值函数，如 pragma_table_info）。
const SQL_SYSTEM_NAME = /^(sqlite_|pragma_)/i;

// 迁移文件按分号切成语句（词法扫描之后：字符串、带引号的标识符与注释里的分号不算）—— 只用来检查，执行的仍是原文。
function migrationStatements(sql) {
  const out = [];
  let cur = [];
  for (const x of sqlTokens(sql)) {
    if (sqlPunct(x, ";")) { if (cur.length) out.push(cur); cur = []; }
    else cur.push(x);
  }
  if (cur.length) out.push(cur);
  return out;
}
// 规则在「形状串」上匹配：词之间一个空格，普通名字原样（带引号的标识符去掉引号；名字里有别的字符时换成 "?"，任何规则都
// 匹配不上），字符串换成 ''。名字之后跟着 "." 的（库名前缀 main.x / temp.x）不匹配任何规则 → 按「不允许的语句」拒绝。
const MIG_NAME = "([A-Za-z_][A-Za-z0-9_]*)\\b(?!\\s*\\.)";
const MIG_RULES = [
  // 建表必须带列定义：CREATE TABLE … AS SELECT 不匹配（它会把别的表的数据复制进来）
  [new RegExp(`^CREATE\\s+(?:TEMP\\s+|TEMPORARY\\s+)?TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?${MIG_NAME}\\s*\\(`, "i"), 1],
  [new RegExp(`^CREATE\\s+(?:UNIQUE\\s+)?INDEX\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?${MIG_NAME}\\s+ON\\s+${MIG_NAME}\\s*\\(`, "i"), 2],
  [new RegExp(`^ALTER\\s+TABLE\\s+${MIG_NAME}\\s+(?:ADD|RENAME|DROP)\\b`, "i"), 1],
  [new RegExp(`^DROP\\s+TABLE\\s+(?:IF\\s+EXISTS\\s+)?${MIG_NAME}$`, "i"), 1],
  // 整句锚定：DROP INDEX IF EXISTS main.x 不会把 IF 或 main 当成索引名放行
  [new RegExp(`^DROP\\s+INDEX\\s+(?:IF\\s+EXISTS\\s+)?${MIG_NAME}$`, "i"), "index"],
  [new RegExp(`^(?:INSERT|REPLACE)\\s+(?:OR\\s+[A-Za-z]+\\s+)?INTO\\s+${MIG_NAME}`, "i"), 1],
  [new RegExp(`^UPDATE\\s+(?:OR\\s+[A-Za-z]+\\s+)?${MIG_NAME}`, "i"), 1],
  [new RegExp(`^DELETE\\s+FROM\\s+${MIG_NAME}`, "i"), 1],
];
function migrationShape(toks) {
  return toks.map((x) => (x.t === "id" ? (/^[A-Za-z_][A-Za-z0-9_]*$/.test(x.v) ? x.v : "\"?\"") : x.t === "str" || x.t === "blob" ? "''" : x.v)).join(" ");
}
// foreign：本模块不拥有、却可能出现在语句里的表名（库里已有的其它表 + 同批其它模块 manifest 的表），小写。
function checkModuleMigrationSql(text, file, moduleId, tables, foreign) {
  const own = Array.isArray(tables) ? new Set(tables.map((t) => String(t).toLowerCase())) : null;
  let statements;
  try { statements = migrationStatements(text); }
  catch (e) { throw new Error(`module migration ${file} (${moduleId}): ${e.message}`); }
  for (const toks of statements) {
    const shape = migrationShape(toks);
    const head = shape.slice(0, 60);
    let target;
    for (const [re, g] of MIG_RULES) {
      const m = re.exec(shape);
      if (!m) continue;
      if (g === "index") {
        const row = db.prepare("SELECT tbl_name FROM sqlite_master WHERE type = 'index' AND name = ? COLLATE NOCASE").get(m[1]);
        target = row ? row.tbl_name : null;   // 检查时还不存在的索引（IF EXISTS，或本文件前面的语句刚建的）无从归属，放行
      } else target = m[g];
      break;
    }
    if (target === undefined)
      throw new Error(`module migration ${file} (${moduleId}): statement "${head}…" is not allowed — only CREATE TABLE (with column definitions) / CREATE INDEX / ALTER TABLE / DROP and INSERT / UPDATE / DELETE data fixes on unqualified table names (no BEGIN, COMMIT, PRAGMA, ATTACH, VACUUM, triggers, views or CREATE TABLE … AS SELECT)`);
    if (own && target !== null && !own.has(String(target).toLowerCase()))
      throw new Error(`module migration ${file} (${moduleId}): statement "${head}…" touches table "${target}", which module ${moduleId} does not own (manifest tables)`);
    // 语句的其余部分：不得读别的表（INSERT … SELECT … FROM users、UPDATE … SET a = (SELECT … FROM users)），不得出现系统名
    for (const x of toks) {
      if (x.t !== "id") continue;
      if (SQL_SYSTEM_NAME.test(x.v))
        throw new Error(`module migration ${file} (${moduleId}): statement "${head}…" uses "${x.v}" — sqlite_ and pragma_ names are not allowed`);
      if (own && foreign && foreign.has(x.v.toLowerCase()) && !own.has(x.v.toLowerCase()))
        throw new Error(`module migration ${file} (${moduleId}): statement "${head}…" refers to table "${x.v}", which module ${moduleId} does not own (manifest tables)`);
    }
  }
}
function moduleBackupTag(ids) {
  const shown = ids.length <= 4 ? ids : ids.slice(0, 3).concat([`and-${ids.length - 3}-more`]);
  return "modules-" + shown.join("-");
}
function runModuleMigrations(list) {
  if (!db) throw new Error("store.runModuleMigrations: call store.init() first");
  if (TX_DEPTH > 0) throw new Error("store.runModuleMigrations must run outside any transaction (the pre-migration backup uses VACUUM INTO)");
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'module_migrations'").get())
    throw new Error("store.runModuleMigrations: table module_migrations is missing (schema migration 50 runs in store.init())");
  const entries = Array.isArray(list) ? list : [];
  // 语句里不得出现的别人的表：库里现有的全部表 + 这一批各模块 manifest 的表（每个模块自己的表在检查时排除）
  const knownTables = new Set(stmt("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => String(r.name).toLowerCase()));
  for (const e of entries) if (e && Array.isArray(e.tables)) for (const t of e.tables) knownTables.add(String(t).toLowerCase());
  const plan = [];
  const seenModules = new Set();
  for (const entry of entries) {
    const moduleId = entry && entry.module;
    if (typeof moduleId !== "string" || !MODULE_ID_RE.test(moduleId)) throw new Error(`module migrations: bad module id ${JSON.stringify(moduleId)}`);
    if (seenModules.has(moduleId)) throw new Error(`module migrations: module ${moduleId} is listed twice`);
    seenModules.add(moduleId);
    const dir = entry.dir;
    let names;
    try { names = fs.readdirSync(dir); }
    catch (e) { throw new Error(`module migrations: cannot read ${dir} for module ${moduleId} (${e.message})`); }
    const re = new RegExp(`^${moduleId}-(\\d{4})\\.sql$`);
    const files = names.filter((f) => /\.sql$/i.test(f)).sort();
    files.forEach((f, i) => {
      const m = re.exec(f);
      if (!m) throw new Error(`module migrations: ${path.join(dir, f)} must be named ${moduleId}-NNNN.sql`);
      if (Number(m[1]) !== i + 1) throw new Error(`module migrations: ${moduleId} files must be numbered from 0001 without gaps (found ${f} where ${moduleId}-${String(i + 1).padStart(4, "0")}.sql belongs)`);
    });
    const applied = new Map(stmt("SELECT id, file, sha256 FROM module_migrations WHERE module = ?").all(moduleId).map((r) => [r.id, r]));
    for (const r of applied.values())
      if (!files.includes(r.file)) throw new Error(`module migration ${r.file} (${moduleId}) was applied but is missing from ${dir} — applied files must stay; refusing to start`);
    for (const f of files) {
      const id = f.slice(0, -4);
      const raw = fs.readFileSync(path.join(dir, f), "utf8");
      const sha = moduleMigrationSha256(raw);
      const prev = applied.get(id);
      if (prev) {
        if (prev.sha256 !== sha) throw new Error(`module migration ${f} (${moduleId}) has changed since it was applied (sha256 mismatch) — applied files must not be edited; add ${moduleId}-${String(files.length + 1).padStart(4, "0")}.sql instead. Refusing to start`);
        continue;
      }
      const text = moduleMigrationText(raw);
      checkModuleMigrationSql(text, f, moduleId, entry.tables, knownTables);
      plan.push({ module: moduleId, id, file: f, text, sha });
    }
  }
  if (plan.length && !MODULE_MIGRATION_BACKUP_DONE) {
    MODULE_MIGRATION_BACKUP_DONE = true;
    backupBeforeMigration(moduleBackupTag(plan.map((p) => p.id)));
  }
  const ran = [];
  for (const p of plan) {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(p.text);
      stmt("INSERT INTO module_migrations (id, module, file, sha256, appliedAt) VALUES (?, ?, ?, ?, ?)").run(p.id, p.module, p.file, p.sha, new Date().toISOString());
      db.exec("COMMIT");
    } catch (e) {
      try { db.exec("ROLLBACK"); } catch {}
      throw new Error(`Module migration ${p.file} (${p.module}) failed and was rolled back: ${e.message}`);
    }
    ran.push(p.id);
  }
  // 建出的表必须覆盖 manifest 的 tables（表归属守卫之外的运行期兜底：少建一张表，模块第一次查询才会 500）。
  const exists = stmt("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? COLLATE NOCASE");
  for (const entry of entries) {
    if (!Array.isArray(entry.tables)) continue;
    const missing = entry.tables.filter((t) => !exists.get(String(t)));
    if (missing.length) throw new Error(`module ${entry.module}: manifest tables ${missing.join(", ")} were not created by its migrations (${entry.dir})`);
  }
  return ran;
}

// ---------- row <-> object mappers ----------
// 第四批 6.1：按题型走注册表（modules/learning/qtypes/index.js rowToQuestion）。旧四种题型逐字照旧（options / rubric / maxPoints 列，
// fill 的可接受答案仍存在 options 列）；新题型读 data 列（迁移 73）；未知题型（更新版本写入的行）→ unsupported: true，
// 抽题、组卷与题库列表跳过它。origin：AI 起草并被采纳的题目的来源信息（迁移 58）；points：单题分值（迁移 59，null = 按考试的题型默认分值）。
function rowToQuestion(r) {
  return QTYPES.rowToQuestion(r);
}
function rowToAttempt(r) {
  if (!r) return null;
  return {
    id: r.id, userId: r.userId, programId: r.programId, examId: r.examId || null,
    startedAt: r.startedAt, submittedAt: r.submittedAt,
    questions: r.questions ? JSON.parse(r.questions) : [],
    answers: r.answers ? JSON.parse(r.answers) : null,
    percent: r.percent, passed: r.passed === null ? null : !!r.passed,
    detail: r.detail ? JSON.parse(r.detail) : null,
    blurCount: r.blurCount || 0,
    voided: !!r.voided,
    draftAnswers: r.draftAnswers ? JSON.parse(r.draftAnswers) : null,
    lastSavedAt: r.lastSavedAt || null,
    // 评分状态（迁移 58）：grading | pending_review | manual_pending | final；历史答卷为 NULL，视同 final
    gradingStatus: r.gradingStatus || null,
  };
}
function rowToExam(r) {
  if (!r) return null;
  return {
    // CX-154：英文名可以留空（与课程 CX-036 同口径）。title 读出时回落中文名，各处显示不出空白；
    // titleEn 是库里的英文原值，编辑页与 updateExam 用它，回落值不会被写回库里。
    id: r.id, programId: r.programId, title: r.title || r.title_zh || "", titleEn: r.title || "", title_zh: r.title_zh,
    status: r.status,
    passingScore: r.passingScore, mcqCount: r.mcqCount, openCount: r.openCount,
    timeLimitMinutes: r.timeLimitMinutes,
    maxAttempts: r.maxAttempts, retakeCooldownHours: r.retakeCooldownHours,
    showAnswersAfterExam: !!r.showAnswersAfterExam,
    autoRetrain: r.autoRetrain === undefined ? true : !!r.autoRetrain,
    // 每题分值（迁移 59）：typePoints 为空 = 旧口径
    typePoints: (() => { if (!r.typePoints) return null; try { const t = JSON.parse(r.typePoints); return t && typeof t === "object" ? t : null; } catch { return null; } })(),
    multiPartial: r.multiPartial === undefined || r.multiPartial === null ? true : !!r.multiPartial,
    // 固定题目模式（迁移 63）：mode 为空 = random
    mode: r.mode === "fixed" ? "fixed" : "random",
    questionIds: (() => { if (!r.questionIds) return []; try { const a = JSON.parse(r.questionIds); return Array.isArray(a) ? a.map(String) : []; } catch { return []; } })(),
    // 第四批（迁移 73）：选项顺序随机 / 固定、新题型按比例给分、随机抽题的情境案例组数；缺列或空值 = 默认（随机、按比例、0 组）
    shuffleOptions: r.shuffleOptions === undefined || r.shuffleOptions === null ? true : !!r.shuffleOptions,
    partialCredit: r.partialCredit === undefined || r.partialCredit === null ? true : !!r.partialCredit,
    caseCount: Number(r.caseCount) > 0 ? Number(r.caseCount) : 0,
    // F58（迁移 90）：考前须知（选填，纯文本）；缺列或空值 = null（只显示系统须知）
    preNotice: r.preNotice ? String(r.preNotice) : null,
    preNotice_zh: r.preNotice_zh ? String(r.preNotice_zh) : null,
    createdAt: r.createdAt, updatedAt: r.updatedAt,
  };
}

// ---------- meta / id counter ----------
function getMeta(key) {
  const r = stmt("SELECT value FROM meta WHERE key = ?").get(key);
  return r ? r.value : null;
}
function setMeta(key, value) {
  stmt("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, String(value));
}

// 与题型有关的列由注册表算（QTYPES.questionColumns；旧四种题型与改动前逐字相同，data 为 NULL）
function insertQuestionRow(q) {
  const col = QTYPES.questionColumns(q);
  db.prepare(
    `INSERT INTO questions (id, courseId, moduleId, type, question, question_zh, options, explanation, explanation_zh, rubric, rubric_zh, maxPoints, origin, points, data)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    q.id, q.courseId, q.moduleId || null, q.type, q.question, q.question_zh || null,
    col.options,
    col.explanation, col.explanation_zh,
    col.rubric, col.rubric_zh,
    col.maxPoints,
    q.origin ? JSON.stringify(q.origin) : null,
    q.points != null ? q.points : null,
    col.data
  );
}

// ---------- seeding & migration ----------
// Production mode (LMS_PROD=1 or config.json {"production": true}) never seeds
// demo accounts or shows demo passwords. A fresh production database gets one
// ADMIN account whose password comes from LMS_ADMIN_PASSWORD, or is generated
// and printed to the console exactly once.
function isProduction() {
  if (process.env.LMS_PROD === "1") return true;
  try {
    // LMS_CONFIG_PATH: same alternate-config override server.js readConfig()
    // honors, so an injected config drives production mode too. A missing or
    // unreadable file still means "not production" via the catch below.
    return !!JSON.parse(fs.readFileSync(process.env.LMS_CONFIG_PATH || path.join(ROOT, "config.json"), "utf8")).production;
  } catch { return false; }
}
// Real-data deployments (LMS_NO_DEMO_USERS=1) keep demo courses/questions but
// never create demo PEOPLE: no Juan, no DEMO-ADMIN, no demo talent trajectory.
// Tests don't set the flag, so the test fixtures keep their seeded identities.
function noDemoUsers() { return process.env.LMS_NO_DEMO_USERS === "1"; }
function seedFresh(hashPassword) {
  const now = new Date().toISOString();
  const ins = db.prepare("INSERT INTO users (id, employeeId, name, role, passwordHash, lastLoginAt, createdAt) VALUES (?, ?, ?, ?, ?, NULL, ?)");
  if (isProduction()) {
    let pw = process.env.LMS_ADMIN_PASSWORD || "";
    if (!pw) {
      pw = require("crypto").randomBytes(9).toString("base64url");
      console.log(`\n*** Production first run: ADMIN password is ${pw} — save it now, it is not shown again. ***\n`);
    }
    ins.run("u-admin", "ADMIN", "Administrator", "admin", hashPassword(pw), now);
    return; // no demo employee, no seed questions
  }
  // Demo identities are fictional.
  const users = [
    { id: "u-admin", employeeId: "ADMIN", name: "Administrator", role: "admin", pw: "unfolding888" },
    ...(noDemoUsers() ? [] : [{ id: "u-1001", employeeId: "DP-1001", name: "Juan Dela Cruz", role: "employee", pw: "test1234" }]),
  ];
  for (const u of users) ins.run(u.id, u.employeeId, u.name, u.role, hashPassword(u.pw), now);
  QUESTIONS.forEach((q, i) => insertQuestionRow({ id: "q" + (i + 1), ...q }));
  setMeta("nextQ", QUESTIONS.length + 1);
}

// The public demo needs a management-capable login that is distinct from the
// built-in owner account. Run this on every non-production boot so an existing
// Render database receives the account too; never reset it once it exists.
function ensureDemoAdmin(hashPassword) {
  if (isProduction() || noDemoUsers() || getUserByEmployeeId(DEMO_ADMIN.employeeId)) return;
  db.prepare(
    "INSERT INTO users (id, employeeId, name, role, passwordHash, lastLoginAt, createdAt, mustChangePassword, active) VALUES (?, ?, ?, 'admin', ?, NULL, ?, 0, 1)"
  ).run(DEMO_ADMIN.id, DEMO_ADMIN.employeeId, DEMO_ADMIN.name, hashPassword(DEMO_ADMIN.password), new Date().toISOString());
}

function migrateFromJson() {
  const data = JSON.parse(fs.readFileSync(LEGACY_JSON, "utf8"));
  db.exec("BEGIN");
  try {
    if (Array.isArray(data.users)) {
      const ins = db.prepare("INSERT OR IGNORE INTO users (id, employeeId, name, role, passwordHash, lastLoginAt, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?)");
      for (const u of data.users) ins.run(u.id, u.employeeId, u.name, u.role, u.passwordHash, u.lastLoginAt || null, u.createdAt || new Date().toISOString());
    }
    // progress: { userId: { courseId: { moduleId: iso } } }
    if (data.progress) {
      const ins = db.prepare("INSERT OR IGNORE INTO progress (userId, courseId, moduleId, completedAt) VALUES (?, ?, ?, ?)");
      for (const [userId, courses] of Object.entries(data.progress))
        for (const [courseId, mods] of Object.entries(courses || {}))
          for (const [moduleId, iso] of Object.entries(mods || {})) ins.run(userId, courseId, moduleId, iso);
    }
    if (Array.isArray(data.attempts)) {
      const ins = db.prepare("INSERT OR IGNORE INTO attempts (id, userId, programId, startedAt, submittedAt, questions, answers, percent, passed, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
      for (const a of data.attempts) {
        // Skip legacy course-keyed attempts from before the program restructure.
        if (!a.programId) continue;
        ins.run(a.id, a.userId, a.programId, a.startedAt, a.submittedAt || null,
          a.questions ? JSON.stringify(a.questions) : null,
          a.answers ? JSON.stringify(a.answers) : null,
          a.percent != null ? a.percent : null,
          a.passed == null ? null : a.passed ? 1 : 0,
          a.detail ? JSON.stringify(a.detail) : null);
      }
    }
    if (Array.isArray(data.questions)) {
      for (const q of data.questions) insertQuestionRow(q);
    }
    setMeta("nextQ", data.nextQ || (data.questions ? data.questions.length + 1 : QUESTIONS.length + 1));
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  // Don't import twice.
  fs.renameSync(LEGACY_JSON, LEGACY_JSON + ".migrated");
}

// ---------- public API ----------
function init({ hashPassword }) {
  db = new DatabaseSync(DB_PATH);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec("PRAGMA foreign_keys = ON");
  createSchema();
  migrateSchema();

  const userCount = db.prepare("SELECT COUNT(*) AS n FROM users").get().n;
  if (userCount === 0) {
    if (fs.existsSync(LEGACY_JSON)) migrateFromJson();
    else seedFresh(hashPassword);
  }
  ensureDemoAdmin(hashPassword);
  syncSeedQuestions();
  backfillAssignments();
  seedContent();
  ensureDemoMedia();
  // Data migrations come after seeding so a fresh database is migrated the
  // same way as a long-lived one (e.g. seeded programs still get their exam).
  runMigrations(DATA_MIGRATIONS);
  seedTalentDemo();
  cleanupExpiredSessions();
}

// Demo talent trajectory for the demo employee so the People profile shows a
// full story out of the box (never in production; runs once via meta flag).
function seedTalentDemo() {
  if (isProduction() || noDemoUsers() || getMeta("seedTalentDemo")) return;
  setMeta("seedTalentDemo", "1");
  if (!getUserById("u-1001")) return;
  db.prepare("UPDATE users SET department = ?, position = ?, jobLevel = ?, hireDate = ?, talentTags = ?, potential = ?, empStatus = ? WHERE id = ?")
    .run("Customer Care", "Customer Care Team Lead", "MB2", "2024-03-04",
      JSON.stringify(["高潜 HiPo", "关键人才 Key talent"]), "High", "regular", "u-1001"); // F48：标签不带 emoji
  // 12.2：本种子在数据迁移之后执行，迁移 87 到不了这两个标签 —— 这里补跑同一个映射（写 2 条 migration 事件与 1 条系统审计）
  controlledTagsMap(87);
  const now = new Date().toISOString();
  const ins = db.prepare("INSERT OR IGNORE INTO talent_records (id, userId, type, date, title, detail, programId, createdBy, createdAt) VALUES (?, 'u-1001', ?, ?, ?, ?, NULL, 'u-admin', ?)");
  // detail 里的选项值必须是 canonical（= options[i] = 英文显示名）。这份种子跑在
  // DATA_MIGRATIONS 之后，migration 41 的重映射到不了它，所以这里写错的话每个新库
  // 都会带着一批「不在自己字段选项表里」的死值出生，两种语言都原样显示。
  // 标题是自由文本，保持双语。
  const demo = [
    ["tr-demo-1", "training", "2024-06-28", "动力营 Power Camp Batch 3",
      { programName: "动力营 Power Camp", period: "2024-05 ~ 2024-06", result: "Completed", score: 92, rank: "3/25" }],
    ["tr-demo-2", "award", "2024-06-28", "优秀学员 Outstanding Trainee",
      { awardName: "Top learner", programName: "动力营 Power Camp Batch 3", issuer: "HR & Training Committee" }],
    ["tr-demo-3", "regularization", "2024-09-04", "转正 Regularization",
      { result: "On time", review: "试用期目标全部达成,客户满意度部门前 20%。", synced: true }],
    ["tr-demo-4", "violation", "2024-11-12", "Late compliance attestation",
      { severity: "Minor", description: "季度合规确认迟交 3 天 Quarterly attestation 3 days late", action: "口头提醒 Verbal reminder" }],
    ["tr-demo-5", "transfer", "2024-12-01", "Player Support → Customer Care",
      { fromDept: "Player Support", toDept: "Customer Care", fromPosition: "Support Agent", toPosition: "Customer Care Specialist", reason: "业务需要 + 个人发展意愿", synced: true }],
    ["tr-demo-6", "performance", "2025-01-15", "2024-H2 Performance Review",
      { period: "2024-H2", rating: "A", score: 91, summary: "持续超额完成 CSAT 目标,对新人辅导投入突出。" }],
    ["tr-demo-7", "promotion", "2025-07-01", "MB3 → MB2",
      { fromLevel: "MB3", toLevel: "MB2", method: "Defense", result: "Passed", score: 88, comments: "对升级问题有清楚 ownership;跨团队规划待加强。", synced: true }],
  ];
  for (const [id, type, date, title, detail] of demo) ins.run(id, type, date, title, JSON.stringify(detail), now);
  ensureDepartment("Customer Care");
}

// Course/program content lives in the DB so HR can edit it in the console.
// content.js is only the seed for a fresh database.
function seedContent() {
  if (isProduction()) return; // production starts with no demo content
  const n = db.prepare("SELECT COUNT(*) AS n FROM content").get().n;
  if (n > 0) return;
  const now = new Date().toISOString();
  const ins = db.prepare("INSERT INTO content (kind, id, json, updatedAt) VALUES (?, ?, ?, ?)");
  db.exec("BEGIN");
  try {
    for (const p of PROGRAMS) ins.run("program", p.id, JSON.stringify(p), now);
    for (const c of COURSES) ins.run("course", c.id, JSON.stringify(c), now);
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

// Add real media to the public demonstration without exposing files under
// public/. The PDF uses the same authenticated attachment route as admin
// uploads; the video uses an HTTPS embed supported by the course reader.
// Existing HR-authored media is preserved, and this never runs in production.
function ensureDemoMedia() {
  if (isProduction() || getMeta("demoMediaV1")) return;

  const guideSource = path.join(ROOT, "scripts", "samples", "unfolding-learning-guide.pdf");
  const attachDir = process.env.LMS_ATTACH_DIR
    ? path.resolve(process.env.LMS_ATTACH_DIR)
    : path.join(ROOT, "data", "attachments");

  if (fs.existsSync(guideSource)) {
    fs.mkdirSync(attachDir, { recursive: true });
    const guideDest = path.join(attachDir, DEMO_GUIDE_KEY);
    if (!fs.existsSync(guideDest)) fs.copyFileSync(guideSource, guideDest);
    const size = fs.statSync(guideDest).size;
    if (!getAttachment(DEMO_GUIDE_ID)) {
      createAttachment({
        id: DEMO_GUIDE_ID,
        courseId: "culture-conduct",
        kind: "pdf",
        storageKey: DEMO_GUIDE_KEY,
        originalName: "Unfolding Learning Guide.pdf",
        mime: "application/pdf",
        size,
        uploadedBy: DEMO_ADMIN.id,
      });
    }

    const recordCourse = listContent("course").find((c) => c.id === "culture-conduct");
    const recordSection = recordCourse && recordCourse.modules && recordCourse.modules[0]
      && recordCourse.modules[0].sections && recordCourse.modules[0].sections[0];
    if (recordSection) {
      recordSection.attachments = Array.isArray(recordSection.attachments) ? recordSection.attachments : [];
      if (!recordSection.attachments.some((a) => a.id === DEMO_GUIDE_ID)) {
        recordSection.attachments.push({ id: DEMO_GUIDE_ID, kind: "pdf", name: "Unfolding Learning Guide.pdf", size });
        putContent("course", recordCourse.id, recordCourse);
      }
    }
  }

  const coachingCourse = listContent("course").find((c) => c.id === "data-privacy");
  const coachingSection = coachingCourse && coachingCourse.modules && coachingCourse.modules[0]
    && coachingCourse.modules[0].sections && coachingCourse.modules[0].sections[0];
  if (coachingSection && !coachingSection.video && !coachingSection.videoEmbed) {
    // Big Buck Bunny is an openly licensed Blender Foundation demo film.
    coachingSection.videoEmbed = "https://www.youtube.com/embed/aqz-KE-bpKQ";
    putContent("course", coachingCourse.id, coachingCourse);
  }

  setMeta("demoMediaV1", "1");
}

// Insert seed questions added to content.js after the DB was first created
// (matched by English question text, so HR-deleted questions aren't resurrected
// on every start — only genuinely new seeds are added, tracked via meta).
function syncSeedQuestions() {
  if (isProduction()) return; // demo questions never enter a production DB
  const seen = Number(getMeta("seedQCount") || 0);
  if (seen >= QUESTIONS.length) return;
  const existing = new Set(db.prepare("SELECT question FROM questions").all().map((r) => r.question));
  db.exec("BEGIN");
  try {
    for (const q of QUESTIONS) {
      if (existing.has(q.question)) continue;
      const n = Number(getMeta("nextQ") || 1);
      insertQuestionRow({ ...q, id: "q" + n });
      setMeta("nextQ", n + 1);
    }
    setMeta("seedQCount", QUESTIONS.length);
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

// One-time backfill when the assignments feature first ships: existing users
// keep seeing every program (no due date), so nothing disappears on upgrade.
function backfillAssignments() {
  if (getMeta("assignBackfill")) return;
  const now = new Date().toISOString();
  const ins = db.prepare("INSERT OR IGNORE INTO assignments (userId, programId, dueAt, assignedAt) VALUES (?, ?, NULL, ?)");
  for (const u of db.prepare("SELECT id FROM users").all())
    for (const p of PROGRAMS) ins.run(u.id, p.id, now);
  setMeta("assignBackfill", "1");
}

// ---------- transactions（批量写的原子性） ----------
// transaction(fn)：fn 里的全部写库要么一起提交，要么一起回滚。批量导入接口
// （employees/bulk、bulk-reset、bulk-update、records/bulk、secondary-lines/bulk、
// questions/bulk、assignments/bulk）
// 用它把整批包成一个事务：中途任何一行抛异常 → 整批回滚，库里一行不留。
//   · fn 必须是**同步**的：node:sqlite 是同步 API，一个 await 就会让别的请求的写库
//     插进这个事务（同一连接），回滚时连它们一起丢掉。传进 async 函数 → 直接抛错。
//   · 顶层用 BEGIN IMMEDIATE：一开始就拿写锁，外部进程（脚本）持锁时在 BEGIN 就失败，
//     而不是写到一半才撞上 SQLITE_BUSY。
//   · 嵌套调用走 SAVEPOINT（内层失败只回滚内层，异常照常外抛）。
//   · 回滚后 bumpScopeEpoch()：事务里的 ensureDepartment 已经 bump 过 epoch，若期间有人
//     基于**未提交**的部门表建了范围缓存，回滚后它就是脏的 —— 再 bump 一次让下一次判定
//     重建。data_version 对本连接自己的写不动（见「缓存与失效」），所以这一步不能省。
//   · 副作用（审计、通知、邮件、会话之外的内存状态）由 TMS 自己的调用方在 transaction() **返回之后**
//     再做，免得有人把副作用塞进事务里。
//   · 例外一是领域事件（见下「领域事件」一节）：事务里写发件箱行的同时把信封排进
//     PENDING_EVENTS；**最外层**提交成功之后才整批交给分发器（EVENT_SINK），任何一层回滚
//     都把本层之后排进来的信封丢掉（它们的发件箱行也随回滚消失）。分发器自己的异常在
//     flushCommittedEvents 里吞掉并记日志：数据已经提交，不能再让 transaction() 抛错。
//   · 例外二是 afterCommit(fn, label)（模块 services.afterCommit / audit / notify 的底座，CONTRACT.md 4.2）：
//     事务里登记的回调排进 PENDING_AFTER，按层记录、回滚丢弃本层（与 PENDING_EVENTS 同一做法）；最外层提交
//     成功后**先把整个队列换出**、再分发事件、再按登记顺序执行换出的回调。先换出是因为事件在 transaction()
//     返回之前同步分发，订阅方会开新的最外层事务 —— 不换出的话，原事务的回调会在订阅方的提交时被提前执行。
//     事务本身是在某个事件处理函数里开的（分发器正在一轮分发中）时，本事务的事件只会排进分发器的队列：回调交给
//     分发器，排在这些事件之后执行（flushCommittedEvents 的 then），顺序仍是「本事务的事件分发之后」。
//     回调的异常只记一行 [after-commit] <label>，不改变 transaction() 的返回值。
let TX_DEPTH = 0;
let TX_GEN = 0;   // 最外层事务的序号（eventOrgIndex 用来判断「还在同一笔事务里」）
let PENDING_AFTER = [];   // afterCommit 登记的 { fn, label }，等最外层提交后执行
function transaction(fn) {
  const sp = TX_DEPTH > 0 ? "tx_sp_" + TX_DEPTH : null;
  db.exec(sp ? `SAVEPOINT ${sp}` : "BEGIN IMMEDIATE");
  if (!sp) TX_GEN++;
  const evMark = PENDING_EVENTS.length;
  const afMark = PENDING_AFTER.length;
  TX_DEPTH++;
  let result;
  try {
    result = fn();
    if (result && typeof result.then === "function")
      throw new Error("store.transaction(fn): fn must be synchronous (got a Promise)");
  } catch (e) {
    TX_DEPTH--;
    try { db.exec(sp ? `ROLLBACK TO ${sp}; RELEASE ${sp}` : "ROLLBACK"); } catch {}
    PENDING_EVENTS.length = evMark;
    PENDING_AFTER.length = afMark;
    bumpScopeEpoch();
    throw e;
  }
  TX_DEPTH--;
  try {
    db.exec(sp ? `RELEASE ${sp}` : "COMMIT");
  } catch (e) {
    try { if (!sp) db.exec("ROLLBACK"); } catch {}
    PENDING_EVENTS.length = sp ? evMark : 0;
    PENDING_AFTER.length = sp ? afMark : 0;
    bumpScopeEpoch();
    throw e;
  }
  if (!sp) {
    let after = null;
    if (PENDING_AFTER.length) { after = PENDING_AFTER; PENDING_AFTER = []; }   // 先换出，再分发
    // 分发器接手了回调（它正在一轮分发里，本事务的事件只是排进了它的队列）→ 由它在这些事件分发完之后执行；
    // 否则（事件已同步分发完、没有事件、没接分发器）在这里执行。两种情况都是「本事务的事件分发之后、按登记顺序」。
    const deferred = PENDING_EVENTS.length ? flushCommittedEvents(after ? () => runAfterCommit(after) : null) : false;
    if (after && !deferred) runAfterCommit(after);
  }
  return result;
}
function inTransaction() { return TX_DEPTH > 0; }
// afterCommit(fn, label?)：事务里 → 排到最外层提交之后（事件分发之后，按登记顺序），所在层回滚时丢弃；
// 不在事务里 → 立即执行。fn 必须同步；异常只记日志 [after-commit] <label>（模块的 services 传 "culture:<label>"）。
function afterCommit(fn, label) {
  if (typeof fn !== "function") throw new Error("store.afterCommit(fn): fn must be a function");
  const item = { fn, label: label == null ? "" : String(label) };
  if (TX_DEPTH > 0) PENDING_AFTER.push(item);
  else runAfterCommit([item]);
}
function runAfterCommit(list) {
  for (const a of list) {
    try {
      const r = a.fn();
      if (r && typeof r.then === "function") {
        if (typeof r.catch === "function") r.catch(() => {});
        throw new TypeError("afterCommit callbacks must be synchronous (got a Promise)");
      }
    } catch (e) {
      const name = e && typeof e.name === "string" && /^[A-Za-z_$][\w$]{0,60}$/.test(e.name) ? e.name : "Error";
      console.error(`[after-commit] ${a.label || "(unlabelled)"} (${name})`);
    }
  }
}

// ---------- 领域事件（core 发布，ARCHITECTURE-MODULAR.md §5.3） ----------
// 捕获点集中在本文件：员工与部门的**每一条**写入路径最终都落到下面这几个函数，所以在这里
// 比较变更前后值、发事件，一个钩子覆盖全部接口（逐个接口埋点，新接口一漏就是一个缺口）：
//   createUser        → employee.hired
//   updateUser        → employee.transferred / manager_changed / terminated / reactivated
//                       （只在 fields 含 department / managerId / active / empStatus 时比对）
//   clearDepartment   → employee.transferred（被清空部门的人，to 为空）
//   updateDepartment  → department.renamed / moved / deactivated
//   ensureDepartment  → department.moved（认领孤儿部门：parentId 从空变为某部门）
//   deleteDepartment  → department.deactivated（deleted:true）+ 每个子部门 department.moved
//   renameDepartment  → department.renamed（registered:false：改的是不在部门表里的自由文本部门名）
// 不产生事件的写：部门改名时级联改 users.department（人没有换部门，由 department.renamed 表达）；
// 部门改挂靠后成员的一级/二级归属随之变化（不逐人发 transferred，由 department.moved 表达 ——
// 需要按人处理的订阅方同时订阅它）；部门新建、重新启用、改负责人/排序；改职级/职位/姓名等
// 其它字段；初始化与迁移里的种子写入（裸 SQL）；以及绕过本文件直接写库的脚本。
//
// 事务：事件行必须与引起它的数据变更同事务。调用方已在事务里（runBatch 的批量接口）就并进去；
// 没有（单条接口的自动提交写）就由写函数自己开一个（inEventTx），把业务写与发件箱行包成一笔。
// 分发时机见上面 transaction() 的说明。迁移（runMigrations 用裸 BEGIN 执行）里不要调用这些写函数：
// 初始化与迁移按约定不产生事件，且裸 BEGIN 里再开 BEGIN IMMEDIATE 会直接报错。
let PENDING_EVENTS = [];   // 已写入发件箱、等最外层提交后分发的信封
let EVENT_SINK = null;     // (envelopes) => void；server.js 启动时接上分发总线。脚本进程不接 → 行留在发件箱里未分发
let EVENT_NEEDS_DISPATCH = null;   // (type) => boolean：该类型有没有进程内订阅方；null = 一律当作有
// opts.needsDispatch：没有任何订阅方的事件类型不必在提交后分发、也不必事后回写 —— 写入时就记为
// 已分发（dispatchedAt = occurredAt、attempts = 0），也不进待分发队列。4,000 行的批量因此省掉
// 一轮分发与一整批回写（回写会把刚插入的每一页再写一遍）。有订阅方的类型照常走提交后分发。
function setEventSink(fn, opts = {}) {
  EVENT_SINK = typeof fn === "function" ? fn : null;
  EVENT_NEEDS_DISPATCH = EVENT_SINK && opts && typeof opts.needsDispatch === "function" ? opts.needsDispatch : null;
}
function inEventTx(fn) { return TX_DEPTH > 0 ? fn() : transaction(fn); }
// then：本事务的 afterCommit 回调（没有则为 null）。分发器（kernel/events.js 的 bus.publish）若正处在一轮分发中
// （本事务是某个事件处理函数开的），只会把事件排进队列就返回 —— 这时它接手 then，排在这些事件之后执行，并返回 true；
// 同步分发完才返回的分发器返回 falsy，由 transaction() 接着执行回调。分发器抛错时回调仍由 transaction() 执行。
// 返回 true 表示回调已被分发器接手。
function flushCommittedEvents(then) {
  const evs = PENDING_EVENTS;
  PENDING_EVENTS = [];
  if (!EVENT_SINK) return false;
  try { return EVENT_SINK(evs, typeof then === "function" ? then : undefined) === true; }
  catch (e) { console.error(`[events] dispatch of ${evs.length} committed event(s) failed: ${(e && e.name) || "Error"}`); return false; }
}
function emitEvent(type, subject, data) {
  if (TX_DEPTH === 0) throw new Error(`store: event ${type} emitted outside a transaction`);
  const ev = events.createEnvelope({ type, subject, data });
  let settled = false;   // 没有订阅方 → 写入即已分发
  if (EVENT_NEEDS_DISPATCH) { try { settled = !EVENT_NEEDS_DISPATCH(type); } catch { settled = false; } }
  stmt("INSERT INTO event_outbox (id, type, occurredAt, actorId, subjectUserId, subjectDeptId, data, version, dispatchedAt, attempts, lastError) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL)")
    .run(ev.id, ev.type, ev.occurredAt, ev.actorId, ev.subject.userId || null, ev.subject.deptId || null, events.encodeData(ev), ev.version, settled ? ev.occurredAt : null);
  if (!settled) PENDING_EVENTS.push(ev);
  return ev;
}
// 分发结果写回（kernel/events.js 的总线在每轮分发之后调用）：成功 → dispatchedAt + attempts+1、
// 清 lastError；失败 → attempts+1 + lastError。一轮一笔事务（4,000 个事件一次提交）。
// 逐行按主键写回（预编译语句；实测比「一条语句 + json_each 展开 id 列表」更快：4,000 行约 30–45ms）。
function recordEventDispatch(results) {
  if (!Array.isArray(results) || !results.length) return;
  const now = new Date().toISOString();
  const ok = stmt("UPDATE event_outbox SET dispatchedAt = ?, attempts = attempts + 1, lastError = NULL WHERE id = ?");
  const bad = stmt("UPDATE event_outbox SET attempts = attempts + 1, lastError = ? WHERE id = ?");
  transaction(() => {
    for (const r of results) {
      if (r.ok) ok.run(now, r.id);
      else bad.run(String(r.error || "failed").slice(0, 1000), r.id);
    }
  });
}
// 模块发布事件的入口（CONTRACT.md 4.4；PHASE2-KERNEL.md 1.5）：就是上面的 emitEvent —— 必须在事务里调用，
// 发件箱行与业务写同一事务，最外层提交后分发，回滚则丢弃。「type 必须在该模块的 publishes 里」
// （event_not_declared）与 GET 只读（write_in_get）由 server.js 的 services 包装层判定：store 不持有注册表。
const publishEvent = (type, subject, data) => emitEvent(type, subject, data);

// ---------- 模块的受限数据库接口（CONTRACT.md 4.1；PHASE2-KERNEL.md 1.3） ----------
// moduleDb(moduleId, tables, tableModule) → { moduleId, db, runReadOnly, isReadOnly }
//   db           冻结的 { prepare(sql) }：交给模块的 services.db。与 TMS 共用同一连接，底层语句走 stmt() 的
//                预编译缓存（同一 SQL 文本同一语句）；prepare 时分两道校验，违反抛 err.code = "db_scope"：
//                ① 词法（checkModuleSql，基于 sqlTokens 单遍扫描）：单条语句（末尾可以有一个分号）、以 SELECT / WITH /
//                  INSERT / UPDATE / DELETE / REPLACE 开头（WITH 只读）；表的位置（FROM / JOIN / INTO / UPDATE 之后，
//                  以及 FROM 列表里逗号之后）只能是本模块的表、本语句 WITH 子句定义的名字或 json_each / json_tree，
//                  不得是字符串（FROM 'users' 在 SQLite 里就是 users 表），不得带库名前缀；字符串紧挨着 "."（'users'.x）拒绝；
//                  逐词（含去掉引号的标识符）拒绝其它模块的表名（tableModule）、sqlite_ / pragma_ 开头的名称、
//                  PRAGMA / ATTACH / DETACH / VACUUM / CREATE / DROP / ALTER。
//                ② 以数据库为准的兜底（checkModuleSqlPlan）：EXPLAIN 这条语句，打开的每个 B 树（OpenRead / OpenWrite /
//                  ReopenIdx 的 p2、Clear 的 p1）都必须是本模块的表或其索引的 rootpage、且在 main 库里；词法漏看的写法
//                  也读不到别人的表。json_each 等虚表与临时表（OpenEphemeral）不开 B 树，不受影响。
//                写语句只能在事务里执行（db_write_outside_tx）；布尔参数拒绝（先转成 0 / 1）。
//   runReadOnly  (fn) → fn()：GET 分发期间调用，写语句抛 err.code = "write_in_get"（可嵌套，异常时照样复位）
//   isReadOnly   () → boolean：services 包装层据此让 transaction / events.publish / notify / defer 也抛 write_in_get
// 两道校验与 modules/culture/test/harness.js 的 checkSql / checkPlan 逐条相同（模块测试用的就是那一份；
// test/kernel-store-modules.test.js 用同一批语句核对两边的判定一致），出现差异以 CONTRACT.md 4.1 为准。
const MODULE_SQL_FIRST = new Set(["SELECT", "WITH", "INSERT", "UPDATE", "DELETE", "REPLACE"]);
const MODULE_SQL_FORBIDDEN = new Set(["PRAGMA", "ATTACH", "DETACH", "VACUUM", "CREATE", "DROP", "ALTER"]);
// FROM 列表在同一层括号里遇到这些词就结束（之后的逗号不再是联接）；JOIN … ON 的 ON 不结束（ON 之后仍可 ", 下一张表"）。
const MODULE_SQL_FROM_END = new Set(["WHERE", "GROUP", "ORDER", "LIMIT", "HAVING", "WINDOW", "UNION", "EXCEPT", "INTERSECT", "RETURNING", "VALUES", "SET", "DO", "SELECT"]);
function moduleCodeError(code, msg) { const e = new Error(code + ": " + msg); e.code = code; return e; }
function checkModuleSql(sql, moduleId, own, foreign) {
  const scope = (msg) => moduleCodeError("db_scope", msg);
  let toks;
  try { toks = sqlTokens(sql); } catch (e) { throw scope(e.message); }
  const semi = toks.findIndex((x) => sqlPunct(x, ";"));
  if (semi > -1) {
    if (semi !== toks.length - 1) throw scope("only one statement is allowed");
    toks = toks.slice(0, semi);
  }
  const first = toks.length && toks[0].t === "id" && !toks[0].q ? toks[0].v.toUpperCase() : "";
  if (!MODULE_SQL_FIRST.has(first)) throw scope("statement must start with SELECT / WITH / INSERT / UPDATE / DELETE / REPLACE");
  toks.forEach((x, k) => {
    if (x.t === "id") {
      if (MODULE_SQL_FORBIDDEN.has(x.v.toUpperCase()) || SQL_SYSTEM_NAME.test(x.v)) throw scope(x.v + " is not allowed");
      if (foreign.has(x.v.toLowerCase())) throw scope(`word "${x.v}" is another module's table name`);
    } else if (x.t === "str" && (sqlPunct(toks[k + 1], ".") || sqlPunct(toks[k - 1], "."))) {
      throw scope("a quoted string cannot be used as a table or column qualifier");
    }
  });
  // WITH 子句定义的名字：WITH [RECURSIVE] name [(cols)] AS [NOT] [MATERIALIZED] ( … ) [, …]（任何一层括号里的 WITH 都算）
  const ctes = new Set();
  const closeOf = (k) => { let d = 0; for (; k < toks.length; k++) { if (sqlPunct(toks[k], "(")) d++; else if (sqlPunct(toks[k], ")") && --d === 0) return k + 1; } return k; };
  for (let k = 0; k < toks.length; k++) {
    if (!sqlKw(toks[k], "WITH")) continue;
    let j = k + 1;
    if (sqlKw(toks[j], "RECURSIVE")) j++;
    for (;;) {
      const name = toks[j];
      if (!name || name.t !== "id") break;
      j++;
      if (sqlPunct(toks[j], "(")) j = closeOf(j);
      if (!sqlKw(toks[j], "AS")) break;
      j++;
      if (sqlKw(toks[j], "NOT")) j++;
      if (sqlKw(toks[j], "MATERIALIZED")) j++;
      if (!sqlPunct(toks[j], "(")) break;
      ctes.add(name.v.toLowerCase());
      j = closeOf(j);
      if (!sqlPunct(toks[j], ",")) break;
      j++;
    }
  }
  const tableAt = (k) => {
    const x = toks[k];
    if (sqlPunct(x, "(")) return;   // 子查询或括号里的联接：里面的 FROM 另行检查
    if (!x || x.t !== "id") throw scope(x && x.t === "str" ? "a quoted string cannot be used as a table name" : "a table name is expected after FROM / JOIN / INTO / UPDATE");
    if (sqlPunct(toks[k + 1], ".")) throw scope(`schema-qualified table names ("${x.v}.…") are not allowed`);
    const t = x.v.toLowerCase();
    if (own.has(t) || ctes.has(t) || t === "json_each" || t === "json_tree") return;
    throw scope(`table "${x.v}" is not owned by ${moduleId}`);
  };
  const frames = [{ from: false }];
  for (let k = 0; k < toks.length; k++) {
    const x = toks[k];
    const fr = frames[frames.length - 1];
    if (sqlPunct(x, "(")) { frames.push({ from: false }); continue; }
    if (sqlPunct(x, ")")) { if (frames.length > 1) frames.pop(); continue; }
    if (sqlPunct(x, ",")) { if (fr.from) tableAt(k + 1); continue; }
    if (x.t !== "id" || x.q) continue;
    const kw = x.v.toUpperCase();
    if (kw === "FROM") {
      if (sqlKw(toks[k - 1], "DISTINCT")) continue;   // a IS [NOT] DISTINCT FROM b
      fr.from = true;
      tableAt(k + 1);
    } else if (kw === "JOIN" || kw === "INTO") tableAt(k + 1);
    else if (kw === "UPDATE") {
      if (sqlKw(toks[k - 1], "DO")) continue;   // ON CONFLICT … DO UPDATE SET
      tableAt(sqlKw(toks[k + 1], "OR") ? k + 3 : k + 1);
    } else if (MODULE_SQL_FROM_END.has(kw)) fr.from = false;
  }
  const write = first === "INSERT" || first === "UPDATE" || first === "DELETE" || first === "REPLACE";
  if (first === "WITH") {
    toks.forEach((x, k) => {
      if (x.t !== "id" || x.q) return;
      const kw = x.v.toUpperCase();
      const dml = kw === "INSERT" || kw === "DELETE" || (kw === "UPDATE" && !sqlKw(toks[k - 1], "DO")) || (kw === "REPLACE" && !sqlPunct(toks[k + 1], "("));
      if (dml) throw scope("a WITH statement must be read-only");
    });
  }
  return { write };
}
// 以数据库为准的兜底：本模块的表及其索引（含自动索引）的 rootpage；EXPLAIN 出来打开的 B 树必须都在其中。
const MODULE_PLAN_FORBIDDEN_OPS = new Set(["Destroy", "CreateBtree", "ParseSchema", "SqlExec", "Vacuum", "IncrVacuum", "VCreate", "VDestroy", "DropTable", "DropIndex", "DropTrigger", "LoadAnalysis", "Expire", "JournalMode"]);
// write：写语句往 AUTOINCREMENT 表插行时 SQLite 自己读写 sqlite_sequence，这时放行它的 rootpage（语句文本里写
// sqlite_sequence 已被词法一道按 sqlite_ 前缀拒绝，模块没法直接读写它）。
function checkModuleSqlPlan(sql, moduleId, own, write) {
  const roots = new Set();
  for (const r of stmt("SELECT tbl_name, rootpage FROM sqlite_master WHERE type IN ('table', 'index') AND rootpage > 0").all()) {
    const t = String(r.tbl_name).toLowerCase();
    if (own.has(t) || (write && t === "sqlite_sequence")) roots.add(Number(r.rootpage));
  }
  const plan = db.prepare("EXPLAIN " + sql).all();
  for (const op of plan) {
    const code = op.opcode;
    let page = null, dbNo = 0, regRoot = false;
    if (code === "OpenRead" || code === "OpenWrite" || code === "ReopenIdx") { page = Number(op.p2); dbNo = Number(op.p3); regRoot = (Number(op.p5) & 0x10) !== 0; }
    else if (code === "Clear") { page = Number(op.p1); dbNo = Number(op.p2); }
    else if (MODULE_PLAN_FORBIDDEN_OPS.has(code)) throw moduleCodeError("db_scope", `the statement's plan uses ${code}, which a module statement may not`);
    else continue;
    if (dbNo !== 0 || regRoot || !roots.has(page))
      throw moduleCodeError("db_scope", `the statement opens a table or index that is not owned by ${moduleId} (${code} on root page ${page}${dbNo ? " of database " + dbNo : ""})`);
  }
}
function checkModuleParams(args) {
  for (const a of args) {
    if (typeof a === "boolean") throw new Error("db: bind booleans as 0 / 1");
    if (a !== null && typeof a !== "string" && typeof a !== "number" && typeof a !== "bigint" && !(a instanceof Uint8Array)) throw new Error("db: unsupported parameter type " + typeof a);
  }
}
function moduleDb(moduleId, tables, tableModule) {
  if (typeof moduleId !== "string" || !MODULE_ID_RE.test(moduleId)) throw new Error(`store.moduleDb: bad module id ${JSON.stringify(moduleId)}`);
  if (!Array.isArray(tables) || tables.some((t) => typeof t !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(t)))
    throw new Error(`store.moduleDb(${moduleId}): tables must be an array of table names`);
  if (!tableModule || typeof tableModule !== "object")
    throw new Error(`store.moduleDb(${moduleId}): tableModule (the registry's table → module map) is required — it is how other modules' tables are refused`);
  const own = new Set(tables.map((t) => t.toLowerCase()));
  const foreign = new Set();
  for (const [t, owner] of Object.entries(tableModule)) {
    const k = String(t).toLowerCase();
    if (owner === moduleId) continue;
    if (own.has(k)) throw new Error(`store.moduleDb(${moduleId}): table ${t} belongs to module ${owner}`);
    foreign.add(k);
  }
  let readOnly = 0;
  const cache = new Map();   // SQL 文本 → 包装后的语句（校验只做一次）
  function prepare(sql) {
    if (typeof sql !== "string") throw moduleCodeError("db_scope", "prepare(sql) needs an SQL string");
    const hit = cache.get(sql);
    if (hit) return hit;
    const info = checkModuleSql(sql, moduleId, own, foreign);
    stmt(sql);   // 在 prepare 时编译：语法错误当场抛出
    checkModuleSqlPlan(sql, moduleId, own, info.write);
    const guard = (args) => {
      checkModuleParams(args);
      if (info.write) {
        if (readOnly > 0) throw moduleCodeError("write_in_get", "write statement during a GET handler");
        if (TX_DEPTH === 0) throw moduleCodeError("db_write_outside_tx", "write statement outside a transaction");
      }
    };
    const wrapped = Object.freeze({
      get: (...a) => { guard(a); return stmt(sql).get(...a); },
      all: (...a) => { guard(a); return stmt(sql).all(...a); },
      run: (...a) => { guard(a); return stmt(sql).run(...a); },
      iterate: (...a) => { guard(a); return stmt(sql).iterate(...a); },
    });
    cache.set(sql, wrapped);
    return wrapped;
  }
  return Object.freeze({
    moduleId,
    db: Object.freeze({ prepare }),
    runReadOnly(fn) {
      readOnly++;
      try { return fn(); } finally { readOnly--; }
    },
    isReadOnly: () => readOnly > 0,
  });
}
// 部门层级索引（一级/二级），给事件 data 用。失效口径与范围缓存相同：本连接的部门写 bump
// SCOPE_EPOCH，别的连接的提交改 data_version。批量接口 4,000 行只在新建部门时重建。
// 事务进行中（BEGIN IMMEDIATE 持写锁）别的连接提交不了，data_version 不会变：同一笔最外层
// 事务里只看 epoch，省掉 4,000 行批量里每行一次 PRAGMA。TX_GEN 在每次最外层 BEGIN 时 +1。
let EVENT_ORG_INDEX = null;
let EVENT_ORG_KEY = null;
let EVENT_ORG_TXGEN = -1;
let EVENT_ORG_EPOCH = -1;
function eventOrgIndex() {
  if (EVENT_ORG_INDEX && TX_DEPTH > 0 && EVENT_ORG_TXGEN === TX_GEN && EVENT_ORG_EPOCH === SCOPE_EPOCH) return EVENT_ORG_INDEX;
  const key = stmt("PRAGMA data_version").get().data_version + ":" + SCOPE_EPOCH;
  if (!EVENT_ORG_INDEX || EVENT_ORG_KEY !== key) {
    EVENT_ORG_INDEX = orgLib.buildOrgIndex(listDepartments(true));
    EVENT_ORG_KEY = key;
  }
  EVENT_ORG_TXGEN = TX_DEPTH > 0 ? TX_GEN : -1;
  EVENT_ORG_EPOCH = SCOPE_EPOCH;
  return EVENT_ORG_INDEX;
}
// 一个人所在部门的事件形状：部门名 + 部门 id + 一级/二级/三级（四级及更深并入三级；直接挂一级
// 部门时 level2、level3 为空、isDirect 为 true，二级展示为「本部」；直接挂二级部门时 level3 为空、
// isDirect2 为 true，三级展示为「本部」）。部门为空 → 全空；部门名不在部门表（或父链成环）→ 只有部门名。
// 2026-09-28 起增加 level3 / level3Id / isDirect2 三键（只增键，信封 version 仍为 1）。
function eventDeptRef(idx, name) {
  const department = name == null || String(name).trim() === "" ? null : String(name);
  const d = department ? idx.deptOf(department) : null;
  const l = department ? idx.levelsOf(department) : null;
  return {
    department, deptId: d ? d.id : null,
    level1: l ? l.level1 : null, level1Id: l ? l.level1Id : null,
    level2: l ? l.level2 : null, level2Id: l ? l.level2Id : null,
    isDirect: l ? l.isDirect : false,
    level3: l ? l.level3 : null, level3Id: l ? l.level3Id : null,
    isDirect2: l ? l.isDirect2 : false,
  };
}
// 「属于某个部门」的人（含停用者），按 org.js 的 deptOf 口径判定：users.department 去首尾空白后
// 与部门原文相同，或只差大小写且没有别的部门与它原文相同。deptRow 为 null 时（自由文本部门名，
// 不在部门表里）取与 name 只差大小写、且不落在任何登记部门上的人。改名级联、删除前的人数校验、
// 清空部门、旧版改名都用它 —— 与 HoD 推算、范围解析认的是同一批人，不会出现「HoD 名单把他算作
// 成员、改名却把他留在旧名上」或「删除校验数到 0 人、实际还有人」。全表一次扫描（4,000 人约几毫秒），
// 只在这几个低频的部门写里用。
function usersResolvingTo(idx, deptRow, name) {
  const key = deptNameKey(deptRow ? deptRow.name : name);
  if (!key) return [];
  const want = deptRow ? String(deptRow.id) : null;
  return stmt("SELECT id, employeeId, department FROM users WHERE department IS NOT NULL AND department <> ''").all()
    .filter((u) => {
      if (deptNameKey(u.department) !== key) return false;
      const hit = idx.deptOf(u.department);
      return (hit ? hit.id : null) === want;
    });
}
// 一个部门在树里的位置（部门事件用）。
function eventDeptPosition(idx, deptId) {
  const d = idx.byId.get(String(deptId));
  if (!d) return { parentId: null, parentName: null, level: null, level1: null, level1Id: null };
  const parent = d.parentId ? idx.byId.get(d.parentId) : null;
  const l = idx.levelsOf(d.name);
  return { parentId: d.parentId || null, parentName: parent ? parent.name : null, level: l ? l.level : null, level1: l ? l.level1 : null, level1Id: l ? l.level1Id : null };
}
const EVENT_USER_FIELDS = ["department", "managerId", "active", "empStatus"];
const eventDeptKey = (s) => (s == null ? "" : String(s).trim().toLowerCase());
const rowActive = (u) => u.active !== 0 && u.active !== false;
const rowInService = (u) => rowActive(u) && u.empStatus !== "exited";   // 与 modules/core/org.js isInService 同口径
function emitHired(u) {
  emitEvent("employee.hired", { userId: u.id }, {
    employeeId: u.employeeId, role: u.role, empStatus: u.empStatus || null, hireDate: u.hireDate || null,
    managerId: u.managerId || null, org: eventDeptRef(eventOrgIndex(), u.department),
  });
}
// 同一次更新可以发多个事件（例如批量同时改部门和上级），顺序固定：transferred → manager_changed →
// terminated / reactivated。
//   transferred   部门名按「去首尾空白、不分大小写」比较（与部门匹配口径一致）：只改大小写不算调动
//   terminated    active 由启用变停用（reason "deactivated"），或 empStatus 变为 exited（reason
//                 "exited"；同一次更新两者都发生时记 exited）。先停用、后补离职记录的人会先后收到
//                 deactivated 与 exited 两个事件 —— 订阅方按幂等处理
//   reactivated   由「不在职」变为「在职」（在职 = 启用且 empStatus 不是 exited）
function emitUserChangeEvents(before, after) {
  const subject = { userId: after.id };
  let idx = null;
  const org = () => idx || (idx = eventOrgIndex());
  if (eventDeptKey(before.department) !== eventDeptKey(after.department))
    emitEvent("employee.transferred", subject, { employeeId: after.employeeId, from: eventDeptRef(org(), before.department), to: eventDeptRef(org(), after.department) });
  if ((before.managerId || null) !== (after.managerId || null))
    emitEvent("employee.manager_changed", subject, { employeeId: after.employeeId, from: before.managerId || null, to: after.managerId || null });
  const exitedNow = after.empStatus === "exited" && before.empStatus !== "exited";
  const deactivatedNow = rowActive(before) && !rowActive(after);
  const status = () => ({
    empStatus: { from: before.empStatus || null, to: after.empStatus || null },
    active: { from: rowActive(before), to: rowActive(after) },
  });
  if (exitedNow || deactivatedNow)
    emitEvent("employee.terminated", subject, { employeeId: after.employeeId, reason: exitedNow ? "exited" : "deactivated", ...status(), org: eventDeptRef(org(), after.department) });
  else if (!rowInService(before) && rowInService(after))
    emitEvent("employee.reactivated", subject, { employeeId: after.employeeId, ...status(), org: eventDeptRef(org(), after.department) });
}

// 批量重置密码的写库一步：改哈希（强制首登改密）+ 吊销该人全部会话。调用方在
// transaction() 里逐人调用 —— 会话吊销与改密同事务，回滚时两者都不发生，提交时两者
// 同时生效（不会出现「密码已改、旧会话还活着」或反过来的中间态）。
function resetUserPasswordAndSessions(id, passwordHash) {
  setUserPassword(id, passwordHash, true);
  deleteUserSessions(id);
}

// users
function getUserByEmployeeId(employeeId) {
  return stmt("SELECT * FROM users WHERE lower(employeeId) = lower(?)").get(String(employeeId || "").trim()) || null;
}
function getUserById(id) {
  return stmt("SELECT * FROM users WHERE id = ?").get(id) || null;
}
function listUsers() {
  return db.prepare("SELECT * FROM users ORDER BY createdAt").all();
}
function employeeIdExists(employeeId) {
  return !!stmt("SELECT 1 FROM users WHERE lower(employeeId) = lower(?)").get(String(employeeId).trim());
}
function createUser({ id, employeeId, name, role, passwordHash, department, email, phone, managerId, larkUserId, mustChangePassword, position, jobLevel, hireDate, empStatus }) {
  const now = new Date().toISOString();
  // New hires get an HR-generated password → must set their own on first login.
  // SSO-provisioned users (larkUserId set) never type that password, so their
  // creator passes mustChangePassword: 0.
  // Employment status defaults to probation 试用 for fresh hires.
  // 领域事件 employee.hired 与建号同一事务（批量建号时并进 runBatch 的事务）。
  return inEventTx(() => {
    stmt("INSERT INTO users (id, employeeId, name, role, passwordHash, lastLoginAt, createdAt, mustChangePassword, department, active, email, phone, managerId, larkUserId, position, jobLevel, hireDate, empStatus) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(id, employeeId, name, role, passwordHash, now, mustChangePassword === 0 ? 0 : 1, department || null, email || null, phone || null, managerId || null, larkUserId || null,
        position || null, jobLevel || null, hireDate || null,
        empStatus || (role === "admin" ? "regular" : "probation"));
    const u = getUserById(id);
    emitHired(u);
    return u;
  });
}
function getUserByLarkId(larkUserId) {
  if (!larkUserId) return undefined;
  return db.prepare("SELECT * FROM users WHERE larkUserId = ?").get(larkUserId);
}
function setUserLarkId(userId, larkUserId) {
  db.prepare("UPDATE users SET larkUserId = ? WHERE id = ?").run(larkUserId || null, userId);
}
// Partial update of profile/admin fields (never touches credentials).
function updateUser(id, fields) {
  // 12.2 受控标签的存储层兜底（设计 b12-design 5.4 第 3 条）：受控写法先规范成 canonical；受控集合有变化时，标签改动与留痕事件
  // （source script）在同一事务里写。演示脚本与今后任何直写 talentTags 的路径都不会绕过留痕。
  if (fields.talentTags !== undefined) {
    const c = canonicalizeTagList(fields.talentTags || []);
    const rest = { ...fields, talentTags: c.out };
    return transaction(() => { tagFallbackEvents(id, c.keys); return updateUserRaw(id, rest); });
  }
  return updateUserRaw(id, fields);
}
function updateUserRaw(id, fields) {
  const allowed = ["name", "department", "role", "active", "email", "phone", "managerId", "position", "jobLevel", "hireDate", "talentTags", "potential", "empStatus", "extras"];
  const sets = [], vals = [];
  for (const k of allowed) {
    if (fields[k] !== undefined) {
      sets.push(`${k} = ?`);
      vals.push(
        k === "active" ? (fields[k] ? 1 : 0)
        : k === "talentTags" ? JSON.stringify(fields[k] || [])
        : k === "extras" ? JSON.stringify(fields[k] || {})
        : fields[k]
      );
    }
  }
  if (!sets.length) return getUserById(id);
  // 潜力评定日期（迁移 67，第二批 2.4）：potential 的值真的变了才写 —— 新值非空写当前时间，清空写 NULL；
  // 原样回传同一个值（编辑资料整页每次都带 potential）不动日期。与本次 UPDATE 同一条语句写入。
  if (fields.potential !== undefined) {
    const cur = stmt("SELECT potential FROM users WHERE id = ?").get(id);
    const next = fields.potential === null || fields.potential === "" ? null : fields.potential;
    if (cur && (cur.potential || null) !== next) { sets.push("potentialAt = ?"); vals.push(next ? new Date().toISOString() : null); }
  }
  // 部门 / 上级 / 启用状态 / 在职状态是领域事件关心的四个字段：碰到其一，就在同一事务里
  // 读变更前的行、写、读变更后的行、按差异发事件（emitUserChangeEvents）。其余字段照旧一条语句。
  if (!EVENT_USER_FIELDS.some((k) => fields[k] !== undefined)) {
    db.prepare(`UPDATE users SET ${sets.join(", ")} WHERE id = ?`).run(...vals, id);
    return getUserById(id);
  }
  return inEventTx(() => {
    const before = stmt("SELECT id, employeeId, department, managerId, active, empStatus FROM users WHERE id = ?").get(id);
    db.prepare(`UPDATE users SET ${sets.join(", ")} WHERE id = ?`).run(...vals, id);
    const after = getUserById(id);
    if (before && after) emitUserChangeEvents(before, after);
    return after;
  });
}
// mustChange: true for HR-issued/reset passwords (forces a change on next login),
// false when the user sets their own.
function setUserPassword(id, passwordHash, mustChange) {
  stmt("UPDATE users SET passwordHash = ?, mustChangePassword = ? WHERE id = ?")
    .run(passwordHash, mustChange ? 1 : 0, id);
}
function setLastLogin(id, iso) {
  db.prepare("UPDATE users SET lastLoginAt = ? WHERE id = ?").run(iso, id);
}
// Department is a free-text field on users (no separate table). These bulk-edit
// it across everyone currently in a given department — the basis for the admin
// "manage departments" tool (rename / delete).
// { inService: true }（CX-127）：只数在职（账号可用、未离职，同 org.js isInService）；不带参数数全部档案（删除前的占用校验用）
function countByDepartment(o = {}) {
  const live = o.inService ? " AND active <> 0 AND (empStatus IS NULL OR empStatus <> 'exited')" : "";
  return db.prepare(`SELECT department AS name, COUNT(*) AS n FROM users WHERE department IS NOT NULL AND department <> ''${live} GROUP BY department ORDER BY department`).all();
}
// renameDepartment 只用于**不在部门表里**的自由文本部门名（部门表里的部门改名走 updateDepartment）：
// 人没有换部门，发一条 department.renamed（subject 无 deptId，data.registered = false）。
// 匹配口径同 usersResolvingTo（大小写变体一并改）。
function renameDepartment(from, to) {
  return inEventTx(() => {
    const idx = eventOrgIndex();
    const affected = usersResolvingTo(idx, idx.deptOf(from), from);
    const up = stmt("UPDATE users SET department = ? WHERE id = ?");
    for (const u of affected) up.run(to, u.id);
    const n = affected.length;
    if (n > 0) emitEvent("department.renamed", {}, { from: String(from), to: String(to), registered: false, members: n });
    return n;
  });
}
// 清空一个部门名上的全部人员：每人一条 employee.transferred（to 为空）。现有接口在调用前
// 已拦下「部门里还有人」的情况，这里仍按实际改到的人发事件，保证 store 层的口径完整。
// 匹配口径同 usersResolvingTo。
function clearDepartment(name) {
  return inEventTx(() => {
    const idx = eventOrgIndex();
    const affected = usersResolvingTo(idx, idx.deptOf(name), name);
    const up = stmt("UPDATE users SET department = NULL WHERE id = ?");
    for (const u of affected) up.run(u.id);
    for (const u of affected)
      emitEvent("employee.transferred", { userId: u.id }, { employeeId: u.employeeId, from: eventDeptRef(idx, u.department), to: eventDeptRef(idx, null) });
    return affected.length;
  });
}

// sessions (with server-side expiry)
function createSession(token, userId) {
  const now = Date.now();
  db.prepare("INSERT INTO sessions (token, userId, createdAt, expiresAt) VALUES (?, ?, ?, ?)")
    .run(token, userId, new Date(now).toISOString(), new Date(now + SESSION_TTL_MS).toISOString());
}
function getSessionUser(token) {
  if (!token) return null;
  const s = db.prepare("SELECT * FROM sessions WHERE token = ?").get(token);
  if (!s) return null;
  if (new Date(s.expiresAt).getTime() < Date.now()) {
    db.prepare("DELETE FROM sessions WHERE token = ?").run(token);
    return null;
  }
  return getUserById(s.userId);
}
function deleteUserSessions(userId) {
  stmt("DELETE FROM sessions WHERE userId = ?").run(userId);
}
// CX-093（10/11 上线前测试）：本人改密后吊销其他设备上的会话，保留当前这台。返回吊销的条数。
function deleteOtherSessions(userId, keepToken) {
  return db.prepare("DELETE FROM sessions WHERE userId = ? AND token <> ?").run(userId, String(keepToken || "")).changes;
}
// Sign out just this device/tab (the default for the logout button).
function deleteSession(token) {
  db.prepare("DELETE FROM sessions WHERE token = ?").run(token);
}
function cleanupExpiredSessions() {
  db.prepare("DELETE FROM sessions WHERE expiresAt < ?").run(new Date().toISOString());
}

// ---------- password-reset tokens（自助找回密码） ----------
// The table stores sha256(token) and nothing else — see migration 45. Nothing
// in this file ever sees, logs or returns a token in the clear: the caller
// hands in the hash.
function createPasswordReset(row) {
  db.prepare(
    `INSERT INTO password_resets (id, userId, tokenHash, expiresAt, usedAt, createdAt, requestedFor)
     VALUES (?, ?, ?, ?, NULL, ?, ?)`
  ).run(row.id, row.userId, row.tokenHash, row.expiresAt, row.createdAt, row.requestedFor || null);
}
function getPasswordResetByHash(tokenHash) {
  if (!tokenHash) return null;
  return db.prepare("SELECT * FROM password_resets WHERE tokenHash = ?").get(tokenHash) || null;
}
// Single use, enforced by the UPDATE itself: `usedAt IS NULL` in the WHERE means
// two requests racing with the SAME link both pass the read check, but only one
// of them reports changes === 1 — the other is refused like any dead link.
function markPasswordResetUsed(id, iso) {
  return db.prepare("UPDATE password_resets SET usedAt = ? WHERE id = ? AND usedAt IS NULL").run(iso, id).changes;
}
// A fresh request voids the account's outstanding (unused) links, so only the
// newest mail ever works and tokens can't pile up for one employee.
function deleteUnusedPasswordResets(userId) {
  return db.prepare("DELETE FROM password_resets WHERE userId = ? AND usedAt IS NULL").run(userId).changes;
}
// Housekeeping: an expired row (used or not) can no longer authorise anything,
// and keeping it around only extends how long a hash sits in the backups.
function prunePasswordResets(iso) {
  return db.prepare("DELETE FROM password_resets WHERE expiresAt < ?").run(iso).changes;
}

// progress
function getCourseProgress(userId, courseId) {
  const rows = db.prepare("SELECT moduleId, completedAt FROM progress WHERE userId = ? AND courseId = ?").all(userId, courseId);
  const out = {};
  for (const r of rows) out[r.moduleId] = r.completedAt;
  return out;
}
function setModuleComplete(userId, courseId, moduleId, iso) {
  db.prepare(
    `INSERT INTO progress (userId, courseId, moduleId, completedAt) VALUES (?, ?, ?, ?)
     ON CONFLICT(userId, courseId, moduleId) DO UPDATE SET completedAt = excluded.completedAt`
  ).run(userId, courseId, moduleId, iso);
}

// exams
function listExams() {
  return db.prepare("SELECT * FROM exams ORDER BY createdAt").all().map(rowToExam);
}
function listProgramExams(programId) {
  return db.prepare("SELECT * FROM exams WHERE programId = ? ORDER BY createdAt").all(programId).map(rowToExam);
}
function getExam(id) {
  return rowToExam(db.prepare("SELECT * FROM exams WHERE id = ?").get(id));
}
function createExam(e) {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO exams (id, programId, title, title_zh, status, passingScore, mcqCount, openCount, timeLimitMinutes, maxAttempts, retakeCooldownHours, showAnswersAfterExam, autoRetrain, createdAt, updatedAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    e.id, e.programId, e.title, e.title_zh || null, e.status || "published",
    e.passingScore, e.mcqCount, e.openCount, e.timeLimitMinutes || null,
    e.maxAttempts || 0, e.retakeCooldownHours || 0, e.showAnswersAfterExam ? 1 : 0,
    e.autoRetrain === false ? 0 : 1, now, now
  );
  db.prepare("UPDATE exams SET typePoints = ?, multiPartial = ?, mode = ?, questionIds = ? WHERE id = ?")
    .run(e.typePoints ? JSON.stringify(e.typePoints) : null, e.multiPartial === false ? 0 : 1, e.mode === "fixed" ? "fixed" : null, e.mode === "fixed" && Array.isArray(e.questionIds) ? JSON.stringify(e.questionIds) : null, e.id);
  writeExamOptions(e.id, e);
  return getExam(e.id);
}
// 第四批（迁移 73）：考试选项三列。缺省 = 默认（选项每次随机、按比例给分、0 组案例）
function writeExamOptions(id, e) {
  const n = Math.round(Number(e.caseCount));
  db.prepare("UPDATE exams SET shuffleOptions = ?, partialCredit = ?, caseCount = ? WHERE id = ?")
    .run(e.shuffleOptions === false ? 0 : 1, e.partialCredit === false ? 0 : 1, Number.isFinite(n) && n > 0 ? n : 0, id);
  // F58（迁移 90）：考前须知两列。调用方没带这个键 = 保留原值（服务端 validateExam 已去首尾空白、限 1000 字）；空串存 NULL
  const has = (k) => Object.prototype.hasOwnProperty.call(e, k);
  if (has("preNotice")) db.prepare("UPDATE exams SET preNotice = ? WHERE id = ?").run(e.preNotice ? String(e.preNotice) : null, id);
  if (has("preNotice_zh")) db.prepare("UPDATE exams SET preNotice_zh = ? WHERE id = ?").run(e.preNotice_zh ? String(e.preNotice_zh) : null, id);
}
function updateExam(id, e) {
  db.prepare(
    `UPDATE exams SET title = ?, title_zh = ?, status = ?, passingScore = ?, mcqCount = ?, openCount = ?, timeLimitMinutes = ?, maxAttempts = ?, retakeCooldownHours = ?, showAnswersAfterExam = ?, autoRetrain = ?, updatedAt = ? WHERE id = ?`
  ).run(
    e.titleEn !== undefined ? e.titleEn : e.title, e.title_zh || null, e.status || "published",
    e.passingScore, e.mcqCount, e.openCount, e.timeLimitMinutes || null,
    e.maxAttempts || 0, e.retakeCooldownHours || 0, e.showAnswersAfterExam ? 1 : 0,
    e.autoRetrain === false ? 0 : 1,
    new Date().toISOString(), id
  );
  db.prepare("UPDATE exams SET typePoints = ?, multiPartial = ?, mode = ?, questionIds = ? WHERE id = ?")
    .run(e.typePoints ? JSON.stringify(e.typePoints) : null, e.multiPartial === false ? 0 : 1, e.mode === "fixed" ? "fixed" : null, e.mode === "fixed" && Array.isArray(e.questionIds) ? JSON.stringify(e.questionIds) : null, id);
  writeExamOptions(id, e);
  return getExam(id);
}
function getExamCourseIds(examId) {
  return db.prepare("SELECT courseId FROM exam_courses WHERE examId = ? ORDER BY sortOrder").all(examId).map((r) => r.courseId);
}
function setExamCourses(examId, courseIds) {
  db.exec("BEGIN");
  try {
    db.prepare("DELETE FROM exam_courses WHERE examId = ?").run(examId);
    const ins = db.prepare("INSERT INTO exam_courses (examId, courseId, sortOrder) VALUES (?, ?, ?)");
    courseIds.forEach((cid, i) => ins.run(examId, cid, i));
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

// attempts
function createAttempt(a) {
  db.prepare("INSERT INTO attempts (id, userId, programId, examId, startedAt, submittedAt, questions, answers, percent, passed, detail) VALUES (?, ?, ?, ?, ?, NULL, ?, NULL, NULL, NULL, NULL)")
    .run(a.id, a.userId, a.programId, a.examId || null, a.startedAt, JSON.stringify(a.questions));
}
function getAttempt(id) {
  return rowToAttempt(db.prepare("SELECT * FROM attempts WHERE id = ?").get(id));
}
// The employee's current unsubmitted attempt on an exam (for refresh recovery).
function getOpenAttempt(userId, examId) {
  return rowToAttempt(
    db.prepare("SELECT * FROM attempts WHERE userId = ? AND examId = ? AND submittedAt IS NULL ORDER BY startedAt DESC LIMIT 1").get(userId, examId)
  );
}
// 中途离开考试：重新进入时丢弃未交卷的答卷（整行删除）—— 它从未提交，不计次数、不计成绩，
// 也没有申诉 / 评分记录挂在它上面（这些只针对已提交的答卷）。返回删除行数。
function discardOpenAttempts(userId, examId) {
  return db.prepare("DELETE FROM attempts WHERE userId = ? AND examId = ? AND submittedAt IS NULL").run(userId, examId).changes;
}
// Periodic answer draft while the exam is in progress.
function saveAttemptDraft(id, answers) {
  const now = new Date().toISOString();
  db.prepare("UPDATE attempts SET draftAnswers = ?, lastSavedAt = ? WHERE id = ?")
    .run(JSON.stringify(answers), now, id);
  return now;
}
// 交卷。只在 submittedAt 仍为空时写入（交卷防重：同一答卷的第二次提交改不到任何行，返回 false）。
function submitAttempt(id, { submittedAt, answers, percent, passed, detail, blurCount, gradingStatus }) {
  return db.prepare("UPDATE attempts SET submittedAt = ?, answers = ?, percent = ?, passed = ?, detail = ?, blurCount = ?, gradingStatus = ? WHERE id = ? AND submittedAt IS NULL")
    .run(submittedAt, JSON.stringify(answers), percent, passed ? 1 : 0, JSON.stringify(detail), blurCount || 0, gradingStatus || "final", id).changes === 1;
}
// HR score override on an open question → re-stored grading result.
// gradingStatus 不传时不改（兼容旧调用方）；评分队列定稿与 HR 复核定稿时一并写入。
function updateAttemptGrading(id, { percent, passed, detail, gradingStatus }) {
  if (gradingStatus === undefined)
    db.prepare("UPDATE attempts SET percent = ?, passed = ?, detail = ? WHERE id = ?")
      .run(percent, passed ? 1 : 0, JSON.stringify(detail), id);
  else
    db.prepare("UPDATE attempts SET percent = ?, passed = ?, detail = ?, gradingStatus = ? WHERE id = ?")
      .run(percent, passed ? 1 : 0, JSON.stringify(detail), gradingStatus, id);
}
// 评分队列：处于某些状态的答卷（重启恢复、HR 待办计数）
function listAttemptsByGradingStatus(statuses) {
  if (!statuses || !statuses.length) return [];
  const marks = statuses.map(() => "?").join(",");
  return db.prepare(`SELECT * FROM attempts WHERE gradingStatus IN (${marks}) AND submittedAt IS NOT NULL AND COALESCE(voided, 0) = 0 ORDER BY submittedAt`).all(...statuses).map(rowToAttempt);
}
// 同一考试是否有结论待定（grading / pending_review）的答卷：开始下一次考试与「重置考试次数」都要先等它结案
function pendingExamAttempt(userId, examId) {
  return rowToAttempt(db.prepare("SELECT * FROM attempts WHERE userId = ? AND examId = ? AND submittedAt IS NOT NULL AND COALESCE(voided, 0) = 0 AND gradingStatus IN ('grading','pending_review') ORDER BY submittedAt DESC LIMIT 1").get(userId, examId));
}
function listUserAttempts(userId, programId) {
  return db.prepare("SELECT * FROM attempts WHERE userId = ? AND programId = ? AND submittedAt IS NOT NULL ORDER BY submittedAt DESC").all(userId, programId).map(rowToAttempt);
}
// Voided attempts (HR reset) don't count toward limits or best scores anywhere
// in the employee-facing logic; the admin Results view still lists them.
function listUserExamAttempts(userId, examId) {
  return db.prepare("SELECT * FROM attempts WHERE userId = ? AND examId = ? AND submittedAt IS NOT NULL AND COALESCE(voided, 0) = 0 ORDER BY submittedAt DESC").all(userId, examId).map(rowToAttempt);
}
// 结论待定（grading / pending_review）的答卷不计入最好成绩，定稿后计入（方案 2.5）
const SETTLED = "COALESCE(gradingStatus, 'final') NOT IN ('grading','pending_review')";
function bestExamAttempt(userId, examId) {
  const r = db.prepare(`SELECT * FROM attempts WHERE userId = ? AND examId = ? AND submittedAt IS NOT NULL AND COALESCE(voided, 0) = 0 AND ${SETTLED} ORDER BY percent DESC, COALESCE(passed, 0) DESC, rowid LIMIT 1`).get(userId, examId);
  return rowToAttempt(r);
}
function listExamAttempts(examId) {
  return db.prepare("SELECT * FROM attempts WHERE examId = ? AND submittedAt IS NOT NULL AND COALESCE(voided, 0) = 0").all(examId).map(rowToAttempt);
}
function bestAttempt(userId, programId) {
  const r = db.prepare(`SELECT * FROM attempts WHERE userId = ? AND programId = ? AND submittedAt IS NOT NULL AND COALESCE(voided, 0) = 0 AND ${SETTLED} ORDER BY percent DESC, COALESCE(passed, 0) DESC, rowid LIMIT 1`).get(userId, programId);
  return rowToAttempt(r);
}
function voidUserExamAttempts(userId, examId) {
  return db.prepare("UPDATE attempts SET voided = 1 WHERE userId = ? AND examId = ? AND submittedAt IS NOT NULL AND COALESCE(voided, 0) = 0").run(userId, examId).changes;
}
// Wipe a user's module completions for one course (auto-remediation: 重修).
function clearCourseProgress(userId, courseId) {
  return db.prepare("DELETE FROM progress WHERE userId = ? AND courseId = ?").run(userId, courseId).changes;
}
function listSubmittedAttempts() {
  return db.prepare("SELECT * FROM attempts WHERE submittedAt IS NOT NULL ORDER BY submittedAt DESC").all().map(rowToAttempt);
}

// questions
function listQuestions() {
  return db.prepare("SELECT * FROM questions").all().map(rowToQuestion);
}
function addQuestion(q) {
  const n = Number(getMeta("nextQ") || 1);
  const id = "q" + n;
  insertQuestionRow({ ...q, id });
  setMeta("nextQ", n + 1);
  return id;
}
function deleteQuestion(id) {
  db.prepare("DELETE FROM questions WHERE id = ?").run(id);
}
// 原地改题（保留 id：固定题目模式的考试按 id 引用题目）。q 是完整条目，所有列按它重写。
function updateQuestion(id, q) {
  const col = QTYPES.questionColumns(q);   // 第四批：同 insertQuestionRow，含 data 列
  db.prepare(
    `UPDATE questions SET courseId = ?, moduleId = ?, type = ?, question = ?, question_zh = ?, options = ?, explanation = ?, explanation_zh = ?,
       rubric = ?, rubric_zh = ?, maxPoints = ?, origin = ?, points = ?, data = ? WHERE id = ?`
  ).run(
    q.courseId, q.moduleId || null, q.type, q.question, q.question_zh || null,
    col.options,
    col.explanation, col.explanation_zh,
    col.rubric, col.rubric_zh,
    col.maxPoints,
    q.origin ? JSON.stringify(q.origin) : null,
    q.points != null ? q.points : null,
    col.data,
    String(id)
  );
}
// 题库批量修改（2026-10-06 批量操作 B4）：只动一两列的窄更新，其余列一字不动（不经 rowToQuestion → updateQuestion
// 的整行重写 —— 那条路会丢掉题型不用的列，旧行里的坏 JSON 还会让整批失败）。points = null 即按考试的题型默认分值。
function updateQuestionPoints(id, points) {
  return db.prepare("UPDATE questions SET points = ? WHERE id = ?").run(points == null ? null : points, String(id)).changes;
}
function updateQuestionPlacement(id, courseId, moduleId) {
  return db.prepare("UPDATE questions SET courseId = ?, moduleId = ? WHERE id = ?").run(courseId, moduleId || null, String(id)).changes;
}
// 批量修改读的摘要：只取判定要用的列，不解析 options / origin。
function getQuestionBrief(id) {
  return db.prepare("SELECT id, courseId, moduleId, type, points FROM questions WHERE id = ?").get(String(id)) || null;
}
// 各课程各题型的题量（随机抽题考试的题量提醒用；只计数，不解析题目 JSON）。
function countQuestionsByCourseType() {
  return db.prepare("SELECT courseId, type, COUNT(*) AS n FROM questions GROUP BY courseId, type").all();
}

/* ---- secondary reporting lines 虚线汇报 / 兼任 ----
   Additive to users.managerId, never a replacement: the solid line stays the
   single source of truth for the org tree, performance routing and diagnostics
   depth. These rows are the matrix layer drawn on top. */
function listSecondaryLines(userId) {
  return db.prepare("SELECT * FROM secondary_lines WHERE userId = ? ORDER BY kind, createdAt").all(userId);
}
// Dotted lines pointing AT someone — their matrix team.
function listSecondaryReports(managerId) {
  return db.prepare("SELECT * FROM secondary_lines WHERE managerId = ? ORDER BY createdAt").all(managerId);
}
function listAllSecondaryLines() {
  return db.prepare("SELECT * FROM secondary_lines ORDER BY createdAt").all();
}
function getSecondaryLine(id) {
  return stmt("SELECT * FROM secondary_lines WHERE id = ?").get(id) || null;
}
function addSecondaryLine({ userId, managerId, kind, position, department, note, createdBy }) {
  const n = Number(getMeta("nextSL") || 1);
  setMeta("nextSL", n + 1);
  const id = "sl-" + n;
  stmt(
    `INSERT OR IGNORE INTO secondary_lines (id, userId, managerId, kind, position, department, note, createdAt, createdBy)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, userId, managerId || null, kind, position || null, department || null, note || null, new Date().toISOString(), createdBy || null);
  return getSecondaryLine(id);
}
/* ---------- exam-grade appeals (申诉) ----------
   One open appeal per attempt is enforced by a partial unique index; resolved
   rows stay so a second appeal after a rejection still shows the first. */
function listAppealsForAttempts(attemptIds) {
  if (!attemptIds || !attemptIds.length) return new Map();
  const marks = attemptIds.map(() => "?").join(",");
  const rows = db.prepare(
    `SELECT * FROM attempt_appeals WHERE attemptId IN (${marks}) ORDER BY createdAt DESC`
  ).all(...attemptIds);
  // Newest first, so the first row seen per attempt is the current one.
  const byAttempt = new Map();
  for (const r of rows) if (!byAttempt.has(r.attemptId)) byAttempt.set(r.attemptId, r);
  return byAttempt;
}
function listAppealsByUser(userId) {
  return db.prepare("SELECT * FROM attempt_appeals WHERE userId = ? ORDER BY createdAt DESC").all(userId);
}
function getAppeal(id) {
  return db.prepare("SELECT * FROM attempt_appeals WHERE id = ?").get(id) || null;
}
function getOpenAppeal(attemptId) {
  return db.prepare("SELECT * FROM attempt_appeals WHERE attemptId = ? AND status = 'open'").get(attemptId) || null;
}
function countOpenAppeals() {
  return db.prepare("SELECT COUNT(*) n FROM attempt_appeals WHERE status = 'open'").get().n;
}
function addAppeal({ attemptId, userId, reason }) {
  const n = Number(getMeta("nextAP") || 1);
  setMeta("nextAP", n + 1);
  const id = "ap-" + n;
  db.prepare(
    `INSERT INTO attempt_appeals (id, attemptId, userId, reason, status, createdAt)
     VALUES (?, ?, ?, ?, 'open', ?)`
  ).run(id, attemptId, userId, reason, new Date().toISOString());
  return getAppeal(id);
}
function resolveAppeal(id, { status, resolution, resolvedBy }) {
  db.prepare(
    "UPDATE attempt_appeals SET status = ?, resolution = ?, resolvedBy = ?, resolvedAt = ? WHERE id = ? AND status = 'open'"
  ).run(status, resolution || null, resolvedBy || null, new Date().toISOString(), id);
  return getAppeal(id);
}

function deleteSecondaryLine(id) {
  db.prepare("DELETE FROM secondary_lines WHERE id = ?").run(id);
}
// Deleting a person takes their matrix rows with them, in both directions.
function deleteSecondaryLinesForUser(userId) {
  db.prepare("DELETE FROM secondary_lines WHERE userId = ? OR managerId = ?").run(userId, userId);
}

// content (programs & courses as JSON documents)
function listContent(kind) {
  return db.prepare("SELECT json FROM content WHERE kind = ? ORDER BY rowid").all(kind).map((r) => JSON.parse(r.json));
}
function putContent(kind, id, obj) {
  db.prepare(
    `INSERT INTO content (kind, id, json, updatedAt) VALUES (?, ?, ?, ?)
     ON CONFLICT(kind, id) DO UPDATE SET json = excluded.json, updatedAt = excluded.updatedAt`
  ).run(kind, id, JSON.stringify(obj), new Date().toISOString());
}
function deleteContent(kind, id) {
  db.prepare("DELETE FROM content WHERE kind = ? AND id = ?").run(kind, id);
}
// 内容文档的最近保存时间（CX-042 课程编辑乐观锁用）；没有这行时 null
function contentUpdatedAt(kind, id) {
  const r = db.prepare("SELECT updatedAt FROM content WHERE kind = ? AND id = ?").get(kind, id);
  return r ? r.updatedAt : null;
}

// audit log (append-only)
function addAudit(e) {
  db.prepare(
    "INSERT INTO audit_logs (actorId, actorName, action, target, beforeJson, afterJson, requestId, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  ).run(
    e.actorId || null, e.actorName || null, e.action, e.target || null,
    e.before !== undefined && e.before !== null ? JSON.stringify(e.before) : null,
    e.after !== undefined && e.after !== null ? JSON.stringify(e.after) : null,
    e.requestId || null, new Date().toISOString()
  );
}
function listAudit(limit = 300, offset = 0) {
  return db.prepare("SELECT * FROM audit_logs ORDER BY id DESC LIMIT ? OFFSET ?").all(limit, offset);
}
// The audit table is the one that grows without bound, so the page has to be
// able to say how many rows really exist rather than how many it fetched.
function countAudit() {
  return db.prepare("SELECT COUNT(*) AS n FROM audit_logs").get().n;
}
// 某个动作针对一批 target 的审计行（第二批 2.6：档案评级修改的理由与操作人，只在后台档案里读）。
// 按 id 升序（先发生的在前）；afterJson / beforeJson 原样返回，由调用方解析。audit_logs 没有 target 索引，这一查是
// 全表扫描 —— 只在打开一个有改动的档案时发生、每次只问这一个人的几条记录，可以接受；表过大时再加索引迁移。
function listAuditByTargets(action, targets) {
  const ids = [...new Set((targets || []).filter((t) => t !== null && t !== undefined && t !== "").map(String))];
  if (!action || !ids.length) return [];
  const out = [];
  for (let i = 0; i < ids.length; i += 200) {
    const part = ids.slice(i, i + 200);
    out.push(...db.prepare(`SELECT * FROM audit_logs WHERE action = ? AND target IN (${part.map(() => "?").join(", ")}) ORDER BY id ASC`).all(action, ...part));
  }
  return out.sort((a, b) => a.id - b.id);
}
// 多个动作 × 一批 target 一次查完（第二批 2.8 申诉详情的 calibrationLog 与利益回避：原来要三次全表扫描，审查）。按 id 升序。
function listAuditByTargetsAny(actions, targets) {
  const acts = [...new Set((actions || []).filter(Boolean).map(String))];
  const ids = [...new Set((targets || []).filter((t) => t !== null && t !== undefined && t !== "").map(String))];
  if (!acts.length || !ids.length) return [];
  const out = [];
  for (let i = 0; i < ids.length; i += 200) {
    const part = ids.slice(i, i + 200);
    out.push(...db.prepare(`SELECT * FROM audit_logs WHERE action IN (${acts.map(() => "?").join(", ")}) AND target IN (${part.map(() => "?").join(", ")}) ORDER BY id ASC`).all(...acts, ...part));
  }
  return out.sort((a, b) => a.id - b.id);
}
// 审计页的「本人回避」（第二批 2.8，审查）：这个人有没有涉及本人评级修改 / 申诉的审计行。没有就不必为本人回避逐行扫描。
function auditHasSelfSensitive(userId) {
  if (!userId) return false;
  if (db.prepare("SELECT 1 FROM review_appeals WHERE userId = ? LIMIT 1").get(String(userId))) return true;
  return !!db.prepare("SELECT 1 FROM audit_logs WHERE action = 'talent.record.rating-amend' AND afterJson LIKE ? LIMIT 1").get(`%"userId":${JSON.stringify(String(userId))}%`);
}

// content version snapshots
function snapshotContent(kind, contentId, obj, actorId) {
  const v = (db.prepare("SELECT MAX(version) AS v FROM content_versions WHERE kind = ? AND contentId = ?").get(kind, contentId).v || 0) + 1;
  db.prepare("INSERT INTO content_versions (kind, contentId, version, json, actorId, createdAt) VALUES (?, ?, ?, ?, ?, ?)")
    .run(kind, contentId, v, JSON.stringify(obj), actorId || null, new Date().toISOString());
  return v;
}

// attachments
function createAttachment(a) {
  // ownerKind/ownerId generalise files beyond courses (Phase A); course files
  // keep courseId mirrored into ownerId for the legacy access path.
  const ownerKind = a.ownerKind || (a.courseId ? "course" : null);
  const ownerId = a.ownerId || a.courseId || null;
  db.prepare(
    "INSERT INTO attachments (id, courseId, kind, storageKey, originalName, mime, size, uploadedBy, createdAt, ownerKind, ownerId) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
  ).run(a.id, a.courseId || null, a.kind, a.storageKey, a.originalName, a.mime, a.size, a.uploadedBy || null, new Date().toISOString(), ownerKind, ownerId);
}
function getAttachment(id) {
  return db.prepare("SELECT * FROM attachments WHERE id = ?").get(id) || null;
}
function listAllAttachments() {
  return db.prepare("SELECT * FROM attachments").all();
}
// Used by the office->PDF migration to point an attachment at its converted file.
function updateAttachment(id, fields) {
  const a = db.prepare("SELECT * FROM attachments WHERE id = ?").get(id);
  if (!a) return null;
  const m = { ...a, ...fields };
  db.prepare("UPDATE attachments SET kind = ?, storageKey = ?, mime = ?, size = ? WHERE id = ?")
    .run(m.kind, m.storageKey, m.mime, m.size, id);
  return db.prepare("SELECT * FROM attachments WHERE id = ?").get(id);
}
// Office 课件补转成 PDF 之后改指向（P0 1.4，modules/learning/office-convert.js 与离线脚本共用）。
// 条件更新：只有附件仍指向转换前的那个文件（fromKey）才改，期间被别处改过就不动 —— 返回 false，
// 调用方丢掉刚生成的 PDF。返回 true 表示恰好改了这一行。
function convertAttachmentToPdf(id, fromKey, { storageKey, size }) {
  const r = db.prepare("UPDATE attachments SET kind = 'pdf', storageKey = ?, mime = 'application/pdf', size = ? WHERE id = ? AND storageKey = ?")
    .run(String(storageKey), Number(size) || 0, String(id), String(fromKey));
  return r.changes === 1;
}
// ---- 非课程附件（第二批 2.8 申诉佐证材料，ownerKind 'review_appeal'）----
// courseId 写 ''（表上 NOT NULL；保存课程时永远匹配不到任何课程），ownerId 先为空，提交申诉时由 bindAttachmentOwner 绑定。
function createOwnedAttachment(a) {
  db.prepare(
    "INSERT INTO attachments (id, courseId, kind, storageKey, originalName, mime, size, uploadedBy, createdAt, ownerKind, ownerId) VALUES (?, '', ?, ?, ?, ?, ?, ?, ?, ?, NULL)"
  ).run(a.id, a.kind, a.storageKey, a.originalName, a.mime, a.size, a.uploadedBy || null, a.createdAt || new Date().toISOString(), a.ownerKind);
  return getAttachment(a.id);
}
// 只绑定本人上传、尚未绑定的那一行；返回是否恰好绑定了一行
function bindAttachmentOwner(id, ownerKind, ownerId, uploadedBy) {
  return db.prepare("UPDATE attachments SET ownerId = ? WHERE id = ? AND ownerKind = ? AND ownerId IS NULL AND uploadedBy = ?")
    .run(String(ownerId), String(id), String(ownerKind), String(uploadedBy)).changes === 1;
}
function listAttachmentsByOwner(ownerKind, ownerId) {
  return db.prepare("SELECT * FROM attachments WHERE ownerKind = ? AND ownerId = ? ORDER BY createdAt, id").all(String(ownerKind), String(ownerId));
}
function countUnboundAttachments(ownerKind, uploadedBy, sinceIso) {
  return db.prepare("SELECT COUNT(*) AS n FROM attachments WHERE ownerKind = ? AND ownerId IS NULL AND uploadedBy = ? AND createdAt >= ?")
    .get(String(ownerKind), String(uploadedBy), String(sinceIso)).n;
}

// ---- 课件内视频（第三批 5.7，迁移 72 attachment_media）----
// 转码引擎 modules/learning/video-transcode.js 与 server.js 只经这组函数读写。slides 存 JSON，读出时解析成数组。
const MEDIA_STATUSES = ["pending", "transcoding", "ready", "failed", "external", "skipped"];
const MEDIA_COLS = ["id", "attachmentId", "seq", "kind", "source", "name", "url", "slides", "srcKey", "srcExt", "srcSize",
  "storageKey", "size", "durationSec", "status", "reason", "detail", "attempts", "createdAt", "updatedAt"];
function rowToMedia(r) {
  if (!r) return null;
  let slides = [];
  try { const s = JSON.parse(r.slides || "[]"); slides = Array.isArray(s) ? s : []; } catch {}
  return { ...r, slides, attempts: r.attempts || 0 };
}
// 一个事务插入多行；缺 id 的生成 am-<12 hex>。返回插入后的行（已解析）。
function createAttachmentMedia(rows) {
  const list = (Array.isArray(rows) ? rows : [rows]).filter(Boolean);
  if (!list.length) return [];
  const now = new Date().toISOString();
  const ins = db.prepare(`INSERT INTO attachment_media (${MEDIA_COLS.join(", ")}) VALUES (${MEDIA_COLS.map(() => "?").join(", ")})`);
  const ids = [];
  transaction(() => {
    for (const r of list) {
      const id = r.id || "am-" + require("crypto").randomBytes(6).toString("hex");
      const v = {
        ...r, id, kind: r.kind || "video", source: r.source || "embedded", name: String(r.name || "").slice(0, 200) || "video",
        slides: JSON.stringify(Array.isArray(r.slides) ? r.slides : []), status: MEDIA_STATUSES.includes(r.status) ? r.status : "pending",
        attempts: Number(r.attempts) || 0, createdAt: r.createdAt || now, updatedAt: r.updatedAt || now,
      };
      ins.run(...MEDIA_COLS.map((k) => (v[k] === undefined ? null : v[k])));
      ids.push(id);
    }
  });
  return ids.map(getAttachmentMedia);
}
// 过滤：attachmentId（单个）、attachmentIds（多个）、statuses（多个）。按 attachmentId, seq 排序。
function listAttachmentMedia({ attachmentId, attachmentIds, statuses } = {}) {
  const where = [], args = [];
  if (attachmentId) { where.push("attachmentId = ?"); args.push(String(attachmentId)); }
  if (Array.isArray(attachmentIds)) {
    if (!attachmentIds.length) return [];
    where.push(`attachmentId IN (${attachmentIds.map(() => "?").join(",")})`); args.push(...attachmentIds.map(String));
  }
  if (Array.isArray(statuses)) {
    if (!statuses.length) return [];
    where.push(`status IN (${statuses.map(() => "?").join(",")})`); args.push(...statuses.map(String));
  }
  const sql = "SELECT * FROM attachment_media" + (where.length ? " WHERE " + where.join(" AND ") : "") + " ORDER BY attachmentId, seq";
  return db.prepare(sql).all(...args).map(rowToMedia);
}
function getAttachmentMedia(id) {
  return rowToMedia(db.prepare("SELECT * FROM attachment_media WHERE id = ?").get(String(id)));
}
// 条件更新：opts.expectStatus（字符串或数组）给了就只在当前状态匹配时更新。自动写 updatedAt。返回改动行数（0/1）。
function updateAttachmentMedia(id, patch, { expectStatus } = {}) {
  const keys = Object.keys(patch || {}).filter((k) => MEDIA_COLS.includes(k) && k !== "id" && k !== "createdAt" && k !== "updatedAt");
  const vals = keys.map((k) => (k === "slides" ? JSON.stringify(Array.isArray(patch.slides) ? patch.slides : []) : patch[k] === undefined ? null : patch[k]));
  const sets = keys.map((k) => `${k} = ?`).concat("updatedAt = ?");
  vals.push(new Date().toISOString());
  let sql = `UPDATE attachment_media SET ${sets.join(", ")} WHERE id = ?`;
  vals.push(String(id));
  if (expectStatus != null) {
    const ex = Array.isArray(expectStatus) ? expectStatus : [expectStatus];
    sql += ` AND status IN (${ex.map(() => "?").join(",")})`;
    vals.push(...ex.map(String));
  }
  return db.prepare(sql).run(...vals).changes;
}
// 原子认领：pending | failed → transcoding，attempts + 1。返回是否认领成功。
function claimAttachmentMedia(id) {
  return db.prepare("UPDATE attachment_media SET status = 'transcoding', attempts = attempts + 1, reason = NULL, updatedAt = ? WHERE id = ? AND status IN ('pending','failed')")
    .run(new Date().toISOString(), String(id)).changes === 1;
}
// 启动时：上次进程留下的 transcoding → pending（原因记 cancelled）。返回行数。
function resetTranscodingMedia() {
  return db.prepare("UPDATE attachment_media SET status = 'pending', reason = 'cancelled', updatedAt = ? WHERE status = 'transcoding'")
    .run(new Date().toISOString()).changes;
}
function countAttachmentMediaByStatus() {
  const out = Object.fromEntries(MEDIA_STATUSES.map((s) => [s, 0]));
  for (const r of db.prepare("SELECT status, COUNT(*) AS n FROM attachment_media GROUP BY status").all())
    if (r.status in out) out[r.status] = r.n;
  return out;
}
// 孤儿清理用：所有行仍引用的原始视频与转码结果文件名（非空 srcKey / storageKey；转码成功后引擎把 srcKey 置空）
function listMediaFileKeys() {
  const srcKeys = new Set(), storageKeys = new Set();
  for (const r of db.prepare("SELECT srcKey, storageKey FROM attachment_media").all()) {
    if (r.srcKey) srcKeys.add(r.srcKey);
    if (r.storageKey) storageKeys.add(r.storageKey);
  }
  return { srcKeys, storageKeys };
}
// 重新提取同一份课件前清掉旧行（opts.keepStatuses 默认保留 ready / transcoding）。返回删除行数。
function deleteAttachmentMedia(attachmentId, { keepStatuses = ["ready", "transcoding"] } = {}) {
  const keep = Array.isArray(keepStatuses) ? keepStatuses.map(String) : [];
  const sql = "DELETE FROM attachment_media WHERE attachmentId = ?" + (keep.length ? ` AND status NOT IN (${keep.map(() => "?").join(",")})` : "");
  return db.prepare(sql).run(String(attachmentId), ...keep).changes;
}

// ---- 培训概览的整表读取（第三批 1.4：一次请求预读一次，modules/learning/training-stats.js 的快照用）----
// progress 全表：[{ userId, courseId, moduleId, completedAt }]
function listAllProgress() {
  return db.prepare("SELECT userId, courseId, moduleId, completedAt FROM progress").all();
}
// 某个 projectId 下的全部 activity_state 行（课程出勤用 '__course__'）
function listActivityStatesByProject(projectId) {
  return db.prepare("SELECT * FROM activity_state WHERE projectId = ?").all(String(projectId));
}
// assignments 全表：[{ userId, programId, dueAt, assignedAt, source }]（source：null = 指派，'self' = 自主学习，迁移 74）
function listAllAssignments() {
  return db.prepare("SELECT userId, programId, dueAt, assignedAt, source FROM assignments").all().map((r) => ({ ...r, source: r.source || null }));
}
// 已提交答卷的轻量列（不解析题目、答案与明细），按 rowid 排序：快照复现 bestAttempt 的取法
function listSubmittedAttemptsLite() {
  return db.prepare("SELECT id, userId, programId, examId, startedAt, submittedAt, percent, passed, voided, gradingStatus FROM attempts WHERE submittedAt IS NOT NULL ORDER BY rowid")
    .all().map((r) => ({ ...r, examId: r.examId || null, passed: r.passed === null ? null : !!r.passed, voided: !!r.voided, gradingStatus: r.gradingStatus || null }));
}

// assignments
function getUserAssignments(userId) {
  const out = {};
  for (const r of db.prepare("SELECT programId, dueAt, assignedAt, source FROM assignments WHERE userId = ?").all(userId))
    out[r.programId] = { dueAt: r.dueAt, assignedAt: r.assignedAt, source: r.source || null };
  return out;
}
// 指派（HR 单个 / 批量、新员工默认、培养项目、选修申请通过）。同一门课原本是自主学习（source='self'）的，
// 改成指派（source = NULL）并保留最初的 assignedAt（第四批 7，迁移 74）。
function setAssignment(userId, programId, dueAt) {
  stmt(
    `INSERT INTO assignments (userId, programId, dueAt, assignedAt) VALUES (?, ?, ?, ?)
     ON CONFLICT(userId, programId) DO UPDATE SET dueAt = excluded.dueAt, source = NULL`
  ).run(userId, programId, dueAt || null, new Date().toISOString());
}
// 第四批 7：员工在「课程目录」自主加入公开课程。已有任何一行（指派或自主）都不动；返回插入的行数（0 = 已有）。
function selfEnroll(userId, programId) {
  return stmt("INSERT OR IGNORE INTO assignments (userId, programId, dueAt, assignedAt, source) VALUES (?, ?, NULL, ?, 'self')")
    .run(userId, programId, new Date().toISOString()).changes;
}
// 退出自主学习 / 公开课程关闭时移出未开始的人：只删 source='self' 的行，指派行一字不动。学习进度与答卷保留。
function removeSelfEnrollment(userId, programId) {
  return db.prepare("DELETE FROM assignments WHERE userId = ? AND programId = ? AND source = 'self'").run(userId, programId).changes;
}
// 一门课（程序）的全部自主学习行：[{ userId, assignedAt }]
function listSelfEnrollments(programId) {
  return db.prepare("SELECT userId, assignedAt FROM assignments WHERE programId = ? AND source = 'self'").all(programId);
}
function removeAssignment(userId, programId) {
  db.prepare("DELETE FROM assignments WHERE userId = ? AND programId = ?").run(userId, programId);
}
// Impact counters for delete-protection (see courseUsage in server.js).
function countProgramAssignees(programId) {
  return db.prepare("SELECT COUNT(*) AS n FROM assignments WHERE programId = ?").get(programId).n;
}
function countCourseProgressUsers(courseId) {
  return db.prepare("SELECT COUNT(DISTINCT userId) AS n FROM progress WHERE courseId = ?").get(courseId).n;
}

// ---------- unified approvals engine (Phase A) ----------
// One engine for every approval kind. `subject` is a small JSON object owned
// by the kind (enroll → {programId}); dedupe keeps one pending request per
// (kind, target, subject).
function createApproval({ id, kind, subject, requesterId, targetUserId, note }) {
  const sj = JSON.stringify(subject || {});
  const existing = db.prepare(
    "SELECT * FROM approvals WHERE kind = ? AND targetUserId IS ? AND subjectJson = ? AND status = 'pending'"
  ).get(kind, targetUserId || null, sj);
  if (existing) return existing;
  db.prepare(
    "INSERT INTO approvals (id, kind, subjectJson, requesterId, targetUserId, note, status, requestedAt) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)"
  ).run(id, kind, sj, requesterId, targetUserId || null, note || null, new Date().toISOString());
  return getApproval(id);
}
function getApproval(id) {
  return db.prepare("SELECT * FROM approvals WHERE id = ?").get(id) || null;
}
function listApprovals(kind, status) {
  return db.prepare("SELECT * FROM approvals WHERE kind = ? AND status = ? ORDER BY requestedAt").all(kind, status);
}
function countApprovals(kind, status) {
  return db.prepare("SELECT COUNT(*) AS n FROM approvals WHERE kind = ? AND status = ?").get(kind, status).n;
}
function listApprovalsFor(targetUserId, kind) {
  return db.prepare("SELECT * FROM approvals WHERE targetUserId = ? AND kind = ? ORDER BY requestedAt DESC").all(targetUserId, kind);
}
function decideApproval(id, status, decidedBy, decideNote) {
  db.prepare("UPDATE approvals SET status = ?, decidedBy = ?, decideNote = ?, decidedAt = ? WHERE id = ?")
    .run(status, decidedBy || null, decideNote || null, new Date().toISOString(), id);
  return getApproval(id);
}

// Elective-enrollment wrappers: same names/shapes the server has always used,
// now backed by the approvals engine (kind = 'enroll').
function enrollRow(a) {
  if (!a) return null;
  const s = JSON.parse(a.subjectJson || "{}");
  return {
    id: a.id, userId: a.targetUserId, programId: s.programId || null,
    status: a.status, note: a.note, decidedBy: a.decidedBy, decideNote: a.decideNote,
    requestedAt: a.requestedAt, decidedAt: a.decidedAt,
  };
}
function createEnrollmentRequest({ id, userId, programId, note }) {
  return enrollRow(createApproval({ id, kind: "enroll", subject: { programId }, requesterId: userId, targetUserId: userId, note }));
}
function getEnrollmentRequest(id) {
  const a = getApproval(id);
  return a && a.kind === "enroll" ? enrollRow(a) : null;
}
function listPendingRequests() {
  return listApprovals("enroll", "pending").map(enrollRow);
}
function countPendingRequests() {
  return countApprovals("enroll", "pending");
}
function listUserRequests(userId) {
  return listApprovalsFor(userId, "enroll").map(enrollRow);
}
// Latest request per program for a user → drives each catalog card's status.
function getUserRequestMap(userId) {
  const out = {};
  const rows = listApprovalsFor(userId, "enroll").map(enrollRow).reverse(); // oldest→newest
  for (const r of rows) if (r.programId) out[r.programId] = r;
  return out;
}
function decideEnrollmentRequest(id, status, decidedBy, decideNote) {
  return enrollRow(decideApproval(id, status, decidedBy, decideNote));
}

// ---------- training projects: members & activity state (Phase B) ----------
// The project STRUCTURE (cohorts/classes/phases/activities) lives as a JSON
// document in `content` (kind 'tproject'); these tables hold per-person state.
// 期次轨迹（迁移 66 cohortLog）：[{ cohortId, enteredAt, leftAt }]，leftAt 为空 = 这一段还没结束。
// 没有轨迹的旧行（或坏数据）按一段处理：当前期次、addedAt 起、未结束。modules/learning/completion.js 的退训判定读它。
function memberCohortLog(row) {
  if (!row) return [];
  if (row.cohortLog) {
    try { const l = JSON.parse(row.cohortLog); if (Array.isArray(l)) return l; } catch (_) { /* 按旧行处理 */ }
  }
  return [{ cohortId: row.cohortId || null, enteredAt: row.addedAt, leftAt: null }];
}
// 进入一个期次：先给还没结束的段收尾，再记新的一段
function enterCohortLog(log, cohortId, at) {
  for (const e of log) if (!e.leftAt) e.leftAt = at;
  log.push({ cohortId: cohortId || null, enteredAt: at, leftAt: null });
  return log;
}
const projectMemberRow = (projectId, userId, role) =>
  stmt("SELECT * FROM project_members WHERE projectId = ? AND userId = ? AND role = ?").get(projectId, userId, role);
function addProjectMember({ projectId, cohortId, userId, role, classId, groupId }) {
  const now = new Date().toISOString();
  const prev = projectMemberRow(projectId, userId, role);
  // 期次轨迹：新加入、退训后重新加入、在训时换到别的期次 → 记新的一段；在训且同一期次重复加入不动
  const log = memberCohortLog(prev);
  if (!prev || prev.state === "withdrawn" || (prev.cohortId || null) !== (cohortId || null)) enterCohortLog(log, cohortId, now);
  stmt(
    `INSERT INTO project_members (projectId, cohortId, userId, role, addedAt, classId, groupId, state, cohortLog)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?)
     ON CONFLICT(projectId, userId, role) DO UPDATE SET
       cohortId = excluded.cohortId, classId = excluded.classId,
       groupId = excluded.groupId, state = 'active', cohortLog = excluded.cohortLog`
  ).run(projectId, cohortId || null, userId, role, now, classId || null, groupId || null, JSON.stringify(log));
}
function listProjectMembers(projectId) {
  return db.prepare("SELECT * FROM project_members WHERE projectId = ?").all(projectId);
}
// How much attendance / completion history a project carries: offline attendance
// and online-activity completion rows (completed / excused), both written under
// projectId = the project id. Used as the guard on deleting one: any such row
// means it really ran and must be closed, not erased.
function countActivityStates(projectId) {
  return db.prepare("SELECT COUNT(*) AS n FROM activity_state WHERE projectId = ?").get(projectId).n;
}
// Only ever called for a project that passed that guard, i.e. staff rows on a
// project no learner ever joined.
function deleteProjectMembersFor(projectId) {
  return db.prepare("DELETE FROM project_members WHERE projectId = ?").run(projectId).changes;
}
function getUserMemberships(userId) {
  return db.prepare("SELECT * FROM project_members WHERE userId = ? AND state = 'active'").all(userId);
}
// 含已退训（withdrawn）的全部成员记录：「退训后不再提醒」的判定要同时看在训与已退训（modules/learning/completion.js withdrawnOnly）。
// cohorts = 解析后的期次轨迹（迁移 66，见 memberCohortLog）。
function listUserMemberships(userId) {
  return stmt("SELECT * FROM project_members WHERE userId = ?").all(userId).map((m) => ({ ...m, cohorts: memberCohortLog(m) }));
}
function withdrawProjectMember(projectId, userId, role) {
  const prev = projectMemberRow(projectId, userId, role);
  if (!prev || prev.state === "withdrawn") return; // 已退训：不重复收尾
  // 期次轨迹：给当前一段收尾（退训之后再派的课不算项目派的）
  const log = memberCohortLog(prev);
  const now = new Date().toISOString();
  for (const e of log) if (!e.leftAt) e.leftAt = now;
  stmt("UPDATE project_members SET state = 'withdrawn', cohortLog = ? WHERE projectId = ? AND userId = ? AND role = ?")
    .run(JSON.stringify(log), projectId, userId, role);
}
function moveProjectMember(projectId, userId, role, { cohortId, classId, groupId }) {
  const prev = projectMemberRow(projectId, userId, role);
  if (!prev) return;
  // 期次轨迹：换到别的期次 → 上一段收尾、记新的一段（期次为空 = COALESCE 保留原期次，轨迹不动）
  const to = cohortId || null;
  const log = to && to !== (prev.cohortId || null) ? JSON.stringify(enterCohortLog(memberCohortLog(prev), to, new Date().toISOString())) : null;
  stmt(
    "UPDATE project_members SET cohortId = COALESCE(?, cohortId), classId = ?, groupId = ?, cohortLog = COALESCE(?, cohortLog) WHERE projectId = ? AND userId = ? AND role = ?"
  ).run(to, classId || null, groupId || null, log, projectId, userId, role);
}
function setActivityState({ projectId, cohortId, activityId, userId, status, by, note }) {
  db.prepare(
    `INSERT INTO activity_state (projectId, cohortId, activityId, userId, status, at, by, note)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(activityId, userId) DO UPDATE SET status = excluded.status, at = excluded.at, by = excluded.by, note = excluded.note`
  ).run(projectId, cohortId, activityId, userId, status, new Date().toISOString(), by || null, note || null);
}
function listActivityStates(activityId) {
  return db.prepare("SELECT * FROM activity_state WHERE activityId = ?").all(activityId);
}
function getUserActivityStates(userId, projectId) {
  const out = {};
  for (const r of db.prepare("SELECT * FROM activity_state WHERE userId = ? AND projectId = ?").all(userId, projectId))
    out[r.activityId] = r;
  return out;
}
// Same shape, keyed purely by activity id — the key the roll-call itself reads
// (listActivityStates). Completion must agree with what the roll-call shows, so
// a row is counted whatever projectId it was written under.
function getUserStatesForActivities(userId, activityIds) {
  const out = {};
  const ids = [...new Set((activityIds || []).filter(Boolean).map(String))];
  if (!ids.length) return out;
  const ph = ids.map(() => "?").join(",");
  for (const r of db.prepare(`SELECT * FROM activity_state WHERE userId = ? AND activityId IN (${ph})`).all(userId, ...ids))
    out[r.activityId] = r;
  return out;
}
// Undo one learner's mark on one activity (back to "not checked in").
function deleteActivityState(activityId, userId) {
  return db.prepare("DELETE FROM activity_state WHERE activityId = ? AND userId = ?").run(activityId, userId).changes;
}
function getActivityState(activityId, userId) {
  return db.prepare("SELECT * FROM activity_state WHERE activityId = ? AND userId = ?").get(activityId, userId) || null;
}
// Server-instance secret for rotating offline check-in codes (created once).
function getCheckinSecret() {
  let s = getMeta("checkinSecret");
  if (!s) {
    s = require("crypto").randomBytes(16).toString("hex");
    setMeta("checkinSecret", s);
  }
  return s;
}

// notifications (in-app; email is a separate pluggable hook)
function createNotification({ id, userId, type, title, title_zh, body, body_zh, link }) {
  db.prepare("INSERT INTO notifications (id, userId, type, title, title_zh, body, body_zh, link, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(id, userId, type, title, title_zh || null, body || null, body_zh || null, link || null, new Date().toISOString());
}
function listNotifications(userId, limit = 40) {
  return db.prepare("SELECT * FROM notifications WHERE userId = ? ORDER BY createdAt DESC LIMIT ?").all(userId, limit);
}
function countUnreadNotifications(userId) {
  return db.prepare("SELECT COUNT(*) AS n FROM notifications WHERE userId = ? AND readAt IS NULL").get(userId).n;
}
function markNotificationsRead(userId, id) {
  const now = new Date().toISOString();
  if (id) db.prepare("UPDATE notifications SET readAt = ? WHERE userId = ? AND id = ? AND readAt IS NULL").run(now, userId, id);
  else db.prepare("UPDATE notifications SET readAt = ? WHERE userId = ? AND readAt IS NULL").run(now, userId);
}
// Dedup guard for the daily reminder job (avoid re-notifying the same thing).
function hasNotificationSince(userId, type, link, sinceIso) {
  return !!db.prepare("SELECT 1 FROM notifications WHERE userId = ? AND type = ? AND (link IS ? OR link = ?) AND createdAt >= ? LIMIT 1")
    .get(userId, type, link || null, link || "", sinceIso);
}
// 同类通知（不论链接）自某时起是否发过：培训概览「提前提醒」每人每天一条（第三批 4.4）
function hasNotificationTypeSince(userId, type, sinceIso) {
  return !!db.prepare("SELECT 1 FROM notifications WHERE userId = ? AND type = ? AND createdAt >= ? LIMIT 1").get(userId, type, sinceIso);
}
// CX-114：同类型、同链接（= 同一门课）的通知自某时刻起是否已发过
function hasNotificationLinkSince(userId, type, link, sinceIso) {
  return !!db.prepare("SELECT 1 FROM notifications WHERE userId = ? AND type = ? AND link = ? AND createdAt >= ? LIMIT 1").get(userId, type, link, sinceIso);
}

// ---------- talent records & field config (TMS layer) ----------
function rowToTalentRecord(r) {
  if (!r) return null;
  let detail = {};
  try { detail = r.detail ? JSON.parse(r.detail) : {}; } catch {}
  return {
    id: r.id, userId: r.userId, type: r.type, date: r.date, title: r.title,
    detail, programId: r.programId, createdBy: r.createdBy,
    createdAt: r.createdAt, updatedAt: r.updatedAt,
  };
}
function createTalentRecord({ id, userId, type, date, title, detail, programId, createdBy }) {
  stmt("INSERT INTO talent_records (id, userId, type, date, title, detail, programId, createdBy, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(id, userId, type, date, title, JSON.stringify(detail || {}), programId || null, createdBy, new Date().toISOString());
  return getTalentRecord(id);
}
function getTalentRecord(id) {
  return rowToTalentRecord(stmt("SELECT * FROM talent_records WHERE id = ?").get(id));
}
// 幂等写一条人才记录：id 由调用方按业务键确定性生成（例如 core 订阅 culture.program.completed 时按
// programId + userId 算出），同 id 的行已存在就什么也不做 —— 同一事件重复送达、补发都不会写出第二条，
// 已写入的记录也不会被改写。按主键 INSERT OR IGNORE，逐条 O(1)（4,000 人的一轮分发就是 4,000 次主键插入）。
// 返回 true = 新写入，false = 已存在。事件处理函数在事务之外调用时每条自动提交。
function addTalentRecordOnce({ id, userId, type, date, title, detail, programId, createdBy }) {
  for (const [k, v] of Object.entries({ id, userId, type, date, createdBy }))
    if (typeof v !== "string" || !v) throw new Error(`store.addTalentRecordOnce: ${k} must be a non-empty string`);
  return stmt("INSERT OR IGNORE INTO talent_records (id, userId, type, date, title, detail, programId, createdBy, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(id, userId, type, date, title == null ? "" : String(title), JSON.stringify(detail || {}), programId || null, createdBy, new Date().toISOString()).changes > 0;
}
function updateTalentRecord(id, { type, date, title, detail, programId }) {
  db.prepare("UPDATE talent_records SET type = ?, date = ?, title = ?, detail = ?, programId = ?, updatedAt = ? WHERE id = ?")
    .run(type, date, title, JSON.stringify(detail || {}), programId || null, new Date().toISOString(), id);
  return getTalentRecord(id);
}
function deleteTalentRecord(id) {
  db.prepare("DELETE FROM talent_records WHERE id = ?").run(id);
}
function listTalentRecords(userId) {
  return db.prepare("SELECT * FROM talent_records WHERE userId = ? ORDER BY date DESC, createdAt DESC").all(userId).map(rowToTalentRecord);
}
function talentRecordExists(userId, type, date, title) {
  return !!stmt("SELECT 1 FROM talent_records WHERE userId = ? AND type = ? AND date = ? AND title = ?").get(userId, type, date, title);
}
// All records of one type across employees — talent review & cross-people search.
function listTalentRecordsByType(type) {
  return db.prepare("SELECT * FROM talent_records WHERE type = ? ORDER BY date DESC, createdAt DESC").all(type).map(rowToTalentRecord);
}
// Best submitted score per user for one program — cohort ranking on the profile.
function listProgramBestScores(programId) {
  return db.prepare(`SELECT userId, MAX(percent) AS best FROM attempts WHERE programId = ? AND submittedAt IS NOT NULL AND ${SETTLED} GROUP BY userId`).all(programId);
}
// Datalist suggestions. Field name is whitelisted here — never pass user input.
function listDistinctUserField(field) {
  if (!["position", "jobLevel", "department"].includes(field)) return [];
  return db.prepare(`SELECT DISTINCT ${field} AS v FROM users WHERE ${field} IS NOT NULL AND ${field} != '' ORDER BY v`).all().map((r) => r.v);
}

// record type / field configuration
function rowToRecordField(r) {
  let options = [];
  try { options = r.options ? JSON.parse(r.options) : []; } catch {}
  let zh = [];
  try { zh = r.options_zh ? JSON.parse(r.options_zh) : []; } catch {}
  // options is the stored value AND the English display name; options_zh is the
  // display-only Chinese twin. The client always gets an array of the same length
  // (index i pairs with options[i]) falling back to the English item, so a row
  // written before migration 41 — or by a client that never sends the Chinese
  // list — renders as English instead of as blanks.
  const options_zh = options.map((o, i) => (typeof zh[i] === "string" && zh[i] !== "" ? zh[i] : o));
  return {
    id: r.id, typeKey: r.typeKey, key: r.key, label: r.label, label_zh: r.label_zh || null, input: r.input,
    options, options_zh, options_desc: descOf(r.options_desc, options), options_desc_zh: descOf(r.options_desc_zh, options),
    required: !!r.required, showInTimeline: !!r.showInTimeline,
    filterable: !!r.filterable, sort: r.sort, active: !!r.active,
    // 是否发给 AI（迁移 58）：send | mask | omit，NULL 与未知值一律按 omit（从严）
    aiShare: AI_SHARE.has(r.aiShare) ? r.aiShare : "omit",
  };
}
const AI_SHARE = new Set(["send", "mask", "omit"]);
// 选项说明（迁移 56）：JSON 数组，与 options 按位置对齐；读出时补齐为等长，没有说明的项为空串
function descOf(raw, options) {
  let a = [];
  try { a = raw ? JSON.parse(raw) : []; } catch {}
  if (!Array.isArray(a)) a = [];
  return options.map((_, i) => (typeof a[i] === "string" ? a[i] : ""));
}
function rowToRecordType(t) {
  return {
    key: t.key, label: t.label, label_zh: t.label_zh || null, color: t.color,
    builtin: !!t.builtin, active: !!t.active, sort: t.sort,
    employeeVisible: !!t.employeeVisible,
    // 第二批 8.3（迁移 71）：汇报线上级能否在下属档案里看到这类记录；列不存在（迁移前的库副本）按可见
    managerVisible: t.managerVisible === undefined || t.managerVisible === null ? true : !!t.managerVisible,
  };
}
function listRecordTypes(includeInactive) {
  return db.prepare("SELECT * FROM record_types ORDER BY sort, rowid").all()
    .map(rowToRecordType)
    .filter((t) => includeInactive || t.active);
}
function getRecordType(key) {
  const t = db.prepare("SELECT * FROM record_types WHERE key = ?").get(key);
  return t ? rowToRecordType(t) : null;
}
function upsertRecordType({ key, label, label_zh, color, builtin, active, sort, employeeVisible, managerVisible }) {
  // A caller that only knows one name (HR typing a new type) gets it in both
  // slots — an empty counterpart would render as blank in the other language.
  const en = String(label || "").trim();
  const zh = String(label_zh || "").trim() || en;
  // managerVisible（迁移 71）：调用方没带（undefined）时保留原值；新建的类型默认对上级可见
  let mgrVis = managerVisible;
  if (mgrVis === undefined) { const cur = getRecordType(key); mgrVis = cur ? cur.managerVisible : true; }
  db.prepare(
    `INSERT INTO record_types (key, label, label_zh, color, builtin, active, sort, employeeVisible, managerVisible) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET label = excluded.label, label_zh = excluded.label_zh, color = excluded.color, active = excluded.active, sort = excluded.sort, employeeVisible = excluded.employeeVisible, managerVisible = excluded.managerVisible`
  ).run(key, en, zh, color || null, builtin ? 1 : 0, active === false ? 0 : 1, sort || 0, employeeVisible ? 1 : 0, mgrVis ? 1 : 0);
  return getRecordType(key);
}
function deleteRecordType(key) {
  db.prepare("DELETE FROM record_types WHERE key = ?").run(key);
  db.prepare("DELETE FROM record_fields WHERE typeKey = ?").run(key);
}
function listRecordFields(typeKey, includeInactive) {
  const rows = typeKey
    ? db.prepare("SELECT * FROM record_fields WHERE typeKey = ? ORDER BY sort, rowid").all(typeKey)
    : db.prepare("SELECT * FROM record_fields ORDER BY typeKey, sort, rowid").all();
  return rows.map(rowToRecordField).filter((f) => includeInactive || f.active);
}
function getRecordField(id) {
  const r = db.prepare("SELECT * FROM record_fields WHERE id = ?").get(id);
  return r ? rowToRecordField(r) : null;
}
function nextRecordFieldId() {
  const n = Number(getMeta("nextRF") || 1);
  setMeta("nextRF", n + 1);
  return { id: "rf-" + n, key: "c" + n };
}
function upsertRecordField(f) {
  // options decides the shape: it holds the strings that get written into records,
  // so options_zh is aligned to it item by item — surplus Chinese entries dropped,
  // missing ones filled with the English item. Silent alignment rather than a
  // rejection: the console edits the two lists in two separate inputs, so they sit
  // out of step on nearly every keystroke, and erroring there would turn saving a
  // field into a counting exercise. Nothing matches on options_zh — it only ever
  // decorates — so trimming a too-long list loses no data that means anything.
  const options = Array.isArray(f.options) ? f.options.map((o) => String(o)) : [];
  const zhIn = Array.isArray(f.options_zh) ? f.options_zh : [];
  const optionsZh = options.map((o, i) => {
    const v = typeof zhIn[i] === "string" ? zhIn[i].trim() : "";
    return v || o;
  });
  // 选项说明（迁移 56）：调用方没带（undefined）时保留库里原值；带了则按 options 对齐（多截少补，去首尾空白，每项最多 300 字）。
  // 空数组表示清空。说明只作展示，不参与任何匹配。
  // 每档说明上限 400 字（2026-09-30 由 300 放宽：负责人提供的正式说明最长 309 字）
  const descIn = (arr) => (arr === undefined ? undefined : JSON.stringify(options.map((_, i) => (Array.isArray(arr) && typeof arr[i] === "string" ? arr[i].trim().slice(0, 400) : ""))));
  const desc = descIn(f.options_desc), descZh = descIn(f.options_desc_zh);
  // 是否发给 AI（迁移 58）：调用方没带时保留原值；新建行默认 omit。取值校验与「只有超级管理员能放宽」在 server.js。
  const aiShare = f.aiShare === undefined ? undefined : (AI_SHARE.has(f.aiShare) ? f.aiShare : "omit");
  db.prepare(
    `INSERT INTO record_fields (id, typeKey, key, label, label_zh, input, options, options_zh, required, showInTimeline, filterable, sort, active, options_desc, options_desc_zh, aiShare)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET label = excluded.label, label_zh = excluded.label_zh, input = excluded.input, options = excluded.options,
       options_zh = excluded.options_zh,
       options_desc = COALESCE(excluded.options_desc, record_fields.options_desc),
       options_desc_zh = COALESCE(excluded.options_desc_zh, record_fields.options_desc_zh),
       aiShare = COALESCE(excluded.aiShare, record_fields.aiShare),
       required = excluded.required, showInTimeline = excluded.showInTimeline, filterable = excluded.filterable,
       sort = excluded.sort, active = excluded.active`
  ).run(
    f.id, f.typeKey, f.key, String(f.label || "").trim(),
    String(f.label_zh || "").trim() || String(f.label || "").trim(),
    f.input || "text",
    options.length ? JSON.stringify(options) : null,
    options.length ? JSON.stringify(optionsZh) : null,
    f.required ? 1 : 0, f.showInTimeline === false ? 0 : 1, f.filterable ? 1 : 0,
    f.sort || 0, f.active === false ? 0 : 1,
    desc === undefined ? null : desc, descZh === undefined ? null : descZh,
    aiShare === undefined ? (getRecordField(f.id) ? null : (f.typeKey === "culture-program" ? null : "omit")) : (f.typeKey === "culture-program" ? null : aiShare)
  );
  return getRecordField(f.id);
}
function deleteRecordField(id) {
  db.prepare("DELETE FROM record_fields WHERE id = ?").run(id);
}

// performance review cycles (Phase 3). Items snapshot the manager; the cycle
// close writes finalised ratings into talent_records (done by the server).
function createReviewCycle(name, dueAt, opts = {}) {
  const n = Number(getMeta("nextRC") || 1);
  setMeta("nextRC", n + 1);
  const id = "rc-" + n;
  db.prepare("INSERT INTO review_cycles (id, name, status, createdAt, dueAt) VALUES (?, ?, 'open', ?, ?)")
    .run(id, name, new Date().toISOString(), dueAt || null);
  // 绩效流程 v2（迁移 65）：opts = { kind, flow, quota, dueRateAt, dueCalibAt }；不传 = 旧流程
  if (opts && (opts.kind || opts.flow || opts.quota || opts.dueRateAt || opts.dueCalibAt)) {
    db.prepare("UPDATE review_cycles SET kind = ?, flow = ?, quota = ?, dueRateAt = ?, dueCalibAt = ? WHERE id = ?")
      .run(opts.kind === "annual" ? "annual" : "quarter", opts.flow === "v2" ? "v2" : null,
        opts.quota ? JSON.stringify(opts.quota) : null, opts.dueRateAt || null, opts.dueCalibAt || null, id);
  }
  return getReviewCycle(id);
}
function setReviewCycleDates(id, f) {
  const sets = [], vals = [];
  for (const k of ["dueAt", "dueRateAt", "dueCalibAt"]) if (f[k] !== undefined) { sets.push(`${k} = ?`); vals.push(f[k] || null); }
  if (f.quota !== undefined) { sets.push("quota = ?"); vals.push(f.quota ? JSON.stringify(f.quota) : null); }
  if (sets.length) db.prepare(`UPDATE review_cycles SET ${sets.join(", ")} WHERE id = ?`).run(...vals, id);
  return getReviewCycle(id);
}
// 一级部门 × 周期的 HoD 提交 / HR 确认状态（迁移 65）
function getReviewDeptStatus(cycleId, dept1Id) {
  return db.prepare("SELECT * FROM review_dept_status WHERE cycleId = ? AND dept1Id = ?").get(cycleId, dept1Id) || null;
}
function listReviewDeptStatus(cycleId) {
  return db.prepare("SELECT * FROM review_dept_status WHERE cycleId = ?").all(cycleId);
}
function upsertReviewDeptStatus(cycleId, dept1Id, fields) {
  const cur = getReviewDeptStatus(cycleId, dept1Id);
  if (!cur) db.prepare("INSERT INTO review_dept_status (cycleId, dept1Id) VALUES (?, ?)").run(cycleId, dept1Id);
  const allowed = ["dept1Name", "hodId", "hodSubmittedAt", "hrConfirmedAt", "hrId", "returnedAt", "returnReason"];
  const sets = [], vals = [];
  for (const k of allowed) if (fields[k] !== undefined) { sets.push(`${k} = ?`); vals.push(fields[k]); }
  if (sets.length) db.prepare(`UPDATE review_dept_status SET ${sets.join(", ")} WHERE cycleId = ? AND dept1Id = ?`).run(...vals, cycleId, dept1Id);
  return getReviewDeptStatus(cycleId, dept1Id);
}
// 员工本人已关闭周期的结果（「我的绩效」）：只读已归档的那几列
function listMyClosedReviewItems(userId) {
  return db.prepare(
    `SELECT ri.id, ri.finalRating, ri.managerRating, ri.managerText, ri.highlights, ri.goalsNext, ri.recordId,
            ri.userId, ri.appealFrom, ri.appealDeadline,
            rc.id AS cycleId, rc.name AS cycleName, rc.kind AS cycleKind, rc.flow AS cycleFlow, rc.closedAt, rc.createdAt AS cycleCreatedAt,
            rc.resultsAt AS cycleResultsAt, rc.appealDeadline AS cycleAppealDeadline, rc.status AS cycleStatus
     FROM review_items ri JOIN review_cycles rc ON rc.id = ri.cycleId
     WHERE ri.userId = ? AND rc.status = 'closed' ORDER BY COALESCE(rc.closedAt, rc.createdAt) DESC`
  ).all(userId);
}
// 某人已关闭周期归档进档案的绩效记录：[{ recordId, cycleId, cycleName, period }]（period = 记录现在的 detail.period）。
// 第二批 2.6 的护栏（2026-10-08，审查 P0-5）：同一期不能再新建或导入一条绩效记录绕开「改评级须写理由」。
function listCycleArchivedRecords(userId) {
  return db.prepare(
    `SELECT ri.recordId, rc.id AS cycleId, rc.name AS cycleName, tr.detail
     FROM review_items ri JOIN review_cycles rc ON rc.id = ri.cycleId JOIN talent_records tr ON tr.id = ri.recordId
     WHERE ri.userId = ? AND rc.status = 'closed' AND ri.recordId IS NOT NULL AND tr.type = 'performance'`
  ).all(userId).map((r) => {
    let d = {};
    try { d = r.detail ? JSON.parse(r.detail) : {}; } catch {}
    return { recordId: r.recordId, cycleId: r.cycleId, cycleName: r.cycleName, period: d && d.period != null ? String(d.period) : null };
  });
}
// 由评估周期归档进档案的那条记录对应的评估项（第二批 2.6）：review_items.recordId = 记录 id，带周期名、状态与关闭时间。
// 没有（手工新建 / 导入的记录）→ null。周期归档的记录不许改类型、不许删除，改评级须写理由并留「已改动」标记。
function getReviewItemByRecordId(recordId) {
  if (!recordId) return null;
  return db.prepare(
    `SELECT ri.*, rc.name AS cycleName, rc.status AS cycleStatus, rc.closedAt AS cycleClosedAt
     FROM review_items ri JOIN review_cycles rc ON rc.id = ri.cycleId WHERE ri.recordId = ? LIMIT 1`
  ).get(String(recordId)) || null;
}
// 一批记录 id 里哪些是周期归档的：Map(recordId → { itemId, cycleId, cycleName, archived: finalRating || managerRating })。
// 后台档案时间线一次查完（每人通常只有几条绩效记录）。
function mapReviewItemsByRecordIds(recordIds) {
  const ids = [...new Set((recordIds || []).filter(Boolean).map(String))];
  const out = new Map();
  for (let i = 0; i < ids.length; i += 200) {
    const part = ids.slice(i, i + 200);
    for (const r of db.prepare(
      `SELECT ri.id, ri.recordId, ri.finalRating, ri.managerRating, ri.cycleId, rc.name AS cycleName
       FROM review_items ri JOIN review_cycles rc ON rc.id = ri.cycleId WHERE ri.recordId IN (${part.map(() => "?").join(", ")})`
    ).all(...part)) {
      if (!out.has(r.recordId)) out.set(r.recordId, { itemId: r.id, cycleId: r.cycleId, cycleName: r.cycleName, archived: r.finalRating || r.managerRating || null });
    }
  }
  return out;
}
// 所有进行中周期里的评估项（HoD 校准页按一级部门筛）
function listOpenCycleItems() {
  return db.prepare(
    `SELECT ri.*, rc.name AS cycleName, rc.kind AS cycleKind, rc.flow AS cycleFlow FROM review_items ri
     JOIN review_cycles rc ON rc.id = ri.cycleId WHERE rc.status = 'open'`
  ).all();
}
function setReviewCycleDue(id, dueAt) {
  db.prepare("UPDATE review_cycles SET dueAt = ? WHERE id = ?").run(dueAt || null, id);
  return getReviewCycle(id);
}
function getReviewCycle(id) {
  return db.prepare("SELECT * FROM review_cycles WHERE id = ?").get(id) || null;
}
function listReviewCycles() {
  return db.prepare("SELECT * FROM review_cycles ORDER BY createdAt DESC").all();
}
// atIso（可选，第二批 2.8）：关闭时刻由调用方给出（与 resultsAt 同一个 nowMs()，测试里的 LMS_FAKE_NOW 下两者一致）
function closeReviewCycle(id, atIso) {
  db.prepare("UPDATE review_cycles SET status = 'closed', closedAt = ? WHERE id = ?").run(atIso || new Date().toISOString(), id);
  return getReviewCycle(id);
}
// 结果正式告知（第二批 2.8，迁移 70）：只对已关闭、尚未告知的周期写一次 resultsAt 与申诉截止日；返回是否恰好写了这一行
function setReviewCycleResultsAt(id, iso, deadline) {
  return db.prepare("UPDATE review_cycles SET resultsAt = ?, appealDeadline = ? WHERE id = ? AND status = 'closed' AND resultsAt IS NULL")
    .run(String(iso), deadline || null, String(id)).changes === 1;
}
// Discard a cycle launched by mistake (wrong scope / typo). Only ever called
// for an OPEN cycle that wrote no talent records — the endpoint enforces that,
// so closed history and anything already on a profile can never be erased.
function deleteReviewCycle(id) {
  db.exec("BEGIN");
  try {
    db.prepare("DELETE FROM review_items WHERE cycleId = ?").run(id);
    db.prepare("DELETE FROM review_cycles WHERE id = ?").run(id);
    db.exec("COMMIT");
  } catch (e) { db.exec("ROLLBACK"); throw e; }
}
// Count of participants who already have any input recorded — the guard that
// decides whether a cycle is still safe to discard.
function countReviewCycleProgress(id) {
  return db.prepare(
    `SELECT COUNT(*) total,
            SUM(selfAt IS NOT NULL) selfDone,
            SUM(managerRating IS NOT NULL) rated,
            SUM(recordId IS NOT NULL) written
     FROM review_items WHERE cycleId = ?`
  ).get(id);
}
// Launching a company-wide cycle inserts one row per employee (4k+ at DigiPlus
// scale). One transaction instead of one per row, and either the whole roster
// lands or none of it does — a half-populated cycle is not a usable state.
function addReviewItemsBulk(cycleId, targets) {
  db.exec("BEGIN");
  try {
    for (const t of targets) {
      addReviewItem({ cycleId, userId: t.id, managerId: t.managerId || null, prevGoals: latestClosedReviewGoals(t.id) });
    }
    db.exec("COMMIT");
  } catch (e) { db.exec("ROLLBACK"); throw e; }
}
function addReviewItem({ cycleId, userId, managerId, prevGoals }) {
  const n = Number(getMeta("nextRI") || 1);
  setMeta("nextRI", n + 1);
  db.prepare("INSERT OR IGNORE INTO review_items (id, cycleId, userId, managerId, prevGoals, createdAt) VALUES (?, ?, ?, ?, ?, ?)")
    .run("ri-" + n, cycleId, userId, managerId || null, prevGoals || null, new Date().toISOString());
}
// The goals the person set in their most recently CLOSED cycle — they become
// "last quarter's goals" that the new self-review reports against.
function latestClosedReviewGoals(userId) {
  const r = db.prepare(
    `SELECT ri.goalsNext FROM review_items ri
     JOIN review_cycles rc ON rc.id = ri.cycleId
     WHERE ri.userId = ? AND rc.status = 'closed' AND ri.goalsNext IS NOT NULL
     ORDER BY rc.closedAt DESC LIMIT 1`
  ).get(userId);
  return r ? r.goalsNext : null;
}
function getReviewItem(id) {
  return db.prepare("SELECT * FROM review_items WHERE id = ?").get(id) || null;
}
function listCycleItems(cycleId) {
  return db.prepare("SELECT * FROM review_items WHERE cycleId = ? ORDER BY createdAt").all(cycleId);
}
// Items the employee still interacts with (their own self-eval, or their
// directs' reviews) — open cycles only.
function listMyReviewItems(userId) {
  return db.prepare(
    `SELECT ri.*, rc.name AS cycleName, rc.dueAt AS cycleDueAt, rc.flow AS cycleFlow, rc.dueRateAt AS cycleDueRateAt, rc.dueCalibAt AS cycleDueCalibAt FROM review_items ri
     JOIN review_cycles rc ON rc.id = ri.cycleId
     WHERE ri.userId = ? AND rc.status = 'open' AND COALESCE(rc.kind, 'quarter') <> 'annual' ORDER BY ri.createdAt DESC`
  ).all(userId);
}
function listTeamReviewItems(managerId) {
  return db.prepare(
    `SELECT ri.*, rc.name AS cycleName, rc.dueAt AS cycleDueAt, rc.flow AS cycleFlow, rc.dueRateAt AS cycleDueRateAt FROM review_items ri
     JOIN review_cycles rc ON rc.id = ri.cycleId
     WHERE ri.managerId = ? AND rc.status = 'open' AND COALESCE(rc.kind, 'quarter') <> 'annual' ORDER BY ri.createdAt DESC`
  ).all(managerId);
}
// 绩效看板第一期（2026-10-10）：经理看板要已关闭的周期 —— 本人作为发起时直属上级的全部季度条目（含已关闭；年度周期上级不评级，不含）
function listManagedReviewItems(managerId) {
  return db.prepare(
    `SELECT ri.* FROM review_items ri JOIN review_cycles rc ON rc.id = ri.cycleId
     WHERE ri.managerId = ? AND COALESCE(rc.kind, 'quarter') <> 'annual' ORDER BY ri.createdAt DESC`
  ).all(managerId);
}
function updateReviewItem(id, fields) {
  const allowed = ["selfText", "selfAt", "managerRating", "managerText", "managerAt", "finalRating", "recordId",
    "selfOutcomes", "selfChallenges", "selfFeedback", "selfExtra", "goalsNext", "oneOnOneAt", "oneOnOneNotes",
    "employeeOneOnOneAt", "highlights", "hodText", "hodAt", "hodId", "hodProxy",
    // 第二批 2.8（迁移 70）：关闭时的部门、2.6 修改后重新告知的时刻与申诉截止日
    "closeDept", "appealFrom", "appealDeadline"];
  const sets = [], vals = [];
  for (const k of allowed) {
    if (fields[k] !== undefined) { sets.push(`${k} = ?`); vals.push(fields[k]); }
  }
  if (!sets.length) return getReviewItem(id);
  db.prepare(`UPDATE review_items SET ${sets.join(", ")} WHERE id = ?`).run(...vals, id);
  return getReviewItem(id);
}

// ---------- 第二批 2.8：部门 → HRBP 分工与绩效申诉（迁移 70）----------
// 写函数不自己开事务（replace* 除外，用可嵌套的 transaction）：调用方在 runBatch 里调用，编号计数器随插入一起提交。
function listHrbpAssignments() {
  return db.prepare("SELECT deptId, userId, createdAt, createdBy FROM hrbp_assignments ORDER BY deptId, createdAt, userId").all();
}
function listHrbpDeptIdsOfUser(userId) {
  return db.prepare("SELECT deptId FROM hrbp_assignments WHERE userId = ? ORDER BY deptId").all(String(userId)).map((r) => r.deptId);
}
// 一个部门的 HRBP 换成 userIds（保留未变行的 createdAt）→ { before, after }（userId 数组，按原顺序 / 新顺序）
function replaceDeptHrbps(deptId, userIds, actorId, atIso) {
  return transaction(() => {
    const before = db.prepare("SELECT userId FROM hrbp_assignments WHERE deptId = ? ORDER BY createdAt, userId").all(String(deptId)).map((r) => r.userId);
    const want = [...new Set((userIds || []).map(String))];
    const keep = new Set(want);
    for (const u of before) if (!keep.has(u)) db.prepare("DELETE FROM hrbp_assignments WHERE deptId = ? AND userId = ?").run(String(deptId), u);
    const had = new Set(before);
    const at = atIso || new Date().toISOString();
    for (const u of want) if (!had.has(u)) db.prepare("INSERT INTO hrbp_assignments (deptId, userId, createdAt, createdBy) VALUES (?, ?, ?, ?)").run(String(deptId), u, at, actorId || null);
    const after = db.prepare("SELECT userId FROM hrbp_assignments WHERE deptId = ? ORDER BY createdAt, userId").all(String(deptId)).map((r) => r.userId);
    return { before, after };
  });
}
// 一个人直接负责的部门换成 deptIds → 只返回有变化的部门 [{ deptId, before, after }]
function replaceUserHrbpDepts(userId, deptIds, actorId, atIso) {
  return transaction(() => {
    const cur = new Set(listHrbpDeptIdsOfUser(userId));
    const want = new Set((deptIds || []).map(String));
    const out = [];
    for (const d of new Set([...cur, ...want])) {
      if (cur.has(d) === want.has(d)) continue;
      const before = db.prepare("SELECT userId FROM hrbp_assignments WHERE deptId = ? ORDER BY createdAt, userId").all(d).map((r) => r.userId);
      const next = want.has(d) ? [...before, String(userId)] : before.filter((u) => u !== String(userId));
      const r = replaceDeptHrbps(d, next, actorId, atIso);
      out.push({ deptId: d, before: r.before, after: r.after });
    }
    return out;
  });
}
const REVIEW_APPEAL_PATCHABLE = new Set(["status", "withdrawnAt", "handlerId", "startedAt", "decidedAt", "decidedBy", "ratingBefore", "newRating", "reply", "internalNote"]);
const REVIEW_APPEAL_MARKERS = new Set(["remindSoonAt", "remindOverdueOn", "escalatedAt"]);
function getReviewAppeal(id) {
  return id ? db.prepare("SELECT * FROM review_appeals WHERE id = ?").get(String(id)) || null : null;
}
function getReviewAppealByItem(itemId) {
  return itemId ? db.prepare("SELECT * FROM review_appeals WHERE itemId = ?").get(String(itemId)) || null : null;
}
// 某条档案记录的申诉（2.6 护栏：申诉处理中不能另行修改评级）
function getReviewAppealByRecord(recordId) {
  return recordId ? db.prepare("SELECT * FROM review_appeals WHERE recordId = ? ORDER BY submittedAt DESC LIMIT 1").get(String(recordId)) || null : null;
}
function mapReviewAppealsByItems(itemIds) {
  const ids = [...new Set((itemIds || []).filter(Boolean).map(String))];
  const out = new Map();
  for (let i = 0; i < ids.length; i += 200) {
    const part = ids.slice(i, i + 200);
    for (const r of db.prepare(`SELECT * FROM review_appeals WHERE itemId IN (${part.map(() => "?").join(", ")})`).all(...part)) out.set(r.itemId, r);
  }
  return out;
}
function listReviewAppeals({ cycleId, statuses } = {}) {
  const where = [], vals = [];
  if (cycleId) { where.push("cycleId = ?"); vals.push(String(cycleId)); }
  if (Array.isArray(statuses) && statuses.length) { where.push(`status IN (${statuses.map(() => "?").join(", ")})`); vals.push(...statuses.map(String)); }
  return db.prepare(`SELECT * FROM review_appeals${where.length ? " WHERE " + where.join(" AND ") : ""} ORDER BY submittedAt DESC, id DESC`).all(...vals);
}
function listOpenReviewAppeals() {
  return listReviewAppeals({ statuses: ["submitted", "in_review"] });
}
// 编号 rap-<n>（meta nextRAP）。已存在的编号跳过（meta 被重置、或旧附件表配新 meta 的还原，不能把别人的材料挂到新申诉上，审查）
function createReviewAppeal(r) {
  let n = Number(getMeta("nextRAP") || 1);
  while (db.prepare("SELECT 1 FROM review_appeals WHERE id = ?").get("rap-" + n)
    || db.prepare("SELECT 1 FROM attachments WHERE ownerKind = 'review_appeal' AND ownerId = ?").get("rap-" + n)) n++;
  setMeta("nextRAP", n + 1);
  const id = "rap-" + n;
  db.prepare(`INSERT INTO review_appeals (id, itemId, cycleId, userId, recordId, deptId, deptName, ratingAtSubmit, reason, status,
      submittedAt, windowDeadline, slaDueOn, conflictIds, reasonCategory, reasonCategorySubmitted) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'submitted', ?, ?, ?, ?, ?, ?)`)
    .run(id, String(r.itemId), String(r.cycleId), String(r.userId), String(r.recordId), r.deptId || null, r.deptName || null,
      String(r.ratingAtSubmit), String(r.reason), String(r.submittedAt), String(r.windowDeadline), String(r.slaDueOn),
      JSON.stringify(Array.isArray(r.conflictIds) ? r.conflictIds : []), r.reasonCategory || null, r.reasonCategory || null);
  return getReviewAppeal(id);
}
// 条件更新：WHERE id = ? AND status = from [AND handlerId IS ?]；patch 只认白名单列。返回是否恰好改了一行
function transitionReviewAppeal(id, cond, patch) {
  const sets = [], vals = [];
  for (const [k, v] of Object.entries(patch || {})) {
    if (!REVIEW_APPEAL_PATCHABLE.has(k)) throw new Error("transitionReviewAppeal: column not patchable: " + k);
    sets.push(`${k} = ?`); vals.push(v === undefined ? null : v);
  }
  if (!sets.length) return false;
  let sql = `UPDATE review_appeals SET ${sets.join(", ")} WHERE id = ? AND status = ?`;
  vals.push(String(id), String(cond && cond.from));
  if (cond && cond.handlerId !== undefined) { sql += " AND handlerId IS ?"; vals.push(cond.handlerId); }
  return db.prepare(sql).run(...vals).changes === 1;
}
// 提醒标记（幂等）：UPDATE … SET col = value WHERE id = ? AND col IS expect（expect = 读取时的原值；首次为 null）
function setReviewAppealMarker(id, column, value, opts) {
  if (!REVIEW_APPEAL_MARKERS.has(column)) throw new Error("setReviewAppealMarker: unknown marker " + column);
  const expect = opts && opts.expect !== undefined ? opts.expect : null;
  return db.prepare(`UPDATE review_appeals SET ${column} = ? WHERE id = ? AND ${column} IS ?`).run(value, String(id), expect).changes === 1;
}
// 申诉原因分类（迁移 97）：HRBP 改正分类。返回是否改了一行
function setReviewAppealCategory(id, category) {
  return db.prepare("UPDATE review_appeals SET reasonCategory = ? WHERE id = ?").run(category || null, String(id)).changes === 1;
}
// 利益回避名单只增不减（提交时的快照 ∪ 之后发现的）
function addReviewAppealConflicts(id, ids) {
  const ap = getReviewAppeal(id);
  if (!ap) return false;
  let cur = [];
  try { cur = JSON.parse(ap.conflictIds || "[]"); } catch {}
  const next = [...new Set([...(Array.isArray(cur) ? cur : []), ...(ids || []).filter(Boolean).map(String)])];
  if (next.length === cur.length) return false;
  db.prepare("UPDATE review_appeals SET conflictIds = ? WHERE id = ?").run(JSON.stringify(next), String(id));
  return true;
}
function createReviewAppealConsult(r) {
  let n = Number(getMeta("nextRAC") || 1);
  while (db.prepare("SELECT 1 FROM review_appeal_consults WHERE id = ?").get("rac-" + n)) n++;
  setMeta("nextRAC", n + 1);
  const id = "rac-" + n;
  db.prepare("INSERT INTO review_appeal_consults (id, appealId, consulteeId, relation, askedBy, askedAt, question) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(id, String(r.appealId), String(r.consulteeId), r.relation === "hod" ? "hod" : "manager", String(r.askedBy), String(r.askedAt), r.question || null);
  return getReviewAppealConsult(id);
}
function getReviewAppealConsult(id) {
  return id ? db.prepare("SELECT * FROM review_appeal_consults WHERE id = ?").get(String(id)) || null : null;
}
function listReviewAppealConsults(appealId) {
  return db.prepare("SELECT * FROM review_appeal_consults WHERE appealId = ? ORDER BY askedAt, id").all(String(appealId));
}
// 征询人看到的自己的征询：带申诉状态与结论时间（a_ 前缀）
function listReviewAppealConsultsFor(consulteeId) {
  return db.prepare(
    `SELECT c.*, a.status AS appealStatus, a.decidedAt AS appealDecidedAt, a.userId AS appealUserId, a.cycleId AS appealCycleId,
            a.itemId AS appealItemId, a.submittedAt AS appealSubmittedAt
     FROM review_appeal_consults c JOIN review_appeals a ON a.id = c.appealId WHERE c.consulteeId = ? ORDER BY c.askedAt DESC, c.id DESC`
  ).all(String(consulteeId));
}
function answerReviewAppealConsult(id, opinion, atIso) {
  return db.prepare("UPDATE review_appeal_consults SET opinion = ?, answeredAt = ? WHERE id = ? AND answeredAt IS NULL")
    .run(String(opinion), String(atIso), String(id)).changes === 1;
}
// { open, total }：open = 未答、申诉处理中；total = 申诉处理中或 sinceIso 之后作出结论的征询
function countReviewAppealConsultsFor(consulteeId, sinceIso) {
  const r = db.prepare(
    `SELECT SUM(CASE WHEN c.answeredAt IS NULL AND a.status = 'in_review' THEN 1 ELSE 0 END) AS open,
            SUM(CASE WHEN a.status = 'in_review' OR (a.decidedAt IS NOT NULL AND a.decidedAt >= ?) THEN 1 ELSE 0 END) AS total
     FROM review_appeal_consults c JOIN review_appeals a ON a.id = c.appealId WHERE c.consulteeId = ?`
  ).get(String(sinceIso || ""), String(consulteeId));
  return { open: Number(r && r.open) || 0, total: Number(r && r.total) || 0 };
}
function addReviewAppealEvent(e) {
  db.prepare("INSERT INTO review_appeal_events (appealId, at, actorId, kind, data) VALUES (?, ?, ?, ?, ?)")
    .run(String(e.appealId), e.at || new Date().toISOString(), e.actorId || null, String(e.kind), e.data === undefined || e.data === null ? null : JSON.stringify(e.data));
}
function listReviewAppealEvents(appealId) {
  return db.prepare("SELECT * FROM review_appeal_events WHERE appealId = ? ORDER BY id").all(String(appealId))
    .map((r) => { let data = null; try { data = r.data ? JSON.parse(r.data) : null; } catch {} return { ...r, data }; });
}
// 查看记录去重（每人每申诉每个马尼拉日一次）
function hasReviewAppealEvent(appealId, kind, actorId, data) {
  return !!db.prepare("SELECT 1 FROM review_appeal_events WHERE appealId = ? AND kind = ? AND actorId IS ? AND data IS ? LIMIT 1")
    .get(String(appealId), String(kind), actorId || null, data === undefined || data === null ? null : JSON.stringify(data));
}

// succession plans (Phase 4): key position → successor candidates + readiness
// createdBy / source（迁移 80）：source = manual（单条录入，缺省）| import（批量导入）| filter（人才筛选批量加入）
function addSuccession({ positionName, userId, readiness, note, createdBy, source }) {
  const n = Number(getMeta("nextSC") || 1);
  setMeta("nextSC", n + 1);
  const id = "sc-" + n;
  const now = new Date().toISOString();
  db.prepare("INSERT INTO succession (id, positionName, userId, readiness, note, createdAt, updatedAt, createdBy, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(id, positionName, userId, readiness, note || null, now, now, createdBy || null, source || "manual");
  return db.prepare("SELECT * FROM succession WHERE id = ?").get(id);
}
function listSuccession() {
  return db.prepare("SELECT * FROM succession ORDER BY positionName, createdAt").all();
}
function getSuccession(id) {
  return db.prepare("SELECT * FROM succession WHERE id = ?").get(id) || null;
}
function updateSuccession(id, fields) {
  const s = getSuccession(id);
  if (!s) return null;
  db.prepare("UPDATE succession SET readiness = ?, note = ?, updatedAt = ? WHERE id = ?")
    .run(fields.readiness !== undefined ? fields.readiness : s.readiness,
      fields.note !== undefined ? fields.note : s.note, new Date().toISOString(), id);
  return getSuccession(id);
}
function deleteSuccession(id) {
  db.prepare("DELETE FROM succession WHERE id = ?").run(id);
}

// ---------- 12.2 关键岗位清单（迁移 86，设计 b12-design 第 4 节）----------
// nameKey = positionKey(name)，全局唯一（唯一索引兜底；同键已存在由调用方先查 getKeyPositionByKey 回 409）。
const kpRow = (r) => (r ? { ...r, isKey: r.isKey ? 1 : 0 } : null);
function listKeyPositions() {
  return db.prepare("SELECT * FROM key_positions ORDER BY name COLLATE NOCASE, id").all().map(kpRow);
}
function getKeyPosition(id) {
  return kpRow(db.prepare("SELECT * FROM key_positions WHERE id = ?").get(id));
}
function getKeyPositionByKey(nameKey) {
  return kpRow(db.prepare("SELECT * FROM key_positions WHERE nameKey = ?").get(nameKey));
}
function createKeyPosition({ name, nameKey, deptId, deptName, isKey, note, source, createdBy }) {
  const id = "kp-" + crypto.randomBytes(6).toString("hex");
  db.prepare("INSERT INTO key_positions (id, name, nameKey, deptId, deptName, isKey, note, source, createdAt, createdBy, updatedAt, updatedBy) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)")
    .run(id, name, nameKey, deptId || null, deptName || null, isKey === false || isKey === 0 ? 0 : 1, note || null, source || "manual", new Date().toISOString(), createdBy || null);
  return getKeyPosition(id);
}
// fields：name / nameKey / deptId / deptName / isKey / note 中给出的项（undefined = 不改）
function updateKeyPosition(id, fields, updatedBy) {
  const cur = getKeyPosition(id);
  if (!cur) return null;
  const v = (k) => (fields[k] !== undefined ? fields[k] : cur[k]);
  db.prepare("UPDATE key_positions SET name = ?, nameKey = ?, deptId = ?, deptName = ?, isKey = ?, note = ?, updatedAt = ?, updatedBy = ? WHERE id = ?")
    .run(v("name"), v("nameKey"), v("deptId") || null, v("deptName") || null, v("isKey") === false || v("isKey") === 0 ? 0 : 1, v("note") || null,
      new Date().toISOString(), updatedBy || null, id);
  return getKeyPosition(id);
}
function deleteKeyPosition(id) {
  return db.prepare("DELETE FROM key_positions WHERE id = ?").run(id).changes;
}

// ---------- 12.2 受控人才标签（迁移 86 / 87，设计 b12-design 第 5 节）----------
// 映射白名单只在 modules/talent/controlled-tags.js 一处（前端镜像 web/src/controlledTags.js）；这里只负责写库与留痕。
// 当前状态的唯一来源仍是 users.talentTags；talent_tag_events 只追加，与标签改动在同一事务里写。
const CTAGS = require("./modules/talent/controlled-tags.js");
const tagsOfRow = (s) => { try { const a = s ? JSON.parse(s) : []; return Array.isArray(a) ? a : []; } catch { return []; } };
// 一组标签里能映射到受控 key 的写法换成 canonical 值、同一人重复的合并（保留首次出现的位置），其余原样保留。
// → { out, keys:Set（持有的受控 key）, renamed:{ 原写法: canonical }, changed }
function canonicalizeTagList(list) {
  const m = CTAGS.mapTags(Array.isArray(list) ? list : []);
  const renamed = {};
  for (const x of m.mapped) renamed[x.from] = CTAGS.CANONICAL[x.key];
  return { out: m.tags, keys: new Set(CTAGS.heldKeysOf(m.tags)), renamed, changed: m.changed };
}
function insertTagEvent({ userId, tagKey, action, reason, source, actorId, actorName, at, effectiveOn, requestId }) {
  const ev = {
    id: "tte-" + crypto.randomBytes(8).toString("hex"), userId, tagKey, action, reason, source,
    actorId: actorId || null, actorName: actorName || null, at: at || new Date().toISOString(),
    effectiveOn: effectiveOn === undefined ? null : effectiveOn, requestId: requestId || null,
  };
  db.prepare("INSERT INTO talent_tag_events (id, userId, tagKey, action, reason, source, actorId, actorName, at, effectiveOn, requestId) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(ev.id, ev.userId, ev.tagKey, ev.action, ev.reason, ev.source, ev.actorId, ev.actorName, ev.at, ev.effectiveOn, ev.requestId);
  return ev;
}
// 受控标签专用入口（POST /api/admin/employees/:id/controlled-tags）：改 users.talentTags + 写一条事件，同一事务；不经 updateUser 的兜底
// （否则一次动作两条事件）。add 追加 canonical 值；remove 删除该 key 的所有写法。已持有再 add / 未持有再 remove → { unchanged:true }。
// opts：{ reason, actorId, actorName, requestId, effectiveOn, at }。→ { unchanged } | { talentTags, event }；查无此人 → null
function setControlledTag(userId, tagKey, action, opts = {}) {
  if (!CTAGS.KEYS.includes(tagKey) || !["add", "remove"].includes(action)) throw new Error("setControlledTag: bad tag or action");
  return transaction(() => {
    const row = db.prepare("SELECT talentTags FROM users WHERE id = ?").get(userId);
    if (!row) return null;
    const cur = tagsOfRow(row.talentTags);
    const c = canonicalizeTagList(cur);
    const has = c.keys.has(tagKey);
    if ((action === "add" && has) || (action === "remove" && !has)) return { unchanged: true, talentTags: cur };
    const next = action === "add" ? [...c.out, CTAGS.CANONICAL[tagKey]]
      : c.out.filter((t) => !(typeof t === "string" && CTAGS.keyOf(t) === tagKey));
    db.prepare("UPDATE users SET talentTags = ? WHERE id = ?").run(JSON.stringify(next), userId);
    const event = insertTagEvent({ userId, tagKey, action, reason: opts.reason, source: "manual", actorId: opts.actorId, actorName: opts.actorName,
      at: opts.at, effectiveOn: opts.effectiveOn || null, requestId: opts.requestId });
    return { talentTags: next, event };
  });
}
function listTagEvents(userId) {
  return db.prepare("SELECT * FROM talent_tag_events WHERE userId = ? ORDER BY at, id").all(userId);
}
function listAllTagEvents() {
  return db.prepare("SELECT * FROM talent_tag_events ORDER BY at, id").all();
}
// updateUser 的存储层兜底（设计 5.4 第 3 条）：凡写 talentTags，先把受控写法规范成 canonical，再与库里当前的受控集合比较；
// 有差异就在同一事务里写事件（source script）。actor 取请求上下文（kernel/events.js currentContext），没有则为空 = 系统。
function tagFallbackEvents(id, nextKeys) {
  const row = db.prepare("SELECT talentTags FROM users WHERE id = ?").get(id);
  if (!row) return;
  const before = canonicalizeTagList(tagsOfRow(row.talentTags)).keys;
  const ctx = events.currentContext();
  const actorId = ctx && ctx.actorId ? ctx.actorId : null;
  const actor = actorId ? db.prepare("SELECT name FROM users WHERE id = ?").get(actorId) : null;
  const today = ymdManila();
  for (const k of CTAGS.KEYS) {
    const a = before.has(k), b = nextKeys.has(k);
    if (a === b) continue;
    insertTagEvent({ userId: id, tagKey: k, action: b ? "add" : "remove", reason: CTAGS.SCRIPT_REASON, source: "script",
      actorId, actorName: actor ? actor.name : null, effectiveOn: today, requestId: ctx && ctx.requestId ? ctx.requestId : null });
  }
}
function ymdManila() { return new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10); }
// 数据迁移 87（及演示种子之后）共用：存量标签映射为受控标签、补写 migration 事件、改写已保存筛选的 talentTag 叶子、写一条系统审计。
// 幂等：第二次执行找不到非 canonical 写法、所有持有者都已有事件，不改数据、不写审计。→ { people, events, filters }
function controlledTagsMap(migration) {
  const renamed = {};
  let people = 0, evCount = 0, filters = 0;
  const upd = db.prepare("UPDATE users SET talentTags = ? WHERE id = ?");
  const hasEv = db.prepare("SELECT 1 FROM talent_tag_events WHERE userId = ? AND tagKey = ? LIMIT 1");
  for (const u of db.prepare("SELECT id, talentTags FROM users WHERE talentTags IS NOT NULL AND talentTags NOT IN ('', '[]')").all()) {
    let tags;
    try { tags = JSON.parse(u.talentTags); } catch { continue; }
    if (!Array.isArray(tags)) continue;
    const c = canonicalizeTagList(tags);
    if (c.changed) { upd.run(JSON.stringify(c.out), u.id); people++; Object.assign(renamed, c.renamed); }
    for (const k of CTAGS.KEYS) {
      if (!c.keys.has(k) || hasEv.get(u.id, k)) continue;
      const orig = [...new Set(tags.filter((t) => typeof t === "string" && CTAGS.keyOf(t) === k))];
      insertTagEvent({ userId: u.id, tagKey: k, action: "add", reason: CTAGS.migrationReason(orig), source: "migration", effectiveOn: null });
      evCount++;
    }
  }
  const now = new Date().toISOString();
  for (const f of db.prepare("SELECT id, definition FROM talent_filters").all()) {
    let def;
    try { def = JSON.parse(f.definition); } catch { continue; }
    let dirty = false;
    TALENT_FILTER_MODEL.walkLeaves(def, (leaf) => {
      if (!leaf || leaf.field !== "talentTag" || !Array.isArray(leaf.value)) return;
      const c = canonicalizeTagList(leaf.value);
      if (c.changed) { leaf.value = c.out; dirty = true; Object.assign(renamed, c.renamed); }
    });
    if (!dirty) continue;
    db.prepare("UPDATE talent_filters SET definition = ?, version = version + 1, updatedAt = ? WHERE id = ?").run(JSON.stringify(def), now, f.id);
    filters++;
  }
  if (!people && !evCount && !filters) return { people, events: evCount, filters };
  addAudit({ actorId: null, actorName: null, action: "talent.tags.controlled-map", target: "talentTags",
    before: null, after: { migration, people, events: evCount, filters, renamed }, requestId: null });
  console.log(`[migration ${migration}] controlled talent tags: ${people} people rewritten, ${evCount} events written, ${filters} filters rewritten`);
  return { people, events: evCount, filters };
}

// ---------- 12.2 工作台快照（迁移 86，设计 b12-design 第 2.8 节）----------
// 按主体存行；同一季度、同一 metric 每天整体替换一次（每个季度的最后一次快照即期末状态）。无对外接口。
function replaceWorkbenchSnapshots(periodKey, metric, rows, takenOn) {
  return transaction(() => {
    db.prepare("DELETE FROM workbench_snapshots WHERE periodKey = ? AND metric = ?").run(periodKey, metric);
    const ins = db.prepare("INSERT INTO workbench_snapshots (periodKey, metric, subjectId, deptName, data, takenOn) VALUES (?, ?, ?, ?, ?, ?)");
    for (const r of rows) ins.run(periodKey, metric, String(r.subjectId), r.deptName || null, JSON.stringify(r.data || {}), takenOn);
    return rows.length;
  });
}
function listWorkbenchSnapshots(periodKey, metric) {
  return db.prepare("SELECT * FROM workbench_snapshots WHERE periodKey = ? AND metric = ? ORDER BY subjectId").all(periodKey, metric)
    .map((r) => { let data = {}; try { data = JSON.parse(r.data) || {}; } catch {} return { ...r, data }; });
}
function hasWorkbenchSnapshots(periodKey, metric) {
  return !!db.prepare("SELECT 1 FROM workbench_snapshots WHERE periodKey = ? AND metric = ? LIMIT 1").get(periodKey, metric);
}
// 某个 metric 最早的快照日（界面「自 YYYY-MM 起留存」）；没有 → null
function firstWorkbenchSnapshotDay(metric) {
  const r = db.prepare("SELECT MIN(takenOn) AS d FROM workbench_snapshots WHERE metric = ?").get(metric);
  return r && r.d ? r.d : null;
}
// 只保留 periodKey ≥ minKey 的行（'YYYY-Qn' 按字符串比较即时间顺序）
function pruneWorkbenchSnapshots(minKey) {
  return db.prepare("DELETE FROM workbench_snapshots WHERE periodKey < ?").run(minKey).changes;
}

// ---------- 人才筛选（迁移 80，第五批 8.1）----------
// 行 → 对象：definition / columns / sort 解析成 JSON（坏 JSON 回落为空定义 / 默认列，不抛异常）。
function rowToTalentFilter(r) {
  if (!r) return null;
  const pj = (s, d) => { try { const v = s ? JSON.parse(s) : d; return v === null || v === undefined ? d : v; } catch { return d; } };
  return {
    id: r.id, name: r.name, name_zh: r.name_zh || null, builtinKey: r.builtinKey || null,
    definition: pj(r.definition, { v: 1, logic: "and", items: [] }), columns: pj(r.columns, []), sort: pj(r.sort, null),
    visibility: r.visibility === "shared" ? "shared" : "private", ownerId: r.ownerId || null,
    version: Number(r.version) || 1, createdAt: r.createdAt, updatedAt: r.updatedAt, updatedBy: r.updatedBy || null,
  };
}
function listTalentFilters() {
  return db.prepare("SELECT * FROM talent_filters ORDER BY (builtinKey IS NULL), updatedAt DESC").all().map(rowToTalentFilter);
}
function getTalentFilter(id) {
  return rowToTalentFilter(db.prepare("SELECT * FROM talent_filters WHERE id = ?").get(String(id)));
}
function getTalentFilterByKey(key) {
  return rowToTalentFilter(db.prepare("SELECT * FROM talent_filters WHERE builtinKey = ?").get(String(key)));
}
function createTalentFilter(f) {
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO talent_filters (id, name, name_zh, builtinKey, definition, columns, sort, visibility, ownerId, version, createdAt, updatedAt, updatedBy)
              VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, 1, ?, ?, ?)`)
    .run(f.id, f.name, f.name_zh || null, JSON.stringify(f.definition), JSON.stringify(f.columns || []), f.sort ? JSON.stringify(f.sort) : null,
      f.visibility === "shared" ? "shared" : "private", f.ownerId || null, now, now, f.updatedBy || null);
  return getTalentFilter(f.id);
}
// 乐观锁：version 与库里不一致 → 返回 null（调用方回 409 filter_conflict），一行都不写。成功后 version + 1。
function updateTalentFilter(id, patch, expectedVersion, updatedBy) {
  const cur = getTalentFilter(id);
  if (!cur || Number(expectedVersion) !== cur.version) return null;
  const next = { ...cur, ...patch };
  const r = db.prepare(`UPDATE talent_filters SET name = ?, name_zh = ?, definition = ?, columns = ?, sort = ?, visibility = ?, version = version + 1, updatedAt = ?, updatedBy = ?
                        WHERE id = ? AND version = ?`)
    .run(next.name, next.name_zh || null, JSON.stringify(next.definition), JSON.stringify(next.columns || []), next.sort ? JSON.stringify(next.sort) : null,
      next.visibility === "shared" ? "shared" : "private", new Date().toISOString(), updatedBy || null, cur.id, cur.version);
  return r.changes ? getTalentFilter(cur.id) : null;
}
function deleteTalentFilter(id) {
  db.prepare("DELETE FROM talent_filter_members WHERE filterId = ?").run(String(id));
  db.prepare("DELETE FROM talent_filters WHERE id = ?").run(String(id));
}
function listTalentFilterMembers(filterId) {
  return db.prepare("SELECT * FROM talent_filter_members WHERE filterId = ? ORDER BY addedAt").all(String(filterId));
}
function setTalentFilterMember({ filterId, userId, mode, note, addedBy }) {
  db.prepare(`INSERT INTO talent_filter_members (filterId, userId, mode, note, addedBy, addedAt) VALUES (?, ?, ?, ?, ?, ?)
              ON CONFLICT(filterId, userId) DO UPDATE SET mode = excluded.mode, note = excluded.note, addedBy = excluded.addedBy, addedAt = excluded.addedAt`)
    .run(String(filterId), String(userId), mode, note || null, String(addedBy), new Date().toISOString());
}
function removeTalentFilterMember(filterId, userId) {
  return db.prepare("DELETE FROM talent_filter_members WHERE filterId = ? AND userId = ?").run(String(filterId), String(userId)).changes > 0;
}

// departments (managed org dimension; parentId is org-tree groundwork)
// group：集团层部门（meta larksync.groupDepts，由 modules/core/larksync.js 维护），见 modules/core/org.js buildOrgIndex。
function groupDeptIds() {
  try { return new Set(JSON.parse(getMeta("larksync.groupDepts") || "[]")); } catch { return new Set(); }
}
function listDepartments(includeInactive) {
  const groups = groupDeptIds();
  return db.prepare("SELECT * FROM departments ORDER BY sort, name").all()
    .map((d) => ({ id: d.id, name: d.name, parentId: d.parentId, active: !!d.active, sort: d.sort, ownerId: d.ownerId || null, ...(groups.has(d.id) ? { group: true } : {}) }))
    .filter((d) => includeInactive || d.active);
}
// 部门名匹配口径（与 modules/core/org.js 的 deptOf、范围解析 scopeAllowsDepartment 一致）：
// 去首尾空白后先按原文精确匹配，再不区分大小写。不区分大小写按 JS toLowerCase —— SQLite 的
// lower() 只折叠 ASCII 字母，「PARAÑAQUE OFFICE」与「Parañaque Office」在 SQL 里不相等，
// 以前会因此新建出一条只差大小写的一级部门（name 上的 UNIQUE 区分大小写，也拦不住）。
// 大小写相同写法重复时取 sort, name 排在前面的一条（与 org.js 的 byName 同一取法）。
const deptNameKey = (s) => (s == null ? "" : String(s).trim().toLowerCase());
function getDepartmentByName(name) {
  const n = String(name || "").trim();
  if (!n) return null;
  const exact = stmt("SELECT * FROM departments WHERE name = ?").get(n);
  if (exact) return exact;
  const ci = stmt("SELECT * FROM departments WHERE lower(name) = lower(?) ORDER BY sort, name LIMIT 1").get(n);
  if (ci || /^[\x00-\x7f]*$/.test(n)) return ci || null;
  // 含非 ASCII 字母且上面没命中：按 JS 口径在部门表里再找一次（几百行；只在未命中时走到这里）。
  const k = n.toLowerCase();
  return stmt("SELECT * FROM departments ORDER BY sort, name").all().find((d) => deptNameKey(d.name) === k) || null;
}
// 把 deptId 挂到 newParentId 下会不会成环：从新父级沿 parentId 往上走，走到 deptId 自己即成环
// （含 newParentId === deptId）。PUT /departments/:id 与「认领孤儿部门」共用这一条规则。
function departmentWouldCycle(deptId, newParentId) {
  if (!deptId || !newParentId) return false;
  const seen = new Set();
  let cur = String(newParentId);
  while (cur && !seen.has(cur)) {
    if (cur === String(deptId)) return true;
    seen.add(cur);
    const row = stmt("SELECT parentId FROM departments WHERE id = ?").get(cur);
    cur = row && row.parentId ? String(row.parentId) : null;
  }
  return false;   // 走到根，或撞上一个不经过 deptId 的既有环（那是别处的坏数据，不是这次写造成的）
}
// Idempotent by name — the auto-registration path for forms and CSV imports.
function ensureDepartment(name, parentId) {
  name = String(name || "").trim();
  if (!name) return null;
  const existing = getDepartmentByName(name);
  if (existing) {
    // Adopt an orphan into the tree (import backfill); never re-parent one
    // that already has a place, and never make a node its own parent —
    // nor its own descendant's child: a root adopted under one of its own
    // subdepartments would form a parentId loop, and every department in that
    // loop drops out of the level-1 tree (and its people out of the HoD list).
    // Refused silently here (nothing written, no event); the HTTP adopt path
    // checks first and answers 400 dept_cycle.
    if (parentId && !existing.parentId && parentId !== existing.id && !departmentWouldCycle(existing.id, parentId)) {
      return inEventTx(() => {
        const idxBefore = eventOrgIndex();
        db.prepare("UPDATE departments SET parentId = ? WHERE id = ?").run(parentId, existing.id);
        bumpScopeEpoch();
        emitEvent("department.moved", { deptId: existing.id }, {
          name: existing.name, from: eventDeptPosition(idxBefore, existing.id), to: eventDeptPosition(eventOrgIndex(), existing.id), reason: "adopted",
        });
        return getDepartmentByName(name);
      });
    }
    return existing;
  }
  const n = Number(getMeta("nextDept") || 1);
  setMeta("nextDept", n + 1);
  db.prepare("INSERT INTO departments (id, name, parentId, active, sort) VALUES (?, ?, ?, 1, ?)").run("d-" + n, name, parentId || null, n);
  bumpScopeEpoch();
  return getDepartmentByName(name);
}
// 改名、改父级、停用各发一个事件（department.renamed / moved / deactivated）。改名与级联改
// users.department 同在一笔事务里（原来是两条各自提交的语句）。
function updateDepartment(id, fields) {
  return inEventTx(() => {
    const d = db.prepare("SELECT * FROM departments WHERE id = ?").get(id);
    if (!d) return null;
    const newName = fields.name !== undefined ? String(fields.name).trim() : d.name;
    const newParent = fields.parentId !== undefined ? fields.parentId : d.parentId;
    const newActive = fields.active !== undefined ? (fields.active ? 1 : 0) : d.active;
    const moved = (newParent || null) !== (d.parentId || null);
    const deactivated = !!d.active && !newActive;
    const renamed = newName !== d.name;
    const idxBefore = moved || deactivated || renamed ? eventOrgIndex() : null;
    // Renaming cascades to the users who belong to this department — matched the
    // way org.js / the scope resolver match (exact, then case-insensitive), not
    // by exact text: a member stored as "sales" under "Sales" must follow the
    // rename, or they silently fall out of the tree (and out of the HoD list).
    // Resolved against the tree BEFORE the rename.
    const memberIds = renamed ? usersResolvingTo(idxBefore, d, d.name).map((u) => u.id) : [];
    db.prepare("UPDATE departments SET name = ?, parentId = ?, active = ?, sort = ?, ownerId = ? WHERE id = ?")
      .run(newName, newParent, newActive,
        fields.sort !== undefined ? fields.sort : d.sort,
        fields.ownerId !== undefined ? (fields.ownerId || null) : (d.ownerId || null), id);
    let members = 0;
    if (renamed) {
      const up = stmt("UPDATE users SET department = ? WHERE id = ?");
      for (const uid of memberIds) up.run(newName, uid);
      members = memberIds.length;
    }
    bumpScopeEpoch(); // 改名/改父级都会改变范围解析出的名称集合
    const after = db.prepare("SELECT * FROM departments WHERE id = ?").get(id);
    const subject = { deptId: d.id };
    if (renamed) emitEvent("department.renamed", subject, { from: d.name, to: newName, registered: true, members });
    if (moved) emitEvent("department.moved", subject, { name: newName, from: eventDeptPosition(idxBefore, d.id), to: eventDeptPosition(eventOrgIndex(), d.id), reason: "updated" });
    if (deactivated) emitEvent("department.deactivated", subject, { name: newName, deleted: false, ...eventDeptPosition(idxBefore, d.id) });
    return after;
  });
}
// 该部门名下的人数（含停用者）。匹配口径同 usersResolvingTo：大小写变体的成员也算 ——
// DELETE 的「有在编员工，只能停用」校验靠它，按原文精确计数会把「sales」下的人数成 0、放行删除。
function countUsersInDepartment(name) {
  const idx = eventOrgIndex();
  return usersResolvingTo(idx, idx.deptOf(name), name).length;
}
// 删除 = department.deactivated（deleted:true；删一个已停用的部门同样发，wasActive 为 false）；
// 子部门变成一级部门，各发一条 department.moved（reason "parent_deleted"）。
function deleteDepartment(id) {
  return inEventTx(() => {
    const d = db.prepare("SELECT * FROM departments WHERE id = ?").get(id);
    const idxBefore = d ? eventOrgIndex() : null;
    const kids = d ? db.prepare("SELECT id, name FROM departments WHERE parentId = ?").all(id) : [];
    // Children survive as roots rather than pointing at a ghost parent.
    db.prepare("UPDATE departments SET parentId = NULL WHERE parentId = ?").run(id);
    db.prepare("DELETE FROM departments WHERE id = ?").run(id);
    bumpScopeEpoch();
    if (!d) return;
    emitEvent("department.deactivated", { deptId: d.id }, { name: d.name, deleted: true, wasActive: !!d.active, ...eventDeptPosition(idxBefore, d.id) });
    if (kids.length) {
      const idxAfter = eventOrgIndex();
      for (const k of kids)
        emitEvent("department.moved", { deptId: k.id }, { name: k.name, from: eventDeptPosition(idxBefore, k.id), to: eventDeptPosition(idxAfter, k.id), reason: "parent_deleted" });
    }
  });
}

// ---------- RBAC roles（角色与授权，P1） ----------
// grants/scope 以 JSON 字符串落库、读时 parse。grants 恒补齐为 9 域全列（fullGrants），
// scope 默认空对象 {}（= 全公司，P1 只存不强制）。key 为内置角色的稳定 slug，自定义
// 角色为 NULL。域的授予/拒绝口径（roles 恒超管专属不可授予、accounts 可授予受范围约束、
// 超管 9 域全 manage 等，D6）由 server.js 的 resolveGrants/sanitizeGrants/闸门执行；
// 本层只忠实存取。
function rowToRole(r) {
  if (!r) return null;
  // scope 的坏形状**不能**被静默吞成 {} —— {} 等于全公司，那是一次看不见的提权。
  // 这里只做「忠实记录」：解析失败或解析出非普通对象时挂一个 scopeMalformed 标记，
  // 由 parseScope() 按 fail closed 口径处理（理由写在 parseScope 上方）。正常行不带
  // 这个字段，所以 /api/admin/roles 的响应形状对现有前端一字不变。
  let scope, scopeMalformed = false;
  try { scope = JSON.parse(r.scope || "{}"); } catch { scope = {}; scopeMalformed = true; }
  if (scope !== null && scope !== undefined && (typeof scope !== "object" || Array.isArray(scope))) { scope = {}; scopeMalformed = true; }
  let grants;
  try { grants = JSON.parse(r.grants || "{}"); } catch { grants = {}; }
  return {
    id: r.id,
    key: r.key || null,
    name: r.name,
    name_zh: r.name_zh,
    grants: fullGrants(grants),
    scope: scope && typeof scope === "object" && !Array.isArray(scope) ? scope : {},
    ...(scopeMalformed ? { scopeMalformed: true } : {}),
    builtin: !!r.builtin,
    createdAt: r.createdAt,
  };
}
// 内置角色先出、其余按 id；每行附上成员数（COUNT users.adminRoleId）供角色管理页展示。
function listRoles() {
  return db.prepare("SELECT * FROM roles ORDER BY builtin DESC, id").all().map((r) => {
    const role = rowToRole(r);
    role.memberCount = roleMemberCount(r.id);
    return role;
  });
}
function getRole(id) {
  const r = db.prepare("SELECT * FROM roles WHERE id = ?").get(id);
  return r ? rowToRole(r) : null;
}
function getRoleByKey(key) {
  if (!key) return null;
  const r = db.prepare("SELECT * FROM roles WHERE key = ?").get(key);
  return r ? rowToRole(r) : null;
}
// 自定义角色：key 恒 NULL、builtin 默认 0。name_zh 缺省回落到 name（避免另一语言空白）。
function createRole({ name, name_zh, grants, scope, builtin }) {
  const now = new Date().toISOString();
  const en = String(name || "").trim();
  const info = db.prepare(
    "INSERT INTO roles (key, name, name_zh, grants, scope, builtin, createdAt) VALUES (NULL, ?, ?, ?, ?, ?, ?)"
  ).run(
    en, String(name_zh || "").trim() || en,
    JSON.stringify(fullGrants(grants)),
    JSON.stringify(scope && typeof scope === "object" && !Array.isArray(scope) ? scope : {}),
    builtin ? 1 : 0, now
  );
  bumpScopeEpoch();
  return Number(info.lastInsertRowid);
}
// 部分更新：只写传入的键（name/name_zh/grants/scope）。key/builtin/createdAt 不可改。
function updateRole(id, { name, name_zh, grants, scope }) {
  const sets = [], vals = [];
  if (name !== undefined) { sets.push("name = ?"); vals.push(String(name || "").trim()); }
  if (name_zh !== undefined) { sets.push("name_zh = ?"); vals.push(String(name_zh || "").trim()); }
  if (grants !== undefined) { sets.push("grants = ?"); vals.push(JSON.stringify(fullGrants(grants))); }
  if (scope !== undefined) { sets.push("scope = ?"); vals.push(JSON.stringify(scope && typeof scope === "object" && !Array.isArray(scope) ? scope : {})); }
  if (!sets.length) return false;
  bumpScopeEpoch();
  return db.prepare(`UPDATE roles SET ${sets.join(", ")} WHERE id = ?`).run(...vals, id).changes > 0;
}
function deleteRole(id) {
  bumpScopeEpoch();
  return db.prepare("DELETE FROM roles WHERE id = ?").run(id).changes > 0;
}
function roleMemberCount(id) {
  return db.prepare("SELECT COUNT(*) AS n FROM users WHERE adminRoleId = ?").get(id).n;
}
// roleIdOrNull=null → 收回后台角色，回落普通员工。不校验角色存在性（server 层做）。
function setUserAdminRole(userId, roleIdOrNull) {
  db.prepare("UPDATE users SET adminRoleId = ? WHERE id = ?").run(roleIdOrNull == null ? null : roleIdOrNull, userId);
}
function superAdminRoleId() {
  const r = db.prepare("SELECT id FROM roles WHERE key = 'super-admin'").get();
  return r ? r.id : null;
}
// 活跃超管计数（active!=0 且解析出的角色 key==='super-admin'）。与 server.js
// isSuperAdmin 同口径：adminRoleId 指向超管角色的算，遗留 admin（role='admin' 且
// adminRoleId IS NULL，视为超管的兜底）也算 —— 迁移 44 后正常库里只剩前者，兜底是为
// 迁移后新建或半初始化的库兜底。指派角色时用它守住「最后一个活跃超管不得归零」。
function countActiveSuperAdmins() {
  const said = superAdminRoleId();
  return db.prepare(
    `SELECT COUNT(*) AS n FROM users
      WHERE active != 0
        AND ( adminRoleId = ? OR (role = 'admin' AND adminRoleId IS NULL) )`
  ).get(said == null ? -1 : said).n;
}

// ---------- RBAC scope 范围解析（P2 阶段 A：只解析，不改任何查询） ----------
// 口径来源：仓库根 RBAC-DESIGN.md §2（范围 = 部门清单，每项可勾「含下级」）与
// RBAC-SCOPE-INVENTORY.md（112 条后台路由里 61 条受范围约束的逐条清点）。
// 本节**只提供解析器**：61 条端点的实际过滤/校验/重算由 server.js 在阶段 B 逐条接入。
// 上线后行为必须一字不变 —— 现有全部角色的 scope 都是空的，空 = 全公司 = 不过滤。
//
// 解析链（不可省略任何一环）：scope 里的部门 **id** → 含下级时展开子树 → **名称**集合
// → 匹配 users.department。因为 users.department 存的是部门**名称**而不是 id（已核实：
// 925 人的部门名全部能在 departments 表里找到，0 孤儿；改名/合并会 UPDATE users、
// 删除会置 NULL，名称是被维护同步的）。
//
// ===== 坏 JSON / 坏结构的取舍：选 fail closed（零可见）=====
// 两个方向都可辩护，决定性的问题是「哪一种失败是看得见的」：
//  1) fail open（退化全公司）在本系统里**不可观测**。空 scope 本来就等于全公司，于是
//     一个被损坏的 scope 与一个合法的全公司角色，在角色页上、在 /api/me 里、在名册页上
//     长得一模一样 —— 一次静默提权，不会有任何人去查。一个手改库的脚本、一次半截的导入、
//     一个写坏的字节，就能把范围受限的 HRBP 变成全公司可读；而这正是 RBAC 要防的那件事。
//  2) fail closed（零可见）是**响亮**的：持该角色的人一打开名册就看到空表，必然报修。
//     代价落在可用性，不落在保密性。而且恢复路径永远存在 —— 超管不受范围约束
//     （RBAC-DESIGN.md §2），总有人能进角色页把 scope 改回来；已经泄露出去的数据没有
//     恢复路径。**可用性可逆、保密性不可逆**，这个不对称是最终理由。
//  3) 「一个坏字段把人锁死在零可见」的风险是真的，所以关门的触发面被收得很窄：
//     缺失 / null / {} / {departments:[]} 一律**不算坏**（向后兼容红线），只有三种
//     明确自相矛盾的形状才关门：
//       a. scope 文本 JSON.parse 失败（或 parse 出非普通对象）→ rowToRole 打 scopeMalformed；
//       b. departments 存在但不是数组；
//       c. departments 是非空数组，却一条都解析不出 id。
//     **陈旧 id**（指向已删部门）不算坏结构：它自然解析成空名称集合，同样零可见，但那是
//     配置的真实含义（范围指向了一个不存在的部门），不是解析器在替人猜。
// 相关的同一条逻辑：范围生效时，`department` 为空的员工**不可见**（他不属于任何被授予的
// 部门）。实测 925 人里 0 人部门为空，所以这条今天不影响谁，但它必须是 false 而不是 true。
//
// ===== 缓存与失效 =====
// 名称集合依赖 departments 表（id/name/parentId）与角色的 scope，两者都很少变但都会变。
// 失效信号是**两个**、互补不可省：
//   (1) PRAGMA data_version —— 只对**别的连接**的提交 +1，兜住脚本直写库 / 另一个进程；
//   (2) SCOPE_EPOCH —— 本进程自己的部门/角色写会 bump 它，因为 data_version 对本连接
//       自己的写**不动**（server.js 那 9 处手动 refreshContent() 是同一个道理）。
// 只有 (1) 会漏掉「本进程刚给部门改了名」；只有 (2) 会漏掉「别的进程改了库」。
//
// ===== 性能 =====
// roster 一次判 925 人：调用方先 resolveScopeDepartmentNames(role) 拿到名称集合（每个
// epoch 每个角色只展开一次子树），再对每一行做 O(1) 的 Set.has —— 不要在循环里重新展开
// 子树。scopeAllowsUser 本身也走同一份缓存，所以 925 次调用 = 925 次 Map/Set 查找。

let SCOPE_EPOCH = 0;          // 本连接自己的 departments/roles 写次数（见上「缓存与失效」）
let SCOPE_CACHE_KEY = null;   // `${data_version}:${SCOPE_EPOCH}`，变了就全清
let SCOPE_DEPT_INDEX = null;  // { byId: Map<id,{id,name,parentId}>, childrenOf: Map<id,id[]> }
const SCOPE_NAME_CACHE = new Map(); // 角色 → { names:Set<原名>, lower:Set<小写名> }
let SCOPE_BUILDS = 0;         // 子树展开次数（排障/测试用，见 scopeCacheStats）
function bumpScopeEpoch() { SCOPE_EPOCH++; }
function scopeCacheGate() {
  const key = dataVersion() + ":" + SCOPE_EPOCH;
  if (key === SCOPE_CACHE_KEY) return;
  SCOPE_CACHE_KEY = key;
  SCOPE_DEPT_INDEX = null;
  SCOPE_NAME_CACHE.clear();
}
// 部门树索引。读**全部**部门（含 active=0）：停用一个部门不会清掉员工身上的部门名，
// 把停用部门排除在外只会让该部门的员工在自己 HRBP 眼里凭空消失（又一种「开箱即残」）。
function scopeDeptIndex() {
  scopeCacheGate();
  if (SCOPE_DEPT_INDEX) return SCOPE_DEPT_INDEX;
  const byId = new Map(), childrenOf = new Map();
  for (const r of db.prepare("SELECT id, name, parentId FROM departments").all()) {
    byId.set(r.id, { id: r.id, name: r.name, parentId: r.parentId || null });
    if (r.parentId) {
      const kids = childrenOf.get(r.parentId);
      if (kids) kids.push(r.id); else childrenOf.set(r.parentId, [r.id]);
    }
  }
  SCOPE_DEPT_INDEX = { byId, childrenOf };
  return SCOPE_DEPT_INDEX;
}
// 规范化一个角色的范围配置。返回 { all, denyAll, malformed, departments:[{id,includeChildren}] }：
//   all=true     → 全公司，不过滤（空范围 / 无角色 —— 向后兼容的默认）
//   denyAll=true → 零可见（坏结构，fail closed；理由见本节顶部）
// includeChildren 缺省取 **false**（只含本部门）：设计约定里它是必填布尔，缺了就按更窄的
// 一侧读，与 fail closed 的姿态一致；阶段 C 的选择器一律显式写这个布尔。
function parseScope(role) {
  const out = { all: false, denyAll: false, malformed: false, departments: [] };
  if (!role) { out.all = true; return out; }  // 无后台角色（遗留 admin / 员工端）：范围不适用，域闸门管
  if (role.scopeMalformed) { out.malformed = true; out.denyAll = true; return out; }
  let raw = role.scope;
  if (typeof raw === "string") {           // 直接把库里的原始字符串喂进来也要能判
    const t = raw.trim();
    if (!t) { out.all = true; return out; }
    try { raw = JSON.parse(t); } catch { out.malformed = true; out.denyAll = true; return out; }
  }
  if (raw === null || raw === undefined) { out.all = true; return out; }
  if (typeof raw !== "object" || Array.isArray(raw)) { out.malformed = true; out.denyAll = true; return out; }
  const list = raw.departments;
  if (list === null || list === undefined) { out.all = true; return out; }
  if (!Array.isArray(list)) { out.malformed = true; out.denyAll = true; return out; }
  if (list.length === 0) { out.all = true; return out; }
  const seen = new Map();
  for (const e of list) {
    let id = "", inc = false;
    if (typeof e === "string" || typeof e === "number") id = String(e).trim();
    else if (e && typeof e === "object" && !Array.isArray(e)) {
      id = e.id === null || e.id === undefined ? "" : String(e.id).trim();
      inc = !!e.includeChildren;
    }
    if (!id) continue;
    if (seen.has(id)) { if (inc) seen.get(id).includeChildren = true; continue; } // 同一部门两条：含下级取并集
    const item = { id, includeChildren: inc };
    seen.set(id, item);
    out.departments.push(item);
  }
  // 非空数组却一条 id 都没解析出来 = 自相矛盾的配置 → 关门，不退化全公司。
  if (!out.departments.length) { out.malformed = true; out.denyAll = true; return out; }
  return out;
}
// 子树展开：BFS + visited，**不写死深度**（今天实测最大深度 2，明天可能不是），
// 且对环形 parentId（a→b→a，或自己指自己）天然免疫 —— 每个 id 最多入队一次。
function scopeCollectSubtree(idx, rootId, includeChildren, names) {
  const root = idx.byId.get(rootId);
  if (!root) return;                      // 陈旧 id：不产出名称（也不退化全公司）
  names.add(root.name);
  if (!includeChildren) return;
  const seen = new Set([rootId]);
  const queue = [rootId];
  for (let i = 0; i < queue.length; i++) {
    for (const cid of idx.childrenOf.get(queue[i]) || []) {
      if (seen.has(cid)) continue;
      seen.add(cid);
      const c = idx.byId.get(cid);
      if (c) names.add(c.name);
      queue.push(cid);
    }
  }
}
// 内部：一次算出 { names, lower } 并按 epoch 缓存。null = 全公司（不过滤）。
function scopeSets(role) {
  const sc = parseScope(role);
  if (sc.all) return null;
  scopeCacheGate();
  const key = (role && role.id !== null && role.id !== undefined ? "r" + role.id : "anon") + "|" +
    (sc.denyAll ? "!" : JSON.stringify(sc.departments));
  const hit = SCOPE_NAME_CACHE.get(key);
  if (hit) return hit;
  const names = new Set(), lower = new Set();
  if (!sc.denyAll) {
    const idx = scopeDeptIndex();
    SCOPE_BUILDS++;
    for (const d of sc.departments) scopeCollectSubtree(idx, d.id, d.includeChildren, names);
    for (const n of names) lower.add(String(n).trim().toLowerCase());
  }
  const sets = { names, lower };
  SCOPE_NAME_CACHE.set(key, sets);
  return sets;
}
// 可见部门**名称集合**。null = 全公司（不过滤）；空 Set = 零可见。
// 给 SQL 用时记得 users.department 是名称：`WHERE department IN (...)`（或 lower() 比对，
// 与 scopeAllowsDepartment 的大小写不敏感口径一致）。**不要修改返回的 Set** —— 它是缓存本体。
function resolveScopeDepartmentNames(role) {
  const sets = scopeSets(role);
  return sets ? sets.names : null;
}
// 单个部门名是否在范围内。大小写/首尾空白不敏感（getDepartmentByName 也是 lower() 比对）。
// 部门名为空 → false（范围生效时「没有部门」不属于任何被授予的部门）。
function scopeAllowsDepartment(role, deptName) {
  const sets = scopeSets(role);
  if (!sets) return true;
  const n = deptName === null || deptName === undefined ? "" : String(deptName).trim().toLowerCase();
  if (!n) return false;
  return sets.lower.has(n);
}
// 单个员工是否在范围内。只看 users.department —— 主体判定的唯一依据（见清点文档 §0）。
function scopeAllowsUser(role, user) {
  if (!user) return false;
  return scopeAllowsDepartment(role, user.department);
}
// 缓存自曝（排障与测试用，和 instance introspection 一个路数）：key 是当前失效基线，
// roles 是已缓存的角色数，builds 是进程启动至今真正展开子树的次数。
function scopeCacheStats() {
  scopeCacheGate();
  return { key: SCOPE_CACHE_KEY, epoch: SCOPE_EPOCH, roles: SCOPE_NAME_CACHE.size, builds: SCOPE_BUILDS };
}
// ---------- instance & integrity introspection（商业化 P0：缓存闭环 / 自我暴露） ----------
// SQLite 的 PRAGMA data_version：同一连接自己读、自己写都不变，唯独**别的连接**提交
// 后 +1 —— 正是为跨进程失效造的信号。server.js 在每个 API 请求入口比对它，变了才重建
// 内存缓存；一条 PRAGMA 是内存读，微秒级。注意它对本连接的写不动 —— 服务端各写点手动
// 调 refreshContent() 的那套机制与此互补，一处都不能删。
function dataVersion() {
  return db.prepare("PRAGMA data_version").get().data_version;
}
// 这个库实际达到的 schema 版本（= 已应用迁移的最大编号）。排障第一问「你连的是哪个库、
// 什么版本」的后半个答案；前半个（哪个库）见 dbPath()。
function schemaVersion() {
  try { return db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get().v || 0; } catch { return 0; }
}
// 解析后的数据库绝对路径。server.js 用它算实例指纹（sha256 前 8 位放 /api/env）、
// 写 <db>.server.lock 护栏锁，/api/admin/instance 原样返回全路径（仅管理员可见）。
function dbPath() { return DB_PATH; }
// 引用完整性体检：绕过服务直写库的脚本（或手改库）最常见的后果就是悬空引用 ——
// 「课程库 3 门草稿但员工端在学第 4 门」那类灵异现象的数据形态。server 启动时跑一次
// 并通知管理员；GET /api/admin/integrity 按需重跑。
// 返回结构化 [{kind, count, sample:[前 3 个 id]}]：count 由 SQL 聚合，sample 用
// LIMIT 3 —— 就算库里躺着 3000 条悬空引用，也不会全捞进内存。
// 五个类目**永远都在**，干净库就是五行 count=0 —— 巡检和界面要能区分
// 「没查」和「查了没问题」，这两种在只报异常的输出里长得一模一样。
function checkReferences() {
  const out = [];
  const push = (kind, count, sample) => { out.push({ kind, count, sample }); };
  // assignments → program（content kind='program'）
  push("assignments→program",
    db.prepare("SELECT COUNT(*) AS n FROM assignments WHERE programId NOT IN (SELECT id FROM content WHERE kind = 'program')").get().n,
    db.prepare("SELECT DISTINCT programId AS id FROM assignments WHERE programId NOT IN (SELECT id FROM content WHERE kind = 'program') LIMIT 3").all().map((r) => r.id));
  // program.courseIds → course：课程引用埋在 program 的 JSON 文档里，只能解析着查。
  // program 数量是个位数到两位数，全量解析没有内存问题。
  {
    const courseIds = new Set(db.prepare("SELECT id FROM content WHERE kind = 'course'").all().map((r) => r.id));
    let n = 0; const sample = [];
    for (const r of db.prepare("SELECT id, json FROM content WHERE kind = 'program'").all()) {
      let p; try { p = JSON.parse(r.json); } catch { continue; }
      for (const cid of p.courseIds || []) {
        if (courseIds.has(cid)) continue;
        n++;
        if (sample.length < 3) sample.push(r.id + "→" + cid);
      }
    }
    push("program.courseIds→course", n, sample);
  }
  // exams 的课程池 → course（关联表 exam_courses）
  push("exam_courses.courseId→course",
    db.prepare("SELECT COUNT(*) AS n FROM exam_courses WHERE courseId NOT IN (SELECT id FROM content WHERE kind = 'course')").get().n,
    db.prepare("SELECT examId || '→' || courseId AS id FROM exam_courses WHERE courseId NOT IN (SELECT id FROM content WHERE kind = 'course') LIMIT 3").all().map((r) => r.id));
  // attempts.examId → exam（examId 为 NULL 的历史行不算悬空 —— 迁移 7 之前就没有这列）
  push("attempts.examId→exam",
    db.prepare("SELECT COUNT(*) AS n FROM attempts WHERE examId IS NOT NULL AND examId NOT IN (SELECT id FROM exams)").get().n,
    db.prepare("SELECT id FROM attempts WHERE examId IS NOT NULL AND examId NOT IN (SELECT id FROM exams) LIMIT 3").all().map((r) => r.id));
  // review_items.cycleId → review_cycles
  push("review_items.cycleId→cycle",
    db.prepare("SELECT COUNT(*) AS n FROM review_items WHERE cycleId NOT IN (SELECT id FROM review_cycles)").get().n,
    db.prepare("SELECT id FROM review_items WHERE cycleId NOT IN (SELECT id FROM review_cycles) LIMIT 3").all().map((r) => r.id));
  return out;
}

// Checkpoint the WAL into the main db file and close cleanly on shutdown.
function close() {
  try { db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); } catch {}
  try { db.close(); } catch {}
}

/* ---------- AI 治理（迁移 58；NEXT-WORK/specs/03-ai-governance-spec.md 2.3–2.6） ----------
   ai_calls / ai_notice_acks 归 core（审计），talent_portraits 归 talent。三张表都不存任何发给 AI 或 AI 回复的原文：
   ai_calls 只有元数据与用量；画像的正文是经 HR 审阅的业务结果，丢弃或到期失效时清空。 */
const AI_CALL_COLS = ["createdAt", "requestId", "actorId", "actorKind", "feature", "subjectUserId", "refId", "providerId", "protocol", "endpointHost",
  "configHash", "modelRequested", "modelReturned", "promptVersion", "status", "errorCode", "httpStatus", "attempts", "latencyMs",
  "inChars", "outChars", "inTokens", "outTokens", "tokensEstimated", "redactions"];
function addAiCall(c) {
  const row = { createdAt: new Date().toISOString(), attempts: 1, tokensEstimated: 0, ...c };
  if (row.redactions && typeof row.redactions === "object") row.redactions = Object.keys(row.redactions).length ? JSON.stringify(row.redactions) : null;
  const vals = AI_CALL_COLS.map((k) => (row[k] === undefined ? null : row[k]));
  const r = db.prepare(`INSERT INTO ai_calls (${AI_CALL_COLS.join(", ")}) VALUES (${AI_CALL_COLS.map(() => "?").join(", ")})`).run(...vals);
  return Number(r.lastInsertRowid);
}
function getAiCall(id) {
  return db.prepare("SELECT * FROM ai_calls WHERE id = ?").get(Number(id)) || null;
}
function setAiCallRef(id, refId) {
  db.prepare("UPDATE ai_calls SET refId = ? WHERE id = ?").run(refId == null ? null : String(refId), Number(id));
}
// 列表（治理页与 CSV 共用；范围过滤在 server.js 按行做）。按 id 倒序。
function listAiCalls({ from, to, feature, status, actorId } = {}) {
  const where = [], args = [];
  if (from) { where.push("createdAt >= ?"); args.push(from); }
  if (to) { where.push("createdAt < ?"); args.push(to); }
  if (feature) { where.push("feature = ?"); args.push(feature); }
  if (status) { where.push("status = ?"); args.push(status); }
  if (actorId) { where.push("actorId = ?"); args.push(actorId); }
  return db.prepare(`SELECT * FROM ai_calls${where.length ? " WHERE " + where.join(" AND ") : ""} ORDER BY id DESC`).all(...args);
}
// 用量汇总：按功能统计次数、失败次数与 token（输入 + 输出）
function aiUsageBetween(from, to) {
  return db.prepare(
    `SELECT feature, COUNT(*) AS calls, SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS errors,
            SUM(CASE WHEN status = 'demo' THEN 1 ELSE 0 END) AS demo,
            COALESCE(SUM(inTokens), 0) AS inTokens, COALESCE(SUM(outTokens), 0) AS outTokens
       FROM ai_calls WHERE createdAt >= ? AND createdAt < ? GROUP BY feature ORDER BY feature`
  ).all(from, to);
}
function aiTokensBetween(from, to) {
  const r = db.prepare("SELECT COALESCE(SUM(inTokens), 0) + COALESCE(SUM(outTokens), 0) AS n FROM ai_calls WHERE createdAt >= ? AND createdAt < ?").get(from, to);
  return Number(r.n) || 0;
}
function aiCallsExist() {
  return !!db.prepare("SELECT 1 FROM ai_calls LIMIT 1").get();
}
// 保留期清理（每日一次）：按功能删掉早于 before 的记录；grading / portrait 另按业务对象清理（见下一个函数）
function pruneAiCalls(feature, before) {
  return db.prepare("DELETE FROM ai_calls WHERE feature = ? AND createdAt < ?").run(feature, before).changes;
}
// grading / portrait 的调用记录随业务对象保留：对应答卷或画像已删除的，一并删除
function pruneOrphanAiCalls() {
  const a = db.prepare("DELETE FROM ai_calls WHERE feature = 'grading' AND refId IS NOT NULL AND refId NOT IN (SELECT id FROM attempts)").run().changes;
  const b = db.prepare("DELETE FROM ai_calls WHERE feature = 'portrait' AND refId IS NOT NULL AND refId NOT IN (SELECT id FROM talent_portraits)").run().changes;
  return a + b;
}
function ackAiNotice(userId, notice, version) {
  db.prepare("INSERT OR IGNORE INTO ai_notice_acks (userId, notice, version, ackedAt) VALUES (?, ?, ?, ?)").run(userId, notice, Number(version), new Date().toISOString());
}
function aiNoticeAcked(userId, notice, version) {
  return !!db.prepare("SELECT 1 FROM ai_notice_acks WHERE userId = ? AND notice = ? AND version = ?").get(userId, notice, Number(version));
}

const PORTRAIT_COLS = ["id", "userId", "status", "content", "unsupportedCount", "providerId", "protocol", "model", "modelReturned", "promptVersion", "callId",
  "inputDigest", "demo", "generatedBy", "generatedAt", "confirmedBy", "confirmedAt", "discardedBy", "discardedAt", "discardReason", "objections"];
function rowToPortrait(r) {
  if (!r) return null;
  const parse = (v, d) => { try { return v ? JSON.parse(v) : d; } catch { return d; } };
  return { ...r, content: parse(r.content, null), objections: parse(r.objections, []), demo: !!r.demo, unsupportedCount: r.unsupportedCount || 0 };
}
function createPortrait(p) {
  const row = { unsupportedCount: 0, demo: 0, ...p };
  row.content = row.content == null ? null : JSON.stringify(row.content);
  row.objections = JSON.stringify(row.objections || []);
  row.demo = row.demo ? 1 : 0;
  db.prepare(`INSERT INTO talent_portraits (${PORTRAIT_COLS.join(", ")}) VALUES (${PORTRAIT_COLS.map(() => "?").join(", ")})`).run(...PORTRAIT_COLS.map((k) => (row[k] === undefined ? null : row[k])));
  return getPortrait(row.id);
}
function getPortrait(id) {
  return rowToPortrait(db.prepare("SELECT * FROM talent_portraits WHERE id = ?").get(String(id)));
}
function listPortraits(userId) {
  return db.prepare("SELECT * FROM talent_portraits WHERE userId = ? ORDER BY generatedAt DESC").all(userId).map(rowToPortrait);
}
const PORTRAIT_UPDATABLE = new Set(["status", "content", "unsupportedCount", "confirmedBy", "confirmedAt", "discardedBy", "discardedAt", "discardReason", "objections"]);
function updatePortrait(id, fields) {
  const keys = Object.keys(fields).filter((k) => PORTRAIT_UPDATABLE.has(k));
  if (!keys.length) return getPortrait(id);
  const vals = keys.map((k) => (k === "content" || k === "objections" ? (fields[k] == null ? null : JSON.stringify(fields[k])) : fields[k]));
  db.prepare(`UPDATE talent_portraits SET ${keys.map((k) => k + " = ?").join(", ")} WHERE id = ?`).run(...vals, String(id));
  return getPortrait(id);
}
// 确认新版本时：该员工此前的已确认版本变为 superseded（保留正文）
function supersedeConfirmedPortraits(userId, exceptId) {
  return db.prepare("UPDATE talent_portraits SET status = 'superseded' WHERE userId = ? AND status = 'confirmed' AND id != ?").run(userId, exceptId).changes;
}
// 每人保留最近 keep 个已确认或被替代的版本，更早的删除
function prunePortraitHistory(userId, keep) {
  const rows = db.prepare("SELECT id FROM talent_portraits WHERE userId = ? AND status IN ('confirmed','superseded') ORDER BY COALESCE(confirmedAt, generatedAt) DESC").all(userId);
  let n = 0;
  for (const r of rows.slice(keep)) n += db.prepare("DELETE FROM talent_portraits WHERE id = ?").run(r.id).changes;
  return n;
}
// 学习助手判断「考试进行中」用：该员工所有未交卷的答卷
function listOpenAttemptsForUser(userId) {
  return db.prepare("SELECT * FROM attempts WHERE userId = ? AND submittedAt IS NULL").all(userId).map(rowToAttempt);
}
// 评分队列取题库里的中文评分标准用
function getQuestion(id) {
  return rowToQuestion(db.prepare("SELECT * FROM questions WHERE id = ?").get(String(id)));
}
function listPortraitDraftsBefore(before) {
  return db.prepare("SELECT * FROM talent_portraits WHERE status = 'draft' AND generatedAt < ?").all(before).map(rowToPortrait);
}
function listPortraitUserIds() {
  return db.prepare("SELECT DISTINCT userId FROM talent_portraits").all().map((r) => r.userId);
}
function deletePortraitsForUser(userId) {
  return db.prepare("DELETE FROM talent_portraits WHERE userId = ?").run(userId).changes;
}


// ---------- 组织绩效（迁移 95，负责人 2026-10-10）----------
const opRound = (r) => (r ? { ...r, issueRequired: !!r.issueRequired, dims: (() => { try { return JSON.parse(r.dims); } catch { return []; } })() } : null);
function createOrgRound({ id, quarter, name, dueOn, dims, createdBy, issueRequired }) {
  db.prepare("INSERT INTO orgperf_rounds (id, quarter, name, status, dueOn, dims, createdBy, createdAt, issueRequired) VALUES (?, ?, ?, 'draft', ?, ?, ?, ?, ?)")
    .run(id, quarter, name, dueOn || null, JSON.stringify(dims || []), createdBy || null, new Date().toISOString(), issueRequired ? 1 : 0);
  return getOrgRound(id);
}
function getOrgRound(id) { return opRound(db.prepare("SELECT * FROM orgperf_rounds WHERE id = ?").get(String(id))); }
function listOrgRounds() { return db.prepare("SELECT * FROM orgperf_rounds ORDER BY quarter DESC, createdAt DESC").all().map(opRound); }
function updateOrgRound(id, fields) {
  const allowed = ["name", "status", "dueOn", "openedAt", "closedAt", "issueRequired", "publishedAt"];
  const keys = Object.keys(fields || {}).filter((k) => allowed.includes(k));
  if (!keys.length) return getOrgRound(id);
  if (keys.includes("issueRequired")) fields = { ...fields, issueRequired: fields.issueRequired ? 1 : 0 };
  db.prepare(`UPDATE orgperf_rounds SET ${keys.map((k) => k + " = ?").join(", ")} WHERE id = ?`).run(...keys.map((k) => fields[k] == null ? null : fields[k]), String(id));
  return getOrgRound(id);
}
function deleteOrgRound(id) {
  for (const t of ["orgperf_answers", "orgperf_raters", "orgperf_targets"]) db.prepare(`DELETE FROM ${t} WHERE roundId = ?`).run(String(id));
  db.prepare("DELETE FROM orgperf_rounds WHERE id = ?").run(String(id));
}
// 开轮时写快照：targets = [{ dept1Id, dept1 }]，raters = [{ dept1Id, raterId }]
function setOrgRoundSnapshot(roundId, targets, raters) {
  db.prepare("DELETE FROM orgperf_targets WHERE roundId = ?").run(roundId);
  db.prepare("DELETE FROM orgperf_raters WHERE roundId = ?").run(roundId);
  const t = db.prepare("INSERT INTO orgperf_targets (roundId, dept1Id, dept1) VALUES (?, ?, ?)");
  for (const x of targets || []) t.run(roundId, x.dept1Id, x.dept1 || null);
  const r = db.prepare("INSERT INTO orgperf_raters (roundId, dept1Id, raterId) VALUES (?, ?, ?)");
  for (const x of raters || []) r.run(roundId, x.dept1Id, x.raterId);
}
function listOrgTargets(roundId) { return db.prepare("SELECT * FROM orgperf_targets WHERE roundId = ? ORDER BY dept1").all(String(roundId)); }
function listOrgRaters(roundId) { return db.prepare("SELECT * FROM orgperf_raters WHERE roundId = ?").all(String(roundId)); }
function listOrgRatersOfUser(userId) { return db.prepare("SELECT * FROM orgperf_raters WHERE raterId = ?").all(String(userId)); }
function updateOrgRater(roundId, dept1Id, fields) {
  const allowed = ["submittedAt", "remindedAt"];
  const keys = Object.keys(fields || {}).filter((k) => allowed.includes(k));
  if (!keys.length) return;
  db.prepare(`UPDATE orgperf_raters SET ${keys.map((k) => k + " = ?").join(", ")} WHERE roundId = ? AND dept1Id = ?`).run(...keys.map((k) => fields[k] == null ? null : fields[k]), String(roundId), String(dept1Id));
}
const opAns = (a) => ({ ...a, scores: (() => { try { return JSON.parse(a.scores); } catch { return {}; } })() });
function listOrgAnswers(roundId) { return db.prepare("SELECT * FROM orgperf_answers WHERE roundId = ?").all(String(roundId)).map(opAns); }
function listOrgAnswersOf(roundId, raterDept1Id) { return db.prepare("SELECT * FROM orgperf_answers WHERE roundId = ? AND raterDept1Id = ?").all(String(roundId), String(raterDept1Id)).map(opAns); }
function upsertOrgAnswer({ roundId, raterDept1Id, targetDept1Id, scores, issue }) {
  db.prepare(`INSERT INTO orgperf_answers (roundId, raterDept1Id, targetDept1Id, scores, issue, updatedAt) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(roundId, raterDept1Id, targetDept1Id) DO UPDATE SET scores = excluded.scores, issue = excluded.issue, updatedAt = excluded.updatedAt`)
    .run(roundId, raterDept1Id, targetDept1Id, JSON.stringify(scores || {}), issue || null, new Date().toISOString());
}
function listOrgResults(quarter) {
  return quarter ? db.prepare("SELECT * FROM orgperf_results WHERE quarter = ? ORDER BY dept1").all(String(quarter))
    : db.prepare("SELECT * FROM orgperf_results ORDER BY quarter DESC, dept1").all();
}
function getOrgResult(quarter, dept1Id) { return db.prepare("SELECT * FROM orgperf_results WHERE quarter = ? AND dept1Id = ?").get(String(quarter), String(dept1Id)) || null; }
function upsertOrgResult(r) {
  db.prepare(`INSERT INTO orgperf_results (quarter, dept1Id, dept1, rating, note, hodId, recordId, importedBy, importedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(quarter, dept1Id) DO UPDATE SET dept1 = excluded.dept1, rating = excluded.rating, note = excluded.note, hodId = excluded.hodId, recordId = excluded.recordId, importedBy = excluded.importedBy, importedAt = excluded.importedAt`)
    .run(r.quarter, r.dept1Id, r.dept1 || null, r.rating, r.note || null, r.hodId || null, r.recordId || null, r.importedBy || null, new Date().toISOString());
  return getOrgResult(r.quarter, r.dept1Id);
}

module.exports = {
  listManagedReviewItems,   // 绩效看板第一期
  // 组织绩效（迁移 95）
  createOrgRound, getOrgRound, listOrgRounds, updateOrgRound, deleteOrgRound, setOrgRoundSnapshot, listOrgTargets, listOrgRaters, listOrgRatersOfUser,
  updateOrgRater, listOrgAnswers, listOrgAnswersOf, upsertOrgAnswer, listOrgResults, getOrgResult, upsertOrgResult,
  memberCohortLog,   // CX-028：期次轨迹（迁移 66），期次成员表可查
  contentUpdatedAt,  // CX-042：课程编辑乐观锁
  init, isProduction,
  getUserByEmployeeId, getUserById, listUsers, employeeIdExists, createUser, updateUser, setUserPassword, setLastLogin,
  transaction, inTransaction, resetUserPasswordAndSessions,
  setEventSink, recordEventDispatch,
  // 第二段：模块迁移、受限数据库接口、提交后回调、事件发布入口（CONTRACT.md 第 4、8 节）
  runModuleMigrations, moduleMigrationSha256, moduleDb, checkModuleSql, checkModuleSqlPlan, sqlTokens, afterCommit, publishEvent,
  getUserByLarkId, setUserLarkId,
  listRoles, getRole, getRoleByKey, createRole, updateRole, deleteRole, roleMemberCount,
  setUserAdminRole, superAdminRoleId, countActiveSuperAdmins,
  parseScope, resolveScopeDepartmentNames, scopeAllowsDepartment, scopeAllowsUser, scopeCacheStats,
  countByDepartment, renameDepartment, clearDepartment,
  listSecondaryLines, listSecondaryReports, listAllSecondaryLines, getSecondaryLine,
  listAppealsForAttempts, listAppealsByUser, getAppeal, getOpenAppeal, countOpenAppeals,
  addAppeal, resolveAppeal,
  addSecondaryLine, deleteSecondaryLine, deleteSecondaryLinesForUser,
  createSession, getSessionUser, deleteUserSessions, deleteOtherSessions, deleteSession, cleanupExpiredSessions,
  createPasswordReset, getPasswordResetByHash, markPasswordResetUsed, deleteUnusedPasswordResets, prunePasswordResets,
  getCourseProgress, setModuleComplete,
  getUserAssignments, setAssignment, removeAssignment, countProgramAssignees, countCourseProgressUsers,
  // 第四批 7 公开课程 / 自主学习（迁移 74）
  selfEnroll, removeSelfEnrollment, listSelfEnrollments,
  createApproval, getApproval, listApprovals, countApprovals, listApprovalsFor, decideApproval,
  addProjectMember, listProjectMembers, countActivityStates, deleteProjectMembersFor, getUserMemberships, listUserMemberships, withdrawProjectMember, moveProjectMember,
  setActivityState, listActivityStates, getUserActivityStates, getUserStatesForActivities, deleteActivityState, getActivityState, getCheckinSecret,
  createEnrollmentRequest, getEnrollmentRequest, listPendingRequests, countPendingRequests, listUserRequests, getUserRequestMap, decideEnrollmentRequest,
  createNotification, listNotifications, countUnreadNotifications, markNotificationsRead, hasNotificationSince, hasNotificationTypeSince, hasNotificationLinkSince,
  createAttachment, getAttachment, listAllAttachments, updateAttachment, convertAttachmentToPdf,
  createOwnedAttachment, bindAttachmentOwner, listAttachmentsByOwner, countUnboundAttachments,
  // 第三批 5.7 课件内视频（迁移 72）
  createAttachmentMedia, listAttachmentMedia, getAttachmentMedia, updateAttachmentMedia, claimAttachmentMedia,
  resetTranscodingMedia, countAttachmentMediaByStatus, listMediaFileKeys, deleteAttachmentMedia,
  // 第三批 1.4 培训概览快照的整表读取
  listAllProgress, listActivityStatesByProject, listAllAssignments, listSubmittedAttemptsLite,
  addAudit, listAudit, countAudit, listAuditByTargets, listAuditByTargetsAny, auditHasSelfSensitive, snapshotContent,
  listContent, putContent, deleteContent,
  listExams, listProgramExams, getExam, createExam, updateExam, getExamCourseIds, setExamCourses,
  createAttempt, getAttempt, getOpenAttempt, discardOpenAttempts, saveAttemptDraft, submitAttempt, updateAttemptGrading, bestAttempt, listSubmittedAttempts, listUserAttempts,
  listAttemptsByGradingStatus, pendingExamAttempt,
  listUserExamAttempts, bestExamAttempt, listExamAttempts, voidUserExamAttempts, clearCourseProgress,
  listQuestions, addQuestion, deleteQuestion, updateQuestion,
  updateQuestionPoints, updateQuestionPlacement, getQuestionBrief, countQuestionsByCourseType,
  createTalentRecord, getTalentRecord, updateTalentRecord, deleteTalentRecord, listTalentRecords, talentRecordExists, addTalentRecordOnce,
  listTalentRecordsByType, listProgramBestScores, listDistinctUserField,
  listRecordTypes, getRecordType, upsertRecordType, deleteRecordType,
  listRecordFields, getRecordField, nextRecordFieldId, upsertRecordField, deleteRecordField,
  listDepartments, getDepartmentByName, ensureDepartment, updateDepartment, countUsersInDepartment, deleteDepartment, departmentWouldCycle,
  createReviewCycle, getReviewCycle, listReviewCycles, closeReviewCycle, setReviewCycleResultsAt,
  // 第二批 2.8 绩效申诉与 HRBP 分工（迁移 70）
  listHrbpAssignments, listHrbpDeptIdsOfUser, replaceDeptHrbps, replaceUserHrbpDepts,
  getReviewAppeal, getReviewAppealByItem, getReviewAppealByRecord, mapReviewAppealsByItems, listReviewAppeals, listOpenReviewAppeals,
  createReviewAppeal, transitionReviewAppeal, setReviewAppealMarker, addReviewAppealConflicts, setReviewAppealCategory,
  createReviewAppealConsult, getReviewAppealConsult, listReviewAppealConsults, listReviewAppealConsultsFor, answerReviewAppealConsult, countReviewAppealConsultsFor,
  addReviewAppealEvent, listReviewAppealEvents, hasReviewAppealEvent,
  deleteReviewCycle, setReviewCycleDue, countReviewCycleProgress,
  addReviewItem, addReviewItemsBulk, getReviewItem, listCycleItems, listMyReviewItems, listTeamReviewItems, updateReviewItem, latestClosedReviewGoals, listCycleArchivedRecords, getReviewItemByRecordId, mapReviewItemsByRecordIds,
  setReviewCycleDates, getReviewDeptStatus, listReviewDeptStatus, upsertReviewDeptStatus, listMyClosedReviewItems, listOpenCycleItems,
  addSuccession, listSuccession, getSuccession, updateSuccession, deleteSuccession,
  // 12.2 工作台：关键岗位清单、受控人才标签、快照（迁移 86 / 87）
  listKeyPositions, getKeyPosition, getKeyPositionByKey, createKeyPosition, updateKeyPosition, deleteKeyPosition,
  setControlledTag, listTagEvents, listAllTagEvents,
  replaceWorkbenchSnapshots, listWorkbenchSnapshots, hasWorkbenchSnapshots, pruneWorkbenchSnapshots, firstWorkbenchSnapshotDay,
  // 第五批 8.1 人才筛选（迁移 80 / 81）
  listTalentFilters, getTalentFilter, getTalentFilterByKey, createTalentFilter, updateTalentFilter, deleteTalentFilter,
  listTalentFilterMembers, setTalentFilterMember, removeTalentFilterMember,
  getMeta, setMeta,
  // AI 治理（迁移 58）
  addAiCall, getAiCall, setAiCallRef, listAiCalls, aiUsageBetween, aiTokensBetween, aiCallsExist, pruneAiCalls, pruneOrphanAiCalls,
  ackAiNotice, aiNoticeAcked,
  createPortrait, getPortrait, listPortraits, updatePortrait, supersedeConfirmedPortraits, prunePortraitHistory,
  listPortraitDraftsBefore, listPortraitUserIds, deletePortraitsForUser, listOpenAttemptsForUser, getQuestion,
  dataVersion, schemaVersion, dbPath, checkReferences,
  close,
};
