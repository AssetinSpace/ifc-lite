/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * AIM tree decorations state (D-077) — per-GUID badge counts pushed by the AIM
 * host over the aim-bridge (AIM_TREE_DECORATIONS) and rendered as pills on
 * HierarchyPanel rows. A standalone zustand store (like capturePinsStore):
 * everything AIM lives under src/aim so upstream rebases touch zero shared
 * files (D-071).
 *
 * Rows resolve their IFC GlobalId via `guidForEntity` and look the value up in
 * `decorations`; an empty record means "nothing to render" (standalone mode or
 * host without decoration data).
 */

import { create } from 'zustand';

import type { AimTreeDecoration } from './bridge-protocol.js';

interface AimDecorationsState {
  /** Badge counts keyed by IFC GlobalId; empty = feature inactive. */
  decorations: Record<string, AimTreeDecoration>;
  /** True once any decorations arrived — lets the tree skip lookups entirely. */
  hasDecorations: boolean;
  setDecorations: (decorations: Record<string, AimTreeDecoration>) => void;
  clear: () => void;
}

export const useAimDecorationsStore = create<AimDecorationsState>((set) => ({
  decorations: {},
  hasDecorations: false,
  setDecorations: (decorations) =>
    set({ decorations, hasDecorations: Object.keys(decorations).length > 0 }),
  clear: () => set({ decorations: {}, hasDecorations: false }),
}));
