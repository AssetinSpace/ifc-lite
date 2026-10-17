/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Vykonanie bridge správ pohľadu (AIM D-083 fáza 1) cez existujúce cesty
 * viewera: rez cez `showSectionCut`/`clearSectionCut` (tá istá cesta ako SDK
 * `setSection` a BCF viewpoint, Section tool ho ukáže a dá sa posúvať),
 * kamera cez `cameraCallbacks` + `bim.viewer.flyTo`, režim cez `useViewMode`
 * (prepínač 3D|2D|Split, D-075). Vracia ref, aby ho listener v AimBridge
 * mohol volať bez re-registrácie.
 */

import { useEffect, useRef } from 'react';
import { useViewerStore } from '@/store';
import { clearSectionCut, showSectionCut } from '@/store/section-active';
import { mergedSectionBounds, sectionAxisRange } from '@/lib/section/section-distance';
import { totalYupOffset } from '@/lib/geo/coordinate-frame';
import { useViewMode } from '@/hooks/useViewMode';
import type { BimContext } from '@ifc-lite/sdk';
import { resolveGuids } from './bridge-protocol.js';
import type { ViewInboundMessage } from './view-protocol.js';
import { VIEWER_AXIS, cameraStep, storeyCutPercent } from './viewCommands.js';

export function useAimViewCommands(bim: BimContext) {
  const { setMode, storeys } = useViewMode();
  const run = (msg: ViewInboundMessage) => {
    const state = useViewerStore.getState();
    switch (msg.type) {
      case 'SET_SECTION': {
        if (msg.action === 'clear') {
          clearSectionCut(useViewerStore.getState);
          return;
        }
        if (msg.storeyGuid) {
          const storey = storeys.find((s) => s.guid === msg.storeyGuid);
          if (!storey) {
            console.warn('[aim-bridge] SET_SECTION: neznáme podlažie', msg.storeyGuid);
            return;
          }
          const range = sectionAxisRange(mergedSectionBounds(state.models, state.geometryResult), 'down');
          const first = [...state.models.values()].find((m) => m.geometryResult?.coordinateInfo);
          const offY = totalYupOffset(first?.geometryResult?.coordinateInfo).y;
          const position = storeyCutPercent(storey.elevation, msg.offsetM ?? 1.2, offY, range);
          if (position === null) return;
          showSectionCut(useViewerStore.getState, { axis: 'down', position, flipped: msg.flipped === true });
          return;
        }
        if (msg.axis && msg.position !== undefined) {
          showSectionCut(useViewerStore.getState, {
            axis: VIEWER_AXIS[msg.axis],
            position: msg.position,
            flipped: msg.flipped === true,
          });
        }
        return;
      }
      case 'SET_CAMERA': {
        if (msg.projection) state.setProjectionMode(msg.projection);
        const step = cameraStep(msg.preset);
        const cam = state.cameraCallbacks;
        if (step.kind === 'home') cam.home?.();
        else if (step.kind === 'fit') cam.fitAll?.();
        else cam.setPresetView?.(step.view);
        if (msg.guids?.length) {
          const refs = resolveGuids(state.models, msg.guids);
          if (refs.length > 0) bim.viewer.flyTo(refs);
        }
        return;
      }
      case 'SET_VIEW_MODE': {
        const storey = msg.storeyGuid ? storeys.find((s) => s.guid === msg.storeyGuid) : undefined;
        if (msg.storeyGuid && !storey) console.warn('[aim-bridge] SET_VIEW_MODE: neznáme podlažie', msg.storeyGuid);
        setMode(msg.mode, storey);
        return;
      }
    }
  };
  const ref = useRef(run);
  // Najnovšie podlažia a setMode bez re-registrácie listenera v AimBridge.
  useEffect(() => {
    ref.current = run;
  });
  return ref;
}
