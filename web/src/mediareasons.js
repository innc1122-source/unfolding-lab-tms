// 课件内视频（第三批 5.7，2026-10-08；设计 b3-design §13.4 / §13.6 / §13.7）：转码状态、失败原因与「哪一段视频」的行文，
// 课程编辑器（Content.jsx）与课件转换页（OfficeConvertSheet.jsx）共用，两处说法一致。
//
//   mediaText(lang)                          本文件的词典（状态、转码组件状态、提示）
//   reasonText(reason, lang, { ext, minutes }) 失败 / 跳过原因 → 一句话；未知原因原样返回
//   slidesText(slides, lang)                 [{ slideNo, pageNo }] → 「第 4、9 页」/「slides 4, 9」；只在隐藏页上 → 「隐藏页」
//   mediaLine(item, lang, { deck })          「{deck}」第 {slide} 页「{name}」：{原因} —— 通知、审计、后台表格同一格式
//   hostOf(url)                              外链只显示域名
//   mediaSummaryOf(items)                    items → { total, ready, pending, transcoding, failed, external, skipped }
// 「页」用幻灯片编号（slideNo，HR 在 PowerPoint 里找得到的那个）；学员端用转换后的页码，那是 PdfViewer 的事。

const T = {
  zh: {
    st: { pending: '等待转码', transcoding: '转码中', ready: '已就绪', failed: '失败', external: '外部链接', skipped: '已跳过' },
    vst: { ok: '可用', missing: '未安装', disabled: '已停用', no_encoder: '缺少编码器' },
    reason: {
      unavailable: '服务器未安装视频转码组件（ffmpeg），装好后会自动转码',
      no_encoder: '已安装的 ffmpeg 缺少 H.264 / AAC 编码器',
      timeout: (m) => `转码超时（超过 ${m} 分钟）`,
      error: '视频文件已损坏或格式无法识别',
      no_mp4: '转码没有生成可播放的文件',
      source_missing: '原始视频文件丢失，请重新上传课件',
      too_large: '视频超过 500 MB 上限',
      too_long: '视频时长超过 4 小时上限',
      unsupported_format: (ext) => `不支持的视频格式（.${ext}）`,
      unreadable: '无法从 PPT 中读取这段视频，请把视频另存为 MP4，作为小节视频上传',
      linked_file: '视频只是链接到电脑上的文件，没有嵌入 PPT；请在 PowerPoint 中改为嵌入后重新上传',
      hidden_slide: '视频在隐藏的幻灯片上，学员看不到，已跳过',
      audio_not_supported: '音频暂不随课件播放，已跳过',
      too_many_media: '一份课件最多处理 50 段视频，其余已跳过',
      cancelled: '转码已取消（服务重启），会自动重新排队',
      disk_full: '服务器磁盘空间不足，这段视频没有保存；请联系 IT 清理空间后重新上传课件',
      storage_limit: '等待转码的视频已达存储上限，这段视频没有保存；请在已有视频转码完成后重新上传课件',
      ppt_binary: '旧版 .ppt 无法提取视频，请另存为 .pptx 后重新上传',
    },
    slides: (list) => `第 ${list} 页`,
    slideSep: '、',
    hidden: '隐藏页',
    line: (deck, slides, name, why) => `「${deck}」${slides}「${name}」：${why}`,
    lineNoDeck: (slides, name, why) => `${slides}「${name}」：${why}`,
    external: (host) => `外部链接 ${host}`,
    mismatch: (a, b) => `幻灯片数与转换后的页数不一致（${a} / ${b}），视频所在页可能有偏差`,
  },
  en: {
    st: { pending: 'Waiting', transcoding: 'Converting', ready: 'Ready', failed: 'Failed', external: 'External link', skipped: 'Skipped' },
    vst: { ok: 'Available', missing: 'Not installed', disabled: 'Disabled', no_encoder: 'Encoder missing' },
    reason: {
      unavailable: 'The video transcoder (ffmpeg) is not installed; videos will be converted automatically once it is',
      no_encoder: 'The installed ffmpeg lacks the H.264 / AAC encoders',
      timeout: (m) => `Conversion timed out (over ${m} minute${m === 1 ? '' : 's'})`,
      error: "The video file is damaged or its format isn't recognised",
      no_mp4: "Conversion didn't produce a playable file",
      source_missing: 'The original video file is missing; upload the deck again',
      too_large: 'The video is over the 500 MB limit',
      too_long: 'The video is longer than the 4-hour limit',
      unsupported_format: (ext) => `Unsupported video format (.${ext})`,
      unreadable: "This video couldn't be read from the deck; save it as MP4 and upload it as the section video",
      linked_file: 'The video is linked to a file on a computer, not embedded; embed it in PowerPoint and upload again',
      hidden_slide: "The video is on a hidden slide that learners can't see, so it was skipped",
      audio_not_supported: 'Audio is not played with courseware yet, so it was skipped',
      too_many_media: 'Up to 50 videos per deck are processed; the rest were skipped',
      cancelled: 'Conversion was cancelled (server restart) and will be queued again',
      disk_full: "The server is low on disk space, so this video wasn't saved; ask IT to free up space, then upload the deck again",
      storage_limit: "Videos waiting for conversion have reached the storage limit, so this video wasn't saved; upload the deck again once the waiting videos are converted",
      ppt_binary: "Videos can't be extracted from legacy .ppt files — save as .pptx and upload again",
    },
    slides: (list) => `slide${/[,]/.test(list) ? 's' : ''} ${list}`,
    slideSep: ', ',
    hidden: 'hidden slide',
    line: (deck, slides, name, why) => `"${deck}" ${slides} "${name}": ${why}`,
    lineNoDeck: (slides, name, why) => `${slides} "${name}": ${why}`,
    external: (host) => `External link ${host}`,
    mismatch: (a, b) => `Slide count and converted page count differ (${a} / ${b}); video pages may be off`,
  },
};

// 同一类的读取失败共用一句（设计 §13.4 表格同一行）
const UNREADABLE = new Set(['unsupported_compression', 'pptx_unreadable', 'zip64_unsupported']);

export const mediaText = (lang) => T[lang === 'en' ? 'en' : 'zh'];

export function reasonText(reason, lang, opts = {}) {
  const s = mediaText(lang);
  if (!reason) return '';
  const key = UNREADABLE.has(reason) ? 'unreadable' : reason;
  const v = s.reason[key];
  if (typeof v === 'function') {
    if (key === 'timeout') return v(Number(opts.minutes) || 30);
    return v(String(opts.ext || '?').replace(/^\./, '').slice(0, 10));
  }
  return v || String(reason);
}

export function slidesText(slides, lang) {
  const s = mediaText(lang);
  const list = (Array.isArray(slides) ? slides : []).filter(Boolean);
  if (!list.length) return '';
  const visible = list.filter((x) => x.pageNo != null);
  if (!visible.length) return s.hidden;
  const nos = [...new Set(visible.map((x) => x.slideNo != null ? x.slideNo : x.pageNo))];
  return s.slides(nos.join(s.slideSep));
}

export function hostOf(url) {
  try { return new URL(String(url)).hostname; } catch { return ''; }
}

export function mediaLine(item, lang, opts = {}) {
  const s = mediaText(lang);
  const it = item || {};
  const why = it.status === 'external' ? s.external(hostOf(it.url))
    : it.reason ? reasonText(it.reason, lang, { ext: it.srcExt, minutes: opts.minutes })
      : (s.st[it.status] || it.status || '');
  const slides = slidesText(it.slides, lang);
  const deck = opts.deck || it.deck;
  return deck ? s.line(deck, slides, it.name || '', why) : s.lineNoDeck(slides, it.name || '', why);
}

export function mediaSummaryOf(items) {
  const out = { total: 0, ready: 0, pending: 0, transcoding: 0, failed: 0, external: 0, skipped: 0 };
  for (const it of items || []) {
    out.total++;
    if (it && Object.prototype.hasOwnProperty.call(out, it.status)) out[it.status]++;
  }
  return out;
}
