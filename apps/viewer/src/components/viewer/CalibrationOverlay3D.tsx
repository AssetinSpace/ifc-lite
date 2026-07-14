/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * 3D overlay for drawing-underlay calibration (D-072) — Dalux-style
 * reference-point feedback: the picked model points render as labelled
 * A / B markers with a connecting line, re-projected every frame, so the
 * user sees exactly which model span the calibration is based on and can
 * compare its direction with the A–B line on the PDF preview.
 *
 * Same rAF + procedural-SVG pattern as BasepointOverlay: no React
 * re-renders per frame, `pointer-events: none` so picking stays live.
 */

import { useEffect, useRef } from 'react';
import { useViewerStore } from '@/store';
import { getGlobalRenderer } from '@/hooks/useBCF';
import { totalYupOffset } from '@/lib/geo/ifc-origin';

const MARKER_COLOR = '#10b981'; // emerald-500, matches the pane marker
const LABELS = ['A', 'B'] as const;

export function CalibrationOverlay3D() {
  const calibration = useViewerStore((s) => s.underlayCalibration);
  const active = !!calibration && calibration.modelPoints.length > 0;

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
      const c = state.underlayCalibration;
      if (!renderer || !svg || !canvas || !c) {
        rafRef.current = requestAnimationFrame(paint);
        return;
      }
      const camera = renderer.getCamera();
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;

      // IFC plan metres → viewer world at the pick height (the cut plane
      // while the drawing view is locked, else the storey plan height).
      const first = [...state.models.values()].find((m) => m.geometryResult?.coordinateInfo);
      const off = totalYupOffset(first?.geometryResult?.coordinateInfo);
      const worldY = state.underlayCut ?? c.storeyZ + 1.2 - off.y;

      const screens = c.modelPoints.map((p) =>
        camera.projectToScreen({ x: p.x - off.x, y: worldY, z: -p.y - off.z }, w, h),
      );

      const fragments: string[] = [];
      if (screens.length === 2 && screens[0] && screens[1]) {
        fragments.push(`
          <line x1="${screens[0].x}" y1="${screens[0].y}" x2="${screens[1].x}" y2="${screens[1].y}"
            stroke="${MARKER_COLOR}" stroke-width="2" stroke-dasharray="6 4" />
        `);
      }
      screens.forEach((s, i) => {
        if (!s) return;
        fragments.push(`
          <g transform="translate(${Math.round(s.x)} ${Math.round(s.y)})">
            <circle cx="0" cy="0" r="9" fill="${MARKER_COLOR}" fill-opacity="0.9" stroke="white" stroke-width="2" />
            <text x="0" y="3.5" text-anchor="middle" font-family="ui-sans-serif, sans-serif"
              font-size="10" font-weight="700" fill="white">${LABELS[i] ?? i + 1}</text>
          </g>
        `);
      });
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
