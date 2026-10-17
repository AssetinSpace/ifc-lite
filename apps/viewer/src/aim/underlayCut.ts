/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * AIM fork (D-072): the drawing-view storey cut as renderer clip options.
 * It takes precedence over the Section tool's clip: it must survive whatever
 * tool is active, otherwise opening the Section tool would silently drop the
 * floor-plan cut.
 */

import type { RenderOptions } from '@ifc-lite/renderer';

/**
 * Drawing-view cut (D-072) → the renderer's axis/percent section form.
 * A horizontal cut at world-Y `cutY`, expressed like the Section tool's
 * `axis: 'down'` plane so the same clip + cap machinery applies. Returns
 * undefined when there is no cut or no bounds yet (first frames).
 */
function underlayCutPlane(
  cutY: number | null,
  bounds: { min: { x: number; y: number; z: number }; max: { x: number; y: number; z: number } } | null,
):
  | { axis: 'down'; position: number; enabled: true; flipped: false; showCap: false; showOutlines: true }
  | undefined {
  if (cutY === null || !bounds) return undefined;
  const range = bounds.max.y - bounds.min.y;
  if (!(range > 0)) return undefined;
  const position = Math.max(0, Math.min(100, ((cutY - bounds.min.y) / range) * 100));
  // No cap fills: the PDF underlay draws depth-always + translucent, so the
  // grey hatched cap surfaces would shine through it as blotches (live
  // report). Outlines stay — the cut still reads clearly, plan-style.
  return { axis: 'down', position, enabled: true, flipped: false, showCap: false, showOutlines: true };
}

/** Clip overrides for `viewportRenderOptions`; `{}` when no cut is active. */
export function underlayCutClip(
  cutY: number | null,
  bounds: { min: { x: number; y: number; z: number }; max: { x: number; y: number; z: number } } | null,
): Pick<RenderOptions, 'sectionPlane' | 'extraSectionPlanes' | 'clipBox'> {
  const plane = underlayCutPlane(cutY, bounds);
  return plane ? { sectionPlane: plane, extraSectionPlanes: undefined, clipBox: undefined } : {};
}
