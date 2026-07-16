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
 * small LRU of live canvases. Rasters target reading resolution (≤2400 px),
 * far below the plan pane's texture ceiling. ImageBitmaps are closed right
 * after drawImage, and unmounting (tab switch) drops every canvas — only the
 * lightweight view state (page / zoom) survives in the store.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Minus, Plus } from 'lucide-react';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { Button } from '@/components/ui/button';
import { useViewerStore } from '@/store';
import { openPdfDocument, rasterizePdfPage } from '@/lib/pdf/rasterize';

/** Reading raster ceiling (longest edge, device px) and live-canvas budget. */
const READ_RASTER_MAX_PX = 2400;
const CANVAS_LRU_MAX = 4;
const PAGE_GAP_PX = 12;
const ZOOM_MIN = 0.5;
const ZOOM_MAX = 4;

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
        doc = await openPdfDocument(url);
        if (stale) return;
        const first = await doc.getPage(1);
        const vp = first.getViewport({ scale: 1 });
        if (stale) return;
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
      // The state setter never ran after `stale`, so this instance owns doc.
      void doc?.destroy();
      setPdf(null);
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
  const pageWidth = Math.max(0, (bodyWidth - 24) * zoom);

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

  // ── Current page (topmost visible) + persisted view state ────────────────
  useEffect(() => {
    if (visible.size === 0) return;
    const top = Math.min(...visible);
    setCurrentPage((prev) => (prev === top ? prev : top));
  }, [visible]);
  useEffect(() => {
    setDocTabView(docId, { page: currentPage, zoom });
  }, [docId, currentPage, zoom, setDocTabView]);

  // Restore: jump to the remembered page once sizes are known.
  const restoredRef = useRef(false);
  useEffect(() => {
    if (restoredRef.current || !pdf || pageWidth <= 0) return;
    restoredRef.current = true;
    const page = initialViewRef.current?.page ?? 1;
    if (page > 1) {
      const el = pageElsRef.current.get(page);
      el?.scrollIntoView({ block: 'start' });
    }
  }, [pdf, pageWidth]);

  // ── Zoom (buttons + ctrl/cmd-wheel) ──────────────────────────────────────
  const applyZoom = useCallback((factor: number) => {
    setZoom((z) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z * factor)));
  }, []);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return; // plain wheel scrolls the list
      e.preventDefault();
      applyZoom(Math.exp(-e.deltaY * 0.0018));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [applyZoom]);

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
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto bg-muted/30">
        {error ? (
          <div className="flex h-full items-center justify-center p-6 text-center text-[11px] text-muted-foreground">
            {error}
          </div>
        ) : (
          <div className="mx-auto flex w-fit flex-col items-center px-3 py-3">
            {pdf &&
              pageWidth > 0 &&
              Array.from({ length: numPages }, (_, i) => i + 1).map((page) => (
                <PdfPage
                  key={page}
                  pdf={pdf}
                  page={page}
                  width={pageWidth}
                  aspect={aspects.get(page) ?? defaultAspect}
                  render={visible.has(page)}
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
 * Shared LRU of live page canvases, keyed per component instance is overkill —
 * the pane shows ONE document at a time, so a module-level LRU capped at
 * {@link CANVAS_LRU_MAX} is the whole memory budget. Entries are plain
 * canvases (bitmaps are closed immediately after draw).
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

function lruPut(key: string, canvas: HTMLCanvasElement): void {
  canvasLru.set(key, canvas);
  if (canvasLru.size <= CANVAS_LRU_MAX) return;
  for (const [k, c] of canvasLru) {
    if (canvasLru.size <= CANVAS_LRU_MAX) break;
    if (k === key || c.isConnected) continue; // never blank a mounted page
    canvasLru.delete(k);
    // Release the backing store eagerly — GC alone is too lazy for ~20 MB
    // canvases while the WebGPU scene is competing for the same memory.
    c.width = 0;
    c.height = 0;
  }
}

interface PdfPageProps {
  pdf: PDFDocumentProxy;
  page: number;
  width: number;
  aspect: number;
  render: boolean;
  onAspect: (page: number, aspect: number) => void;
  registerEl: (page: number, el: HTMLDivElement | null) => void;
}

function PdfPage({ pdf, page, width, aspect, render, onAspect, registerEl }: PdfPageProps) {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || !render || width <= 0) return;
    let stale = false;
    // Raster key: page identity + resolution bucket (512 px steps so small
    // zoom nudges reuse the cached canvas instead of re-rendering).
    const targetPx = Math.min(
      READ_RASTER_MAX_PX,
      Math.ceil((Math.max(width, width / aspect) * window.devicePixelRatio) / 512) * 512,
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
  }, [pdf, page, width, aspect, render, onAspect]);

  return (
    <div
      ref={(el) => {
        registerEl(page, el);
      }}
      data-page={page}
      className="bg-white shadow-sm"
      style={{
        width: `${width}px`,
        height: `${width / aspect}px`,
        marginBottom: `${PAGE_GAP_PX}px`,
      }}
    >
      <div ref={hostRef} className="h-full w-full" />
    </div>
  );
}

function styleCanvas(canvas: HTMLCanvasElement): void {
  canvas.style.width = '100%';
  canvas.style.height = '100%';
  canvas.style.display = 'block';
}
