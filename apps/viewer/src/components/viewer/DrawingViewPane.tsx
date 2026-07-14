/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Drawing-view 2D pane (D-072) — the "split view": while the drawing view is
 * active (level-locked ortho + storey cut), this floating pane shows the
 * storey's calibrated PDF and keeps it synced with the 3D camera:
 *
 *  - click on the drawing → the 3D camera pans so that world point is
 *    centred (page → affine → IFC metres → world);
 *  - a green marker + direction wedge tracks the camera target / azimuth on
 *    the drawing (world → IFC metres → inverse affine → page).
 *
 * Modeled on the floating Section2DPanel: absolute overlay, docked
 * bottom-left, expandable. MVP shows the whole page (no inner pan/zoom).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Maximize2, Minimize2, X } from 'lucide-react';
import {
  ifcMetresToPage,
  pageToIfcMetres,
  similarityRotation,
  worldToIfcMetres,
  ifcToWorld,
  type Point2,
} from '@ifc-lite/drawing-underlay';
import { Button } from '@/components/ui/button';
import { useViewerStore } from '@/store';
import { useCameraTickSubscription } from '@/hooks/useCameraTickSubscription';
import { useFloorplanView } from '@/hooks/useFloorplanView';
import { totalYupOffset } from '@/lib/geo/ifc-origin';
import { openPdfDocument, rasterizePdfPage } from '@/lib/pdf/rasterize';

/** Pane raster quality (longest edge, device px). */
const PANE_RASTER_PX = 1600;

export function DrawingViewPane() {
  const locked = useViewerStore((s) => s.underlayViewLocked);
  const storeyGuid = useViewerStore((s) => s.underlayActiveStoreyGuid);
  const drawings = useViewerStore((s) => s.underlayDrawings);
  const models = useViewerStore((s) => s.models);
  const cameraRotation = useViewerStore((s) => s.cameraRotation);
  const { exitDrawingView } = useFloorplanView();

  const [expanded, setExpanded] = useState(false);

  // The storey's calibrated, visible drawing (first match wins in MVP —
  // multiple disciplines per level are a D-072 post-MVP item).
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

  // Fit the page box into the pane body explicitly (ResizeObserver), so the
  // canvas, the click mapping, and the marker all share ONE pixel box.
  // CSS aspect-ratio + max-constraints can silently break the ratio when
  // both axes clamp, which would desync marker percentages from the canvas.
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
    // Re-attach when the pane materializes (it renders null until locked).
  }, [locked, drawing, expanded]);

  // ── Page raster ──────────────────────────────────────────────────────────
  const hostRef = useRef<HTMLDivElement>(null);
  const [pageAspect, setPageAspect] = useState<number>(1.414);
  useEffect(() => {
    const host = hostRef.current;
    if (!locked || !drawing || !host) return;
    let stale = false;
    void (async () => {
      try {
        const doc = await openPdfDocument(drawing.pdfUrl);
        try {
          const raster = await rasterizePdfPage(
            doc,
            drawing.placement!.page,
            PANE_RASTER_PX,
            PANE_RASTER_PX,
          );
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
        console.error('drawing-view pane: rasterization failed', err);
      }
    })();
    return () => {
      stale = true;
      host.replaceChildren();
    };
  }, [locked, drawing]);

  // ── 2D → 3D: click jumps the camera ─────────────────────────────────────
  const onPaneClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (!drawing?.placement) return;
      const host = hostRef.current;
      if (!host) return;
      const rect = host.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;
      const nx = (e.clientX - rect.left) / rect.width;
      const ny = (e.clientY - rect.top) / rect.height;
      // Defensive: never jump the camera off-page from an edge/margin click.
      if (nx < 0 || nx > 1 || ny < 0 || ny > 1) return;
      const [w, h] = drawing.placement.pageSize;
      const pagePt: Point2 = {
        x: nx * w,
        y: (1 - ny) * h,
      };
      const ifc = pageToIfcMetres(drawing.placement.affine, pagePt);
      const world = ifcToWorld(ifc, drawing.placement.storeyZ, offset);

      const { cameraCallbacks } = useViewerStore.getState();
      const vp = cameraCallbacks.getViewpoint?.();
      if (!vp || !cameraCallbacks.applyViewpoint) return;
      // Pan: keep the camera's offset from its target, move the target's
      // XZ to the clicked world point (Y stays — the cut height governs).
      const dx = vp.position.x - vp.target.x;
      const dy = vp.position.y - vp.target.y;
      const dz = vp.position.z - vp.target.z;
      const target = { x: world.x, y: vp.target.y, z: world.z };
      cameraCallbacks.applyViewpoint(
        {
          ...vp,
          target,
          position: { x: target.x + dx, y: target.y + dy, z: target.z + dz },
        },
        true,
      );
    },
    [drawing, offset],
  );

  // ── 3D → 2D: marker follows the camera target ────────────────────────────
  const getViewpoint = useViewerStore((s) => s.cameraCallbacks.getViewpoint);
  const frameTick = useCameraTickSubscription(getViewpoint, !!(locked && drawing));
  const marker = useMemo(() => {
    if (!drawing?.placement) return null;
    const vp = useViewerStore.getState().cameraCallbacks.getViewpoint?.();
    if (!vp) return null;
    const ifc = worldToIfcMetres(vp.target, offset);
    let page: Point2;
    try {
      page = ifcMetresToPage(drawing.placement.affine, ifc);
    } catch {
      return null; // singular affine = corrupt placement
    }
    const [w, h] = drawing.placement.pageSize;
    if (w <= 0 || h <= 0) return null;
    const left = (page.x / w) * 100;
    const top = ((h - page.y) / h) * 100;
    if (left < -5 || left > 105 || top < -5 || top > 105) return null;
    // Camera azimuth mapped into page space. Units: `cameraRotation.azimuth`
    // is DEGREES (camera-controls convention), `similarityRotation` is
    // RADIANS — convert before combining. Sign: the drawing's world rotation
    // (page CCW, y-up) subtracts from the camera azimuth, and CSS rotate()
    // is clockwise in the y-down screen box, so the page-space CCW angle
    // flips sign. Final orientation to be confirmed visually on a real
    // calibrated drawing (ROADMAP F7 follow-up).
    const drawingRotDeg = (similarityRotation(drawing.placement.affine) * 180) / Math.PI;
    const angleDeg = -(cameraRotation.azimuth - drawingRotDeg);
    return { left, top, angleDeg };
    // frameTick re-derives from the live camera each viewpoint change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drawing, offset, cameraRotation.azimuth, frameTick]);

  if (!locked || !drawing) return null;

  const frame = expanded
    ? 'absolute inset-4 z-40'
    : 'absolute bottom-4 left-4 z-40 w-80';

  return (
    <div className={`${frame} flex flex-col overflow-hidden rounded-md border bg-background/95 shadow-lg backdrop-blur`}>
      <div className="flex items-center gap-1.5 border-b px-2 py-1">
        <span className="min-w-0 flex-1 truncate text-[11px] font-medium" title={drawing.name}>
          {drawing.name}
        </span>
        <Button
          variant="ghost"
          size="icon"
          className="size-5"
          onClick={() => setExpanded((v) => !v)}
          aria-label={expanded ? 'Shrink drawing pane' : 'Expand drawing pane'}
        >
          {expanded ? <Minimize2 className="size-3" aria-hidden /> : <Maximize2 className="size-3" aria-hidden />}
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="size-5"
          onClick={exitDrawingView}
          aria-label="Exit drawing view"
          title="Exit drawing view"
        >
          <X className="size-3" aria-hidden />
        </Button>
      </div>
      <div
        ref={bodyRef}
        className={`flex min-h-0 items-center justify-center overflow-hidden ${expanded ? 'flex-1' : 'h-56'}`}
      >
        {/* The page box: canvas fill, click mapping and marker percentages
            all resolve against THIS element — one shared pixel box. */}
        <div
          className="relative cursor-crosshair"
          style={fitBox(pageAspect, bodySize)}
          onClick={onPaneClick}
        >
          <div ref={hostRef} className="h-full w-full" />
          {marker && (
          <span
            className="pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-1/2"
            style={{ left: `${marker.left}%`, top: `${marker.top}%` }}
          >
            {/* Camera-direction wedge (rotates about the circle centre). */}
            <span
              className="absolute left-1/2 top-1/2 block h-0 w-0"
              style={{
                transform: `translate(-50%, -50%) rotate(${marker.angleDeg}deg)`,
              }}
            >
              <span
                className="absolute block"
                style={{
                  left: '-7px',
                  top: '-16px',
                  borderLeft: '7px solid transparent',
                  borderRight: '7px solid transparent',
                  borderBottom: '10px solid rgb(16 185 129 / 0.5)',
                }}
              />
            </span>
            {/* Green location circle (Dalux-style). */}
            <span className="block size-3 rounded-full border-2 border-background bg-emerald-500 shadow" />
          </span>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Largest width/height that fits `aspect` (w/h) into the measured body box.
 * Explicit pixels — CSS aspect-ratio with double max-constraints can break
 * the ratio and desync the marker from the canvas.
 */
function fitBox(
  aspect: number,
  body: { w: number; h: number } | null,
): React.CSSProperties {
  if (!body || body.w <= 0 || body.h <= 0 || !(aspect > 0)) {
    return { width: '100%', aspectRatio: String(aspect) };
  }
  const width = Math.min(body.w, body.h * aspect);
  return { width: `${width}px`, height: `${width / aspect}px` };
}
