---
"@ifc-lite/drawing-underlay": minor
---

New package: georeferenced 2D drawing underlays (PDF floor plans) for IFC models. Attach a drawing to an IfcBuildingStorey via 2-point calibration — `solveSimilarityFromCalibration` derives the uniform scale + rotation + translation mapping PDF page points (y-up, resolution-independent) to IFC model metres. Ships a versioned, validating `DrawingPlacement` schema (`_georef` v1 JSON: storey GlobalId, cached storey elevation, page + page size, affine, re-editable calibration pairs, opacity, discipline) and world-transform helpers that place the drawing plane in a Y-up viewer world frame (IFC Z-up axis swap plus a caller-supplied recentering offset), including textured-quad corner/UV computation. Framework-free: no viewer, React, or pdf.js dependency — hosts pass image bitmaps and offsets in.
