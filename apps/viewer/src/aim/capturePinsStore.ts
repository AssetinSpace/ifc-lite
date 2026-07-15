/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Reality Capture pins state (D-073) — capture points pushed by the AIM host
 * over the aim-bridge (CAPTURES_LOAD) and billboarded over the WebGPU canvas by
 * CapturePinLayer. A standalone zustand store (like aimPanelStore): everything
 * AIM lives under src/aim so upstream rebases touch zero shared files (D-071).
 *
 * The layer reads `pins` + the (big store's) camera projection to place DOM
 * markers; a click bounces `CAPTURE_PIN_CLICK` back to the host via `emitClick`,
 * which AimBridge wires to the postMessage channel.
 */

import { create } from 'zustand';

import type { CapturePinWire } from './bridge-protocol.js';

interface CapturePinsState {
  /** Capture points to billboard (world coords in the viewer Y-up frame). */
  pins: CapturePinWire[];
  /** Currently highlighted pin id (hover/selection), or null. */
  selectedId: string | null;
  /** Emitter installed by AimBridge — posts CAPTURE_PIN_CLICK to the host. */
  emitClick: ((captureId: string) => void) | null;
  setPins: (pins: CapturePinWire[]) => void;
  selectPin: (id: string | null) => void;
  setEmitClick: (fn: ((captureId: string) => void) | null) => void;
  /** User clicked a pin in 3D: select it and notify the host. */
  clickPin: (id: string) => void;
}

export const useCapturePinsStore = create<CapturePinsState>((set, get) => ({
  pins: [],
  selectedId: null,
  emitClick: null,
  setPins: (pins) => set({ pins }),
  selectPin: (selectedId) => set({ selectedId }),
  setEmitClick: (emitClick) => set({ emitClick }),
  clickPin: (id) => {
    set({ selectedId: id });
    get().emitClick?.(id);
  },
}));
