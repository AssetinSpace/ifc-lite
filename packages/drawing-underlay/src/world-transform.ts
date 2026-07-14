/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Drawing → world transforms.
 *
 * Frames involved:
 *  - **Page**: PDF page points, bottom-left origin, y up (the affine's source).
 *  - **IFC plan**: IFC model metres, Z up; the affine maps page → plan XY, and
 *    the storey elevation supplies Z.
 *  - **Viewer world**: Y-up metres — the renderer's frame. IFC → viewer is the
 *    fixed axis swap `viewerX = ifcX, viewerY = ifcZ, viewerZ = -ifcY`, then a
 *    caller-supplied recentering offset is subtracted (viewers shift geometry
 *    toward the origin for float precision; e.g. ifc-lite's
 *    `totalYupOffset(coordinateInfo)`). This package takes that offset as a
 *    plain vector so it stays independent of any particular viewer's store.
 */

import type { DrawingPlacement } from './placement.js';
import { applyAffine, invertAffine, type Affine2x3, type Point2 } from './similarity.js';

/** A 3D vector/point in the viewer's Y-up world frame. */
export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export const ZERO_OFFSET: Vec3 = { x: 0, y: 0, z: 0 };

/**
 * Default lift of the underlay plane above the storey elevation (metres).
 * Keeps the drawing from z-fighting with the slab top surface while staying
 * visually "on the floor". 5 cm survives grazing-angle rotation in a
 * depth-tested pass without visibly floating; the plane also switches to a
 * non-occluding pass while a storey cut is active (see PdfPlanePipeline).
 */
export const DEFAULT_PLANE_LIFT = 0.05;

/** Page point → IFC plan metres through the placement affine. */
export function pageToIfcMetres(affine: Affine2x3, p: Point2): Point2 {
  return applyAffine(affine, p);
}

/** IFC plan metres → page point (inverse affine). Throws on a singular affine. */
export function ifcMetresToPage(affine: Affine2x3, p: Point2): Point2 {
  return applyAffine(invertAffine(affine), p);
}

/**
 * IFC plan point at a given elevation → viewer Y-up world.
 * `offset` is the viewer's recentering shift for the owning model.
 */
export function ifcToWorld(p: Point2, ifcZ: number, offset: Vec3): Vec3 {
  return {
    x: p.x - offset.x,
    y: ifcZ - offset.y,
    z: -p.y - offset.z,
  };
}

/**
 * Viewer Y-up world point → IFC plan XY (inverse of `ifcToWorld`, dropping
 * elevation). Used to read a picked world point back into calibration space.
 */
export function worldToIfcMetres(world: Vec3, offset: Vec3): Point2 {
  return {
    x: world.x + offset.x,
    y: -(world.z + offset.z),
  };
}

/** Elevation (IFC Z metres) of a world point. */
export function worldToIfcZ(world: Vec3, offset: Vec3): number {
  return world.y + offset.y;
}

/**
 * The four world-space corners of a placed drawing plane, plus the plane's
 * world height. Corner order matches texture UVs for a y-down raster image:
 *
 *  - `tl` = page (0, H)  → uv (0, 0)
 *  - `tr` = page (W, H)  → uv (1, 0)
 *  - `br` = page (W, 0)  → uv (1, 1)
 *  - `bl` = page (0, 0)  → uv (0, 1)
 *
 * (A rendered PDF page raster has its first pixel row at the top of the page,
 * i.e. at page y = H — hence top-of-page maps to v = 0.)
 */
export interface PlacementCorners {
  tl: Vec3;
  tr: Vec3;
  br: Vec3;
  bl: Vec3;
  /** World Y the plane sits at (storey elevation − offset.y + lift). */
  planeY: number;
}

/**
 * Compute the world-space quad for a placement. `lift` raises the plane
 * slightly above the storey elevation to avoid z-fighting with the slab.
 */
export function placementWorldCorners(
  placement: DrawingPlacement,
  offset: Vec3,
  lift: number = DEFAULT_PLANE_LIFT,
): PlacementCorners {
  const [w, h] = placement.pageSize;
  const z = placement.storeyZ + lift;
  const corner = (u: number, v: number): Vec3 =>
    ifcToWorld(pageToIfcMetres(placement.affine, { x: u, y: v }), z, offset);

  return {
    tl: corner(0, h),
    tr: corner(w, h),
    br: corner(w, 0),
    bl: corner(0, 0),
    planeY: z - offset.y,
  };
}
