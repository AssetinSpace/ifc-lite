/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * 3D location marker (D-072 split view) — the 3D counterpart of the green
 * "you are here" marker in the 2D plan pane. While the split view is active,
 * it projects the camera target onto the screen every frame and draws a green
 * circle there, so the 2D plan and the 3D scene agree on where you're looking.
 *
 * Same rAF + procedural-SVG, `pointer-events: none` pattern as
 * CalibrationOverlay3D / BasepointOverlay. The camera target is already a
 * viewer-world point, so no IFC↔world conversion is needed.
 */

import { useEffect, useRef } from 'react';
import { useViewerStore } from '@/store';
import { getGlobalRenderer } from '@/hooks/useBCF';

const MARKER_COLOR = '#10b981'; // emerald-500, matches the 2D pane marker

export function DrawingLocationOverlay3D() {
  const active = useViewerStore((s) => s.underlaySplitView);

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
      const vp = useViewerStore.getState().cameraCallbacks.getViewpoint?.();
      if (!renderer || !svg || !canvas || !vp) {
        rafRef.current = requestAnimationFrame(paint);
        return;
      }
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      const s = renderer.getCamera().projectToScreen(vp.target, w, h);
      svg.innerHTML = s
        ? `<g transform="translate(${Math.round(s.x)} ${Math.round(s.y)})">
             <circle cx="0" cy="0" r="6" fill="${MARKER_COLOR}" fill-opacity="0.9" stroke="white" stroke-width="2" />
           </g>`
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
