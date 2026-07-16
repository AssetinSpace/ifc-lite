---
"@ifc-lite/drawing-underlay": minor
---

`PdfPlanePipeline` gains `setOcclude(boolean)`: when `false` the plane draws with `depthCompare: 'always'` (no z-fighting with a coplanar slab — correct for a top-down storey-cut floor plan where nothing above the cut should occlude it); when `true` (default) it is depth-tested with a stronger slope-scaled decal bias so it stays put at grazing angles in free 3D. `DEFAULT_PLANE_LIFT` raised 0.02 → 0.05 m.

New affine fine-tuning helpers: `composeAffine(b, a)` (matrix composition, apply `a` then `b`) and `adjustAffine(affine, { translate?, rotateRad?, scaleFactor?, center? })` — post-composes a model-space nudge (translate metres / rotate / scale about a pivot) onto an existing placement, so a calibration can be numerically refined without re-picking points.

New `similarityFromAnchor(anchor, scale, rotationRad)` builds the placement similarity from ONE point correspondence plus an explicit scale and rotation — the "1 point + scale + angle" calibration mode, exact when the drawing's title-block scale is trusted and immune to the angular error a short 2-point pick span amplifies.
