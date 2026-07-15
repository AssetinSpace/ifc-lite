/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Calibration PDF surface (D-072) — the click target for picking the two
 * drawing reference points. Self-contained: it reads the active calibration
 * from the store, rasterizes the page, handles zoom/pan, maps clicks to PDF
 * page points, and draws the A/B markers + span line. It is used both inline
 * in the Drawing Underlays panel (small) and in a large viewport overlay
 * (`CalibrationPdfOverlay`), so the whole PDF can be worked on a big screen.
 *
 * Both instances read/write the same store calibration, so they stay in sync.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Magnet, ZoomIn, ZoomOut } from 'lucide-react';
import type { Point2 } from '@ifc-lite/drawing-underlay';
import { Button } from '@/components/ui/button';
import { useViewerStore } from '@/store';
import { openPdfDocument, rasterizePdfPage } from '@/lib/pdf/rasterize';
import { snapToDrawingFeature } from '@/lib/pdf/snap';

/** Base raster (zoom 1) and the ceiling for zoomed re-rasters. */
const RASTER_PX = 2400;
const RASTER_MAX_PX = 8192;

interface PreviewState {
  canvas: HTMLCanvasElement;
  pixelsPerPoint: number;
  pageSizePts: [number, number];
}

/** page → model → page → model. */
function pickTurn(pageCount: number, modelCount: number): 'page' | 'model' | 'done' {
  if (pageCount > modelCount) return 'model';
  if (pageCount < 2) return 'page';
  return 'done';
}

export function CalibrationPdfSurface({ className }: { className?: string }) {
  const calibration = useViewerStore((s) => s.underlayCalibration);
  const drawings = useViewerStore((s) => s.underlayDrawings);
  const setCalibrationPageSize = useViewerStore((s) => s.setUnderlayCalibrationPageSize);
  const addPagePoint = useViewerStore((s) => s.addUnderlayCalibrationPagePoint);

  const drawing = calibration ? drawings.get(calibration.drawingId) : undefined;
  const awaiting = calibration
    ? pickTurn(calibration.pagePoints.length, calibration.modelPoints.length)
    : 'done';

  const [preview, setPreview] = useState<PreviewState | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [pdfZoom, setPdfZoom] = useState(1);
  const [pdfPan, setPdfPan] = useState({ x: 0, y: 0 });
  const [magnetOn, setMagnetOn] = useState(true);
  /** Longest raster edge currently on screen — re-rastered as zoom grows. */
  const [rasterPx, setRasterPx] = useState(RASTER_PX);

  const clipRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ pointerId: number; startX: number; startY: number; panX: number; panY: number; moved: boolean } | null>(null);

  useEffect(() => {
    setPdfZoom(1);
    setPdfPan({ x: 0, y: 0 });
    setRasterPx(RASTER_PX);
  }, [calibration?.drawingId, calibration?.page]);

  /** Zoom about a fixed point in clip-container coordinates. */
  const zoomAt = useCallback((next: number, cx: number, cy: number) => {
    const clamped = Math.min(12, Math.max(1, next));
    setPdfZoom((prev) => {
      if (clamped === prev) return prev;
      if (clamped === 1) {
        setPdfPan({ x: 0, y: 0 });
        return 1;
      }
      setPdfPan((pan) => ({
        x: cx - ((cx - pan.x) * clamped) / prev,
        y: cy - ((cy - pan.y) * clamped) / prev,
      }));
      return clamped;
    });
  }, []);

  const zoomTo = useCallback(
    (next: number) => {
      const clip = clipRef.current;
      zoomAt(next, (clip?.clientWidth ?? 0) / 2, (clip?.clientHeight ?? 0) / 2);
    },
    [zoomAt],
  );

  // Wheel zoom-to-cursor. Native listener with passive: false — React's
  // synthetic onWheel can't reliably preventDefault, and the page would
  // scroll instead of zooming (live report).
  useEffect(() => {
    const clip = clipRef.current;
    if (!clip) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = clip.getBoundingClientRect();
      setPdfZoom((prev) => {
        const next = Math.min(12, Math.max(1, prev * Math.exp(-e.deltaY * 0.0018)));
        if (next === prev) return prev;
        const cx = e.clientX - rect.left;
        const cy = e.clientY - rect.top;
        if (next === 1) {
          setPdfPan({ x: 0, y: 0 });
          return 1;
        }
        setPdfPan((pan) => ({
          x: cx - ((cx - pan.x) * next) / prev,
          y: cy - ((cy - pan.y) * next) / prev,
        }));
        return next;
      });
    };
    clip.addEventListener('wheel', onWheel, { passive: false });
    return () => clip.removeEventListener('wheel', onWheel);
  }, []);

  // Sharp re-raster once a zoom gesture settles: the on-screen pixel density
  // should track the zoom, else the page reads blurry (live report). CSS
  // keeps scaling the old canvas meanwhile, so there is no flash.
  useEffect(() => {
    const target = Math.min(RASTER_MAX_PX, Math.ceil((RASTER_PX * pdfZoom) / 1024) * 1024);
    if (target === rasterPx) return;
    const timer = setTimeout(() => setRasterPx(target), 280);
    return () => clearTimeout(timer);
  }, [pdfZoom, rasterPx]);

  // Rasterize the page (per drawing/page, and re-raster as zoom deepens).
  useEffect(() => {
    setPreviewError(null);
    if (!calibration || !drawing) {
      setPreview(null);
      return;
    }
    let stale = false;
    void (async () => {
      try {
        const doc = await openPdfDocument(drawing.pdfUrl);
        try {
          const raster = await rasterizePdfPage(doc, calibration.page, rasterPx, rasterPx);
          if (stale) {
            raster.image.close();
            return;
          }
          const canvas = document.createElement('canvas');
          canvas.width = raster.width;
          canvas.height = raster.height;
          canvas.getContext('2d')?.drawImage(raster.image, 0, 0);
          raster.image.close();
          setPreview({ canvas, pixelsPerPoint: raster.pixelsPerPoint, pageSizePts: raster.pageSizePts });
          setCalibrationPageSize(raster.pageSizePts);
        } finally {
          void doc.destroy();
        }
      } catch (err) {
        console.error('calibration surface: rasterization failed', err);
        if (!stale) setPreviewError('Could not render the PDF page.');
      }
    })();
    return () => {
      stale = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [calibration?.drawingId, calibration?.page, drawing?.pdfUrl, rasterPx]);

  // Mount the rasterized canvas into the host.
  useEffect(() => {
    const host = hostRef.current;
    if (!host || !preview) return;
    preview.canvas.style.width = '100%';
    preview.canvas.style.height = 'auto';
    preview.canvas.style.display = 'block';
    host.replaceChildren(preview.canvas);
    return () => host.replaceChildren();
  }, [preview]);

  const pickPagePoint = useCallback(
    (clientX: number, clientY: number) => {
      if (!calibration || !preview || awaiting !== 'page') return;
      const host = hostRef.current;
      if (!host) return;
      const rect = host.getBoundingClientRect(); // post-transform
      if (rect.width <= 0 || rect.height <= 0) return;
      const nx = (clientX - rect.left) / rect.width;
      const ny = (clientY - rect.top) / rect.height;
      if (nx < 0 || nx > 1 || ny < 0 || ny > 1) return;
      let rasterX = nx * preview.canvas.width;
      let rasterY = ny * preview.canvas.height;
      if (magnetOn) {
        // Magnet: snap onto nearby linework/intersections. The search radius
        // shrinks with zoom in page terms (fixed in raster px), so a zoomed-in
        // pick stays a precise pick.
        const snapped = snapToDrawingFeature(preview.canvas, rasterX, rasterY, 18);
        if (snapped) {
          rasterX = snapped.x;
          rasterY = snapped.y;
        }
      }
      addPagePoint({
        x: rasterX / preview.pixelsPerPoint,
        y: (preview.canvas.height - rasterY) / preview.pixelsPerPoint,
      });
    },
    [calibration, preview, awaiting, addPagePoint, magnetOn],
  );

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    dragRef.current = { pointerId: e.pointerId, startX: e.clientX, startY: e.clientY, panX: pdfPan.x, panY: pdfPan.y, moved: false };
    e.currentTarget.setPointerCapture(e.pointerId);
  }, [pdfPan]);
  const onPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    const dx = e.clientX - drag.startX;
    const dy = e.clientY - drag.startY;
    if (!drag.moved && Math.hypot(dx, dy) < 6) return;
    drag.moved = true;
    setPdfPan({ x: drag.panX + dx, y: drag.panY + dy });
  }, []);
  const onPointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    dragRef.current = null;
    if (!drag || drag.pointerId !== e.pointerId) return;
    if (!drag.moved) pickPagePoint(e.clientX, e.clientY);
  }, [pickPagePoint]);

  const markerStyle = useCallback(
    (p: Point2): { left: string; top: string } | null => {
      if (!preview) return null;
      const [w, h] = preview.pageSizePts;
      if (w <= 0 || h <= 0) return null;
      return { left: `${(p.x / w) * 100}%`, top: `${((h - p.y) / h) * 100}%` };
    },
    [preview],
  );

  const abLine = useMemo(() => {
    if (!preview || !calibration || calibration.pagePoints.length !== 2) return null;
    const a = markerStyle(calibration.pagePoints[0]);
    const b = markerStyle(calibration.pagePoints[1]);
    return a && b ? { a, b } : null;
  }, [preview, calibration, markerStyle]);

  if (!calibration || !drawing) return null;

  return (
    <div className={`flex min-h-0 flex-col ${className ?? ''}`}>
      {previewError && <p className="mb-1 text-[11px] text-destructive">{previewError}</p>}
      <div
        ref={clipRef}
        className={`relative min-h-0 flex-1 overflow-hidden rounded border ${awaiting === 'page' ? 'cursor-crosshair ring-1 ring-primary/50' : pdfZoom > 1 ? 'cursor-grab' : ''}`}
        style={{ touchAction: 'none' }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => (dragRef.current = null)}
      >
        <div
          className="relative"
          style={{ transform: `translate(${pdfPan.x}px, ${pdfPan.y}px) scale(${pdfZoom})`, transformOrigin: '0 0' }}
        >
          <div ref={hostRef} />
          {abLine && (
            <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="pointer-events-none absolute inset-0 z-10 h-full w-full">
              <line
                x1={parseFloat(abLine.a.left)} y1={parseFloat(abLine.a.top)}
                x2={parseFloat(abLine.b.left)} y2={parseFloat(abLine.b.top)}
                stroke="#10b981" strokeWidth="2" strokeDasharray="6 4" vectorEffect="non-scaling-stroke"
              />
            </svg>
          )}
          {preview &&
            calibration.pagePoints.map((p, i) => {
              const style = markerStyle(p);
              return style ? (
                <span
                  key={i}
                  className="pointer-events-none absolute z-20"
                  style={{ ...style, transform: `scale(${1 / pdfZoom})` }}
                >
                  {/* Thin crosshair marks the EXACT picked point... */}
                  <span className="absolute -left-px -top-3 block h-6 w-0.5 bg-emerald-600" />
                  <span className="absolute -left-3 -top-px block h-0.5 w-6 bg-emerald-600" />
                  {/* ...and the letter ball hangs below so it never covers it. */}
                  <span className="absolute -left-2 top-2.5 flex size-4 items-center justify-center rounded-full bg-emerald-500 text-[9px] font-bold text-white ring-2 ring-background">
                    {i === 0 ? 'A' : 'B'}
                  </span>
                </span>
              ) : null;
            })}
        </div>
      </div>
      <div className="mt-1.5 flex items-center gap-1">
        <Button variant="ghost" size="icon" className="size-6" onClick={() => zoomTo(pdfZoom + 1)} disabled={pdfZoom >= 8} aria-label="Zoom in">
          <ZoomIn className="size-3.5" aria-hidden />
        </Button>
        <Button variant="ghost" size="icon" className="size-6" onClick={() => zoomTo(pdfZoom - 1)} disabled={pdfZoom <= 1} aria-label="Zoom out">
          <ZoomOut className="size-3.5" aria-hidden />
        </Button>
        {pdfZoom > 1 && (
          <button className="rounded px-1 text-[10px] text-muted-foreground hover:bg-muted" onClick={() => zoomTo(1)}>
            {Math.round(pdfZoom * 10) / 10}× reset
          </button>
        )}
        <Button
          variant={magnetOn ? 'default' : 'ghost'}
          size="icon"
          className="size-6"
          onClick={() => setMagnetOn((v) => !v)}
          aria-label={magnetOn ? 'Magnet snapping on' : 'Magnet snapping off'}
          title="Magnet: snap picks onto nearby lines and intersections"
        >
          <Magnet className="size-3.5" aria-hidden />
        </Button>
        <span className="flex-1 text-right text-[10px] text-muted-foreground">
          PDF {calibration.pagePoints.length}/2 · model {calibration.modelPoints.length}/2
        </span>
      </div>
    </div>
  );
}
