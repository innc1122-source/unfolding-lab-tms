import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { useI18n } from '../i18n.jsx';
import { useAuth } from '../auth.jsx';
import { watermarkText, watermarkTile } from '../watermark.js';

// 带查看人水印的视频播放器（第三批 5.6 / 5.7，2026-10-08）：课程小节视频、视频附件、课件内嵌视频共用。
// - 覆盖层 .wm-layer（pointer-events:none）平铺「姓名 · 工号 · 日期」；
// - 关掉下载、倍速菜单、画中画（画中画窗口没有覆盖层）与右键菜单；
// - 原生全屏会盖住覆盖层，所以隐藏原生全屏按钮，改用自带按钮让外层容器全屏，水印随之全屏。
//   iPhone Safari 不支持元素全屏：按钮不显示，视频只在页面内播放。
// 局限（写进 HANDOVER-IT 8.5）：覆盖层是 DOM，开发者工具可以删掉；controlsList / disablePictureInPicture 只对 Chromium 生效。
const T = {
  zh: { fs: '全屏播放', fsExit: '退出全屏', play: '播放', wmAria: '视频含查看人水印' },
  en: { fs: 'Fullscreen', fsExit: 'Exit fullscreen', play: 'Play', wmAria: 'This video carries a viewer watermark' },
};

const canFullscreen = () => typeof document !== 'undefined' && !!(document.fullscreenEnabled || document.webkitFullscreenEnabled);

const WatermarkedVideo = forwardRef(function WatermarkedVideo({ src, poster, autoPlay = false, onEnded, className = '', label }, ref) {
  const { lang } = useI18n();
  const s = T[lang] || T.en;
  const { user } = useAuth();
  const wrapRef = useRef(null);
  const videoRef = useRef(null);
  const [isFull, setIsFull] = useState(false);
  const [needTap, setNeedTap] = useState(false);
  const text = watermarkText(user);
  const tile = watermarkTile(text, user && user.id ? String(user.id) : '');

  // 父组件（PdfViewer）用 ref.play() 在幻灯片翻到时开始播放
  useImperativeHandle(ref, () => ({
    play: () => {
      const v = videoRef.current;
      if (!v) return Promise.resolve(false);
      return v.play().then(() => { setNeedTap(false); return true; }).catch(() => { setNeedTap(true); return false; });
    },
    pause: () => { if (videoRef.current) videoRef.current.pause(); },
    el: () => wrapRef.current,
  }), []);

  // autoPlay：浏览器拦截自动播放（iOS、未交互）时退回「点按播放」
  useEffect(() => {
    if (!autoPlay) return;
    const v = videoRef.current;
    if (!v) return;
    v.play().then(() => setNeedTap(false)).catch(() => setNeedTap(true));
  }, [autoPlay, src]);

  useEffect(() => {
    const on = () => {
      const fe = document.fullscreenElement || document.webkitFullscreenElement;
      setIsFull(!!fe && fe === wrapRef.current);
    };
    document.addEventListener('fullscreenchange', on);
    document.addEventListener('webkitfullscreenchange', on);
    return () => {
      document.removeEventListener('fullscreenchange', on);
      document.removeEventListener('webkitfullscreenchange', on);
    };
  }, []);

  const toggleFull = () => {
    const el = wrapRef.current;
    if (!el) return;
    const fe = document.fullscreenElement || document.webkitFullscreenElement;
    if (fe) (document.exitFullscreen || document.webkitExitFullscreen).call(document);
    else (el.requestFullscreen || el.webkitRequestFullscreen).call(el);
  };

  const tapPlay = () => {
    const v = videoRef.current;
    if (v) v.play().then(() => setNeedTap(false)).catch(() => {});
  };

  return (
    <div
      ref={wrapRef}
      className={'wm-video' + (isFull ? ' is-full' : '') + (className ? ' ' + className : '')}
      onContextMenu={(e) => e.preventDefault()}
    >
      <video
        ref={videoRef}
        src={src}
        poster={poster}
        controls
        playsInline
        preload="metadata"
        controlsList="nodownload noplaybackrate nofullscreen"
        disablePictureInPicture
        onEnded={onEnded}
        onPlay={() => setNeedTap(false)}
        onContextMenu={(e) => e.preventDefault()}
        aria-label={label}
      />
      <div className="wm-layer" aria-hidden="true" style={tile ? { backgroundImage: `url(${tile})` } : undefined} />
      <span className="wm-sr">{s.wmAria}</span>
      {needTap && (
        <button type="button" className="wm-play" onClick={tapPlay} aria-label={s.play}>
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z" /></svg>
        </button>
      )}
      {canFullscreen() && (
        <button type="button" className="wm-fs" onClick={toggleFull} aria-label={isFull ? s.fsExit : s.fs} title={isFull ? s.fsExit : s.fs}>
          {isFull ? '✕' : '⛶'}
        </button>
      )}
    </div>
  );
});

export default WatermarkedVideo;
