/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * AIM fork (D-072): floor-plane raycast for the drawing-underlay calibration
 * pick. Upstream used to carry this helper in `selectionHandlers.ts` for the
 * add-element tool and removed it when that tool moved to modeling commands;
 * the calibration still needs it, so the fork owns its copy here.
 */

import { useViewerStore } from '@/store';
import type { MouseHandlerContext } from '@/components/viewer/mouseHandlerTypes.js';

/** Renderer Y of the active model's first storey floor; 0 when nothing is loaded. */
function resolveStoreyFloorY(): number {
  const state = useViewerStore.getState();
  const modelId = state.activeModelId;
  if (!modelId) return 0;
  const ds = state.models.get(modelId)?.ifcDataStore;
  if (!ds) return 0;
  const ids = ds.entityIndex.byType.get('IFCBUILDINGSTOREY');
  const storeyId = ids && ids.length > 0 ? ids[0] : null;
  if (storeyId === null) return 0;
  return ds.spatialHierarchy?.storeyElevations?.get(storeyId) ?? 0;
}

/**
 * Intersect the cursor ray with a horizontal floor plane (renderer Y-up).
 * `floorY` overrides the plane height (renderer frame); defaults to the
 * active model's first storey. Returns null for a near-parallel ray or a
 * hit behind the camera.
 */
export function raycastStoreyFloor(
  ctx: MouseHandlerContext,
  x: number,
  y: number,
  floorY?: number,
): { x: number; y: number; z: number } | null {
  const camera = ctx.renderer.getCamera();
  const canvas = ctx.renderer.getCanvas();
  if (!camera || !canvas) return null;
  // `unprojectToRay` takes drawing-buffer pixels, which differ from CSS by DPR.
  const rect = canvas.getBoundingClientRect();
  const sx = rect.width > 0 ? (x / rect.width) * canvas.width : x;
  const sy = rect.height > 0 ? (y / rect.height) * canvas.height : y;
  const ray = camera.unprojectToRay(sx, sy, canvas.width, canvas.height);
  if (!ray) return null;
  const planeY = floorY ?? resolveStoreyFloorY();
  const dy = ray.direction.y;
  if (Math.abs(dy) < 1e-6) return null;
  const t = (planeY - ray.origin.y) / dy;
  if (!Number.isFinite(t) || t <= 0) return null;
  return { x: ray.origin.x + ray.direction.x * t, y: planeY, z: ray.origin.z + ray.direction.z * t };
}
