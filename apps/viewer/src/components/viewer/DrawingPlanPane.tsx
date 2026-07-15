/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Drawing plan pane (D-072 split view) — the 2D side of the resizable
 * 2D | 3D split, kept in sync with the freely-navigable 3D pane
 * (Dalux-style minimap):
 *
 *  - click on the plan → the 3D camera moves there (orbit: pan the target;
 *    walk: teleport, keeping eye height and heading);
 *  - drag ON the marker/cone → rotates the camera look direction, so the
 *    view can be steered from the map;
 *  - drag elsewhere pans the (zoomable) plan; wheel zooms to the cursor,
 *    with a sharp re-raster once the gesture settles;
 *  - the green marker + view cone tracks the camera: its ORBIT TARGET in
 *    orbit mode, or the CAMERA POSITION in walk mode (you are the marker).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { X } from 'lucide-react';
import {
  applyAffine,
  ifcMetresToPage,
  ifcToWorld,
  invertAffine,
  pageToIfcMetres,
  worldToIfcMetres,
  type Point2,
} from '@ifc-lite/drawing-underlay';
import { Button } from '@/components/ui/button';
import { useViewerStore } from '@/store';
import { useCameraTickSubscription } from '@/hooks/useCameraTickSubscription';
import { useFloorplanView } from '@/hooks/useFloorplanView';
import { totalYupOffset } from '@/lib/geo/ifc-origin';
import { openPdfDocument, rasterizePdfPage } from '@/lib/pdf/rasterize';

/** Base raster (zoom 1) and the ceiling for zoomed re-rasters. */
const PANE_RASTER_PX = 2000;
const PANE_RASTER_MAX_PX = 8192;
/** Pointer-down within this CSS distance of the marker starts a rotate drag. */
const ROTATE_GRAB_PX = 30;

export function DrawingPlanPane() {
  const active = useViewerStore((s) => s.underlaySplitView);
  const storeyGuid = useViewerStore((s) => s.underlayActiveStoreyGuid);
  const drawings = useViewerStore((s) => s.underlayDrawings);
  const models = useViewerStore((s) => s.models);
  const activeTool = useViewerStore((s) => s.activeTool);
  const walkMode = activeTool === 'walk';
  const { exitSplitView } = useFloorplanView();

  // The storey's calibrated, visible drawing (first match wins in MVP).
  const drawing = useMemo(() => {
    if (!storeyGuid) return null;
    for (const d of drawings.values()) {
      if (d.placement && d.placement.visible && d.placement.storeyGuid === storeyGuid) return d;
    }
    return null;
  }, [drawings, storeyGuid]);

  const offset = useMemo(() => {
    const first = [...models.values()].find((m) => m.geometryResult?.coordinateInfo);
    return totalYupOffset(first?.geometryResult?.coordinateInfo);
  }, [models]);

  // One shared pixel box for canvas + click mapping + marker.
  const bodyRef = useRef<HTMLDivElement>(null);
  const [bodySize, setBodySize] = useState<{ w: number; h: number } | null>(null);
  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      const r = entries[0]?.contentRect;
      if (r) setBodySize({ w: r.width, h: r.height });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [active, drawing]);

  // ── Zoom / pan (wheel-to-cursor + drag), sharp re-raster on settle ───────
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [rasterPx, setRasterPx] = useState(PANE_RASTER_PX);
  useEffect(() => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
    setRasterPx(PANE_RASTER_PX);
  }, [drawing?.id]);

  useEffect(() => {
    const clip = bodyRef.current;
    if (!clip) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = clip.getBoundingClientRect();
      setZoom((prev) => {
        const next = Math.min(12, Math.max(1, prev * Math.exp(-e.deltaY * 0.0018)));
        if (next === prev) return prev;
        const cx = e.clientX - rect.left;
        const cy = e.clientY - rect.top;
        if (next === 1) {
          setPan({ x: 0, y: 0 });
          return 1;
        }
        setPan((p) => ({
          x: cx - ((cx - p.x) * next) / prev,
          y: cy - ((cy - p.y) * next) / prev,
        }));
        return next;
      });
    };
    clip.addEventListener('wheel', onWheel, { passive: false });
    return () => clip.removeEventListener('wheel', onWheel);
  }, []);

  useEffect(() => {
    const target = Math.min(PANE_RASTER_MAX_PX, Math.ceil((PANE_RASTER_PX * zoom) / 1024) * 1024);
    if (target === rasterPx) return;
    const timer = setTimeout(() => setRasterPx(target), 280);
    return () => clearTimeout(timer);
  }, [zoom, rasterPx]);

  // ── Page raster ──────────────────────────────────────────────────────────
  const hostRef = useRef<HTMLDivElement>(null);
  const [pageAspect, setPageAspect] = useState<number>(1.414);
  useEffect(() => {
    const host = hostRef.current;
    if (!active || !drawing || !host) return;
    let stale = false;
    void (async () => {
      try {
        const doc = await openPdfDocument(drawing.pdfUrl);
        try {
          const raster = await rasterizePdfPage(doc, drawing.placement!.page, rasterPx, rasterPx);
          if (stale) {
            raster.image.close();
            return;
          }
          const canvas = document.createElement('canvas');
          canvas.width = raster.width;
          canvas.height = raster.height;
          canvas.getContext('2d')?.drawImage(raster.image, 0, 0);
          raster.image.close();
          canvas.style.width = '100%';
          canvas.style.height = '100%';
          canvas.style.display = 'block';
          setPageAspect(raster.width / raster.height);
          host.replaceChildren(canvas);
        } finally {
          void doc.destroy();
        }
      } catch (err) {
        console.error('drawing plan pane: rasterization failed', err);
      }
    })();
    return () => {
      stale = true;
      host.replaceChildren();
    };
  }, [active, drawing, rasterPx]);

  // ── Camera coupling helpers ──────────────────────────────────────────────

  /** Clicked page point → move the camera there (orbit pan / walk teleport). */
  const jumpTo = useCallback(
    (pagePt: Point2) => {
      if (!drawing?.placement) return;
      const ifc = pageToIfcMetres(drawing.placement.affine, pagePt);
      const world = ifcToWorld(ifc, drawing.placement.storeyZ, offset);
      const { cameraCallbacks, activeTool: tool } = useViewerStore.getState();
      const vp = cameraCallbacks.getViewpoint?.();
      if (!vp || !cameraCallbacks.applyViewpoint) return;
      if (tool === 'walk') {
        // Teleport: land at the clicked plan point, KEEP eye height and
        // heading (Dalux street-view behaviour) — no surprise fly-aways.
        const position = { x: world.x, y: vp.position.y, z: world.z };
        const target = {
          x: position.x + (vp.target.x - vp.position.x),
          y: position.y + (vp.target.y - vp.position.y),
          z: position.z + (vp.target.z - vp.position.z),
        };
        cameraCallbacks.applyViewpoint({ ...vp, position, target }, true);
        return;
      }
      // Orbit: keep the camera's offset from its target, move the target.
      const dx = vp.position.x - vp.target.x;
      const dy = vp.position.y - vp.target.y;
      const dz = vp.position.z - vp.target.z;
      const target = { x: world.x, y: vp.target.y, z: world.z };
      cameraCallbacks.applyViewpoint(
        { ...vp, target, position: { x: target.x + dx, y: target.y + dy, z: target.z + dz } },
        true,
      );
    },
    [drawing, offset],
  );

  /** Rotate the camera so it looks along marker→cursor (page space). */
  const rotateToward = useCallback(
    (pagePt: Point2) => {
      if (!drawing?.placement) return;
      const { cameraCallbacks, activeTool: tool } = useViewerStore.getState();
      const vp = cameraCallbacks.getViewpoint?.();
      if (!vp || !cameraCallbacks.applyViewpoint) return;
      const anchorWorld = tool === 'walk' ? vp.position : vp.target;
      const anchorPage = (() => {
        try {
          return ifcMetresToPage(drawing.placement!.affine, worldToIfcMetres(anchorWorld, offset));
        } catch {
          return null;
        }
      })();
      if (!anchorPage) return;
      const pdx = pagePt.x - anchorPage.x;
      const pdy = pagePt.y - anchorPage.y;
      if (Math.hypot(pdx, pdy) < 1e-6) return;
      // page dir → IFC dir (affine linear part) → world XZ dir.
      const a = drawing.placement!.affine;
      const o = applyAffine(a, { x: 0, y: 0 });
      const q = applyAffine(a, { x: pdx, y: pdy });
      let wx = q.x - o.x;
      let wz = -(q.y - o.y);
      const len = Math.hypot(wx, wz) || 1;
      wx /= len;
      wz /= len;
      if (tool === 'walk') {
        // Turn in place: swing the target around the camera position.
        const horiz = Math.hypot(vp.target.x - vp.position.x, vp.target.z - vp.position.z) || 5;
        const target = {
          x: vp.position.x + wx * horiz,
          y: vp.target.y,
          z: vp.position.z + wz * horiz,
        };
        cameraCallbacks.applyViewpoint({ ...vp, target }, false);
        return;
      }
      // Orbit: swing the camera around its target to face the new direction.
      const horiz = Math.hypot(vp.position.x - vp.target.x, vp.position.z - vp.target.z) || 5;
      const position = {
        x: vp.target.x - wx * horiz,
        y: vp.position.y,
        z: vp.target.z - wz * horiz,
      };
      cameraCallbacks.applyViewpoint({ ...vp, position }, false);
    },
    [drawing, offset],
  );

  // ── Pointer interaction: rotate on marker, pan elsewhere, click to jump ──
  const dragRef = useRef<{
    pointerId: number;
    mode: 'maybe-click' | 'pan' | 'rotate';
    startX: number;
    startY: number;
    panX: number;
    panY: number;
  } | null>(null);

  const clientToPage = useCallback(
    (clientX: number, clientY: number): Point2 | null => {
      if (!drawing?.placement) return null;
      const host = hostRef.current;
      if (!host) return null;
      const rect = host.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return null;
      const nx = (clientX - rect.left) / rect.width;
      const ny = (clientY - rect.top) / rect.height;
      const [w, h] = drawing.placement.pageSize;
      return { x: nx * w, y: (1 - ny) * h };
    },
    [drawing],
  );

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      let mode: 'maybe-click' | 'rotate' = 'maybe-click';
      // Grab the marker/cone → rotate instead of pan/click.
      const host = hostRef.current;
      if (host && markerRef.current && drawing?.placement) {
        const rect = host.getBoundingClientRect();
        const mx = rect.left + (markerRef.current.left / 100) * rect.width;
        const my = rect.top + (markerRef.current.top / 100) * rect.height;
        if (Math.hypot(e.clientX - mx, e.clientY - my) < ROTATE_GRAB_PX) mode = 'rotate';
      }
      dragRef.current = {
        pointerId: e.pointerId,
        mode,
        startX: e.clientX,
        startY: e.clientY,
        panX: pan.x,
        panY: pan.y,
      };
      e.currentTarget.setPointerCapture(e.pointerId);
    },
    [drawing, pan],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current;
      if (!drag || drag.pointerId !== e.pointerId) return;
      if (drag.mode === 'rotate') {
        const pagePt = clientToPage(e.clientX, e.clientY);
        if (pagePt) rotateToward(pagePt);
        return;
      }
      const dx = e.clientX - drag.startX;
      const dy = e.clientY - drag.startY;
      if (drag.mode === 'maybe-click' && Math.hypot(dx, dy) < 6) return;
      drag.mode = 'pan';
      setPan({ x: drag.panX + dx, y: drag.panY + dy });
    },
    [clientToPage, rotateToward],
  );

  const onPointerUp = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current;
      dragRef.current = null;
      if (!drag || drag.pointerId !== e.pointerId) return;
      if (drag.mode === 'maybe-click') {
        const pagePt = clientToPage(e.clientX, e.clientY);
        if (pagePt) jumpTo(pagePt);
      }
    },
    [clientToPage, jumpTo],
  );

  // ── 3D → 2D: marker follows the camera (target; position in walk mode) ──
  const getViewpoint = useViewerStore((s) => s.cameraCallbacks.getViewpoint);
  const frameTick = useCameraTickSubscription(getViewpoint, !!(active && drawing));
  const marker = useMemo(() => {
    if (!drawing?.placement) return null;
    const vp = useViewerStore.getState().cameraCallbacks.getViewpoint?.();
    if (!vp) return null;
    const anchor = walkMode ? vp.position : vp.target;
    let page: Point2;
    let angleDeg: number;
    try {
      page = ifcMetresToPage(drawing.placement.affine, worldToIfcMetres(anchor, offset));
      let fx = vp.target.x - vp.position.x;
      let fz = vp.target.z - vp.position.z;
      if (Math.hypot(fx, fz) < 1e-3) {
        fx = vp.up.x;
        fz = vp.up.z;
      }
      const inv = invertAffine(drawing.placement.affine);
      const o = applyAffine(inv, { x: 0, y: 0 });
      const q = applyAffine(inv, { x: fx, y: -fz });
      const pdx = q.x - o.x;
      const pdy = q.y - o.y;
      angleDeg = (Math.atan2(pdx, pdy) * 180) / Math.PI;
    } catch {
      return null;
    }
    const [w, h] = drawing.placement.pageSize;
    if (w <= 0 || h <= 0) return null;
    const left = (page.x / w) * 100;
    const top = ((h - page.y) / h) * 100;
    if (left < -5 || left > 105 || top < -5 || top > 105) return null;
    return { left, top, angleDeg };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drawing, offset, walkMode, frameTick]);
  const markerRef = useRef(marker);
  markerRef.current = marker;

  if (!active) return null;

  return (
    <div className="flex h-full w-full flex-col overflow-hidden border-r bg-background">
      <div className="flex items-center gap-1.5 border-b px-2 py-1">
        <span className="min-w-0 flex-1 truncate text-[11px] font-medium" title={drawing?.name}>
          {drawing ? drawing.name : 'Split view'}
          {walkMode && <span className="ml-1 text-muted-foreground">· walk</span>}
        </span>
        <Button
          variant="ghost"
          size="icon"
          className="size-5"
          onClick={exitSplitView}
          aria-label="Exit split view"
          title="Exit split view"
        >
          <X className="size-3" aria-hidden />
        </Button>
      </div>
      {drawing ? (
        <div
          ref={bodyRef}
          className="relative min-h-0 flex-1 overflow-hidden"
          style={{ touchAction: 'none' }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={() => (dragRef.current = null)}
        >
          <div
            className="absolute left-0 top-0"
            style={{
              transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
              transformOrigin: '0 0',
              width: '100%',
              height: '100%',
            }}
          >
            <div className="flex h-full w-full items-center justify-center p-2">
              <div className="relative cursor-crosshair" style={fitBox(pageAspect, bodySize)}>
                <div ref={hostRef} className="h-full w-full" />
                {marker && (
                  <span
                    className="pointer-events-none absolute z-10"
                    style={{
                      left: `${marker.left}%`,
                      top: `${marker.top}%`,
                      transform: `scale(${1 / zoom})`,
                    }}
                  >
                    {/* View cone (drag it to rotate the camera). */}
                    <svg
                      width="88"
                      height="88"
                      viewBox="-44 -44 88 88"
                      className="absolute"
                      style={{ left: '-44px', top: '-44px', transform: `rotate(${marker.angleDeg}deg)` }}
                    >
                      <path
                        d="M 0 0 L -19 -38 A 42.5 42.5 0 0 1 19 -38 Z"
                        fill="rgb(16 185 129 / 0.30)"
                        stroke="rgb(16 185 129 / 0.55)"
                        strokeWidth="1"
                      />
                    </svg>
                    <span className="absolute -left-[7px] -top-[7px] block size-3.5 rounded-full border-2 border-background bg-emerald-500 shadow" />
                  </span>
                )}
              </div>
            </div>
          </div>
        </div>
      ) : (
        <div className="flex flex-1 items-center justify-center p-6 text-center text-[11px] text-muted-foreground">
          No calibrated drawing on this level. Calibrate a PDF to this storey to see the plan here.
        </div>
      )}
    </div>
  );
}

/** Largest box fitting `aspect` (w/h) into the measured body — explicit px. */
function fitBox(aspect: number, body: { w: number; h: number } | null): React.CSSProperties {
  if (!body || body.w <= 0 || body.h <= 0 || !(aspect > 0)) {
    return { width: '100%', aspectRatio: String(aspect) };
  }
  // Leave the p-2 padding (16px) out of the fit so the page never clips.
  const w = Math.max(0, body.w - 16);
  const h = Math.max(0, body.h - 16);
  const width = Math.min(w, h * aspect);
  return { width: `${width}px`, height: `${width / aspect}px` };
}
