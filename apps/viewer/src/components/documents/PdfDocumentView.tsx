/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Paged PDF reader (D-075) — the document-tab body for `kind: 'document'`
 * (and uncalibrated drawings opened as plain files).
 *
 * Memory is the design constraint (the viewer shares one process with the
 * WebGPU scene + underlay textures), so this is a virtualized page list, not
 * a render-everything view: pages mount as aspect-ratio placeholders and only
 * the ones near the viewport are rasterized (IntersectionObserver), with a
 * pixel-budgeted LRU of live canvases. Rasters follow the zoom up to
 * READ_RASTER_MAX_PX so drawings stay sharp when zoomed in, still below the
 * plan pane's texture ceiling. ImageBitmaps are closed right
 * after drawImage, and unmounting (tab switch) drops every canvas — only the
 * lightweight view state (page / zoom) survives in the store.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { Minus, Plus } from 'lucide-react';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { Button } from '@/components/ui/button';
import { useViewerStore } from '@/store';
import {
  openPdfDocument,
  rasterizePdfPage,
  rasterizePdfRegion,
  renderPdfTextLayer,
} from '@/lib/pdf/rasterize';
import { PageIdentifierLinks } from './PageIdentifierLinks';

/**
 * Raster ceiling (longest edge, device px). Deep zoom into drawings needs
 * real resolution — beyond this the canvas is CSS-upscaled (soft). 4096 is
 * safe on every GPU/canvas backend; memory is held in check by the visible
 * ±1 window plus the pixel-budget LRU below, so the worst case is a couple
 * of ~12 MP canvases, not one per page.
 */
const READ_RASTER_MAX_PX = 4096;
/** Live-canvas budget: total detached pixels the LRU may retain (~128 MB
 *  RGBA), plus a count cap so hundreds of tiny thumbnails can't pile up. */
const CANVAS_LRU_BUDGET_PX = 32_000_000;
const CANVAS_LRU_MAX_COUNT = 12;
const PAGE_GAP_PX = 12;
const ZOOM_MIN = 0.5;
const ZOOM_MAX = 16;
/** Trailing debounce before committing a new raster width (CSS scales until). */
const RASTER_SETTLE_MS = 200;
/**
 * Sharp-crop overlay ("vector zoom"): once the zoom outgrows the base
 * raster's ceiling, the VISIBLE crop of the page is re-rendered from the PDF
 * vectors at the exact device scale and layered over the base canvas — so
 * any zoom level reads crisp, like a native PDF viewer. The crop extends one
 * margin beyond the viewport to tolerate small pans; each edge is capped so
 * a single overlay can never exceed one safe canvas.
 */
const SHARP_CROP_MARGIN = 0.5;
const SHARP_CROP_MAX_PX = 4096;

interface PdfDocumentViewProps {
  docId: string;
  url: string;
}

export function PdfDocumentView({ docId, url }: PdfDocumentViewProps) {
  const setDocTabView = useViewerStore((s) => s.setDocTabView);
  // Initial view snapshot only — live view writes must not re-render/loop us.
  const initialViewRef = useRef(
    useViewerStore.getState().docTabs.find((t) => t.docId === docId)?.view,
  );

  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [numPages, setNumPages] = useState(0);
  /** Page aspect (w/h): index 0 = document default, refined per page. */
  const [aspects, setAspects] = useState<ReadonlyMap<number, number>>(new Map());
  const defaultAspect = aspects.get(0) ?? 1 / 1.414;

  const [zoom, setZoom] = useState(initialViewRef.current?.zoom ?? 1);
  const [currentPage, setCurrentPage] = useState(initialViewRef.current?.page ?? 1);

  // ── Document lifecycle ────────────────────────────────────────────────────
  useEffect(() => {
    let stale = false;
    let doc: PDFDocumentProxy | null = null;
    void (async () => {
      try {
        const opened = await openPdfDocument(url);
        if (stale) {
          // Unmounted while downloading — the cleanup below saw doc === null,
          // so this instance must release the proxy itself.
          void opened.destroy();
          return;
        }
        doc = opened;
        const first = await doc.getPage(1);
        const vp = first.getViewport({ scale: 1 });
        if (stale) return; // cleanup owns doc now — it will destroy it
        setAspects(new Map([[0, vp.width / vp.height]]));
        setNumPages(doc.numPages);
        setPdf(doc);
      } catch (err) {
        console.error('pdf document view: open failed', err);
        if (!stale) setError('Could not open this PDF.');
      }
    })();
    return () => {
      stale = true;
      void doc?.destroy();
      setPdf(null);
      // This document's rasters are useless without its proxy; children have
      // already detached their canvases (child cleanups run first), so every
      // disconnected LRU entry is safe to release.
      lruClearDisconnected();
    };
  }, [url]);

  // ── Layout: fit-width base, explicit page heights for virtualization ─────
  const scrollRef = useRef<HTMLDivElement>(null);
  const [bodyWidth, setBodyWidth] = useState(0);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      const r = entries[0]?.contentRect;
      if (r) setBodyWidth(r.width);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  /** Layout width (immediate — placeholders and CSS scale follow this). */
  const pageWidth = Math.max(0, (bodyWidth - 24) * zoom);
  /** Raster width (debounced — pdf.js renders only once a gesture settles). */
  const [rasterWidth, setRasterWidth] = useState(0);
  useEffect(() => {
    if (pageWidth <= 0) return;
    if (rasterWidth === 0) {
      setRasterWidth(pageWidth); // first layout: no gesture to wait out
      return;
    }
    const timer = setTimeout(() => setRasterWidth(pageWidth), RASTER_SETTLE_MS);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageWidth]);

  // ── Visibility tracking (virtualization) ─────────────────────────────────
  const [visible, setVisible] = useState<ReadonlySet<number>>(new Set());
  const pageElsRef = useRef(new Map<number, HTMLDivElement>());
  const observerRef = useRef<IntersectionObserver | null>(null);
  useEffect(() => {
    const root = scrollRef.current;
    if (!root || numPages === 0) return;
    const observer = new IntersectionObserver(
      (entries) => {
        setVisible((prev) => {
          const next = new Set(prev);
          for (const e of entries) {
            const page = Number((e.target as HTMLElement).dataset.page);
            if (!page) continue;
            if (e.isIntersecting) next.add(page);
            else next.delete(page);
          }
          return next;
        });
      },
      // One viewport of lookahead in both directions — the "±1 page" window
      // expressed in scroll space, so tall zoom levels don't over-rasterize.
      { root, rootMargin: '100% 0%' },
    );
    observerRef.current = observer;
    for (const el of pageElsRef.current.values()) observer.observe(el);
    return () => {
      observer.disconnect();
      observerRef.current = null;
    };
  }, [numPages]);

  const registerPageEl = useCallback((page: number, el: HTMLDivElement | null) => {
    const prev = pageElsRef.current.get(page);
    if (prev && observerRef.current) observerRef.current.unobserve(prev);
    if (el) {
      pageElsRef.current.set(page, el);
      observerRef.current?.observe(el);
    } else {
      pageElsRef.current.delete(page);
    }
  }, []);

  const onPageAspect = useCallback((page: number, aspect: number) => {
    setAspects((prev) => {
      if (prev.get(page) === aspect) return prev;
      const next = new Map(prev);
      next.set(page, aspect);
      return next;
    });
  }, []);

  // ── Current page = topmost page at the viewport top (scroll-derived; the
  // IntersectionObserver set is inflated by its lookahead margin and would
  // report a page up to one viewport above the one actually being read).
  useEffect(() => {
    const root = scrollRef.current;
    if (!root || numPages === 0) return;
    let raf = 0;
    const measure = () => {
      raf = 0;
      // "The" page is the one under the reading line (top third of the
      // viewport); when the line falls into a gap, the next page below it.
      const line = root.getBoundingClientRect().top + root.clientHeight / 3;
      let atLine: number | null = null;
      let firstBelow: number | null = null;
      for (const [page, el] of pageElsRef.current) {
        const r = el.getBoundingClientRect();
        if (r.top <= line && r.bottom > line) {
          atLine = page;
          break;
        }
        if (r.bottom > line && (firstBelow === null || page < firstBelow)) firstBelow = page;
      }
      const next = atLine ?? firstBelow ?? 1;
      setCurrentPage((prev) => (prev === next ? prev : next));
    };
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(measure);
    };
    root.addEventListener('scroll', onScroll, { passive: true });
    measure();
    return () => {
      root.removeEventListener('scroll', onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [numPages]);

  // Scroll-settle tick for the sharp-crop overlays: pages re-render their
  // visible crop only once panning pauses, not per scroll frame.
  const [viewportTick, setViewportTick] = useState(0);
  useEffect(() => {
    const root = scrollRef.current;
    if (!root) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onScroll = () => {
      clearTimeout(timer);
      timer = setTimeout(() => setViewportTick((t) => t + 1), RASTER_SETTLE_MS);
    };
    root.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      root.removeEventListener('scroll', onScroll);
      clearTimeout(timer);
    };
  }, []);

  // Persist view state, debounced — every ctrl+wheel tick would otherwise
  // rebuild docTabs (and re-render the whole pane tree) per event.
  useEffect(() => {
    const timer = setTimeout(() => setDocTabView(docId, { page: currentPage, zoom }), 300);
    return () => clearTimeout(timer);
  }, [docId, currentPage, zoom, setDocTabView]);

  // Restore: jump to the remembered page once sizes are known.
  const restoredRef = useRef(false);
  useEffect(() => {
    if (restoredRef.current || !pdf || pageWidth <= 0) return;
    restoredRef.current = true;
    const page = initialViewRef.current?.page ?? 1;
    if (page > 1) pageElsRef.current.get(page)?.scrollIntoView({ block: 'start' });
  }, [pdf, pageWidth]);

  // Deep-link jump for an ALREADY-open tab (DOCUMENT_OPEN with a page): the
  // store view is only read at mount, so jumps arrive as one-shot requests.
  const docJump = useViewerStore((s) => s.docJump);
  const clearDocJump = useViewerStore((s) => s.clearDocJump);
  useEffect(() => {
    if (!docJump || docJump.docId !== docId || !pdf) return;
    pageElsRef.current.get(docJump.page)?.scrollIntoView({ block: 'start' });
    clearDocJump();
  }, [docJump, docId, pdf, clearDocJump]);

  // ── Zoom (buttons, ctrl/cmd-wheel, touch pinch, double-tap) ─────────────
  // Every path funnels through zoomTo, which records an anchor (the point
  // that must stay put: cursor, pinch midpoint, or viewport center); the
  // layout effect below re-projects the scroll offsets right after the new
  // page width commits, so zooming never "runs away" from the target.
  const zoomRef = useRef(zoom);
  const pendingAnchorRef = useRef<{
    clientX: number;
    clientY: number;
    contentX: number;
    contentY: number;
    prevZoom: number;
    nextZoom: number;
  } | null>(null);

  const zoomTo = useCallback((target: number, clientX?: number, clientY?: number) => {
    const prev = zoomRef.current;
    const next = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, target));
    if (next === prev) return;
    const root = scrollRef.current;
    if (root) {
      const rect = root.getBoundingClientRect();
      const cx = clientX ?? rect.left + rect.width / 2;
      const cy = clientY ?? rect.top + rect.height / 2;
      pendingAnchorRef.current = {
        clientX: cx,
        clientY: cy,
        contentX: root.scrollLeft + (cx - rect.left),
        contentY: root.scrollTop + (cy - rect.top),
        prevZoom: prev,
        nextZoom: next,
      };
    }
    // Eager ref update keeps rapid wheel/pinch events compounding correctly
    // even before React commits the state.
    zoomRef.current = next;
    setZoom(next);
  }, []);

  const applyZoom = useCallback(
    (factor: number, clientX?: number, clientY?: number) =>
      zoomTo(zoomRef.current * factor, clientX, clientY),
    [zoomTo],
  );

  useLayoutEffect(() => {
    const a = pendingAnchorRef.current;
    const root = scrollRef.current;
    if (!a || !root || a.nextZoom !== zoom) return;
    pendingAnchorRef.current = null;
    // Content scales ~linearly with zoom (constant padding is negligible).
    const rect = root.getBoundingClientRect();
    const r = a.nextZoom / a.prevZoom;
    root.scrollLeft = a.contentX * r - (a.clientX - rect.left);
    root.scrollTop = a.contentY * r - (a.clientY - rect.top);
  }, [zoom]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return; // plain wheel scrolls the list
      e.preventDefault();
      applyZoom(Math.exp(-e.deltaY * 0.0018), e.clientX, e.clientY);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [applyZoom]);

  // Touch: two-finger pinch drives OUR zoom (sharp re-raster + crop overlay)
  // instead of the browser's page zoom, which can only blur the bitmap —
  // `touch-action: pan-x pan-y` on the scroller keeps one-finger scrolling
  // native but hands the pinch to these handlers; the webkit gesture events
  // are cancelled so iOS Safari can't hijack it either. A quick double-tap
  // toggles fit-width ↔ 3× at the tapped spot (manual detection: dblclick
  // would also fire for desktop double-clicks that should select text).
  const touchesRef = useRef(new Map<number, { x: number; y: number }>());
  const pinchRef = useRef<{ dist: number; zoom: number } | null>(null);
  const lastTapRef = useRef<{ t: number; x: number; y: number } | null>(null);

  const onTouchPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (e.pointerType !== 'touch') return;
    touchesRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (touchesRef.current.size === 2) {
      const [a, b] = [...touchesRef.current.values()];
      pinchRef.current = { dist: Math.hypot(a.x - b.x, a.y - b.y), zoom: zoomRef.current };
      lastTapRef.current = null; // a pinch is not a tap
    }
  }, []);

  const onTouchPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (e.pointerType !== 'touch' || !touchesRef.current.has(e.pointerId)) return;
      touchesRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
      const pinch = pinchRef.current;
      if (!pinch || touchesRef.current.size < 2) return;
      const [a, b] = [...touchesRef.current.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      if (dist <= 0 || pinch.dist <= 0) return;
      zoomTo(pinch.zoom * (dist / pinch.dist), (a.x + b.x) / 2, (a.y + b.y) / 2);
    },
    [zoomTo],
  );

  const onTouchPointerEnd = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (e.pointerType !== 'touch') return;
      const wasPinch = pinchRef.current !== null;
      touchesRef.current.delete(e.pointerId);
      if (touchesRef.current.size < 2) pinchRef.current = null;
      // Double-tap detection (single-finger taps only).
      if (wasPinch || e.type !== 'pointerup') return;
      const now = performance.now();
      const last = lastTapRef.current;
      if (last && now - last.t < 350 && Math.hypot(e.clientX - last.x, e.clientY - last.y) < 30) {
        lastTapRef.current = null;
        if (zoomRef.current < 1.5) zoomTo(3, e.clientX, e.clientY);
        else zoomTo(1);
      } else {
        lastTapRef.current = { t: now, x: e.clientX, y: e.clientY };
      }
    },
    [zoomTo],
  );

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    // iOS Safari's proprietary pinch pipeline — cancel it inside the reader
    // so the pinch always reaches the pointer handlers above.
    const cancel = (e: Event) => e.preventDefault();
    el.addEventListener('gesturestart', cancel);
    el.addEventListener('gesturechange', cancel);
    return () => {
      el.removeEventListener('gesturestart', cancel);
      el.removeEventListener('gesturechange', cancel);
    };
  }, []);

  const pages = useMemo(
    () => Array.from({ length: numPages }, (_, i) => i + 1),
    [numPages],
  );

  return (
    <div className="flex h-full w-full flex-col overflow-hidden">
      <div className="flex items-center gap-1.5 border-b px-2 py-1">
        <span className="text-[11px] tabular-nums text-muted-foreground">
          {numPages > 0 ? `${currentPage} / ${numPages}` : '…'}
        </span>
        <div className="flex-1" />
        <Button
          variant="ghost"
          size="icon"
          className="size-5"
          onClick={() => applyZoom(1 / 1.25)}
          aria-label="Zoom out"
        >
          <Minus className="size-3" aria-hidden />
        </Button>
        <span className="w-9 text-center text-[11px] tabular-nums text-muted-foreground">
          {Math.round(zoom * 100)}%
        </span>
        <Button
          variant="ghost"
          size="icon"
          className="size-5"
          onClick={() => applyZoom(1.25)}
          aria-label="Zoom in"
        >
          <Plus className="size-3" aria-hidden />
        </Button>
      </div>
      <div
        ref={scrollRef}
        className="min-h-0 flex-1 overflow-auto bg-muted/30"
        style={{ touchAction: 'pan-x pan-y' }}
        onPointerDown={onTouchPointerDown}
        onPointerMove={onTouchPointerMove}
        onPointerUp={onTouchPointerEnd}
        onPointerCancel={onTouchPointerEnd}
      >
        {error ? (
          <div className="flex h-full items-center justify-center p-6 text-center text-[11px] text-muted-foreground">
            {error}
          </div>
        ) : (
          <div className="mx-auto flex w-fit flex-col items-center px-3 py-3">
            {pdf &&
              pageWidth > 0 &&
              pages.map((page) => (
                <PdfPage
                  key={page}
                  pdf={pdf}
                  page={page}
                  docId={docId}
                  width={pageWidth}
                  rasterWidth={rasterWidth || pageWidth}
                  aspect={aspects.get(page) ?? defaultAspect}
                  render={visible.has(page)}
                  viewportTick={viewportTick}
                  scrollRootRef={scrollRef}
                  onAspect={onPageAspect}
                  registerEl={registerPageEl}
                />
              ))}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Shared LRU of live page canvases. The pane shows ONE document at a time,
 * so a module-level LRU capped at {@link CANVAS_LRU_BUDGET_PX} detached
 * pixels (and {@link CANVAS_LRU_MAX_COUNT} entries) is
 * the memory budget; canvases still mounted in the DOM are never evicted
 * (blanking a visible page), and the document-lifecycle cleanup releases all
 * detached entries when a tab unmounts.
 */
const canvasLru = new Map<string, HTMLCanvasElement>();

function lruGet(key: string): HTMLCanvasElement | undefined {
  const hit = canvasLru.get(key);
  if (hit) {
    canvasLru.delete(key);
    canvasLru.set(key, hit); // refresh recency
  }
  return hit;
}

function lruRelease(key: string, canvas: HTMLCanvasElement): void {
  canvasLru.delete(key);
  // Release the backing store eagerly — GC alone is too lazy for ~20 MB
  // canvases while the WebGPU scene is competing for the same memory.
  canvas.width = 0;
  canvas.height = 0;
}

function lruDetachedPixels(): number {
  let total = 0;
  for (const c of canvasLru.values()) {
    if (!c.isConnected) total += c.width * c.height;
  }
  return total;
}

function lruPut(key: string, canvas: HTMLCanvasElement): void {
  canvasLru.set(key, canvas);
  // Pixel budget instead of a fixed count: one deep-zoom canvas weighs as
  // much as dozens of fit-width pages, so the budget adapts — a couple of
  // ~12 MP rasters at high zoom, many small ones while skimming.
  let overBudget = lruDetachedPixels() > CANVAS_LRU_BUDGET_PX;
  let overCount = canvasLru.size > CANVAS_LRU_MAX_COUNT;
  if (!overBudget && !overCount) return;
  for (const [k, c] of canvasLru) {
    if (!overBudget && !overCount) break;
    if (k === key || c.isConnected) continue; // never blank a mounted page
    lruRelease(k, c);
    overBudget = lruDetachedPixels() > CANVAS_LRU_BUDGET_PX;
    overCount = canvasLru.size > CANVAS_LRU_MAX_COUNT;
  }
}

/** Drop every detached entry — called when a PDF tab unmounts. */
function lruClearDisconnected(): void {
  for (const [k, c] of canvasLru) {
    if (!c.isConnected) lruRelease(k, c);
  }
}

interface PdfPageProps {
  pdf: PDFDocumentProxy;
  page: number;
  /** Owning document id (identifier links prefer this doc's storey). */
  docId: string;
  /** Layout width (immediate; CSS scales a stale raster until it settles). */
  width: number;
  /** Debounced width the raster is computed from. */
  rasterWidth: number;
  aspect: number;
  render: boolean;
  /** Bumps once panning settles — schedules a sharp-crop re-render. */
  viewportTick: number;
  scrollRootRef: RefObject<HTMLDivElement | null>;
  onAspect: (page: number, aspect: number) => void;
  registerEl: (page: number, el: HTMLDivElement | null) => void;
}

function PdfPage({
  pdf,
  page,
  docId,
  width,
  rasterWidth,
  aspect,
  render,
  viewportTick,
  scrollRootRef,
  onAspect,
  registerEl,
}: PdfPageProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const outerRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLCanvasElement | null>(null);
  const removeOverlay = useCallback(() => {
    const overlay = overlayRef.current;
    overlayRef.current = null;
    if (!overlay) return;
    overlay.remove();
    overlay.width = 0;
    overlay.height = 0;
  }, []);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || !render || rasterWidth <= 0) return;
    let stale = false;
    // The reader is width-fit, but rasterizePdfPage bounds the LONGEST edge —
    // for a portrait page that edge is the height, so a width-derived target
    // must be scaled up by h/w or the raster comes out narrower than the
    // layout box and CSS-upscales into blur. The aspect refines lazily; the
    // effect deps include it, so the raster follows the correction.
    const wantedWidthPx = rasterWidth * window.devicePixelRatio;
    const wantedLongestPx = aspect < 1 ? wantedWidthPx / aspect : wantedWidthPx;
    // Bucketed to 512 px steps so small zoom nudges reuse the cached canvas.
    const targetPx = Math.min(
      READ_RASTER_MAX_PX,
      Math.ceil(wantedLongestPx / 512) * 512,
    );
    const key = `${pdf.fingerprints[0] ?? 'doc'}:${page}:${targetPx}`;
    const cached = lruGet(key);
    if (cached) {
      styleCanvas(cached);
      host.replaceChildren(cached);
      return () => host.replaceChildren();
    }
    void (async () => {
      try {
        const raster = await rasterizePdfPage(pdf, page, targetPx, READ_RASTER_MAX_PX);
        if (stale) {
          raster.image.close();
          return;
        }
        const canvas = document.createElement('canvas');
        canvas.width = raster.width;
        canvas.height = raster.height;
        canvas.getContext('2d')?.drawImage(raster.image, 0, 0);
        raster.image.close();
        onAspect(page, raster.width / raster.height);
        styleCanvas(canvas);
        lruPut(key, canvas);
        if (!stale && hostRef.current) hostRef.current.replaceChildren(canvas);
      } catch (err) {
        console.error(`pdf document view: page ${page} raster failed`, err);
      }
    })();
    return () => {
      stale = true;
      host.replaceChildren();
    };
    // `aspect` is a real input (portrait scaling above): a lazily refined
    // aspect re-rasters only pages whose orientation differs from page 1 —
    // those need the corrected raster anyway.
  }, [pdf, page, rasterWidth, aspect, render, onAspect]);

  // ── Sharp-crop overlay: true "vector zoom". When the layout outgrows the
  // base raster (density < 1), re-render the visible crop from the PDF
  // vectors at the exact device scale and pin it over the base canvas.
  useEffect(() => {
    const outer = outerRef.current;
    const root = scrollRootRef.current;
    if (!outer || !root || !render || rasterWidth <= 0) {
      removeOverlay();
      return;
    }
    let stale = false;
    void (async () => {
      const dpr = window.devicePixelRatio;
      const pageRect = outer.getBoundingClientRect();
      const rootRect = root.getBoundingClientRect();
      if (pageRect.width <= 0) return;
      // Base sharp enough? (base canvas device width vs needed device width)
      const baseCanvas = hostRef.current?.querySelector('canvas');
      const neededDeviceW = pageRect.width * dpr;
      if (baseCanvas && baseCanvas.width >= neededDeviceW * 0.98) {
        removeOverlay();
        return;
      }
      // Visible intersection in page-local CSS coords, padded by the margin.
      const marginX = rootRect.width * SHARP_CROP_MARGIN;
      const marginY = rootRect.height * SHARP_CROP_MARGIN;
      let x0 = Math.max(0, rootRect.left - marginX - pageRect.left);
      let y0 = Math.max(0, rootRect.top - marginY - pageRect.top);
      let x1 = Math.min(pageRect.width, rootRect.right + marginX - pageRect.left);
      let y1 = Math.min(pageRect.height, rootRect.bottom + marginY - pageRect.top);
      if (x1 <= x0 || y1 <= y0) {
        removeOverlay();
        return;
      }
      // Per-edge canvas cap — shrink the margin, keeping the visible center.
      const capCss = SHARP_CROP_MAX_PX / dpr;
      if (x1 - x0 > capCss) {
        const cx = (Math.max(x0, rootRect.left - pageRect.left) + Math.min(x1, rootRect.right - pageRect.left)) / 2;
        x0 = Math.max(0, cx - capCss / 2);
        x1 = Math.min(pageRect.width, x0 + capCss);
      }
      if (y1 - y0 > capCss) {
        const cy = (Math.max(y0, rootRect.top - pageRect.top) + Math.min(y1, rootRect.bottom - pageRect.top)) / 2;
        y0 = Math.max(0, cy - capCss / 2);
        y1 = Math.min(pageRect.height, y0 + capCss);
      }
      try {
        const pdfPage = await pdf.getPage(page);
        if (stale) return;
        const basePts = pdfPage.getViewport({ scale: 1 });
        const pixelsPerPoint = neededDeviceW / basePts.width;
        const region = await rasterizePdfRegion(pdf, page, pixelsPerPoint, {
          x: x0 * dpr,
          y: y0 * dpr,
          width: (x1 - x0) * dpr,
          height: (y1 - y0) * dpr,
        });
        if (stale) {
          region.image.close();
          return;
        }
        const canvas = document.createElement('canvas');
        canvas.width = region.width;
        canvas.height = region.height;
        canvas.getContext('2d')?.drawImage(region.image, 0, 0);
        region.image.close();
        canvas.style.position = 'absolute';
        canvas.style.left = `${(x0 / pageRect.width) * 100}%`;
        canvas.style.top = `${(y0 / pageRect.height) * 100}%`;
        canvas.style.width = `${((x1 - x0) / pageRect.width) * 100}%`;
        canvas.style.height = `${((y1 - y0) / pageRect.height) * 100}%`;
        canvas.style.pointerEvents = 'none';
        if (!stale && outerRef.current) {
          removeOverlay();
          overlayRef.current = canvas;
          outerRef.current.appendChild(canvas);
        }
      } catch (err) {
        console.error(`pdf document view: sharp crop for page ${page} failed`, err);
      }
    })();
    return () => {
      stale = true;
    };
    // width is intentionally read fresh from the DOM (pageRect) — the effect
    // fires on settled signals only: raster commit, pan settle, page window.
  }, [pdf, page, rasterWidth, aspect, render, viewportTick, scrollRootRef, removeOverlay]);

  // Leaving the render window drops the overlay's memory immediately.
  useEffect(() => {
    if (!render) removeOverlay();
  }, [render, removeOverlay]);
  useEffect(() => () => removeOverlay(), [removeOverlay]);

  // ── Selectable text layer. pdf.js lays spans out in page-relative % and
  // sizes fonts via --total-scale-factor, so it renders ONCE per page visit;
  // zooming only updates the CSS variable (effect below).
  const textHostRef = useRef<HTMLDivElement>(null);
  const ptsWidthRef = useRef<number | null>(null);
  useEffect(() => {
    const host = textHostRef.current;
    if (!host || !render) return;
    let cancelled = false;
    let cancelLayer: (() => void) | null = null;
    void (async () => {
      try {
        const layer = await renderPdfTextLayer(pdf, page, host);
        if (cancelled) {
          layer.cancel();
          host.replaceChildren();
          return;
        }
        cancelLayer = layer.cancel;
        ptsWidthRef.current = layer.pageWidthPts;
        const w = outerRef.current?.getBoundingClientRect().width ?? 0;
        if (w > 0) host.style.setProperty('--total-scale-factor', String(w / layer.pageWidthPts));
      } catch (err) {
        console.error(`pdf document view: text layer for page ${page} failed`, err);
      }
    })();
    return () => {
      cancelled = true;
      cancelLayer?.();
      host.replaceChildren();
    };
  }, [pdf, page, render]);
  useEffect(() => {
    const host = textHostRef.current;
    const pts = ptsWidthRef.current;
    if (host && pts && width > 0) {
      host.style.setProperty('--total-scale-factor', String(width / pts));
    }
  }, [width]);

  return (
    <div
      ref={(el) => {
        outerRef.current = el;
        registerEl(page, el);
      }}
      data-page={page}
      className="relative overflow-hidden bg-white shadow-sm"
      style={{
        width: `${width}px`,
        height: `${width / aspect}px`,
        marginBottom: `${PAGE_GAP_PX}px`,
      }}
    >
      <div ref={hostRef} className="h-full w-full" />
      <div ref={textHostRef} className="pdf-doc-text-layer" />
      {/* Identifier hyperlinks (D-076): clickable element codes on the page. */}
      <PageIdentifierLinks pdf={pdf} page={page} render={render} docId={docId} />
    </div>
  );
}

function styleCanvas(canvas: HTMLCanvasElement): void {
  canvas.style.width = '100%';
  canvas.style.height = '100%';
  canvas.style.display = 'block';
}
