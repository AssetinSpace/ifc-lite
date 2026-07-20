---
"@ifc-lite/drawing-underlay": minor
---

Export `similarityFromAnchor` — the "1 point + scale + angle" calibration. Given a single anchor correspondence plus an explicit scale (model metres per PDF page point) and CCW rotation, it builds the proper similarity affine that maps the anchor page point exactly onto its model point. Complements the 2-point `solveSimilarityFromCalibration` for the common case where scale comes from a drawing's title block (1:N) and rotation is 0°, so one unambiguous pivot fully determines the placement.
