// 课件转换（P0 1.3 / 1.4；后台课程库页头的「课件转换」按钮打开）
//   ① 转换组件（LibreOffice）状态：可用 / 未安装 / 已停用，程序位置、版本、最近一次转换；「重新检测」= ?refresh=1
//   ② 状态不是「可用」时的安装说明（命令与环境变量用 <code> 包起来）
//   ③ 待转换清单：装好组件之前上传、仍是 PPT / Word / Excel 原文件的附件，逐条或一键在线补转
// 接口：GET /api/admin/attachments/office-status（培训读）；POST /api/admin/attachments/office-convert（培训写，202 + 后台任务）。
// 只读角色看得到状态与清单，转换按钮只给写权限（canWrite）。任务进行中每 2 秒轮询一次状态接口，
// 结束后提示结果，并通过 onChanged 让页面刷新页头按钮。
// 错误文案：有 code 的按 code 显示本页文案；rbacGate 的 403 / 404 与限流 429 不带 code，按 HTTP 状态兜底。
import { useCallback, useEffect, useRef, useState } from 'react';
import { date as fmtDate } from '../../fmt.js';   // 一致性整改 3
import { Tag, Button, Toast, Banner, Progress, Typography, Spin, Tooltip } from '@douyinfe/semi-ui';
import { IconRefresh, IconArrowLeft } from '@douyinfe/semi-icons';
import { api } from '../../api.js';
import DataTable from '../../components/DataTable.jsx';   // 简化 10/11：横向宽度按列宽求和、手机宽度切卡片
import { useI18n } from '../../i18n.jsx';
import { errText } from '../../apierr.js';
import { mediaText, reasonText, slidesText, hostOf } from '../../mediareasons.js';

const { Text } = Typography;
const POLL_MS = 2000;

const T = {
  zh: {
    title: '课件转换与视频转码',
    back: '返回课程库',
    lead: 'PPT / Word / Excel 一律转为 PDF 后在线查看，不提供下载。转换由服务器上的 LibreOffice 完成；PPT 里嵌入的视频由 ffmpeg 转成网页可播放的 MP4，学员翻到那一页时在幻灯片下方播放。两者都是必装组件。',
    secStatus: '转换组件',
    // 第三批 5.7：视频转码（ffmpeg）
    secOffice: '课件转换（LibreOffice）', secVideo: '视频转码（ffmpeg）',
    vst: { ok: '可用', missing: '未安装', disabled: '已停用', no_encoder: '缺少编码器' },
    kEncoder: '编码器', kLastVideo: '最近一次转码',
    vMissingNote: '课件中的视频已保存，安装后自动转码；在此之前学员看到「视频处理中」。',
    vNoEncoder: '已安装的 ffmpeg 缺少 H.264 / AAC 编码器，视频无法转码。请 IT 换用完整版 ffmpeg。',
    vDisabledHint: '服务器设置了 LMS_DISABLE_VIDEO_TRANSCODE=1，视频转码按已停用处理（仅用于测试）。',
    instVTitle: '安装视频转码组件 ffmpeg（必装）',
    instV1: '请 IT 在服务器上以管理员身份执行：',
    instV2a: '或者把 ffmpeg.exe 放到 ', instV2b: ' 目录。',
    instV3a: '装在其他位置时，请 IT 把环境变量 ', instV3b: ' 设为 ffmpeg.exe 的完整路径。',
    instV4: '服务以系统账户运行时，只为当前用户安装的 ffmpeg 找不到，请按上面的命令为整台机器安装。',
    instV5: '装好后不需要重启：1 分钟内会自动检测到并开始转码，也可以点「重新检测」。',
    secMedia: '课件内的视频',
    chipAll: (n) => `待处理 ${n}`,
    mDeck: '课件 › 小节', mPage: '页码', mVideo: '视频', mSize: '大小', mStatus: '状态', mNote: '说明', mUpdated: '更新时间', mAct: '操作',
    retry: '重试', transcodeAll: '全部转码',
    whyVOff: '请先安装 ffmpeg', whyVEmpty: '没有需要转码的视频',
    vStarted: '已开始转码',
    vJobRunning: (d, t) => `正在转码 ${d} / ${t}`,
    vJobDone: (d, f) => `已转码 ${d} 段，失败 ${f} 段`,
    vJobAborted: '连续 3 段视频转码超时，已停止本轮；请检查服务器负载后重试',
    mediaEmpty: '没有待处理的视频：课件内的视频都已可以播放。',
    eVOff: '视频转码组件不可用，请 IT 安装 ffmpeg 后点「重新检测」',
    eVRunning: '已有转码任务在进行，请等它结束',
    eVUnknown: '找不到这段视频，请刷新后重试',
    eVNothing: '没有需要转码的视频',
    st: { ok: '可用', missing: '未安装', disabled: '已停用' },
    kState: '状态', kPath: '程序位置', kVersion: '版本', kProbed: '检测时间', kLast: '最近一次转换',
    verUnknown: '版本未知',
    lastNone: '暂无记录',
    lastOk: '成功', lastFail: '失败',
    took: (ms) => `耗时 ${(ms / 1000).toFixed(1)} 秒`,
    src: { upload: '上传时转换', batch: '在线补转' },
    recheck: '重新检测',
    disHintA: '服务器设置了 ',
    disHintB: '，转换组件按未安装处理，PPT / Word / Excel 上传会被拒绝。请 IT 去掉这个设置并重启服务。',
    instTitle: '安装转换组件（必装）',
    inst1: '请 IT 在服务器上以管理员身份执行：',
    inst2: '装在默认位置时不需要任何配置。',
    inst3a: '装在其它位置时，请 IT 把环境变量 ',
    inst3b: ' 设为转换程序的完整路径，然后重启服务。',
    inst4: '装好后点「重新检测」，状态变为「可用」即可上传 PPT / Word / Excel，并在下方补转已有的原文件。',
    secPending: (n) => `待转换的课件（${n}）`,
    pendLead: '下面是装好转换组件之前上传、仍是 PPT / Word / Excel 原文件的课件。学员端显示为「待转换」，打不开也不能下载；转换成功后自动改为在线只读的 PDF。',
    missingNote: (n) => `其中 ${n} 个原文件已缺失，无法转换，请重新上传这些课件。`,
    unrefNote: (n) => `其中 ${n} 个未被任何小节使用。`,
    empty: '没有待转换的课件：所有课件都已是在线查看格式。',
    cFile: '文件', cWhere: '所在位置', cUploaded: '上传', cIssue: '问题', cAct: '操作',
    unused: '未被任何小节使用',
    cs: { draft: '草稿', archived: '已下线' },
    fileMissing: '原文件缺失',
    rowConverting: '转换中…',
    lastErr: (r) => `上次失败：${r}`,
    reason: {
      timeout: '转换超时', error: '转换程序出错', no_pdf: '没有生成 PDF', changed: '附件已被改动',
      unavailable: '转换组件不可用', timeouts: '连续超时，任务已中止', missing: '原文件缺失',
    },
    convert: '转换', convertAll: '全部转换',
    whyOff: '转换组件不可用：装好后点「重新检测」',
    whyRunning: '正在转换，请稍候',
    whyEmpty: '没有待转换的课件',
    started: '已开始转换',
    jobRunning: (d, t) => `正在转换 ${d} / ${t}`,
    jobBy: (name) => `由 ${name} 发起`,
    jobCurrent: (name) => `当前：${name}`,
    jobDone: (c, f, m) => `已转换 ${c} 个，失败 ${f} 个，原文件缺失 ${m} 个`,
    jobLast: (when) => `上次补转：${when}`,
    jobInterrupted: '上次的补转任务因服务重启而中断，可以重新点「全部转换」继续。',
    jobAborted: '连续多个文件转换超时，任务已自动中止。请 IT 检查服务器上的 LibreOffice 能否正常运行。',
    jobStopped: '补转任务中途停止了（转换组件不可用或服务重启），没处理的文件可以重新点「全部转换」继续。',
    jobUntried: (n) => `还有 ${n} 个没有处理`,
    eOff: '转换组件不可用，暂时不能转换。请 IT 安装 LibreOffice 后点「重新检测」',
    eRunning: '已有补转任务在进行，请等它结束',
    eNothing: '没有需要转换的课件',
    eUnknown: '找不到该课件，或它不是 PPT / Word / Excel 文件，请刷新后重试',
    eForbidden: '你的角色只能查看培训内容，不能转换课件',
    eNotFound: '课件转换不可用：培训模块未开启，或服务器版本过旧，请 IT 处理',
    eThrottled: '刚刚检测过，请稍后再试',
    eGeneric: '操作失败，请稍后重试',
  },
  en: {
    title: 'File & video conversion',
    back: 'Back to Course Library',
    lead: 'PowerPoint, Word and Excel files are always turned into a PDF and viewed online, never downloaded. LibreOffice on the server does the conversion; videos embedded in PowerPoint decks are turned into web-playable MP4 by ffmpeg and play under the slide. Both are required components.',
    secStatus: 'Converter',
    secOffice: 'File conversion (LibreOffice)', secVideo: 'Video conversion (ffmpeg)',
    vst: { ok: 'Available', missing: 'Not installed', disabled: 'Disabled', no_encoder: 'Encoder missing' },
    kEncoder: 'Encoder', kLastVideo: 'Last video conversion',
    vMissingNote: 'Videos in decks are saved and will be converted automatically once ffmpeg is installed. Until then learners see “video being prepared”.',
    vNoEncoder: 'The installed ffmpeg lacks the H.264 / AAC encoders, so videos cannot be converted. Ask IT to install a full ffmpeg build.',
    vDisabledHint: 'The server sets LMS_DISABLE_VIDEO_TRANSCODE=1, so video conversion is disabled (test use only).',
    instVTitle: 'Install the video transcoder ffmpeg (required)',
    instV1: 'Ask IT to run this on the server as an administrator:',
    instV2a: 'Or put ffmpeg.exe in ', instV2b: '.',
    instV3a: 'If it is installed elsewhere, ask IT to set the environment variable ', instV3b: ' to the full path of ffmpeg.exe.',
    instV4: 'When the service runs under a system account it cannot find an ffmpeg installed for one user only, so install it for the whole machine with the command above.',
    instV5: 'No restart is needed: within a minute it is detected and conversion starts, or click “Check again”.',
    secMedia: 'Videos in decks',
    chipAll: (n) => `Needing attention ${n}`,
    mDeck: 'Deck › section', mPage: 'Slide', mVideo: 'Video', mSize: 'Size', mStatus: 'Status', mNote: 'Details', mUpdated: 'Updated', mAct: 'Action',
    retry: 'Retry', transcodeAll: 'Convert all videos',
    whyVOff: 'Install ffmpeg first', whyVEmpty: 'No videos to convert',
    vStarted: 'Video conversion started',
    vJobRunning: (d, t) => `Converting video ${d} of ${t}`,
    vJobDone: (d, f) => `${d} video${d === 1 ? '' : 's'} converted, ${f} failed`,
    vJobAborted: 'Three videos in a row timed out, so this run stopped; check the server load and try again.',
    mediaEmpty: 'No videos need attention: every video in the decks can be played.',
    eVOff: 'The video transcoder isn’t available. Ask IT to install ffmpeg, then click “Check again”',
    eVRunning: 'A video conversion run is already in progress; wait for it to finish',
    eVUnknown: 'That video wasn’t found. Refresh and try again',
    eVNothing: 'There are no videos to convert',
    st: { ok: 'Ready', missing: 'Not installed', disabled: 'Turned off' },
    kState: 'Status', kPath: 'Program', kVersion: 'Version', kProbed: 'Checked at', kLast: 'Last conversion',
    verUnknown: 'Version unknown',
    lastNone: 'None yet',
    lastOk: 'Succeeded', lastFail: 'Failed',
    took: (ms) => `${(ms / 1000).toFixed(1)} s`,
    src: { upload: 'on upload', batch: 'online conversion' },
    recheck: 'Check again',
    disHintA: 'The server sets ',
    disHintB: ', so the converter counts as not installed and PowerPoint, Word and Excel uploads are rejected. Ask IT to remove that setting and restart the service.',
    instTitle: 'Install the converter (required)',
    inst1: 'Ask IT to run this on the server as an administrator:',
    inst2: 'Nothing needs configuring when it is installed in the default location.',
    inst3a: 'If it is installed elsewhere, ask IT to set the environment variable ',
    inst3b: ' to the full path of the converter program, then restart the service.',
    inst4: 'Once installed, click “Check again”. When the status shows Ready, PowerPoint, Word and Excel uploads work and the originals below can be converted.',
    secPending: (n) => `Files waiting for conversion (${n})`,
    pendLead: 'These PowerPoint, Word and Excel originals were uploaded before the converter was installed. Learners see them as “Pending conversion” and can neither open nor download them; once converted they become a view-only PDF automatically.',
    missingNote: (n) => `${n} of them have lost their original file and can’t be converted. Upload those files again.`,
    unrefNote: (n) => `${n} of them aren’t used by any section.`,
    empty: 'Nothing is waiting for conversion: every file can already be viewed online.',
    cFile: 'File', cWhere: 'Used in', cUploaded: 'Uploaded', cIssue: 'Issue', cAct: 'Action',
    unused: 'Not used by any section',
    cs: { draft: 'Draft', archived: 'Retired' },
    fileMissing: 'Original file missing',
    rowConverting: 'Converting…',
    lastErr: (r) => `Last attempt failed: ${r}`,
    reason: {
      timeout: 'timed out', error: 'converter error', no_pdf: 'no PDF produced', changed: 'attachment changed meanwhile',
      unavailable: 'converter unavailable', timeouts: 'repeated timeouts, run stopped', missing: 'original file missing',
    },
    convert: 'Convert', convertAll: 'Convert all',
    whyOff: 'The converter isn’t available: install it, then click “Check again”',
    whyRunning: 'Conversion in progress, please wait',
    whyEmpty: 'Nothing to convert',
    started: 'Conversion started',
    jobRunning: (d, t) => `Converting ${d} of ${t}`,
    jobBy: (name) => `Started by ${name}`,
    jobCurrent: (name) => `Now: ${name}`,
    jobDone: (c, f, m) => `${c} converted, ${f} failed, ${m} missing the original file`,
    jobLast: (when) => `Last run: ${when}`,
    jobInterrupted: 'The last conversion run was interrupted by a service restart. Click “Convert all” to carry on.',
    jobAborted: 'Several files in a row timed out, so the run stopped by itself. Ask IT to check that LibreOffice runs normally on the server.',
    jobStopped: 'The conversion run stopped partway (the converter became unavailable or the service restarted). Click “Convert all” to carry on with the rest.',
    jobUntried: (n) => `${n} not processed`,
    eOff: 'The converter isn’t available, so nothing can be converted yet. Ask IT to install LibreOffice, then click “Check again”',
    eRunning: 'A conversion run is already in progress; wait for it to finish',
    eNothing: 'There is nothing to convert',
    eUnknown: 'That file wasn’t found or isn’t a PowerPoint, Word or Excel file. Refresh and try again',
    eForbidden: 'Your role can view training but can’t convert files',
    eNotFound: 'File conversion isn’t available: the learning module is off or the server is out of date. Ask IT to check',
    eThrottled: 'The converter was checked a moment ago; try again shortly',
    eGeneric: 'Something went wrong; try again later',
  },
};

const pad = (n) => String(n).padStart(2, '0');
const fmtDT = (v) => {
  if (!v) return '';
  const x = new Date(v);
  if (Number.isNaN(x.getTime())) return String(v);
  return `${x.getFullYear()}-${pad(x.getMonth() + 1)}-${pad(x.getDate())} ${pad(x.getHours())}:${pad(x.getMinutes())}`;
};
const fmtSize = (b) => {
  if (b == null || Number.isNaN(Number(b))) return '';
  if (b < 1024) return `${b} B`;
  const kb = b / 1024;
  if (kb < 1024) return `${kb.toFixed(kb < 10 ? 1 : 0)} KB`;
  const mb = kb / 1024;
  return `${mb.toFixed(mb < 10 ? 1 : 0)} MB`;
};
// Course content titles are bilingual (`title` / `title_zh`); an empty translation falls back to the other language.
const pick = (lang, o, k) => {
  const zh = o && o[k + '_zh'], en = o && o[k];
  return lang === 'zh' ? (zh || en || '') : (en || zh || '');
};

const ERR_BY_CODE = (s) => ({
  office_converter_unavailable: () => s.eOff,
  office_convert_running: () => s.eRunning,
  nothing_to_convert: () => s.eNothing,
  unknown_attachment: () => s.eUnknown,
});
// 第三批 5.7：视频转码接口 POST /api/admin/attachments/media-transcode 的错误码
const MEDIA_ERR_BY_CODE = (s) => ({
  video_transcoder_unavailable: () => s.eVOff,
  video_transcode_running: () => s.eVRunning,
  unknown_media: () => s.eVUnknown,
  nothing_to_transcode: () => s.eVNothing,
});
function mediaErrText(err, s) {
  const code = err && err.data && err.data.code;
  if (!code) return ocErrText(err, s);
  return errText(err, MEDIA_ERR_BY_CODE(s)) || s.eGeneric;
}
// 媒体状态 → 标签颜色
const MEDIA_COLOR = { pending: 'amber', transcoding: 'blue', ready: 'green', failed: 'red', external: 'grey', skipped: 'grey' };

function ocErrText(err, s) {
  const status = err && err.status;
  if (!status) return s.eGeneric; // network failure: the browser's own message is English-only
  const code = err.data && err.data.code;
  if (!code) {
    if (status === 403) return s.eForbidden;
    if (status === 404) return s.eNotFound;
    if (status === 429) return s.eThrottled;
  }
  return errText(err, ERR_BY_CODE(s)) || s.eGeneric;
}

export default function OfficeConvertSheet({ canWrite, initial, onChanged, onClose }) {
  const { lang } = useI18n();
  const s = T[lang];
  const [st, setSt] = useState(initial && initial.converter ? initial : null);
  const [loadErr, setLoadErr] = useState(null);
  const [checking, setChecking] = useState(false);
  const [busy, setBusy] = useState(null); // 'all' | attachment id while a POST is in flight
  const [tick, setTick] = useState(0);    // bumps after every status read, success or not, to drive polling
  const [mFilter, setMFilter] = useState('all'); // 课件内视频清单的状态筛选：all | pending | transcoding | failed | skipped
  const [mBusy, setMBusy] = useState(null);      // 'all' | media id while a POST is in flight
  const mWatching = useRef(false);               // 本页看到在跑的视频转码任务 → 结束时提示一次结果
  const watching = useRef(false);         // a run this sheet saw running → announce its result once it ends
  const alive = useRef(true);
  const hasData = useRef(!!st);
  useEffect(() => () => { alive.current = false; }, []);

  // quiet: polling reads never toast — a flaky network would otherwise pop a message every 2 seconds.
  const load = useCallback(async ({ refresh = false, quiet = false } = {}) => {
    if (refresh) setChecking(true);
    try {
      const d = await api.get('/api/admin/attachments/office-status' + (refresh ? '?refresh=1' : ''));
      if (!alive.current) return;
      hasData.current = true;
      setSt(d);
      setLoadErr(null);
    } catch (err) {
      if (!alive.current) return;
      if (!hasData.current) setLoadErr(err);
      else if (!quiet) Toast.warning({ content: ocErrText(err, T[lang]), duration: 3 });
    } finally {
      if (alive.current) { if (refresh) setChecking(false); setTick((n) => n + 1); }
    }
  }, [lang]);

  useEffect(() => { load({ quiet: !!initial }); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const job = (st && st.job) || {};
  const running = !!job.running;
  // 引擎中止任务时写 job.aborted（"timeouts" | "unavailable" | "shutdown" | "error"），没处理到的 = total - done
  const untried = job.aborted ? Math.max(0, (job.total || 0) - (job.done || 0)) : 0;
  const doneText = s.jobDone(job.converted || 0, job.failed || 0, job.missing || 0) + (untried ? ' · ' + s.jobUntried(untried) : '');
  useEffect(() => {
    if (!st) return undefined;
    if (running) {
      watching.current = true;
      const t = setTimeout(() => load({ quiet: true }), POLL_MS);
      return () => clearTimeout(t);
    }
    if (watching.current) {
      watching.current = false;
      // Toast 的静态方法依赖 this，不能先取出来再调用；任务中途中止时不报成功，并写明还有几个没处理
      if (job.failed || job.missing || job.aborted) Toast.warning({ content: doneText, duration: 5 });
      else Toast.success({ content: doneText, duration: 5 });
      if (onChanged) onChanged();
    }
    return undefined;
  }, [st, tick]); // eslint-disable-line react-hooks/exhaustive-deps

  const start = async (ids) => {
    setBusy(ids ? ids[0] : 'all');
    try {
      const r = await api.post('/api/admin/attachments/office-convert', ids ? { ids } : {});
      if (!alive.current) return;
      Toast.info({ content: s.started, duration: 2 });
      watching.current = true;
      if (r && r.job) setSt((d) => ({ ...(d || {}), job: r.job }));
      // A run that already ended (every file missing, or very fast) still needs the fresh list.
      if (!(r && r.job && r.job.running)) load({ quiet: true });
    } catch (err) {
      if (!alive.current) return;
      Toast.error({ content: ocErrText(err, s), duration: 4 });
      const code = err && err.data && err.data.code;
      if (code === 'office_convert_running' || code === 'office_converter_unavailable' || code === 'unknown_attachment') load({ quiet: true });
    } finally {
      if (alive.current) setBusy(null);
    }
  };

  // ---- 第三批 5.7：视频转码（ffmpeg）—— 状态、待处理清单、重试 ----
  const mt = mediaText(lang);
  const v = (st && st.transcoder) || {};
  const vOk = v.state === 'ok';
  const mJob = (st && st.mediaJob) || {};
  const mRunning = !!mJob.running;
  const mediaRows = (st && Array.isArray(st.media)) ? st.media : [];
  const mc = (st && st.mediaCounts) || {};
  useEffect(() => {
    if (!st) return undefined;
    if (mRunning) {
      mWatching.current = true;
      // 课件转换任务在跑时由上面那条轮询负责，这里不重复请求
      if (running) return undefined;
      const t = setTimeout(() => load({ quiet: true }), POLL_MS);
      return () => clearTimeout(t);
    }
    if (mWatching.current) {
      mWatching.current = false;
      const text = s.vJobDone(mJob.done || 0, mJob.failed || 0);
      if (mJob.failed || mJob.aborted) Toast.warning({ content: text, duration: 5 });
      else Toast.success({ content: text, duration: 5 });
      if (onChanged) onChanged();
    }
    return undefined;
  }, [st, tick]); // eslint-disable-line react-hooks/exhaustive-deps
  const startMedia = async (ids) => {
    setMBusy(ids ? ids[0] : 'all');
    try {
      const r = await api.post('/api/admin/attachments/media-transcode', ids ? { ids } : {});
      if (!alive.current) return;
      Toast.info({ content: s.vStarted, duration: 2 });
      mWatching.current = true;
      if (r && r.job) setSt((d) => ({ ...(d || {}), mediaJob: r.job }));
      load({ quiet: true });
    } catch (err) {
      if (!alive.current) return;
      Toast.error({ content: mediaErrText(err, s), duration: 4 });
      load({ quiet: true });
    } finally {
      if (alive.current) setMBusy(null);
    }
  };
  const mPendingFailed = (mc.pending || 0) + (mc.failed || 0);
  const whyV = !vOk ? s.whyVOff : mRunning ? s.whyRunning : !mPendingFailed ? s.whyVEmpty : '';
  const vColor = { ok: 'green', missing: 'red', disabled: 'grey', no_encoder: 'orange' }[v.state] || 'grey';
  const lv = v.lastTranscode;
  const mShown = mFilter === 'all' ? mediaRows : mediaRows.filter((r) => r.status === mFilter);
  const mPct = mJob.total ? Math.min(100, Math.round(((mJob.done || 0) / mJob.total) * 100)) : 0;
  const mCols = [
    {
      title: s.mDeck, dataIndex: 'deck', width: 200,
      render: (deck, r) => (
        <div className="oc-file">
          <div className="oc-fn">{deck || r.attachmentId}</div>
          {(r.refs || []).map((x, i) => (
            <div className="oc-ref" key={i}>
              {[pick(lang, x, 'courseTitle'), pick(lang, x, 'moduleTitle'), [x.sectionNo, pick(lang, x, 'sectionTitle')].filter(Boolean).join(' ')].filter(Boolean).join(' › ')}
            </div>
          ))}
        </div>
      ),
    },
    { title: s.mPage, dataIndex: 'slides', width: 96, render: (sl) => <span className="tnum">{slidesText(sl, lang) || '—'}</span> },
    {
      title: s.mVideo, dataIndex: 'name', width: 150,
      render: (name, r) => (
        <div className="oc-file">
          <div className="oc-fn">{name || '—'}</div>
          {r.status === 'external' && r.url ? <Text type="tertiary" size="small">{hostOf(r.url)}</Text>
            : r.srcExt ? <Text type="tertiary" size="small">{String(r.srcExt).replace(/^\./, '').toUpperCase()}</Text> : null}
        </div>
      ),
    },
    { title: s.mSize, dataIndex: 'srcSize', width: 84, render: (b) => <span className="tnum">{fmtSize(b) || '—'}</span> },
    { title: s.mStatus, dataIndex: 'status', width: 96, render: (x) => <Tag size="small" type="light" color={MEDIA_COLOR[x] || 'grey'}>{mt.st[x] || x}</Tag> },
    {
      // 用会换行的文字而不是 Tag：原因句子较长；ffmpeg 原始输出（detail）只给写权限，放在悬停提示里
      title: s.mNote, key: 'note', width: 220,
      render: (_, r) => {
        if (mRunning && r.status === 'transcoding') return <Text type="secondary" size="small">{mt.st.transcoding}</Text>;
        const text = r.reason ? reasonText(r.reason, lang, { ext: r.srcExt }) : '';
        if (!text) return <Text type="tertiary">—</Text>;
        const body = <Text type={r.status === 'failed' ? 'danger' : 'tertiary'} size="small">{text}</Text>;
        return canWrite && r.detail ? <Tooltip content={<pre className="oc-detail">{r.detail}</pre>}>{body}</Tooltip> : body;
      },
    },
    { title: s.mUpdated, dataIndex: 'updatedAt', width: 108, render: (x) => <span className="tnum oc-date" title={fmtDT(x)}>{fmtDT(x).slice(5) || '—'}</span> },
    ...(canWrite ? [{
      title: s.mAct, key: 'act', width: 90,
      // 服务端标了 retryable:false（如原始视频已丢失、格式不支持）的失败行不给「重试」，只能重新上传课件
      render: (_, r) => (r.status === 'failed' && r.retryable !== false ? (
        <Button size="small" theme="light" disabled={!vOk || mRunning || !!mBusy} loading={mBusy === r.id} onClick={() => startMedia([r.id])}>{s.retry}</Button>
      ) : null),
    }] : []),
  ];

  const c = (st && st.converter) || {};
  const pending = (st && st.pending) || [];
  const counts = (st && st.counts) || {};
  const ok = c.state === 'ok';
  const reasonText = (r) => (r && s.reason[r]) || r || '';
  const why = !ok ? s.whyOff : running ? s.whyRunning : !pending.length ? s.whyEmpty : '';
  const stateColor = { ok: 'green', missing: 'red', disabled: 'grey' }[c.state] || 'grey';
  const lc = c.lastConversion;
  const currentName = running && job.currentId ? (pending.find((p) => p.id === job.currentId) || {}).originalName : '';
  const pct = job.total ? Math.min(100, Math.round(((job.done || 0) / job.total) * 100)) : 0;

  const cols = [
    {
      // 大小并进文件列，让「问题」列在 720px 的抽屉里不用横向滚动就能看到
      title: s.cFile, dataIndex: 'originalName', width: 145,
      render: (v, r) => (
        <div className="oc-file">
          <div className="oc-fn">{v || r.id}</div>
          <Text type="tertiary" size="small">{[r.ext && String(r.ext).replace(/^\./, '').toUpperCase(), fmtSize(r.size)].filter(Boolean).join(' · ')}</Text>
        </div>
      ),
    },
    {
      title: s.cWhere, dataIndex: 'refs', width: 145,
      render: (refs) => (refs && refs.length ? refs.map((x, i) => (
        <div className="oc-ref" key={i}>
          {[pick(lang, x, 'courseTitle'), pick(lang, x, 'moduleTitle'), [x.sectionNo, pick(lang, x, 'sectionTitle')].filter(Boolean).join(' ')].filter(Boolean).join(' › ')}
          {x.courseStatus && x.courseStatus !== 'published' && s.cs[x.courseStatus] && <Tag size="small" color="grey" style={{ marginLeft: 6 }}>{s.cs[x.courseStatus]}</Tag>}
        </div>
      )) : <Text type="tertiary">{s.unused}</Text>),
    },
    {
      // 表里只放日期（不折行），完整时间放在悬停提示里
      title: s.cUploaded, dataIndex: 'createdAt', width: 118,
      render: (v, r) => (
        <div>
          <div className="tnum oc-date" title={fmtDT(v)}>{fmtDate(v)}</div>
          {r.uploadedByName && <Text type="tertiary" size="small">{r.uploadedByName}</Text>}
        </div>
      ),
    },
    {
      title: s.cIssue, key: 'issue', width: 126,
      // 用会换行的文字而不是 Tag：英文原因较长，Tag 不换行会把表格撑出横向滚动
      render: (_, r) => {
        if (running && job.currentId === r.id) return <Text type="secondary" size="small">{s.rowConverting}</Text>;
        if (r.fileMissing) return <Text type="danger" size="small">{s.fileMissing}</Text>;
        if (r.lastError) return <Text type="warning" size="small" title={fmtDT(r.lastError.at)}>{s.lastErr(reasonText(r.lastError.reason))}</Text>;
        return <Text type="tertiary">—</Text>;
      },
    },
    ...(canWrite ? [{
      title: s.cAct, key: 'act', width: 110,
      render: (_, r) => (
        <Button size="small" theme="light" disabled={!ok || running || r.fileMissing || !!busy} loading={busy === r.id} onClick={() => start([r.id])}>{s.convert}</Button>
      ),
    }] : []),
  ];

  return (
    // 整页（课程库 ?office=1），不用抽屉
    <div className="co-page oc-page">
      <div className="co-page-bar">
        <Button theme="borderless" icon={<IconArrowLeft />} onClick={onClose}>{s.back}</Button>
        <h1 className="co-page-title">{s.title}</h1>
      </div>
      <div className="card oc-body">
        <p className="oc-lead">{s.lead}</p>
        {!st && !loadErr && <div className="oc-loading"><Spin /></div>}
        {!st && loadErr && <Banner type="danger" fullMode={false} closeIcon={null} description={ocErrText(loadErr, s)} />}
        {st && (
          <>
            {/* ① 转换组件状态：左 LibreOffice（课件转换），右 ffmpeg（视频转码，第三批 5.7）；手机上上下排 */}
            <section className="oc-sec">
              <div className="oc-sec-h">
                <h3>{s.secStatus}</h3>
                <Button size="small" theme="light" icon={<IconRefresh />} loading={checking} onClick={() => load({ refresh: true })}>{s.recheck}</Button>
              </div>
              <div className="oc-status2">
              <div className="oc-comp">
              <h4 className="oc-comp-h">{s.secOffice}</h4>
              {c.state === 'disabled' && (
                <Banner type="warning" fullMode={false} closeIcon={null} style={{ marginBottom: 10 }}
                  description={<span>{s.disHintA}<code>LMS_DISABLE_OFFICE_CONVERT=1</code>{s.disHintB}</span>} />
              )}
              <div className="oc-kv">
                <div className="k">{s.kState}</div>
                <div><Tag color={stateColor} type="light">{s.st[c.state] || c.state || '—'}</Tag></div>
                {c.path && (<><div className="k">{s.kPath}</div><div><code className="oc-path">{c.path}</code></div></>)}
                {c.state !== 'missing' && (<><div className="k">{s.kVersion}</div><div title={c.versionSource || undefined}>{c.version || s.verUnknown}</div></>)}
                {c.probedAt && (<><div className="k">{s.kProbed}</div><div className="tnum">{fmtDT(c.probedAt)}</div></>)}
                <div className="k">{s.kLast}</div>
                <div>
                  {lc && lc.at ? (
                    <span className="oc-last">
                      <span className="tnum">{fmtDT(lc.at)}</span>
                      <Tag size="small" color={lc.ok ? 'green' : 'red'}>{lc.ok ? s.lastOk : s.lastFail}</Tag>
                      {lc.ms != null && <span>{s.took(lc.ms)}</span>}
                      {!lc.ok && lc.reason && <span>{reasonText(lc.reason)}</span>}
                      {lc.source && <Text type="tertiary" size="small">{s.src[lc.source] || lc.source}</Text>}
                    </span>
                  ) : <Text type="tertiary">{s.lastNone}</Text>}
                </div>
              </div>
              </div>
              <div className="oc-comp">
                <h4 className="oc-comp-h">{s.secVideo}</h4>
                {v.state === 'disabled' && <Banner type="warning" fullMode={false} closeIcon={null} style={{ marginBottom: 10 }} description={s.vDisabledHint} />}
                {v.state === 'no_encoder' && <Banner type="warning" fullMode={false} closeIcon={null} style={{ marginBottom: 10 }} description={s.vNoEncoder} />}
                {v.state === 'missing' && <Banner type="warning" fullMode={false} closeIcon={null} style={{ marginBottom: 10 }} description={s.vMissingNote} />}
                <div className="oc-kv">
                  <div className="k">{s.kState}</div>
                  <div><Tag color={vColor} type="light">{v.state ? (s.vst[v.state] || v.state) : '—'}</Tag></div>
                  {v.path && (<><div className="k">{s.kPath}</div><div><code className="oc-path">{v.path}</code></div></>)}
                  {v.state && v.state !== 'missing' && v.state !== 'disabled' && (<><div className="k">{s.kVersion}</div><div>{v.version || s.verUnknown}</div></>)}
                  {v.encoder && (<><div className="k">{s.kEncoder}</div><div>{v.encoder}</div></>)}
                  {v.probedAt && (<><div className="k">{s.kProbed}</div><div className="tnum">{fmtDT(v.probedAt)}</div></>)}
                  <div className="k">{s.kLastVideo}</div>
                  <div>
                    {lv && lv.at ? (
                      <span className="oc-last">
                        <span className="tnum">{fmtDT(lv.at)}</span>
                        <Tag size="small" color={lv.ok ? 'green' : 'red'}>{lv.ok ? s.lastOk : s.lastFail}</Tag>
                        {lv.ms != null && <span>{s.took(lv.ms)}</span>}
                        {!lv.ok && lv.reason && <span>{reasonText(lv.reason, lang)}</span>}
                      </span>
                    ) : <Text type="tertiary">{s.lastNone}</Text>}
                  </div>
                </div>
              </div>
              </div>
            </section>

            {/* ② 安装说明：状态不是「可用」时才显示 */}
            {!ok && (
              <section className="oc-sec oc-install">
                <h3>{s.instTitle}</h3>
                <ol>
                  <li>{s.inst1}<div><code>winget install TheDocumentFoundation.LibreOffice</code></div></li>
                  <li>{s.inst2}</li>
                  <li>{s.inst3a}<code>LMS_SOFFICE</code>{s.inst3b}</li>
                  <li>{s.inst4}</li>
                </ol>
              </section>
            )}

            {/* ②b 视频转码组件的安装说明：状态不是「可用」时显示，可折叠（第三批 5.7） */}
            {st.transcoder && !vOk && (
              <details className="oc-sec oc-install oc-vinstall" open={v.state === 'missing'}>
                <summary><h3>{s.instVTitle}</h3></summary>
                <ol>
                  <li>{s.instV1}<div><code>winget install --id Gyan.FFmpeg -e --scope machine</code></div></li>
                  <li>{s.instV2a}<code>C:\Program Files\ffmpeg\bin\</code>{s.instV2b}</li>
                  <li>{s.instV3a}<code>LMS_FFMPEG</code>{s.instV3b}</li>
                  <li>{s.instV4}</li>
                  <li>{s.instV5}</li>
                </ol>
              </details>
            )}

            {/* ③ 待转换清单与补转任务 */}
            <section className="oc-sec">
              <div className="oc-sec-h">
                <h3>{s.secPending(counts.pending != null ? counts.pending : pending.length)}</h3>
                {canWrite && (
                  <div className="oc-all">
                    {why && <Text type="tertiary" size="small">{why}</Text>}
                    <Button theme="solid" type="primary" size="small" disabled={!!why || !!busy} loading={busy === 'all'} onClick={() => start(null)}>{s.convertAll}</Button>
                  </div>
                )}
              </div>
              {job.interrupted && !running && <Banner type="warning" fullMode={false} closeIcon={null} description={s.jobInterrupted} style={{ marginBottom: 10 }} />}
              {job.aborted === 'timeouts' && !running && <Banner type="warning" fullMode={false} closeIcon={null} description={s.jobAborted} style={{ marginBottom: 10 }} />}
              {job.aborted && job.aborted !== 'timeouts' && !job.interrupted && !running && <Banner type="warning" fullMode={false} closeIcon={null} description={s.jobStopped} style={{ marginBottom: 10 }} />}
              {running && (
                <div className="oc-job" role="status">
                  <div className="oc-job-t">
                    <span>{s.jobRunning(job.done || 0, job.total || 0)}</span>
                    {job.by && job.by.name && <Text type="tertiary" size="small">{s.jobBy(job.by.name)}</Text>}
                  </div>
                  <Progress percent={pct} showInfo aria-label={s.jobRunning(job.done || 0, job.total || 0)} />
                  {currentName && <Text type="tertiary" size="small">{s.jobCurrent(currentName)}</Text>}
                </div>
              )}
              {!running && job.finishedAt && (
                <div className="oc-note">{s.jobLast(fmtDT(job.finishedAt))} · {doneText}</div>
              )}
              {pending.length > 0 ? (
                <>
                  <p className="oc-note">{s.pendLead}</p>
                  {counts.missingFiles > 0 && <p className="oc-note oc-warn">{s.missingNote(counts.missingFiles)}</p>}
                  {counts.unreferenced > 0 && <p className="oc-note">{s.unrefNote(counts.unreferenced)}</p>}
                  <DataTable rowKey="id" size="small" pagination={false} columns={cols} dataSource={pending} />
                </>
              ) : <div className="oc-empty">{s.empty}</div>}
            </section>

            {/* ④ 课件内的视频（第三批 5.7）：服务端只返回未就绪、非外链的行；状态筛选在本页做，计数取 mediaCounts */}
            {st.transcoder && (
              <section className="oc-sec oc-media">
                <div className="oc-sec-h">
                  <h3>{s.secMedia}</h3>
                  {canWrite && (
                    <div className="oc-all">
                      {whyV && <Text type="tertiary" size="small">{whyV}</Text>}
                      <Button theme="solid" type="primary" size="small" disabled={!!whyV || !!mBusy} loading={mBusy === 'all'} onClick={() => startMedia(null)}>{s.transcodeAll}</Button>
                    </div>
                  )}
                </div>
                <div className="oc-chips" role="group" aria-label={s.secMedia}>
                  {[['all', s.chipAll(mediaRows.length)], ['pending', `${mt.st.pending} ${mc.pending || 0}`], ['transcoding', `${mt.st.transcoding} ${mc.transcoding || 0}`], ['failed', `${mt.st.failed} ${mc.failed || 0}`], ['skipped', `${mt.st.skipped} ${mc.skipped || 0}`]].map(([k, label]) => (
                    <button key={k} type="button" className={'pill co-chip' + (mFilter === k ? ' on' : '')} aria-pressed={mFilter === k} onClick={() => setMFilter(k)}>{label}</button>
                  ))}
                </div>
                {mJob.aborted === 'timeouts' && !mRunning && <Banner type="warning" fullMode={false} closeIcon={null} description={s.vJobAborted} style={{ marginBottom: 10 }} />}
                {mRunning && (
                  <div className="oc-job" role="status">
                    <div className="oc-job-t"><span>{s.vJobRunning(mJob.done || 0, mJob.total || 0)}</span></div>
                    <Progress percent={mPct} showInfo aria-label={s.vJobRunning(mJob.done || 0, mJob.total || 0)} />
                  </div>
                )}
                {mShown.length > 0
                  ? <DataTable rowKey="id" size="small" pagination={mShown.length > 20 ? { pageSize: 20 } : false} columns={mCols} dataSource={mShown} />
                  : <div className="oc-empty">{s.mediaEmpty}</div>}
              </section>
            )}
          </>
        )}
      </div>
    </div>
  );
}
