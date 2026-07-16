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
  /**
   * Calibration mode. `two-point`: solve scale+rotation+translation from two
   * correspondences. `one-point`: one anchor correspondence, scale and
   * rotation entered explicitly (title-block 1:N, usually 0°) — immune to the
   * angular error a short 2-point span amplifies.
   */
  mode: 'two-point' | 'one-point';
  /** One-point mode: drawing scale denominator N as in 1:N. */
  oneScaleDen: number;
  /** One-point mode: CCW rotation of the drawing in degrees. */
  oneRotationDeg: number;
  /**
   * Target storey — carried in the draft so the live ghost preview and Save
   * use the storey the flow is bound to. Set at start; an explicit dropdown
   * change mid-flow rebinds it via `retargetUnderlayCalibrationStorey`.
   */
  storeyGuid: string;
  /** Target storey elevation in metres (IFC Z). */
  storeyZ: number;
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
   * Horizontal cut for the drawing view (world Y, metres) — applied by the
   * animation loop independently of the Section tool, so the storey cut
   * survives tool switches. Null = no cut.
   */
  underlayCut: number | null;
  /**
   * Camera lock for the calibration drawing view: orbit disabled (pan/zoom
   * stay live) so the top-down orientation can't be lost while picking.
   */
  underlayViewLocked: boolean;
  /**
   * Real 2D|3D split view (Dalux-style): the resizable 2D plan pane is shown
   * beside a FREELY navigable 3D viewport. Distinct from `underlayViewLocked`
   * (which is the top-down locked calibration view).
   */
  underlaySplitView: boolean;
  /** Enlarge the calibration PDF surface into a viewport overlay for picking. */
  underlayCalibrationExpanded: boolean;
  /** Storey GUID the drawing/split view is bound to (drives the 2D pane). */
  underlayActiveStoreyGuid: string | null;
  /**
   * Split-view location pin, PDF page points of the active drawing. Set by
   * clicking the 2D plan (outside walk mode); marks the exact clicked spot in
   * BOTH panes and stays put while the 3D camera moves — camera-independent
   * by design (the camera-coupled marker is walk-mode-only).
   */
  underlayPlanPin: Point2 | null;
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
  /**
   * Live placement update — store + GPU only, NO host save. Fine-tune nudge
   * controls call this per step and persist once via
   * `commitUnderlayPlacement` when the adjustment session ends.
   */
  updateUnderlayPlacementLive: (id: string, placement: DrawingPlacement) => void;
  /**
   * Live opacity update — store + GPU only, NO host save. Continuous inputs
   * (slider drag) call this per tick and persist once via
   * `commitUnderlayPlacement` on release, so a drag can't flood the host's
   * rate-limited write endpoint with one PATCH per change event.
   */
  setUnderlayOpacity: (id: string, opacity: number) => void;
  /** Persist the drawing's current placement via the host save handler. */
  commitUnderlayPlacement: (id: string) => void;
  setUnderlayVisible: (id: string, visible: boolean) => void;
  setUnderlayPanelVisible: (visible: boolean) => void;

  /** Set/clear the drawing-view cut (world Y). */
  setUnderlayCut: (y: number | null) => void;
  /** Move the cut by a delta (no-op when no cut is active). */
  nudgeUnderlayCut: (deltaY: number) => void;
  setUnderlayViewLocked: (locked: boolean) => void;
  setUnderlaySplitView: (on: boolean) => void;
  setUnderlayCalibrationExpanded: (on: boolean) => void;
  setUnderlayActiveStoreyGuid: (guid: string | null) => void;
  setUnderlayPlanPin: (p: Point2 | null) => void;

  startUnderlayCalibration: (
    drawingId: string,
    page: number,
    storey: { guid: string; z: number },
  ) => void;
  /**
   * Rebind an in-flight calibration to a different storey (dropdown change
   * mid-flow). Model points are cleared — they were raycast on the old
   * storey's floor; page points survive (same PDF page).
   */
  retargetUnderlayCalibrationStorey: (storey: { guid: string; z: number }) => void;
  /**
   * Switch calibration mode mid-flow. Going to `one-point` trims picks to
   * the first pair (the anchor); going back keeps whatever is picked.
   */
  setUnderlayCalibrationMode: (mode: 'two-point' | 'one-point') => void;
  /** Update the one-point mode's explicit scale (1:N) / rotation (degrees). */
  setUnderlayCalibrationOneParams: (params: {
    scaleDen?: number;
    rotationDeg?: number;
  }) => void;
  setUnderlayCalibrationPageSize: (pageSize: [number, number]) => void;
  addUnderlayCalibrationPagePoint: (p: Point2) => void;
  addUnderlayCalibrationModelPoint: (p: Point2) => void;
  /** Remove the most recently picked point (model before its page pair). */
  undoUnderlayCalibrationPoint: () => void;
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
  underlayCut: null,
  underlayViewLocked: false,
  underlaySplitView: false,
  underlayCalibrationExpanded: false,
  underlayActiveStoreyGuid: null,
  underlayPlanPin: null,
  underlaySaveHandler: null,

  setUnderlayDrawings: (drawings) => {
    set((state) => {
      const map = new Map<string, UnderlayDrawing>();
      for (const d of drawings) map.set(d.id, d);
      // A host re-send must not nuke session-local work: locally-added
      // drawings (Add PDF, `local:` ids) survive, and an in-flight
      // calibration is kept as long as its drawing still exists.
      for (const [id, d] of state.underlayDrawings) {
        if (id.startsWith('local:') && !map.has(id)) map.set(id, d);
      }
      const calibration =
        state.underlayCalibration && map.has(state.underlayCalibration.drawingId)
          ? state.underlayCalibration
          : null;
      return { underlayDrawings: map, underlayCalibration: calibration };
    });
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

  updateUnderlayPlacementLive: (id, placement) => {
    set((state) => ({
      underlayDrawings: withDrawing(state.underlayDrawings, id, (d) => ({ ...d, placement })),
    }));
  },

  setUnderlayOpacity: (id, opacity) => {
    const clamped = Math.min(1, Math.max(0, opacity));
    set((state) => ({
      underlayDrawings: withDrawing(state.underlayDrawings, id, (d) =>
        d.placement ? { ...d, placement: { ...d.placement, opacity: clamped } } : d,
      ),
    }));
  },

  commitUnderlayPlacement: (id) => {
    const placement = get().underlayDrawings.get(id)?.placement;
    if (placement) get().underlaySaveHandler?.(id, placement);
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

  setUnderlayCut: (y) => set({ underlayCut: y }),

  nudgeUnderlayCut: (deltaY) =>
    set((state) =>
      state.underlayCut === null ? state : { underlayCut: state.underlayCut + deltaY },
    ),

  setUnderlayViewLocked: (locked) => set({ underlayViewLocked: locked }),

  setUnderlaySplitView: (on) => set({ underlaySplitView: on }),

  setUnderlayCalibrationExpanded: (on) => set({ underlayCalibrationExpanded: on }),

  setUnderlayActiveStoreyGuid: (guid) => set({ underlayActiveStoreyGuid: guid }),

  setUnderlayPlanPin: (p) => set({ underlayPlanPin: p }),

  startUnderlayCalibration: (drawingId, page, storey) =>
    set({
      underlayCalibration: {
        drawingId,
        page,
        mode: 'two-point',
        oneScaleDen: 50,
        oneRotationDeg: 0,
        storeyGuid: storey.guid,
        storeyZ: storey.z,
        pageSize: null,
        pagePoints: [],
        modelPoints: [],
      },
      // Start inline; the user opts into the big overlay per calibration.
      underlayCalibrationExpanded: false,
    }),

  setUnderlayCalibrationMode: (mode) =>
    set((state) => {
      const c = state.underlayCalibration;
      if (!c || c.mode === mode) return state;
      return {
        underlayCalibration: {
          ...c,
          mode,
          pagePoints: mode === 'one-point' ? c.pagePoints.slice(0, 1) : c.pagePoints,
          modelPoints: mode === 'one-point' ? c.modelPoints.slice(0, 1) : c.modelPoints,
        },
      };
    }),

  setUnderlayCalibrationOneParams: (params) =>
    set((state) => {
      const c = state.underlayCalibration;
      if (!c) return state;
      return {
        underlayCalibration: {
          ...c,
          oneScaleDen: params.scaleDen ?? c.oneScaleDen,
          oneRotationDeg: params.rotationDeg ?? c.oneRotationDeg,
        },
      };
    }),

  retargetUnderlayCalibrationStorey: (storey) =>
    set((state) => {
      const c = state.underlayCalibration;
      if (!c || (c.storeyGuid === storey.guid && c.storeyZ === storey.z)) return state;
      return {
        underlayCalibration: {
          ...c,
          storeyGuid: storey.guid,
          storeyZ: storey.z,
          modelPoints: [],
        },
      };
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
      const cap = c?.mode === 'one-point' ? 1 : 2;
      if (!c || c.pagePoints.length >= cap) return state;
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

  undoUnderlayCalibrationPoint: () =>
    set((state) => {
      const c = state.underlayCalibration;
      if (!c) return state;
      // Picks alternate page → model, so the last one is a model point
      // whenever the counts are equal (and non-zero).
      if (c.modelPoints.length > 0 && c.modelPoints.length === c.pagePoints.length) {
        return { underlayCalibration: { ...c, modelPoints: c.modelPoints.slice(0, -1) } };
      }
      if (c.pagePoints.length > 0) {
        return { underlayCalibration: { ...c, pagePoints: c.pagePoints.slice(0, -1) } };
      }
      return state;
    }),

  cancelUnderlayCalibration: () =>
    set({ underlayCalibration: null, underlayCalibrationExpanded: false }),

  setUnderlaySaveHandler: (handler) => set({ underlaySaveHandler: handler }),
});
