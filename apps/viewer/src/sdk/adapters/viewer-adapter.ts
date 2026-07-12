/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { EntityRef, SectionPlane, CameraState, ViewerBackendMethods } from '@ifc-lite/sdk';
import type { StoreApi } from './types.js';
import { getModelForRef } from './model-compat.js';
import { toGlobalIdForRef } from '../../store/globalId.js';

const AXIS_TO_STORE: Record<string, 'down' | 'front' | 'side'> = {
  x: 'side',
  y: 'down',
  z: 'front',
};
const STORE_TO_AXIS: Record<string, 'x' | 'y' | 'z'> = {
  side: 'x',
  down: 'y',
  front: 'z',
};

export function createViewerAdapter(store: StoreApi): ViewerBackendMethods {
  // Authoritative view of the colour overrides applied through this adapter.
  // `pendingColorUpdates` is a one-shot channel (consumed then nulled by
  // useGeometryStreaming) and `scene.setColorOverrides` replaces the whole
  // override set on every call, so partial resets and cross-tick colorize
  // accumulation can't be derived from the store — they're tracked here.
  const applied = new Map<number, [number, number, number, number]>();
  return {
    colorize(refs: EntityRef[], color: [number, number, number, number]) {
      const state = store.getState();
      for (const ref of refs) {
        if (!getModelForRef(state, ref.modelId)) continue;
        applied.set(toGlobalIdForRef(state.models, ref), color);
      }
      state.setPendingColorUpdates(new Map(applied));
      return undefined;
    },
    colorizeAll(batches: Array<{ refs: EntityRef[]; color: [number, number, number, number] }>) {
      const state = store.getState();
      // Batch colorize: build the complete color map in a single call.
      // Avoids accumulation issues when React effects fire between calls.
      applied.clear();
      for (const batch of batches) {
        for (const ref of batch.refs) {
          if (!getModelForRef(state, ref.modelId)) continue;
          applied.set(toGlobalIdForRef(state.models, ref), batch.color);
        }
      }
      state.setPendingColorUpdates(new Map(applied));
      return undefined;
    },
    resetColors(refs?: EntityRef[]) {
      const state = store.getState();
      if (refs && refs.length > 0) {
        // Partial reset per the SDK contract (resetColors(refs?)): only the
        // given refs lose their override. Ignoring `refs` cleared the whole
        // scene — e.g. an active HIGHLIGHT_FILTER — whenever the AIM bridge
        // restored the previous FOCUS set.
        for (const ref of refs) {
          applied.delete(toGlobalIdForRef(state.models, ref));
        }
      } else {
        applied.clear();
      }
      // An empty map triggers scene.clearColorOverrides() (null skips the effect).
      state.setPendingColorUpdates(new Map(applied));
      return undefined;
    },
    flyTo(refs: EntityRef[]) {
      // Frame the camera to the refs via the renderer's frameEntities callback
      // (registered by Viewport). Pure camera op — does NOT mutate selection,
      // so it can't race the selection-ref sync or echo an ENTITY_SELECTED back
      // to an embedding host. No-op until the viewport has registered callbacks.
      const state = store.getState();
      const globalIds: number[] = [];
      for (const ref of refs) {
        if (!getModelForRef(state, ref.modelId)) continue;
        globalIds.push(toGlobalIdForRef(state.models, ref));
      }
      if (globalIds.length > 0) {
        state.cameraCallbacks?.frameEntities?.(globalIds);
      }
      return undefined;
    },
    setSection(section: SectionPlane | null) {
      const state = store.getState();
      if (section) {
        state.setSectionPlaneAxis?.(AXIS_TO_STORE[section.axis] ?? 'down');
        state.setSectionPlanePosition?.(section.position);
        if (section.flipped !== undefined && state.sectionPlane?.flipped !== section.flipped) {
          state.flipSectionPlane?.();
        }
        if (state.sectionPlane?.enabled !== section.enabled) {
          state.toggleSectionPlane?.();
        }
      } else {
        if (state.sectionPlane?.enabled) {
          state.toggleSectionPlane?.();
        }
      }
      return undefined;
    },
    getSection() {
      const state = store.getState();
      if (!state.sectionPlane?.enabled) return null;
      return {
        axis: STORE_TO_AXIS[state.sectionPlane.axis] ?? 'y',
        position: state.sectionPlane.position,
        enabled: state.sectionPlane.enabled,
        flipped: state.sectionPlane.flipped,
      };
    },
    setCamera(cameraState: Partial<CameraState>) {
      const state = store.getState();
      if (cameraState.mode) {
        state.setProjectionMode?.(cameraState.mode);
      }
      return undefined;
    },
    getCamera() {
      const state = store.getState();
      return { mode: state.projectionMode ?? 'perspective' };
    },
  };
}
