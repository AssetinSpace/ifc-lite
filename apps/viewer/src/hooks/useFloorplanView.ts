/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Hook for automatic floorplan views per storey.
 * Activates section plane + orthographic top-down view at storey elevation.
 */

import { useCallback, useMemo } from 'react';
import { useViewerStore } from '@/store';
import { totalYupOffset } from '@/lib/geo/ifc-origin';
import { useIfc } from './useIfc';

interface StoreyInfo {
  expressId: number;
  modelId: string;
  name: string;
  elevation: number;
}

export function useFloorplanView() {
  const { models, ifcDataStore } = useIfc();
  const setSectionPlaneAxis = useViewerStore((s) => s.setSectionPlaneAxis);
  const setSectionPlanePosition = useViewerStore((s) => s.setSectionPlanePosition);
  const setActiveTool = useViewerStore((s) => s.setActiveTool);
  const cameraCallbacks = useViewerStore((s) => s.cameraCallbacks);
  const setProjectionMode = useViewerStore((s) => s.setProjectionMode);

  // Collect all available storeys sorted by elevation (descending)
  const availableStoreys = useMemo((): StoreyInfo[] => {
    const storeys: StoreyInfo[] = [];

    if (models.size > 0) {
      for (const [modelId, model] of models) {
        const dataStore = model.ifcDataStore;
        if (!dataStore?.spatialHierarchy) continue;
        const { byStorey, storeyElevations } = dataStore.spatialHierarchy;

        for (const [storeyId] of byStorey.entries()) {
          const elevation = storeyElevations.get(storeyId) ?? 0;
          const name = dataStore.entities.getName(storeyId) || `Storey #${storeyId}`;
          storeys.push({ expressId: storeyId, modelId, name, elevation });
        }
      }
    } else if (ifcDataStore?.spatialHierarchy) {
      const { byStorey, storeyElevations } = ifcDataStore.spatialHierarchy;
      for (const [storeyId] of byStorey.entries()) {
        const elevation = storeyElevations.get(storeyId) ?? 0;
        const name = ifcDataStore.entities.getName(storeyId) || `Storey #${storeyId}`;
        storeys.push({ expressId: storeyId, modelId: 'legacy', name, elevation });
      }
    }

    // Deduplicate storeys at similar elevations (within 0.5m tolerance)
    const seen = new Map<string, StoreyInfo>();
    for (const s of storeys) {
      const key = (Math.round(s.elevation * 2) / 2).toFixed(2);
      if (!seen.has(key) || s.name.length < seen.get(key)!.name.length) {
        seen.set(key, s);
      }
    }

    return Array.from(seen.values()).sort((a, b) => b.elevation - a.elevation);
  }, [models, ifcDataStore]);

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
  const activateFloorplan = useCallback((storey: StoreyInfo) => {
    // 1. Calculate section position as percentage of Y bounds.
    // Cut 1.2 m above the floor, in the recentered viewer-Y frame (bounds
    // below are shiftedBounds, so cutHeight must be shifted too).
    const cutHeight = worldCutY(storey);

    // Find Y bounds from all models using coordinateInfo (pre-computed AABB)
    let yMin = Infinity;
    let yMax = -Infinity;
    if (models.size > 0) {
      for (const [, model] of models) {
        const bounds = model.geometryResult?.coordinateInfo?.shiftedBounds;
        if (bounds) {
          yMin = Math.min(yMin, bounds.min.y);
          yMax = Math.max(yMax, bounds.max.y);
        }
      }
    }

    // Fallback bounds if no coordinate info available
    if (!Number.isFinite(yMin) || !Number.isFinite(yMax)) {
      yMin = -10;
      yMax = 50;
    }

    // Convert to 0-100 percentage
    const range = yMax - yMin;
    const percentage = range > 0 ? ((cutHeight - yMin) / range) * 100 : 50;

    // 2. Set section plane: axis=down (Y), position=calculated, enabled
    setSectionPlaneAxis('down');
    setSectionPlanePosition(Math.max(0, Math.min(100, percentage)));
    setActiveTool('section');

    // 3. Switch to orthographic projection
    setProjectionMode('orthographic');

    // 4. Set camera to top-down view
    cameraCallbacks.setPresetView?.('top');
  }, [models, worldCutY, setSectionPlaneAxis, setSectionPlanePosition, setActiveTool, setProjectionMode, cameraCallbacks]);

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
      return store?.entities.getGlobalId(storey.expressId) || null;
    },
    [models, ifcDataStore],
  );

  const enterDrawingView = useCallback((storey: StoreyInfo) => {
    const state = useViewerStore.getState();
    state.setUnderlayCut(worldCutY(storey));
    state.setUnderlayViewLocked(true);
    state.setUnderlaySplitView(false);
    state.setUnderlayActiveStoreyGuid(storeyGuidFor(storey));
    setProjectionMode('orthographic');
    cameraCallbacks.setPresetView?.('top');
  }, [worldCutY, storeyGuidFor, setProjectionMode, cameraCallbacks]);

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
    state.setUnderlayActiveStoreyGuid(storeyGuidFor(storey));
    setProjectionMode('perspective');
    cameraCallbacks.home?.();
  }, [worldCutY, storeyGuidFor, setProjectionMode, cameraCallbacks]);

  /** Leave split view: close the 2D pane, remove the cut. */
  const exitSplitView = useCallback(() => {
    const state = useViewerStore.getState();
    state.setUnderlaySplitView(false);
    state.setUnderlayCut(null);
    state.setUnderlayActiveStoreyGuid(null);
  }, []);

  return {
    availableStoreys,
    activateFloorplan,
    enterDrawingView,
    exitDrawingView,
    enterSplitView,
    exitSplitView,
  };
}
