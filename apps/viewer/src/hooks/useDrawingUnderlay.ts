/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Sync georeferenced drawing underlays (D-072 in the AIM repo) from the
 * store into the renderer.
 *
 * Store = metadata (drawingUnderlaySlice); GPU = a single PdfPlanePipeline
 * registered as an external overlay on the renderer. This hook owns the
 * pipeline's lifecycle: create on first calibrated drawing, upsert planes as
 * placements change (rasterizing pages via pdf.js on demand), destroy on
 * unmount / renderer swap. Mirrors the pointCloudSlice / usePointCloudSync
 * split.
 *
 * World frame: placements store IFC model metres; the recentering offset of
 * the federation's coordinate frame is read from the first loaded model's
 * `coordinateInfo` (after federation alignment every model shares the
 * anchor's frame — see hooks/ingest/federationAlign.ts).
 */

import { useEffect, useRef, type MutableRefObject } from 'react';
import type { Renderer } from '@ifc-lite/renderer';
import {
  PdfPlanePipeline,
  placementWorldCorners,
  type DrawingPlacement,
} from '@ifc-lite/drawing-underlay';
import { useViewerStore } from '@/store';
import { totalYupOffset } from '@/lib/geo/ifc-origin';
import { openPdfDocument, rasterizePdfPage } from '@/lib/pdf/rasterize';

export const UNDERLAY_OVERLAY_ID = 'drawing-underlay';

/** Longest raster edge in device pixels. High enough for A0 line drawings
 *  under moderate zoom; mip chain covers minification. Re-raster-on-zoom is
 *  a later refinement (D-072 post-MVP). */
const RASTER_TARGET_PX = 4096;

export interface UseDrawingUnderlayParams {
  rendererRef: MutableRefObject<Renderer | null>;
  isInitialized: boolean;
}

/** Signature of the parts of a placement that force a texture re-upload. */
function textureKey(drawingId: string, pdfUrl: string, page: number): string {
  return `${drawingId}|${pdfUrl}|${page}`;
}

/** Placement geometry/presentation signature — cheap change detection. */
function placementKey(p: DrawingPlacement): string {
  return `${p.storeyZ}|${p.affine.join(',')}|${p.pageSize.join(',')}|${p.opacity}|${p.visible}`;
}

export function useDrawingUnderlay({ rendererRef, isInitialized }: UseDrawingUnderlayParams): void {
  const drawings = useViewerStore((s) => s.underlayDrawings);
  const models = useViewerStore((s) => s.models);

  const pipelineRef = useRef<PdfPlanePipeline | null>(null);
  /** drawingId → texture signature of the raster currently on the GPU. */
  const uploadedTexturesRef = useRef(new Map<string, string>());
  /** drawingId → placement signature last applied. */
  const appliedPlacementsRef = useRef(new Map<string, string>());
  /** Monotonic token — invalidates in-flight rasterizations on change. */
  const syncTokenRef = useRef(0);

  useEffect(() => {
    if (!isInitialized) return;
    const renderer = rendererRef.current;
    if (!renderer) return;

    const token = ++syncTokenRef.current;

    const calibrated = [...drawings.values()].filter((d) => d.placement !== null);

    // Nothing calibrated → tear the pipeline down entirely.
    if (calibrated.length === 0) {
      if (pipelineRef.current) {
        renderer.unregisterExternalOverlay(UNDERLAY_OVERLAY_ID);
        pipelineRef.current.destroy();
        pipelineRef.current = null;
        uploadedTexturesRef.current.clear();
        appliedPlacementsRef.current.clear();
      }
      return;
    }

    const descriptor = renderer.getOverlayPassDescriptor();
    if (!descriptor) return; // renderer not ready yet; effect re-runs on init

    if (!pipelineRef.current) {
      pipelineRef.current = new PdfPlanePipeline(descriptor);
      renderer.registerExternalOverlay(UNDERLAY_OVERLAY_ID, pipelineRef.current);
    }
    const pipeline = pipelineRef.current;

    // Recentering offset of the shared (anchor) frame. Federation re-bakes
    // every model into the anchor's coordinateInfo, so the first model with
    // geometry is representative.
    const firstModel = [...models.values()].find((m) => m.geometryResult?.coordinateInfo);
    const offset = totalYupOffset(firstModel?.geometryResult?.coordinateInfo);

    // Drop planes whose drawing disappeared or lost its placement.
    const liveIds = new Set(calibrated.map((d) => d.id));
    for (const id of pipeline.planeIds()) {
      if (!liveIds.has(id)) {
        pipeline.removePlane(id);
        uploadedTexturesRef.current.delete(id);
        appliedPlacementsRef.current.delete(id);
      }
    }

    for (const drawing of calibrated) {
      const placement = drawing.placement!;
      const texKey = textureKey(drawing.id, drawing.pdfUrl, placement.page);
      const posKey = placementKey(placement);
      const hasTexture = uploadedTexturesRef.current.get(drawing.id) === texKey;
      const upToDate = appliedPlacementsRef.current.get(drawing.id) === posKey;
      if (hasTexture && upToDate) continue;

      const corners = placementWorldCorners(placement, offset);

      if (hasTexture) {
        // Geometry/presentation-only change — no rasterization needed.
        pipeline.upsertPlane(drawing.id, {
          corners,
          opacity: placement.opacity,
          visible: placement.visible,
        });
        appliedPlacementsRef.current.set(drawing.id, posKey);
        renderer.requestRender();
        continue;
      }

      // New or re-paged drawing — rasterize async, then upload if still current.
      void (async () => {
        try {
          const doc = await openPdfDocument(drawing.pdfUrl);
          try {
            const raster = await rasterizePdfPage(
              doc,
              placement.page,
              RASTER_TARGET_PX,
              descriptor.device.limits.maxTextureDimension2D,
            );
            if (syncTokenRef.current !== token || pipelineRef.current !== pipeline) {
              raster.image.close();
              return;
            }
            pipeline.upsertPlane(drawing.id, {
              corners,
              image: raster.image,
              opacity: placement.opacity,
              visible: placement.visible,
            });
            raster.image.close(); // GPU copy done; release CPU-side bitmap
            uploadedTexturesRef.current.set(drawing.id, texKey);
            appliedPlacementsRef.current.set(drawing.id, posKey);
            renderer.requestRender();
          } finally {
            void doc.destroy();
          }
        } catch (err) {
          console.error(`drawing-underlay: failed to rasterize "${drawing.name}"`, err);
        }
      })();
    }
  }, [drawings, models, isInitialized, rendererRef]);

  // Teardown on unmount / renderer swap.
  useEffect(() => {
    const renderer = rendererRef.current;
    return () => {
      syncTokenRef.current++;
      if (pipelineRef.current) {
        renderer?.unregisterExternalOverlay(UNDERLAY_OVERLAY_ID);
        pipelineRef.current.destroy();
        pipelineRef.current = null;
        uploadedTexturesRef.current.clear();
        appliedPlacementsRef.current.clear();
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isInitialized]);
}
