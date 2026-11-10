// 课程包导出 / 导入（CX-032，负责人 2026-10-09 拍板「仍在范围」）。纯函数，不碰存储；路由在 server.js
// GET /api/admin/content/courses/:id/export 与 POST /api/admin/content/courses/import。
//
// 课程包 = 一个 JSON 文件：{ format: "tms-course", version: 1, exportedAt, course: {...}, attachments: [...] }。
//   course：标题 / 简介（中英）、类别、修读类型、授课方式与线下信息、学时、默认完成天数、模块（中英名、时长）、
//           小节（中英标题、中英正文 HTML、课件内视频 id、外链视频、附件清单）。不含 id、状态、公开标记、讲师、指派。
//   attachments：附件清单（名称、类型、大小、所在模块 / 小节），只是清单 —— 文件本身不在包里。
// 导入：生成新课程 id 与模块 id，状态一律草稿、不公开、不带讲师；附件与课件内视频在目标库里不存在，一律去掉并在
// 结果里报 attachmentsDropped 人工补传。标题可在导入时改（同名课程允许并存，前端会先提示改名）。
// 坏文件（不是对象、format / version 不对、course 不是对象、模块不是数组…）一律 400 bad_package，不写库。
"use strict";

const FORMAT = "tms-course";   // 不带品牌名：构建产物须品牌中立（test/brand.test.js）
const VERSION = 1;
const MAX_MODULES = 200;
const MAX_SECTIONS = 200;

const str = (v, max) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const orNull = (s) => (s ? s : null);

// 课程文档（content 表里的 course json）→ 课程包
function packCourse(c, attachmentsOfCourse, now) {
  const attIndex = new Map((attachmentsOfCourse || []).map((a) => [a.id, a]));
  const attachments = [];
  const modules = (c.modules || []).map((m, mi) => ({
    title: m.title || "",
    title_zh: m.title_zh || null,
    minutes: Number(m.minutes) || 10,
    sections: (m.sections || []).map((s, si) => {
      const atts = (s.attachments || []).map((x) => {
        const a = attIndex.get(x.id);
        const row = { name: (a && a.originalName) || x.name || "", kind: (a && a.kind) || x.kind || null, size: (a && a.size) || x.size || null, module: mi + 1, section: si + 1 };
        attachments.push(row);
        return { name: row.name, kind: row.kind, size: row.size };
      });
      return {
        heading: s.heading || "",
        heading_zh: s.heading_zh || null,
        html: s.html || "",
        html_zh: s.html_zh || null,
        videoEmbed: s.videoEmbed || null,
        video: s.video ? true : false,   // 课件内视频只记「有」，文件不在包里
        attachments: atts,
      };
    }),
  }));
  return {
    format: FORMAT,
    version: VERSION,
    exportedAt: now || new Date().toISOString(),
    course: {
      title: c.title || "",
      title_zh: c.title_zh || null,
      description: c.description || null,
      description_zh: c.description_zh || null,
      category: c.category || null,
      enrollType: c.enrollType || "mandatory",
      mode: c.mode || "online",
      sessionAt: c.sessionAt || null,
      location: c.location || null,
      sessionNote: c.sessionNote || null,
      hours: typeof c.hours === "number" ? c.hours : null,
      defaultDueDays: c.defaultDueDays || 30,
      modules,
    },
    attachments,
  };
}

function bad(code, en, zh) { return { ok: false, code, error: en, error_zh: zh }; }

// 课程包（请求体）→ 可直接走 PUT /api/admin/content/courses/:id 清洗的课程文档
// opts: { newId, moduleId(i), title, title_zh }（title / title_zh 为导入时改的名字，可选）
function unpackCourse(pkg, opts) {
  const o = opts || {};
  if (!pkg || typeof pkg !== "object" || Array.isArray(pkg))
    return bad("bad_package", "This file is not a course package.", "这不是课程包文件。");
  if (pkg.format !== FORMAT || Number(pkg.version) !== VERSION)
    return bad("bad_package", "Unsupported course package format.", "课程包格式不受支持。");
  const src = pkg.course;
  if (!src || typeof src !== "object" || Array.isArray(src) || !Array.isArray(src.modules))
    return bad("bad_package", "The course package is damaged (course or modules missing).", "课程包已损坏（缺少课程或模块）。");
  if (src.modules.length > MAX_MODULES)
    return bad("bad_package", `Too many modules (max ${MAX_MODULES}).`, `模块过多（最多 ${MAX_MODULES} 个）。`);
  const title = str(o.title != null ? o.title : src.title, 120);
  const title_zh = str(o.title_zh != null ? o.title_zh : src.title_zh, 120);
  if (!title && !title_zh)
    return bad("bad_package", "The course package has no title.", "课程包没有课程名称。");
  let dropped = 0;
  const modules = [];
  for (let i = 0; i < src.modules.length; i++) {
    const m = src.modules[i];
    if (!m || typeof m !== "object" || !Array.isArray(m.sections))
      return bad("bad_package", `Module ${i + 1} is damaged.`, `第 ${i + 1} 个模块已损坏。`);
    if (m.sections.length > MAX_SECTIONS)
      return bad("bad_package", `Module ${i + 1} has too many sections (max ${MAX_SECTIONS}).`, `第 ${i + 1} 个模块小节过多（最多 ${MAX_SECTIONS} 个）。`);
    const mt = str(m.title, 120), mz = str(m.title_zh, 120);
    if (!mt && !mz) return bad("bad_package", `Module ${i + 1} has no name.`, `第 ${i + 1} 个模块没有名称。`);
    const sections = [];
    for (let j = 0; j < m.sections.length; j++) {
      const s = m.sections[j];
      if (!s || typeof s !== "object")
        return bad("bad_package", `Section ${j + 1} of module ${i + 1} is damaged.`, `第 ${i + 1} 个模块的第 ${j + 1} 个小节已损坏。`);
      dropped += (Array.isArray(s.attachments) ? s.attachments.length : 0) + (s.video ? 1 : 0);
      sections.push({
        heading: str(s.heading, 200),
        heading_zh: orNull(str(s.heading_zh, 200)),
        html: typeof s.html === "string" ? s.html : "",
        html_zh: typeof s.html_zh === "string" && s.html_zh ? s.html_zh : null,
        video: null,
        videoEmbed: orNull(str(s.videoEmbed, 2000)),
        attachments: [],
      });
    }
    modules.push({ id: o.moduleId ? o.moduleId(i) : `m-${i + 1}`, title: mt, title_zh: orNull(mz), minutes: Math.min(600, Math.max(1, Number(m.minutes) || 10)), sections });
  }
  const course = {
    id: o.newId,
    programId: null,
    title, title_zh: orNull(title_zh),
    description: orNull(str(src.description, 1000)),
    description_zh: orNull(str(src.description_zh, 1000)),
    category: orNull(str(src.category, 60)),
    enrollType: src.enrollType === "elective" ? "elective" : "mandatory",
    status: "draft",
    public: false,
    defaultDueDays: Math.min(365, Math.max(1, Number(src.defaultDueDays) || 30)),
    mode: src.mode === "offline" ? "offline" : "online",
    sessionAt: orNull(str(src.sessionAt, 16)),
    location: orNull(str(src.location, 200)),
    sessionNote: orNull(str(src.sessionNote, 500)),
    trainerId: null,
    modules,
  };
  if (src.hours != null && src.hours !== "" && Number.isFinite(Number(src.hours))) course.hours = Number(src.hours);
  return { ok: true, course, attachmentsDropped: dropped };
}

module.exports = { FORMAT, VERSION, packCourse, unpackCourse };
