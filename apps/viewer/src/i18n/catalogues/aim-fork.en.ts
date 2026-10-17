/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * AIM fork: strings for the fork-only workspace panels (D-072 drawing
 * underlays, D-075 project documents). A separate catalogue so upstream
 * catalogues stay untouched (docs/FORK_MAINTENANCE.md).
 */
export const aimForkEn = {
  'aimFork.panel.drawingUnderlay': 'Drawing underlays',
  'aimFork.panel.documents': 'Documents',
  /** Assistant source picker: why the fork panels are not discussable (#6833 charter). */
  'aimFork.assistant.boundaryDrawingUnderlay': 'Georeferenced PDF plan underlays. Placing or calibrating a drawing produces no analysis result to discuss.',
  'aimFork.assistant.boundaryDocuments': 'Project document library. Opening a PDF or image produces no analysis result; the documents themselves live in the AIM platform.',
  /** Fork-only ribbon tab (D-072 / D-075); keyed like upstream's `ribbon.tab.*` because the band reads `t(`ribbon.tab.${tab}`)`. */
  'ribbon.tab.documents': 'Documents',
} as const;
