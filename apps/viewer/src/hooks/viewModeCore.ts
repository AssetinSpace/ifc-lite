/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Pure core of the workspace view mode (D-075) — kept import-free so the
 * node test runner can load it without dragging in the Vite-only store.
 */

export type ViewMode = '3d' | '2d' | 'split';

/** Flag combination → user-facing mode. The underlay flags stay the source
 *  of truth (see useViewMode); this is the one place they map to a mode. */
export function deriveViewMode(flags: {
  splitView: boolean;
  planFull: boolean;
  viewLocked: boolean;
}): ViewMode {
  if (flags.splitView && flags.planFull) return '2d';
  if (flags.splitView) return 'split';
  if (flags.viewLocked) return '2d';
  return '3d';
}

/**
 * Why the mode switcher is unavailable, or null when it is usable. Shared
 * by every surface that offers the switch (classic toolbar, mobile toolbar,
 * ribbon Documents tab) so they can never disagree about when 2D/Split is
 * reachable — the string doubles as the tooltip.
 */
export function viewModeDisabledReason(gate: {
  calibrating: boolean;
  storeyCount: number;
}): string | null {
  if (gate.calibrating) return 'Finish or cancel the calibration first';
  if (gate.storeyCount === 0) return 'Load a model with storeys first';
  return null;
}
