/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * @ifc-lite/drawing-underlay — georeferenced 2D drawing underlays (PDF floor
 * plans) for IFC models: placement schema, 2-point similarity calibration,
 * drawing-to-world transforms, and a WebGPU textured-plane pipeline.
 */

export {
  adjustAffine,
  applyAffine,
  composeAffine,
  invertAffine,
  similarityRotation,
  similarityScale,
  solveSimilarityFromCalibration,
} from './similarity.js';
export type { Affine2x3, CalibrationPair, Point2 } from './similarity.js';

export {
  createDrawingPlacement,
  DEFAULT_UNDERLAY_OPACITY,
  parsePlacement,
  serializePlacement,
} from './placement.js';
export type {
  CreateDrawingPlacementInput,
  DrawingPlacement,
  GeorefJsonV1,
  PlacementCalibrationPair,
} from './placement.js';

export {
  DEFAULT_PLANE_LIFT,
  ifcMetresToPage,
  ifcToWorld,
  pageToIfcMetres,
  placementWorldCorners,
  worldToIfcMetres,
  worldToIfcZ,
  ZERO_OFFSET,
} from './world-transform.js';
export type { PlacementCorners, Vec3 } from './world-transform.js';

export { PdfPlanePipeline } from './pdf-plane-pipeline.js';
export type {
  PdfPlanePipelineOptions,
  PlaneImageSource,
  PlaneInput,
} from './pdf-plane-pipeline.js';
