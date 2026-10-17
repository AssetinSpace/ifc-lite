/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Hook for automatic floorplan views per storey.
 *
 * Activates a plan-cut section plane at the storey's elevation and opens the
 * Drawing panel docked so the cut is visible immediately (#5497). It used to
 * also force the 3D viewport into orthographic top-down; that stopped being
 * automatic — the Drawing header's "Match 3D" button applies it on request
 * instead, so switching storeys no longer yanks the 3D camera out from under
 * a user who was mid-orbit.
 */

import { useCallback, useMemo } from 'react';
import { useViewerStore } from '@/store';
import { totalYupOffset } from '@/lib/geo/coordinate-frame';
import { useIfc } from './useIfc';
import {
  collectStoreys,
  mergedSectionBounds,
  sectionAxisRange,
  storeyCutElevation,
  worldToPercent,
  type SectionStorey,
} from '@/lib/section/section-distance';

// >>> AIM-FORK: fork consumers (DrawingUnderlayPanel, ViewModeSwitcher) name the
// storey shape `StoreyInfo`; upstream's `SectionStorey` is the same record.
export type StoreyInfo = SectionStorey;
// <<< AIM-FORK

/**
 * A storey option with its resolved GlobalId — the single source for every
 * storey picker (DrawingUnderlayPanel, ViewModeSwitcher). Placements and the
 * 2D/Split view bind to storey GUIDs (stable across loads), never the
 * session-scoped expressId; storeys without a GUID are unusable and filtered.
 */
export interface StoreyOption {
  key: string;
  name: string;
  elevation: number;
  guid: string;
  info: StoreyInfo;
}

export function useFloorplanView() {
  const { models, ifcDataStore, geometryResult } = useIfc();
  const setSectionPlaneAxis = useViewerStore((s) => s.setSectionPlaneAxis);
  const setSectionPlanePosition = useViewerStore((s) => s.setSectionPlanePosition);
  const setActiveTool = useViewerStore((s) => s.setActiveTool);
  const openPanelInHome = useViewerStore((s) => s.openPanelInHome);
  // >>> AIM-FORK: the D-072/D-075 drawing, split and 2D views drive projection + camera
  const setProjectionMode = useViewerStore((s) => s.setProjectionMode);
  const cameraCallbacks = useViewerStore((s) => s.cameraCallbacks);
  // <<< AIM-FORK

  // Every storey, deduplicated and sorted top-down — the same list the
  // Section bar's storey menu offers (#5499), from the one collector.
  const availableStoreys = useMemo(
    (): SectionStorey[] => collectStoreys(models, ifcDataStore),
    [models, ifcDataStore],
  );

  // Recentering offset of the shared (anchor) frame. Storey elevations are
  // IFC Z metres; the renderer works in recentered viewer-Y metres. Every
  // consumer of a "cut Y" expects the recentered value, so convert here.
  const worldCutY = useCallback(
    (storey: StoreyInfo): number => {
      const first = [...models.values()].find((m) => m.geometryResult?.coordinateInfo);
      const off = totalYupOffset(first?.geometryResult?.coordinateInfo);
      // Cut 1.2 m above the floor (standard architectural plan-cut height).
      return storey.elevation + 1.2 - off.y;
    },
    [models],
  );

  // Activate a floorplan view at the given storey elevation
  const activateFloorplan = useCallback((storey: SectionStorey) => {
    // The plan cut sits 1.2 m above the floor (standard architectural
    // practice), expressed as a percentage of the merged Y bounds — the
    // same conversion the Section bar's distance field uses.
    const range = sectionAxisRange(mergedSectionBounds(models, geometryResult), 'down');
    // Fallback bounds if no coordinate info available
    const percentage = range ? worldToPercent(storeyCutElevation(storey), range) : 50;

    // 2. Set section plane: axis=down (Y), position=calculated, enabled
    setSectionPlaneAxis('down');
    setSectionPlanePosition(percentage);
    setActiveTool('section', 'programmatic');

    // 3. Show the cut: dock the Drawing panel (no forced 3D camera change —
    // "Match 3D" in its header does that on request, #5497).
    openPanelInHome('drawing', 'programmatic');
  }, [models, geometryResult, setSectionPlaneAxis, setSectionPlanePosition, setActiveTool, openPanelInHome]);

  /**
   * Drawing view (D-072): level-locked ortho top-down with an always-on
   * horizontal cut, independent of the Section tool. Unlike
   * `activateFloorplan`, the camera is locked (drag pans instead of
   * orbiting) and the cut survives tool switches; Ctrl/Cmd+scroll moves it.
   */
  const storeyGuidFor = useCallback(
    (storey: StoreyInfo): string | null => {
      const store =
        storey.modelId === 'legacy' ? ifcDataStore : models.get(storey.modelId)?.ifcDataStore;
      return store?.entities.getGlobalId?.(storey.expressId) || null;
    },
    [models, ifcDataStore],
  );

  const enterDrawingView = useCallback((storey: StoreyInfo) => {
    const state = useViewerStore.getState();
    // Idempotent camera: when the locked top-down view is already active
    // (Recalibrate, or switching storeys mid-calibration) only the cut moves —
    // re-applying the top preset visibly spins the view (live report).
    const alreadyTopDown = state.underlayViewLocked;
    state.setUnderlayCut(worldCutY(storey));
    state.setUnderlayViewLocked(true);
    state.setUnderlaySplitView(false);
    state.setUnderlayPlanFull(false);
    state.setUnderlayActiveStoreyGuid(storeyGuidFor(storey));
    if (!alreadyTopDown) {
      setProjectionMode('orthographic');
      cameraCallbacks.setPresetView?.('top');
    }
  }, [worldCutY, storeyGuidFor, setProjectionMode, cameraCallbacks]);

  /**
   * Move an ACTIVE drawing/split view to another storey: update the cut and
   * the bound storey GUID, leaving camera and projection untouched. No-op
   * when neither view is active (a dropdown change alone shouldn't cut).
   */
  const retargetView = useCallback((storey: StoreyInfo) => {
    const state = useViewerStore.getState();
    if (!state.underlayViewLocked && !state.underlaySplitView) return;
    state.setUnderlayCut(worldCutY(storey));
    state.setUnderlayActiveStoreyGuid(storeyGuidFor(storey));
    state.setUnderlayPlanPin(null); // pin belongs to the previous storey's plan
  }, [worldCutY, storeyGuidFor]);

  /** Leave the drawing view: remove the cut, unlock the camera. */
  const exitDrawingView = useCallback(() => {
    const state = useViewerStore.getState();
    state.setUnderlayCut(null);
    state.setUnderlayViewLocked(false);
    state.setUnderlayActiveStoreyGuid(null);
    setProjectionMode('perspective');
  }, [setProjectionMode]);

  /**
   * Split view (D-072): real 2D plan | 3D layout with a FREELY navigable 3D
   * pane (Dalux-style). Unlike the calibration drawing view, the camera is
   * NOT locked — the storey cut is on so the level reads clearly, and the 2D
   * pane is the position minimap. Starts from a pleasant 3/4 home view.
   */
  const enterSplitView = useCallback((storey: StoreyInfo) => {
    const state = useViewerStore.getState();
    state.setUnderlayCut(worldCutY(storey));
    state.setUnderlayViewLocked(false);
    state.setUnderlaySplitView(true);
    state.setUnderlayPlanFull(false);
    state.setUnderlayActiveStoreyGuid(storeyGuidFor(storey));
    state.setUnderlayPlanPin(null);
    setProjectionMode('perspective');
    cameraCallbacks.home?.();
  }, [worldCutY, storeyGuidFor, setProjectionMode, cameraCallbacks]);

  /**
   * 2D plan view (D-075): the calibrated drawing takes the whole center pane
   * and the 3D panel collapses (it stays mounted). Implemented as split view
   * + `underlayPlanFull` so the plan pane, cut and storey binding are shared;
   * the camera is left alone — the 3D pane is not visible in this mode.
   */
  const enterPlanView = useCallback((storey: StoreyInfo) => {
    const state = useViewerStore.getState();
    state.setUnderlayCut(worldCutY(storey));
    state.setUnderlayViewLocked(false);
    state.setUnderlaySplitView(true);
    state.setUnderlayPlanFull(true);
    state.setUnderlayActiveStoreyGuid(storeyGuidFor(storey));
    state.setUnderlayPlanPin(null);
  }, [worldCutY, storeyGuidFor]);

  /** Leave split view: close the 2D pane, remove the cut. */
  const exitSplitView = useCallback(() => {
    const state = useViewerStore.getState();
    state.setUnderlaySplitView(false);
    state.setUnderlayPlanFull(false);
    state.setUnderlayCut(null);
    state.setUnderlayActiveStoreyGuid(null);
    state.setUnderlayPlanPin(null);
  }, []);

  const storeyOptions = useMemo((): StoreyOption[] => {
    const options: StoreyOption[] = [];
    for (const s of availableStoreys) {
      const guid = storeyGuidFor(s);
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
  }, [availableStoreys, storeyGuidFor]);

  return {
    availableStoreys,
    storeyOptions,
    activateFloorplan,
    enterDrawingView,
    exitDrawingView,
    enterSplitView,
    enterPlanView,
    exitSplitView,
    retargetView,
  };
}
