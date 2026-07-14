---
"@ifc-lite/renderer": minor
---

New external-overlay hook: `Renderer.registerExternalOverlay(id, overlay)` / `unregisterExternalOverlay(id)` let app-level packages composite self-contained pipelines (the `ExternalOverlay` contract: `hasGeometry()` + `render(pass, viewProj)`) into the main blended pass, drawn beneath the symbolic annotation layer. `Renderer.getOverlayPassDescriptor()` exposes the pass attachment shape (device, presentation format, MSAA sample count, depth format, write-masked picker color target) so external pipelines can be constructed pass-compatible without reaching into renderer internals. First consumer: `@ifc-lite/drawing-underlay` textured drawing planes.
