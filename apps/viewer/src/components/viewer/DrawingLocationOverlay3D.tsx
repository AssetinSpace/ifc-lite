/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * 3D location marker (D-072 split view) — the 3D counterpart of the green
 * "you are here" marker in the 2D plan pane. While the split view is active
 * it draws, every frame:
 *
 *  - a green circle at the camera target's plan position, snapped DOWN onto
 *    the drawing plane (the placement's storey elevation), so the marker sits
 *    on the floor plan instead of floating at the orbit target's height;
 *  - a translucent Dalux-style view cone showing the camera's horizontal
 *    look direction, oriented by projecting a second point 2 m ahead on the
 *    same plane.
 *
 * Same rAF + procedural-SVG, `pointer-events: none` pattern as
 * CalibrationOverlay3D / BasepointOverlay.
 *
 * Hidden in walk mode: there the user IS the marker (street-view semantics),
 * so a ball floating at their own position would only block the view — the
 * 2D pane still shows position + look direction.
 */

import { useEffect, useRef } from 'react';
import { DEFAULT_PLANE_LIFT } from '@ifc-lite/drawing-underlay';
import { useViewerStore } from '@/store';
import { getGlobalRenderer } from '@/hooks/useBCF';
import { totalYupOffset } from '@/lib/geo/ifc-origin';

const MARKER_COLOR = '#10b981'; // emerald-500, matches the 2D pane marker

export function DrawingLocationOverlay3D() {
  const splitView = useViewerStore((s) => s.underlaySplitView);
  const walkMode = useViewerStore((s) => s.activeTool === 'walk');
  const active = splitView && !walkMode;

  const containerRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    if (!active) return;
    const container = containerRef.current;
    if (!container) return;
    const canvas = container
      .closest('[data-viewport]')
      ?.querySelector('canvas') as HTMLCanvasElement | null;

    function paint() {
      const renderer = getGlobalRenderer();
      const svg = svgRef.current;
      const state = useViewerStore.getState();
      const vp = state.cameraCallbacks.getViewpoint?.();
      if (!renderer || !svg || !canvas || !vp) {
        rafRef.current = requestAnimationFrame(paint);
        return;
      }
      const camera = renderer.getCamera();
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;

      // Plane height: the active storey's placed drawing (storey elevation
      // in the recentered frame + lift), falling back to the cut plane.
      const first = [...state.models.values()].find((m) => m.geometryResult?.coordinateInfo);
      const off = totalYupOffset(first?.geometryResult?.coordinateInfo);
      let planeY = state.underlayCut ?? vp.target.y;
      const guid = state.underlayActiveStoreyGuid;
      if (guid) {
        for (const d of state.underlayDrawings.values()) {
          if (d.placement && d.placement.storeyGuid === guid) {
            planeY = d.placement.storeyZ + DEFAULT_PLANE_LIFT - off.y;
            break;
          }
        }
      }

      // Marker point = camera target's plan XZ, snapped onto the plane.
      const p = { x: vp.target.x, y: planeY, z: vp.target.z };

      // Horizontal look direction; near-top-down falls back to camera up.
      let fx = vp.target.x - vp.position.x;
      let fz = vp.target.z - vp.position.z;
      if (Math.hypot(fx, fz) < 1e-3) {
        fx = vp.up.x;
        fz = vp.up.z;
      }
      const flen = Math.hypot(fx, fz) || 1;
      const q = { x: p.x + (fx / flen) * 2, y: planeY, z: p.z + (fz / flen) * 2 };

      const sp = camera.projectToScreen(p, w, h);
      const sq = camera.projectToScreen(q, w, h);

      if (!sp) {
        svg.innerHTML = '';
        rafRef.current = requestAnimationFrame(paint);
        return;
      }

      const fragments: string[] = [];
      if (sq) {
        // Screen-space cone angle from the projected 2 m look segment; 0° in
        // the sector path points up, SVG rotate() is clockwise.
        const angleDeg = (Math.atan2(sq.x - sp.x, -(sq.y - sp.y)) * 180) / Math.PI;
        fragments.push(`
          <g transform="translate(${sp.x} ${sp.y}) rotate(${angleDeg})">
            <path d="M 0 0 L -19 -38 A 42.5 42.5 0 0 1 19 -38 Z"
              fill="rgb(16 185 129 / 0.30)" stroke="rgb(16 185 129 / 0.55)" stroke-width="1" />
          </g>
        `);
      }
      fragments.push(`
        <circle cx="${sp.x}" cy="${sp.y}" r="6" fill="${MARKER_COLOR}" fill-opacity="0.9"
          stroke="white" stroke-width="2" />
      `);
      svg.innerHTML = fragments.join('');
      rafRef.current = requestAnimationFrame(paint);
    }

    rafRef.current = requestAnimationFrame(paint);
    return () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [active]);

  if (!active) return null;
  return (
    <div ref={containerRef} className="pointer-events-none absolute inset-0 z-30">
      <svg ref={svgRef} className="absolute inset-0 h-full w-full" />
    </div>
  );
}
