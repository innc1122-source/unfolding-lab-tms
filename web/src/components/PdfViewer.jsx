import { useEffect, useRef, useState } from 'react';
import { useI18n } from '../i18n.jsx';
import { useAuth } from '../auth.jsx';
import { drawWatermark, watermarkText } from '../watermark.js';
import WatermarkedVideo from './WatermarkedVideo.jsx';
import { IcWarn } from './LineIcons.jsx';

// 第三批（2026-10-08）：5.6 查看人水印画进 canvas（watermark 属性开启，学员课程页传入）；
// 5.7 课件内嵌视频（media 属性 = GET /api/courses/:id 的 attachment.slideMedia），翻到该页时在幻灯片下方播放。
const T = {
  zh: {
    err: '文档加载失败。', prev: '上一页', next: '下一页', nav: '翻页', fs: '全屏播放', fsClose: '退出全屏',
    wmAria: '页面含查看人水印',
    mediaWait: '本页视频正在处理，稍后刷新即可观看',
    mediaFail: '本页视频暂时无法播放，请稍后再试或联系 HR',
    mediaExternal: (host) => `观看视频（外部网站 ${host}）`,
    mediaIndex: '课件内视频：',
    mediaSlide: (n) => `第 ${n} 页`,
    mediaExternalTag: '（外部链接）',
    mediaHasVideo: '本页有视频',
    mediaBanner: '本页有视频 · 播放',
    videoLabel: (n) => `视频 ${n}`,
  },
  en: {
    err: "Couldn't load the document.", prev: 'Previous page', next: 'Next page', nav: 'Page navigation', fs: 'Fullscreen', fsClose: 'Exit fullscreen',
    wmAria: 'Pages carry a viewer watermark',
    mediaWait: 'This slide’s video is still being prepared — check back shortly.',
    mediaFail: 'This slide’s video can’t be played right now. Try again later or contact HR.',
    mediaExternal: (host) => `Watch the video (external site ${host})`,
    mediaIndex: 'Videos in this deck: ',
    mediaSlide: (n) => `slide ${n}`,
    mediaExternalTag: ' (external link)',
    mediaHasVideo: 'This slide has a video',
    mediaBanner: 'This slide has a video · Play',
    videoLabel: (n) => `Video ${n}`,
  },
};

// Loads the vendored PDF.js (public/vendor/pdfjs) once, globally.
let pdfjsPromise = null;
function loadPdfjs() {
  if (window.pdfjsLib) return Promise.resolve(window.pdfjsLib);
  if (!pdfjsPromise) {
    pdfjsPromise = new Promise((resolve, reject) => {
      const sc = document.createElement('script');
      sc.src = '/vendor/pdfjs/pdf.min.js';
      sc.onload = () => {
        if (window.pdfjsLib) {
          window.pdfjsLib.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/pdf.worker.min.js';
          resolve(window.pdfjsLib);
        } else reject(new Error('pdfjs unavailable'));
      };
      sc.onerror = () => reject(new Error('pdfjs failed to load'));
      document.head.appendChild(sc);
    });
  }
  return pdfjsPromise;
}

// ←/→ 翻页只作用于一个查看器（一页上有两份课件时不再同时翻）：最近点击 / 聚焦的那个；
// 都没有交互过时，作用于第一个处于幻灯片模式的查看器。
const viewers = new Map(); // id -> { slides: boolean }
let activeViewer = null;
let viewerSeq = 0;
const keyOwner = () => {
  if (activeViewer && viewers.has(activeViewer)) return activeViewer;
  for (const [id, v] of viewers) if (v.slides) return id;
  return null;
};
const typingTarget = (t) =>
  !!t && (t.isContentEditable || (t.closest && !!t.closest('video,audio,input,textarea,select,[contenteditable=""],[contenteditable="true"]')));

const hostOf = (url) => {
  try { return new URL(url).hostname; } catch { return ''; }
};

// View-only PDF reader (no browser toolbar, no download, context menu off).
// Two layouts, picked automatically from page 1's aspect ratio:
//  - landscape (converted PPT decks) → SLIDE mode: one page at a time with
//    ‹ › arrows, swipe on touch, ←/→ on keyboard — no endless scrolling;
//  - portrait (policy documents)      → stacked scroll with lazy rendering.
// Pages render at the device pixel ratio (capped 2×) — without that, HiDPI
// screens stretch a 1× bitmap and everything looks soft.
export default function PdfViewer({ url, note, media, watermark = false }) {
  const { lang } = useI18n();
  const pv = T[lang] || T.en;
  const { user } = useAuth();
  const wrapRef = useRef(null);   // scroll mode container
  const slideRef = useRef(null);  // slide mode canvas holder
  const rootRef = useRef(null);
  const mediaBoxRef = useRef(null);
  const playerRef = useRef(null);
  const [status, setStatus] = useState('loading'); // loading | ready | error
  const [mode, setMode] = useState('scroll');      // scroll | slides
  const [numPages, setNumPages] = useState(0);
  const [current, setCurrent] = useState(1);
  const [banner, setBanner] = useState(false);     // 播放器不在视口内时的「本页有视频 · 播放」
  // Mirrors `current` so prev/next read the latest page synchronously — rapid
  // clicks then accumulate instead of all seeing the same stale state value.
  const currentRef = useRef(1);
  const docRef = useRef(null);
  const slideToken = useRef(0);   // drops stale slide renders on rapid paging
  const touchX = useRef(null);
  const [full, setFull] = useState(false); // fullscreen slide overlay
  const fullRef = useRef(null);
  const fullRefState = useRef(false);      // mirrors `full` for async renders
  const navigated = useRef(false);         // 学员主动翻过页之后才自动播放
  const idRef = useRef(null);
  if (idRef.current == null) idRef.current = 'pv' + (++viewerSeq);
  const setPage = (n) => { currentRef.current = n; setCurrent(n); };

  // 水印文字（本人姓名 · 工号 · 日期）；drawPage 是异步的，读 ref 拿最新值
  const wmRef = useRef('');
  wmRef.current = watermark ? watermarkText(user) : '';

  // 5.7：本课件的视频（只认有页码的条目；页码超出总页数的忽略 —— 幻灯片与 PDF 页数对不上时的保护）
  const items = (Array.isArray(media) ? media : [])
    .map((m, i) => ({ ...m, idx: i + 1, pages: (Array.isArray(m && m.pages) ? m.pages : []).map(Number).filter((n) => n >= 1 && (!numPages || n <= numPages)) }))
    .filter((m) => m.pages.length > 0 && ['ready', 'processing', 'unavailable', 'external'].includes(m.status));
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const pageHasMedia = (n) => itemsRef.current.some((m) => m.pages.includes(n));

  const dprCap = () => Math.max(1, Math.min(2, window.devicePixelRatio || 1));

  // Render page n into a fresh canvas that FITS maxW×maxH CSS pixels but is
  // BACKED by ×dpr real pixels (the crispness fix).
  async function drawPage(doc, n, maxW, maxH, capScale) {
    const page = await doc.getPage(n);
    const base = page.getViewport({ scale: 1 });
    let cssScale = Math.min(capScale, (maxW - 2) / base.width);
    if (maxH) cssScale = Math.min(cssScale, (maxH - 2) / base.height);
    const dpr = dprCap();
    const vp = page.getViewport({ scale: cssScale * dpr });
    const canvas = document.createElement('canvas');
    canvas.className = 'pdfpage';
    canvas.width = Math.floor(vp.width);
    canvas.height = Math.floor(vp.height);
    canvas.style.width = Math.floor(vp.width / dpr) + 'px';
    canvas.style.height = Math.floor(vp.height / dpr) + 'px';
    const ctx = canvas.getContext('2d');
    await page.render({ canvasContext: ctx, viewport: vp }).promise;
    // 5.6 水印画进像素：截图、录屏、打印、全屏都带着，删 DOM 也去不掉
    if (wmRef.current) drawWatermark(ctx, vp.width / dpr, vp.height / dpr, dpr, wmRef.current);
    return canvas;
  }

  // ---- slide mode (renders into the inline holder, or the fullscreen one) ----
  async function showSlide(n) {
    const doc = docRef.current;
    const isFull = fullRefState.current;
    const holder = isFull ? fullRef.current : slideRef.current;
    if (!doc || !holder) return;
    const token = ++slideToken.current;
    setPage(n);
    const maxW = isFull ? window.innerWidth - 96 : holder.clientWidth || 720;
    // 全屏且本页有视频：给幻灯片下方的播放器留出高度
    const maxH = isFull ? window.innerHeight - 72 - (pageHasMedia(n) ? Math.min(window.innerHeight * 0.4, 360) : 0) : null;
    try {
      const canvas = await drawPage(doc, n, maxW, maxH, isFull ? 4 : 2.4);
      if (slideToken.current !== token) return;
      const target = fullRefState.current ? fullRef.current : slideRef.current;
      if (!target) return;
      target.innerHTML = '';
      target.appendChild(canvas);
      if (n < doc.numPages) doc.getPage(n + 1).catch(() => {}); // warm the next
    } catch { /* keep whatever is on screen */ }
  }

  const openFull = () => { fullRefState.current = true; setFull(true); requestAnimationFrame(() => showSlide(currentRef.current)); };
  const closeFull = () => { fullRefState.current = false; setFull(false); requestAnimationFrame(() => showSlide(currentRef.current)); };

  useEffect(() => {
    let cancelled = false;
    let renderIO = null;
    let trackIO = null;
    setStatus('loading');
    setNumPages(0);
    setPage(1);

    loadPdfjs()
      .then((pdfjs) => pdfjs.getDocument({ url, withCredentials: true }).promise)
      .then(async (doc) => {
        if (cancelled) return;
        docRef.current = doc;
        const first = await doc.getPage(1);
        if (cancelled) return;
        const fb = first.getViewport({ scale: 1 });
        setNumPages(doc.numPages);

        if (fb.width > fb.height) {
          // Landscape deck → slides. The holder mounts on the next frame.
          setMode('slides');
          setStatus('ready');
          requestAnimationFrame(() => { if (!cancelled) showSlide(1); });
          return;
        }

        // Portrait document → stacked lazy scroll.
        setMode('scroll');
        const container = wrapRef.current;
        if (!container) return;
        container.innerHTML = '';
        const width = container.clientWidth || 720;
        const slotH = Math.round(fb.height * Math.min(1.7, (width - 2) / fb.width));
        const live = new Map(); // n -> slot, pages whose canvas is in the DOM

        const renderSlot = async (n, slot) => {
          if (cancelled || live.has(n)) return;
          live.set(n, slot);
          try {
            const canvas = await drawPage(doc, n, width, null, 1.7);
            if (cancelled || !live.has(n)) return;
            slot.innerHTML = '';
            slot.style.minHeight = '';
            slot.appendChild(canvas);
          } catch {
            live.delete(n);
            return;
          }
          // Memory guard for long documents: keep ~8 hi-res canvases. Only
          // release pages far OUTSIDE the observer margin, so scrolling back
          // is guaranteed to fire a fresh intersection and re-render them.
          if (live.size > 8) {
            for (const [m, sl] of live) {
              if (live.size <= 8) break;
              if (Math.abs(m - currentRef.current) <= 2) continue;
              const r = sl.getBoundingClientRect();
              if (r.bottom < -1400 || r.top > window.innerHeight + 1400) {
                live.delete(m);
                sl.innerHTML = '';
                sl.style.minHeight = slotH + 'px';
              }
            }
          }
        };

        // Render when a page nears the viewport (~a screen away).
        renderIO = new IntersectionObserver((entries) => {
          for (const e of entries) {
            if (e.isIntersecting) renderSlot(Number(e.target.dataset.page), e.target);
          }
        }, { rootMargin: '1200px 0px' });
        // Keep the "n / total" counter in step with what you're looking at.
        trackIO = new IntersectionObserver((entries) => {
          for (const e of entries) {
            if (e.isIntersecting && e.intersectionRatio >= 0.5) setPage(Number(e.target.dataset.page));
          }
        }, { threshold: [0.5] });

        for (let i = 1; i <= doc.numPages; i++) {
          const slot = document.createElement('div');
          slot.className = 'pdfslot';
          slot.dataset.page = String(i);
          slot.style.minHeight = slotH + 'px';
          container.appendChild(slot);
          renderIO.observe(slot);
          trackIO.observe(slot);
        }
        if (!cancelled) setStatus('ready');
      })
      .catch(() => { if (!cancelled) setStatus('error'); });

    return () => {
      cancelled = true;
      slideToken.current++;
      if (renderIO) renderIO.disconnect();
      if (trackIO) trackIO.disconnect();
      docRef.current = null;
    };
  }, [url]); // eslint-disable-line react-hooks/exhaustive-deps

  const go = (n) => {
    const clamped = Math.max(1, Math.min(numPages, n));
    if (mode === 'slides') {
      navigated.current = true;
      if (clamped !== currentRef.current) showSlide(clamped);
      return;
    }
    setPage(clamped); // instant counter feedback; the scroll observer confirms it
    const slot = wrapRef.current && wrapRef.current.querySelector(`.pdfslot[data-page="${clamped}"]`);
    if (slot) slot.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  // 键盘翻页的归属登记（见文件顶部 keyOwner）
  useEffect(() => {
    const id = idRef.current;
    viewers.set(id, { slides: mode === 'slides' && status === 'ready' });
    return () => {
      viewers.delete(id);
      if (activeViewer === id) activeViewer = null;
    };
  }, [mode, status]);
  const claimKeys = () => { activeViewer = idRef.current; };

  // ←/→ page the deck, Esc leaves fullscreen (ignored while typing or inside a player).
  useEffect(() => {
    if (mode !== 'slides' || status !== 'ready') return;
    const onKey = (e) => {
      if (e.key === 'Escape' && fullRefState.current) { closeFull(); return; }
      if (typingTarget(e.target)) return;
      if (!fullRefState.current && keyOwner() !== idRef.current) return;
      if (e.key === 'ArrowRight') go(currentRef.current + 1);
      else if (e.key === 'ArrowLeft') go(currentRef.current - 1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [mode, status, numPages]); // eslint-disable-line react-hooks/exhaustive-deps

  // Fullscreen: lock body scroll, re-fit the slide when the window resizes.
  useEffect(() => {
    if (!full) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    let t = null;
    const onResize = () => { clearTimeout(t); t = setTimeout(() => showSlide(currentRef.current), 150); };
    window.addEventListener('resize', onResize);
    return () => {
      document.body.style.overflow = prev;
      clearTimeout(t);
      window.removeEventListener('resize', onResize);
    };
  }, [full]); // eslint-disable-line react-hooks/exhaustive-deps

  // 5.7 自动播放：学员翻到有视频的页时，只在播放器至少一半在视口内（或全屏）才自动播放；
  // 否则在幻灯片下方给「本页有视频 · 播放」提示，点后滚到播放器并播放。被浏览器拦截时播放器自己出「播放」按钮。
  const curItems = mode === 'slides' ? items.filter((m) => m.pages.includes(current)) : [];
  const firstReady = curItems.find((m) => m.status === 'ready' && m.src) || null;
  const firstReadyId = firstReady ? firstReady.id : null;
  useEffect(() => {
    setBanner(false);
    if (mode !== 'slides' || !firstReadyId) return;
    const raf = requestAnimationFrame(() => {
      const box = mediaBoxRef.current;
      let visible = full;
      if (!visible && box) {
        const r = box.getBoundingClientRect();
        const vh = window.innerHeight || document.documentElement.clientHeight;
        const shown = Math.max(0, Math.min(r.bottom, vh) - Math.max(r.top, 0));
        visible = r.height > 0 && shown / r.height >= 0.5;
      }
      if (!navigated.current && !full) { if (!visible) setBanner(true); return; }
      if (visible && playerRef.current) playerRef.current.play();
      else setBanner(true);
    });
    return () => cancelAnimationFrame(raf);
  }, [current, firstReadyId, mode, full]);

  const playFromBanner = () => {
    const box = mediaBoxRef.current;
    if (box) box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    setBanner(false);
    if (playerRef.current) playerRef.current.play();
  };

  const onTouchStart = (e) => { touchX.current = e.touches[0].clientX; };
  const onTouchEnd = (e) => {
    if (touchX.current == null) return;
    const dx = e.changedTouches[0].clientX - touchX.current;
    touchX.current = null;
    if (Math.abs(dx) > 45) go(currentRef.current + (dx < 0 ? 1 : -1));
  };

  // 一条视频的呈现（就绪 → 播放器；处理中 / 失败 → 说明；外部链接 → 新窗口链接）
  const renderItem = (m, opts = {}) => {
    const label = pv.videoLabel(m.idx);
    if (m.status === 'ready' && m.src) {
      return (
        <WatermarkedVideo
          key={m.id + ':' + (opts.page || 0) + (opts.full ? ':f' : '')}
          ref={opts.primary ? playerRef : undefined}
          src={m.src}
          label={label}
          className="pv-media-player"
        />
      );
    }
    if (m.status === 'external' && m.url && /^https?:\/\//i.test(m.url)) {
      return (
        <a key={m.id} className="btn ghost pv-media-link" href={m.url} target="_blank" rel="noopener noreferrer">
          {pv.mediaExternal(hostOf(m.url))}
        </a>
      );
    }
    if (m.status === 'processing') return <div key={m.id} className="pv-media-wait">{label} · {pv.mediaWait}</div>;
    return <div key={m.id} className="pv-media-wait is-fail">{label} · {pv.mediaFail}</div>;
  };

  const slideMedia = (isFull) => curItems.length > 0 && (
    <div className="pv-media" ref={isFull === full ? mediaBoxRef : undefined}>
      {curItems.map((m) => renderItem(m, { page: current, full: isFull, primary: firstReady && m.id === firstReady.id }))}
    </div>
  );

  // 课件内视频索引：每条可点，跳到所在页
  const indexRow = items.length > 0 && status === 'ready' && (
    <div className="pv-media-index">
      <span>{pv.mediaIndex}</span>
      {items.map((m, i) => (
        <span key={m.id || i}>
          {i > 0 && <span aria-hidden="true"> · </span>}
          <button type="button" className="link-btn" onClick={() => go(m.pages[0])}>
            {pv.mediaSlide(m.pages[0])}{m.status === 'external' ? pv.mediaExternalTag : ''}
          </button>
        </span>
      ))}
    </div>
  );

  const curHasMedia = mode === 'slides' && curItems.length > 0;

  return (
    <div
      ref={rootRef}
      className={'pdfviewer' + (items.length > 0 ? ' has-media' : '')}
      onContextMenu={(e) => e.preventDefault()}
      onPointerDown={claimKeys}
      onFocus={claimKeys}
      tabIndex={mode === 'slides' ? 0 : undefined}
    >
      {watermark && <span className="wm-sr">{pv.wmAria}</span>}
      {mode === 'slides' ? (
        <div className="pdfslides" onTouchStart={onTouchStart} onTouchEnd={onTouchEnd}>
          <div className="pdfslide-holder" ref={slideRef} />
          <button type="button" className="pdfslide-arr left" onClick={() => go(currentRef.current - 1)} disabled={current <= 1} aria-label={pv.prev}>‹</button>
          <button type="button" className="pdfslide-arr right" onClick={() => go(currentRef.current + 1)} disabled={current >= numPages} aria-label={pv.next}>›</button>
          <button type="button" className="pdfslide-fs" onClick={openFull} aria-label={pv.fs} title={pv.fs}>⛶</button>
        </div>
      ) : (
        <div className="pdfviewer-pages" ref={wrapRef} />
      )}
      {full && (
        <div
          className={'pdffull' + (curHasMedia ? ' has-media' : '')}
          onClick={(e) => { if (e.target === e.currentTarget) closeFull(); }}
          onTouchStart={onTouchStart} onTouchEnd={onTouchEnd}
          role="dialog" aria-label={pv.fs}
        >
          <button type="button" className="pdffull-close" onClick={closeFull} aria-label={pv.fsClose}>✕</button>
          <button type="button" className="pdfslide-arr pdffull-arr left" onClick={() => go(currentRef.current - 1)} disabled={current <= 1} aria-label={pv.prev}>‹</button>
          <div className="pdffull-stack">
            <div className="pdffull-holder" ref={fullRef} />
            {slideMedia(true)}
          </div>
          <button type="button" className="pdfslide-arr pdffull-arr right" onClick={() => go(currentRef.current + 1)} disabled={current >= numPages} aria-label={pv.next}>›</button>
          <div className="pdffull-count tnum">{current} / {numPages}</div>
        </div>
      )}
      {status === 'loading' && <div className="pdfviewer-state">…</div>}
      {status === 'error' && <div className="pdfviewer-state pdfviewer-err"><IcWarn /> {pv.err}</div>}
      {status === 'ready' && numPages > 1 && (
        <div className="pdfpager" role="group" aria-label={pv.nav}>
          <button type="button" onClick={() => go(currentRef.current - 1)} disabled={current <= 1} aria-label={pv.prev}>‹</button>
          <span className="pdfpager-count tnum">
            {current} / {numPages}
            {curHasMedia && <><span className="pv-dot" aria-hidden="true" /><span className="wm-sr">{pv.mediaHasVideo}</span></>}
          </span>
          <button type="button" onClick={() => go(currentRef.current + 1)} disabled={current >= numPages} aria-label={pv.next}>›</button>
        </div>
      )}
      {banner && !full && firstReady && (
        <button type="button" className="pv-media-banner" onClick={playFromBanner}>
          <svg className="ic sm" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z" /></svg>
          {pv.mediaBanner}
        </button>
      )}
      {!full && slideMedia(false)}
      {/* 竖版文档（滚动模式）很少有视频：不自动播放，按索引列出，学员自己点播放 */}
      {mode === 'scroll' && items.length > 0 && (
        <div className="pv-media pv-media-list">
          {items.map((m) => (
            <div key={m.id} className="pv-media-item">
              <div className="pv-media-cap">{pv.mediaSlide(m.pages[0])}</div>
              {renderItem(m, { page: m.pages[0] })}
            </div>
          ))}
        </div>
      )}
      {indexRow}
      {note && <div className="locknote">{note}</div>}
    </div>
  );
}
