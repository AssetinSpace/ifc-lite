/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Drawing plan pane (D-072 split view) — the 2D side of the real resizable
 * 2D | 3D split. Shows the active storey's calibrated PDF and stays synced
 * with the freely-navigable 3D pane (Dalux-style minimap):
 *
 *  - click on the plan → the 3D camera pans so that world point is centred
 *    (page → affine → IFC metres → world);
 *  - a green marker + camera-direction wedge tracks the 3D camera target /
 *    azimuth on the plan (world → IFC metres → inverse affine → page).
 *
 * Unlike the old floating pane, this fills its resizable `Panel` (mounted by
 * ViewerLayout) — no absolute positioning, no expand toggle.
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

/** Pane raster quality (longest edge, device px). */
const PANE_RASTER_PX = 2000;

export function DrawingPlanPane() {
  const active = useViewerStore((s) => s.underlaySplitView);
  const storeyGuid = useViewerStore((s) => s.underlayActiveStoreyGuid);
  const drawings = useViewerStore((s) => s.underlayDrawings);
  const models = useViewerStore((s) => s.models);
  const cameraRotation = useViewerStore((s) => s.cameraRotation);
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

  // One shared pixel box for canvas + click mapping + marker (explicit fit;
  // CSS aspect-ratio with double max-constraints can desync them).
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
          const raster = await rasterizePdfPage(doc, drawing.placement!.page, PANE_RASTER_PX, PANE_RASTER_PX);
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
  }, [active, drawing]);

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
      if (nx < 0 || nx > 1 || ny < 0 || ny > 1) return;
      const [w, h] = drawing.placement.pageSize;
      const pagePt: Point2 = { x: nx * w, y: (1 - ny) * h };
      const ifc = pageToIfcMetres(drawing.placement.affine, pagePt);
      const world = ifcToWorld(ifc, drawing.placement.storeyZ, offset);

      const { cameraCallbacks } = useViewerStore.getState();
      const vp = cameraCallbacks.getViewpoint?.();
      if (!vp || !cameraCallbacks.applyViewpoint) return;
      // Keep the camera's offset from its target; move the target's XZ to the
      // clicked world point (Y stays — the storey cut height governs).
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

  // ── 3D → 2D: marker follows the camera target ────────────────────────────
  const getViewpoint = useViewerStore((s) => s.cameraCallbacks.getViewpoint);
  const frameTick = useCameraTickSubscription(getViewpoint, !!(active && drawing));
  const marker = useMemo(() => {
    if (!drawing?.placement) return null;
    const vp = useViewerStore.getState().cameraCallbacks.getViewpoint?.();
    if (!vp) return null;
    const ifc = worldToIfcMetres(vp.target, offset);
    let page: Point2;
    let angleDeg: number;
    try {
      page = ifcMetresToPage(drawing.placement.affine, ifc);
      // View direction, derived from the actual camera vectors (no azimuth
      // sign conventions): horizontal forward in world XZ; near-top-down
      // views degenerate, so fall back to the camera's up vector (= screen
      // up on the map).
      let fx = vp.target.x - vp.position.x;
      let fz = vp.target.z - vp.position.z;
      if (Math.hypot(fx, fz) < 1e-3) {
        fx = vp.up.x;
        fz = vp.up.z;
      }
      // world → IFC plan direction (ifcY = -worldZ), then IFC → page through
      // the inverse affine's linear part (translation cancelled out).
      const inv = invertAffine(drawing.placement.affine);
      const o = applyAffine(inv, { x: 0, y: 0 });
      const q = applyAffine(inv, { x: fx, y: -fz });
      const pdx = q.x - o.x;
      const pdy = q.y - o.y;
      // Page y-up → screen y-down; the cone points "up" at 0°, CSS rotates CW.
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
  }, [drawing, offset, cameraRotation.azimuth, frameTick]);

  if (!active) return null;

  return (
    <div className="flex h-full w-full flex-col overflow-hidden border-r bg-background">
      <div className="flex items-center gap-1.5 border-b px-2 py-1">
        <span className="min-w-0 flex-1 truncate text-[11px] font-medium" title={drawing?.name}>
          {drawing ? drawing.name : 'Split view'}
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
        <div ref={bodyRef} className="flex min-h-0 flex-1 items-center justify-center overflow-hidden p-2">
          <div className="relative cursor-crosshair" style={fitBox(pageAspect, bodySize)} onClick={onPaneClick}>
            <div ref={hostRef} className="h-full w-full" />
            {marker && (
              <span
                className="pointer-events-none absolute z-10"
                style={{ left: `${marker.left}%`, top: `${marker.top}%` }}
              >
                {/* Dalux-style view cone: a translucent ~55° sector showing
                    where the 3D camera looks, rotating with it. */}
                <svg
                  width="88"
                  height="88"
                  viewBox="-44 -44 88 88"
                  className="absolute"
                  style={{
                    left: '-44px',
                    top: '-44px',
                    transform: `rotate(${marker.angleDeg}deg)`,
                  }}
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
  const width = Math.min(body.w, body.h * aspect);
  return { width: `${width}px`, height: `${width / aspect}px` };
}
