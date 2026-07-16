/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Workspace view mode (D-075): 3D | 2D | Split, Dalux-style.
 *
 * The mode is DERIVED from the drawing-underlay flags rather than stored —
 * `underlaySplitView` / `underlayViewLocked` / `underlayPlanFull` are already
 * the source of truth for the plan pane, the storey cut and the calibration
 * flow, and a second stored mode would have to be kept in sync with all of
 * them. This hook is the one place that maps the flag combinations to a
 * user-facing mode and back.
 *
 *   '2d'    — plan pane fills the center (split + plan-full), or the locked
 *             top-down calibration/model view when no drawing is calibrated.
 *   'split' — resizable 2D plan | free 3D.
 *   '3d'    — everything else (the default workspace).
 */

import { useCallback, useMemo } from 'react';
import { useViewerStore } from '@/store';
import { useIfc } from './useIfc';
import { useFloorplanView, type StoreyInfo } from './useFloorplanView';

export type ViewMode = '3d' | '2d' | 'split';

/** A storey option with its resolved GlobalId (view state binds to GUIDs). */
export interface ViewModeStorey {
  key: string;
  name: string;
  elevation: number;
  guid: string;
  info: StoreyInfo;
}

export function useViewMode() {
  const splitView = useViewerStore((s) => s.underlaySplitView);
  const planFull = useViewerStore((s) => s.underlayPlanFull);
  const viewLocked = useViewerStore((s) => s.underlayViewLocked);
  const activeStoreyGuid = useViewerStore((s) => s.underlayActiveStoreyGuid);
  const lastStoreyGuid = useViewerStore((s) => s.underlayLastStoreyGuid);
  const drawings = useViewerStore((s) => s.underlayDrawings);
  const { models, ifcDataStore } = useIfc();
  const {
    availableStoreys,
    enterDrawingView,
    exitDrawingView,
    enterSplitView,
    enterPlanView,
    exitSplitView,
    retargetView,
  } = useFloorplanView();

  const mode: ViewMode = useMemo(() => {
    if (splitView && planFull) return '2d';
    if (splitView) return 'split';
    if (viewLocked) return '2d';
    return '3d';
  }, [splitView, planFull, viewLocked]);

  // Storeys with resolved GlobalIds (same resolution as DrawingUnderlayPanel;
  // storeys without a GUID are unusable — placements couldn't bind to them).
  const storeys = useMemo((): ViewModeStorey[] => {
    const options: ViewModeStorey[] = [];
    for (const s of availableStoreys) {
      const store =
        s.modelId === 'legacy' ? ifcDataStore : models.get(s.modelId)?.ifcDataStore;
      const guid = store?.entities.getGlobalId(s.expressId) ?? '';
      if (!guid) continue;
      options.push({
        key: `${s.modelId}:${s.expressId}`,
        name: s.name,
        elevation: s.elevation,
        guid,
        info: s,
      });
    }
    return options;
  }, [availableStoreys, models, ifcDataStore]);

  /** Does the storey have a calibrated, visible drawing (plan pane content)? */
  const storeyHasDrawing = useCallback(
    (guid: string): boolean => {
      for (const d of drawings.values()) {
        if (d.placement && d.placement.visible && d.placement.storeyGuid === guid) return true;
      }
      return false;
    },
    [drawings],
  );

  /** Target storey: explicit pick → active → last used → first available. */
  const resolveStorey = useCallback(
    (explicit?: ViewModeStorey): ViewModeStorey | null => {
      if (explicit) return explicit;
      const byGuid = (guid: string | null) =>
        guid ? (storeys.find((s) => s.guid === guid) ?? null) : null;
      return byGuid(activeStoreyGuid) ?? byGuid(lastStoreyGuid) ?? storeys[0] ?? null;
    },
    [storeys, activeStoreyGuid, lastStoreyGuid],
  );

  const setMode = useCallback(
    (next: ViewMode, storey?: ViewModeStorey) => {
      const state = useViewerStore.getState();
      if (next === '3d') {
        if (state.underlaySplitView) exitSplitView();
        if (state.underlayViewLocked) exitDrawingView();
        return;
      }
      const target = resolveStorey(storey);
      if (!target) return; // no storeys yet — the switcher is disabled anyway
      if (next === 'split') {
        // From 2D just re-open the 3D pane; the binding and cut are shared.
        if (state.underlaySplitView && state.underlayPlanFull && !storey) {
          state.setUnderlayPlanFull(false);
          return;
        }
        enterSplitView(target.info);
        return;
      }
      // '2d' — plan pane when the storey has a calibrated drawing; otherwise
      // the locked ortho top-down MODEL view (Dalux behaviour without plans).
      if (storeyHasDrawing(target.guid)) {
        if (state.underlaySplitView && !state.underlayPlanFull && !storey) {
          state.setUnderlayPlanFull(true);
          return;
        }
        enterPlanView(target.info);
      } else {
        enterDrawingView(target.info);
      }
    },
    [
      resolveStorey,
      storeyHasDrawing,
      enterSplitView,
      enterPlanView,
      enterDrawingView,
      exitDrawingView,
      exitSplitView,
    ],
  );

  /** Move an active 2D/Split view to another storey (mode is kept). */
  const setStorey = useCallback(
    (storey: ViewModeStorey) => {
      if (mode === '3d') return;
      // 2D with a drawing ↔ 2D without one differ in surface (plan pane vs
      // locked model view), so a storey change re-evaluates the mode.
      if (mode === '2d') {
        setMode('2d', storey);
        return;
      }
      retargetView(storey.info);
    },
    [mode, setMode, retargetView],
  );

  const activeStorey = useMemo(
    () => storeys.find((s) => s.guid === activeStoreyGuid) ?? null,
    [storeys, activeStoreyGuid],
  );

  return { mode, setMode, setStorey, storeys, activeStorey };
}
