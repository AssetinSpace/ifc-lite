/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * 3D location pin (D-072 split view) — the 3D counterpart of the green pin
 * in the 2D plan pane. The pin is the last spot CLICKED on the plan (page
 * coordinates in the store), mapped through the drawing's affine onto the
 * placed plane, so both panes always mark the identical drawing spot and
 * camera moves never displace it. Re-projected every frame only because the
 * camera changes — the anchored world point itself is fixed.
 *
 * Same rAF + procedural-SVG, `pointer-events: none` pattern as
 * CalibrationOverlay3D / BasepointOverlay.
 *
 * Hidden in walk mode: there the user IS the marker (street-view semantics),
 * so a ball floating at their own position would only block the view — the
 * 2D pane shows position + look direction instead.
 */

import { useEffect, useRef } from 'react';
import {
  DEFAULT_PLANE_LIFT,
  pageToIfcMetres,
  type DrawingPlacement,
} from '@ifc-lite/drawing-underlay';
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
      if (!renderer || !svg || !canvas) {
        rafRef.current = requestAnimationFrame(paint);
        return;
      }

      // The pin lives on the active storey's placed drawing; without a pin
      // (nothing clicked yet) or a placement there is nothing to mark.
      const pin = state.underlayPlanPin;
      const guid = state.underlayActiveStoreyGuid;
      let placement: DrawingPlacement | null = null;
      if (guid) {
        for (const d of state.underlayDrawings.values()) {
          if (d.placement && d.placement.storeyGuid === guid) {
            placement = d.placement;
            break;
          }
        }
      }
      if (!pin || !placement) {
        svg.innerHTML = '';
        rafRef.current = requestAnimationFrame(paint);
        return;
      }

      const camera = renderer.getCamera();
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;

      // Fixed world point: pin page pt → IFC plan metres → recentered world,
      // sitting ON the drawing plane (storey elevation + lift).
      const first = [...state.models.values()].find((m) => m.geometryResult?.coordinateInfo);
      const off = totalYupOffset(first?.geometryResult?.coordinateInfo);
      const ifc = pageToIfcMetres(placement.affine, pin);
      const p = {
        x: ifc.x - off.x,
        y: placement.storeyZ + DEFAULT_PLANE_LIFT - off.y,
        z: -ifc.y - off.z,
      };

      const sp = camera.projectToScreen(p, w, h);
      svg.innerHTML = sp
        ? `<circle cx="${sp.x}" cy="${sp.y}" r="6" fill="${MARKER_COLOR}" fill-opacity="0.9"
            stroke="white" stroke-width="2" />`
        : '';
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
