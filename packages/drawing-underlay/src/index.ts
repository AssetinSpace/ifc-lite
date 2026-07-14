/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * @ifc-lite/drawing-underlay — georeferenced 2D drawing underlays (PDF floor
 * plans) for IFC models: placement schema, 2-point similarity calibration,
 * drawing-to-world transforms, and a WebGPU textured-plane pipeline.
 *
 * Module map (populated milestone by milestone):
 *  - placement.ts       DrawingPlacement schema + (de)serialization (M1)
 *  - similarity.ts      2-point similarity solve + affine helpers (M1)
 *  - world-transform.ts drawing px -> IFC metres -> Y-up world corners (M1)
 *  - pdf-plane-pipeline.ts  self-contained WebGPU textured quad (M2)
 */

export {};
