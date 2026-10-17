# @ifc-lite/drawing-underlay

Georeferenced 2D drawing underlays for IFC models: attach a PDF floor plan (or any
raster image) to an `IfcBuildingStorey` so it sits at the correct XY position,
rotation, scale, and storey elevation in world space.

The package is deliberately small and dependency-free:

- **`DrawingPlacement`** — a versioned, serializable placement record (storey
  GlobalId, storey elevation, page + page size, a 2×3 affine from drawing pixels to
  IFC model metres, the calibration point pairs that produced it, opacity,
  discipline).
- **`solveSimilarityFromCalibration`** — derives a similarity transform (uniform
  scale + rotation + translation) from two point correspondences: two points picked
  on the drawing and their matching model coordinates.
- **World-transform helpers** — map drawing pixels through the affine into IFC model
  metres and on into a Y-up viewer world frame (the IFC Z-up → viewer Y-up axis swap
  plus a caller-supplied recentering offset), producing the four world-space corners
  of the drawing plane at the storey elevation.
- **`PdfPlanePipeline`** — a self-contained WebGPU pipeline that draws the placed
  drawing as an alpha-blended, depth-tested (non-depth-writing) textured quad. The
  caller uploads an `ImageBitmap`/canvas (e.g. a pdf.js-rendered page — PDF rendering
  itself is intentionally *not* part of this package) and invokes
  `render(pass, viewProj)` from inside an existing render pass.

## Usage sketch

```ts
import {
  solveSimilarityFromCalibration,
  createDrawingPlacement,
  placementWorldCorners,
  type CalibrationPair,
  type Vec3,
} from '@ifc-lite/drawing-underlay';

// Two picks on the drawing (PDF page points) matched to two model points (IFC metres).
const pairs: [CalibrationPair, CalibrationPair] = [
  { page: { x: 120, y: 840 }, model: { x: 0.0, y: 0.0 } },
  { page: { x: 1980, y: 850 }, model: { x: 24.6, y: 0.1 } },
];
const affine = solveSimilarityFromCalibration(pairs);

const placement = createDrawingPlacement({
  storeyGuid: '2O2Fr$t4X7Zf8NOew3FLOH',
  storeyZ: 3.0,           // metres, IFC Z
  page: 1,
  pageSize: [841, 1189],  // PDF points (A0)
  affine,
  calibration: pairs,     // kept for re-editing
});

// Four Y-up world-space corners for the textured quad. `yUpOffset` is the
// viewer's recentering shift for the owning model (in the viewer app:
// totalYupOffset(coordinateInfo)); zero when the model is not recentred.
const yUpOffset: Vec3 = { x: 0, y: 0, z: 0 };
const corners = placementWorldCorners(placement, yUpOffset);
```

See the ifc-lite viewer app for a full integration (pdf.js rasterization, storey
picker, calibration UI, persistence).
