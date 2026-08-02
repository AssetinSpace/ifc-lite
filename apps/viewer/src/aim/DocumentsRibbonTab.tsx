/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Ribbon · Documents tab — the fork's own ribbon tab, gathering the
 * AIM-layer surfaces that upstream's five tabs have no home for:
 *
 *   · Documents  — the project document library (D-075), `documents` panel
 *   · Underlays  — georeferenced PDF drawing underlays (D-072)
 *   · 3D | 2D | Split (+ storey) — the workspace view mode (D-075)
 *
 * Nothing new and nothing moved out from under anyone: every button drives
 * the same store action the classic toolbar and the sidebar rail already
 * drive, so both toolbar styles keep offering the identical command set.
 * Since the ribbon became the default toolbar (upstream #1880), these were
 * reachable there only via the sidebar rail — this tab is the missing
 * ribbon-side entry point.
 *
 * The tab body lives here, under `src/aim/`, so upstream (which has no such
 * file) can never conflict with it; the two-line wiring into the ribbon
 * itself is bracketed with `AIM-FORK` sentinels — see docs/FORK_MAINTENANCE.md.
 */

import { Columns2, Files, Map as MapIcon } from 'lucide-react';
import { IsometricView, TopView } from '@/icons';
import { useViewerStore } from '@/store';
import { useViewMode } from '@/hooks/useViewMode';
import { viewModeDisabledReason } from '@/hooks/viewModeCore';
import { VIEW_MODES, StoreyPicker } from '@/components/viewer/ViewModeSwitcher';
import {
  RibbonGroup,
  RibbonGroupDivider,
  RibbonLargeButton,
} from '@/components/viewer/ribbon/primitives';

/** Ribbon icons for the view modes, keyed by the shared `VIEW_MODES` ids. */
const MODE_ICONS = {
  '3d': IsometricView,
  '2d': TopView,
  split: Columns2,
} as const;

export function DocumentsRibbonTab() {
  // The two fork panels are single-tenant sidebar panels like every other
  // one, so their store flag IS the latched state (same read the mobile
  // toolbar uses); `toggleWorkspacePanel` handles the docking rules.
  const documentsPanelVisible = useViewerStore((s) => s.documentsPanelVisible);
  const underlayPanelVisible = useViewerStore((s) => s.underlayPanelVisible);
  const calibrating = useViewerStore((s) => s.underlayCalibration !== null);

  const { mode, setMode, storeys } = useViewMode();
  const disabledReason = viewModeDisabledReason({ calibrating, storeyCount: storeys.length });

  return (
    <>
      <RibbonGroup label="Library">
        <RibbonLargeButton
          icon={Files}
          label="Documents"
          tooltip="Project documents (PDFs & images) — open as tabs"
          active={documentsPanelVisible}
          onClick={() => useViewerStore.getState().toggleWorkspacePanel('documents')}
        />
        <RibbonLargeButton
          icon={MapIcon}
          label="Underlays"
          tooltip="Drawing underlays — georeferenced PDF plans"
          active={underlayPanelVisible}
          onClick={() => useViewerStore.getState().toggleWorkspacePanel('drawing-underlay')}
        />
      </RibbonGroup>

      <RibbonGroupDivider />

      {/* Same control as the classic toolbar's segmented switcher, in ribbon
          shape: identical modes, identical gating, identical storey picker. */}
      <RibbonGroup label="View mode">
        {VIEW_MODES.map((m) => (
          <RibbonLargeButton
            key={m.id}
            icon={MODE_ICONS[m.id]}
            label={m.label}
            tooltip={disabledReason ?? m.title}
            active={mode === m.id}
            disabled={disabledReason !== null}
            onClick={() => setMode(m.id)}
          />
        ))}
        <div className="flex h-full items-center pl-1">
          <StoreyPicker className="h-7" />
        </div>
      </RibbonGroup>
    </>
  );
}
