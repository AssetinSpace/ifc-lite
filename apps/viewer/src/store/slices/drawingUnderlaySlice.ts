/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Drawing underlay state (georeferenced PDF floor plans, D-072 in the AIM
 * repo). The slice holds metadata only — source URL, parsed placement,
 * calibration draft; the GPU side (textures, plane pipeline) lives in the
 * renderer via `useDrawingUnderlay`, mirroring the pointCloudSlice /
 * usePointCloudSync split.
 *
 * Persistence is host-agnostic: a save handler is registered by whichever
 * host embeds the viewer (the AIM bridge in the AIM deployment). Without a
 * handler, calibrations still work — they just live for the session.
 */

import type { StateCreator } from 'zustand';
import type { DrawingPlacement, Point2 } from '@ifc-lite/drawing-underlay';

/** One underlay drawing known to the viewer (calibrated or not). */
export interface UnderlayDrawing {
  /** Stable id — the host's document id, or a generated one for local files. */
  id: string;
  name: string;
  /** Source PDF URL (rasterized app-side via pdf.js). */
  pdfUrl: string;
  /** Georeferenced placement; null until the drawing is calibrated. */
  placement: DrawingPlacement | null;
}

/**
 * In-progress 2-point calibration. Points arrive alternately from the 2D
 * pane (PDF page points) and the 3D viewport (IFC plan metres via raycast);
 * the flow completes when both arrays hold 2 entries.
 */
export interface UnderlayCalibrationDraft {
  drawingId: string;
  /** 1-based page being calibrated. */
  page: number;
  /** Page size [w, h] in PDF points — known once the page is rendered. */
  pageSize: [number, number] | null;
  /** Picked drawing points, PDF page points (bottom-left, y up). Max 2. */
  pagePoints: Point2[];
  /** Picked model points, IFC plan metres (y up). Max 2. */
  modelPoints: Point2[];
}

export interface DrawingUnderlaySlice {
  /** Keyed by drawing id. Replaced immutably on every mutation. */
  underlayDrawings: Map<string, UnderlayDrawing>;
  underlayPanelVisible: boolean;
  /** Calibration in progress, or null. */
  underlayCalibration: UnderlayCalibrationDraft | null;
  /**
   * Host persistence hook (e.g. the AIM bridge). Called after a placement
   * is created or its presentation fields change. Null = session-only.
   */
  underlaySaveHandler: ((drawingId: string, placement: DrawingPlacement) => void) | null;

  /** Bulk-replace the drawing list (host load path). */
  setUnderlayDrawings: (drawings: readonly UnderlayDrawing[]) => void;
  /** Add or replace one drawing (local file open, host push). */
  upsertUnderlayDrawing: (drawing: UnderlayDrawing) => void;
  removeUnderlayDrawing: (id: string) => void;
  /** Commit a placement (calibration save / host update) and notify the host. */
  setUnderlayPlacement: (id: string, placement: DrawingPlacement) => void;
  setUnderlayOpacity: (id: string, opacity: number) => void;
  setUnderlayVisible: (id: string, visible: boolean) => void;
  setUnderlayPanelVisible: (visible: boolean) => void;

  startUnderlayCalibration: (drawingId: string, page: number) => void;
  setUnderlayCalibrationPageSize: (pageSize: [number, number]) => void;
  addUnderlayCalibrationPagePoint: (p: Point2) => void;
  addUnderlayCalibrationModelPoint: (p: Point2) => void;
  cancelUnderlayCalibration: () => void;

  setUnderlaySaveHandler: (
    handler: ((drawingId: string, placement: DrawingPlacement) => void) | null,
  ) => void;
}

/** Immutable Map update helper — zustand needs a fresh identity to notify. */
function withDrawing(
  map: Map<string, UnderlayDrawing>,
  id: string,
  update: (d: UnderlayDrawing) => UnderlayDrawing,
): Map<string, UnderlayDrawing> {
  const existing = map.get(id);
  if (!existing) return map;
  const next = new Map(map);
  next.set(id, update(existing));
  return next;
}

export const createDrawingUnderlaySlice: StateCreator<
  DrawingUnderlaySlice,
  [],
  [],
  DrawingUnderlaySlice
> = (set, get) => ({
  underlayDrawings: new Map(),
  underlayPanelVisible: false,
  underlayCalibration: null,
  underlaySaveHandler: null,

  setUnderlayDrawings: (drawings) => {
    const map = new Map<string, UnderlayDrawing>();
    for (const d of drawings) map.set(d.id, d);
    set({ underlayDrawings: map, underlayCalibration: null });
  },

  upsertUnderlayDrawing: (drawing) => {
    set((state) => {
      const next = new Map(state.underlayDrawings);
      next.set(drawing.id, drawing);
      return { underlayDrawings: next };
    });
  },

  removeUnderlayDrawing: (id) => {
    set((state) => {
      if (!state.underlayDrawings.has(id)) return state;
      const next = new Map(state.underlayDrawings);
      next.delete(id);
      const calibration =
        state.underlayCalibration?.drawingId === id ? null : state.underlayCalibration;
      return { underlayDrawings: next, underlayCalibration: calibration };
    });
  },

  setUnderlayPlacement: (id, placement) => {
    set((state) => ({
      underlayDrawings: withDrawing(state.underlayDrawings, id, (d) => ({ ...d, placement })),
      // A committed placement ends any calibration on the same drawing.
      underlayCalibration:
        state.underlayCalibration?.drawingId === id ? null : state.underlayCalibration,
    }));
    get().underlaySaveHandler?.(id, placement);
  },

  setUnderlayOpacity: (id, opacity) => {
    const clamped = Math.min(1, Math.max(0, opacity));
    let saved: DrawingPlacement | null = null;
    set((state) => ({
      underlayDrawings: withDrawing(state.underlayDrawings, id, (d) => {
        if (!d.placement) return d;
        saved = { ...d.placement, opacity: clamped };
        return { ...d, placement: saved };
      }),
    }));
    if (saved) get().underlaySaveHandler?.(id, saved);
  },

  setUnderlayVisible: (id, visible) => {
    let saved: DrawingPlacement | null = null;
    set((state) => ({
      underlayDrawings: withDrawing(state.underlayDrawings, id, (d) => {
        if (!d.placement) return d;
        saved = { ...d.placement, visible };
        return { ...d, placement: saved };
      }),
    }));
    if (saved) get().underlaySaveHandler?.(id, saved);
  },

  setUnderlayPanelVisible: (visible) => set({ underlayPanelVisible: visible }),

  startUnderlayCalibration: (drawingId, page) =>
    set({
      underlayCalibration: {
        drawingId,
        page,
        pageSize: null,
        pagePoints: [],
        modelPoints: [],
      },
    }),

  setUnderlayCalibrationPageSize: (pageSize) =>
    set((state) =>
      state.underlayCalibration
        ? { underlayCalibration: { ...state.underlayCalibration, pageSize } }
        : state,
    ),

  addUnderlayCalibrationPagePoint: (p) =>
    set((state) => {
      const c = state.underlayCalibration;
      if (!c || c.pagePoints.length >= 2) return state;
      return { underlayCalibration: { ...c, pagePoints: [...c.pagePoints, p] } };
    }),

  addUnderlayCalibrationModelPoint: (p) =>
    set((state) => {
      const c = state.underlayCalibration;
      // A model point is only picked after its matching page point.
      if (!c || c.modelPoints.length >= 2 || c.modelPoints.length >= c.pagePoints.length) {
        return state;
      }
      return { underlayCalibration: { ...c, modelPoints: [...c.modelPoints, p] } };
    }),

  cancelUnderlayCalibration: () => set({ underlayCalibration: null }),

  setUnderlaySaveHandler: (handler) => set({ underlaySaveHandler: handler }),
});
