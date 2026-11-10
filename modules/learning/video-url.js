// 课程小节外链视频地址（CX-033 / CX-034 / CX-035，2026-10-09 上线验收）。纯函数，server.js 保存课程时调用。
//   kind = "embed"：允许嵌入的站点页面（YouTube 自动换成 /embed/ 地址；其余按来源白名单：缺省清单 + config.json 的 videoEmbedHosts）
//   kind = "file" ：视频文件直链（.mp4 / .webm / .m3u8 / .mov / .ogg），员工端用带水印的播放器播放，不走 iframe
//   kind = null   ：不接受 —— reason = not_http（不是 http(s) 地址）| host_not_allowed（来源不在白名单）
"use strict";

const DEFAULT_EMBED_HOSTS = [
  "youtube.com", "youtube-nocookie.com", "youtu.be",
  "vimeo.com", "player.vimeo.com",
  "bilibili.com", "player.bilibili.com",
];
const FILE_EXT = /\.(mp4|webm|m3u8|mov|ogg)$/i;

function hostAllowed(host, allowed) {
  const h = String(host || "").toLowerCase();
  return allowed.some((a) => {
    const x = String(a || "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
    return x && (h === x || h.endsWith("." + x));
  });
}

function classifyVideoUrl(raw, extraHosts) {
  const v = String(raw || "").trim();
  if (!v) return { kind: null, url: null, reason: "empty" };
  if (!/^https?:\/\//i.test(v)) return { kind: null, url: v, reason: "not_http" };
  let u;
  try { u = new URL(v); } catch { return { kind: null, url: v, reason: "not_http" }; }
  const host = u.hostname.toLowerCase();
  // YouTube：watch / shorts / youtu.be / embed → 统一成 /embed/<id>
  let m = v.match(/(?:youtube\.com\/watch\?(?:.*&)?v=|youtu\.be\/)([\w-]{6,})/i) || v.match(/youtube(?:-nocookie)?\.com\/(?:embed|shorts)\/([\w-]{6,})/i);
  if (m) return { kind: "embed", url: `https://www.youtube.com/embed/${m[1]}`, host: "www.youtube.com" };
  if (FILE_EXT.test(u.pathname)) return { kind: "file", url: v, host };
  const allowed = DEFAULT_EMBED_HOSTS.concat(Array.isArray(extraHosts) ? extraHosts : []);
  if (hostAllowed(host, allowed)) return { kind: "embed", url: v, host };
  return { kind: null, url: v, host, reason: "host_not_allowed" };
}

module.exports = { DEFAULT_EMBED_HOSTS, classifyVideoUrl };
