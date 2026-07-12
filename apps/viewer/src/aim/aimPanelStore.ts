/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * AIM panel state — DB-side data for the selected entity, pushed by the AIM
 * host over the aim-bridge (AIM_PANEL_DATA / AIM_PANEL_EMPTY). A standalone
 * zustand store, deliberately NOT a slice in src/store: everything AIM lives
 * under src/aim so upstream rebases touch zero shared files.
 *
 * The payload is a host-driven render schema: the host decides labels, rows,
 * sections and links; this side renders it generically (see AimCard.tsx).
 * New AIM fields therefore never require a viewer redeploy.
 */

import { create } from 'zustand';

export interface AimPanelData {
  version: 1;
  /** Echo of the requested element's GlobalId — used to drop stale responses. */
  guid: string;
  title: string;
  subtitle?: string;
  badges?: { label: string; tone?: 'default' | 'accent' }[];
  sections?: {
    label: string;
    rows: { label: string; value: string; href?: string; mono?: boolean }[];
  }[];
  documents?: { name: string; href: string; badge?: string }[];
  actions?: { label: string; href: string; primary?: boolean }[];
}

export type AimPanelState =
  | { status: 'idle' }
  | { status: 'loading'; guid: string }
  | { status: 'ready'; guid: string; data: AimPanelData }
  | { status: 'empty'; guid: string; reason: string };

interface AimPanelStore {
  /** True when running inside the AIM host iframe (set once by AimBridge). */
  embedded: boolean;
  /** Trusted parent origin for AIM_NAVIGATE posts (set once by AimBridge). */
  parentOrigin: string | null;
  panel: AimPanelState;
  setEmbedded: (embedded: boolean, parentOrigin: string | null) => void;
  /** New selection — enter loading and arm the no-answer timeout. */
  beginLoading: (guid: string) => void;
  /** Host answered. Ignored unless `guid` matches the current selection. */
  resolve: (guid: string, next: { data: AimPanelData } | { reason: string }) => void;
  clear: () => void;
}

/** Old host / dead network never answers — degrade loading → quiet empty. */
const LOADING_TIMEOUT_MS = 10_000;
let loadingTimer: ReturnType<typeof setTimeout> | undefined;

export const useAimPanelStore = create<AimPanelStore>((set, get) => ({
  embedded: false,
  parentOrigin: null,
  panel: { status: 'idle' },

  setEmbedded: (embedded, parentOrigin) => set({ embedded, parentOrigin }),

  beginLoading: (guid) => {
    clearTimeout(loadingTimer);
    loadingTimer = setTimeout(() => {
      const { panel } = get();
      if (panel.status === 'loading' && panel.guid === guid) {
        set({ panel: { status: 'empty', guid, reason: 'timeout' } });
      }
    }, LOADING_TIMEOUT_MS);
    set({ panel: { status: 'loading', guid } });
  },

  resolve: (guid, next) => {
    const { panel } = get();
    if (panel.status === 'idle' || panel.guid !== guid) return; // stale response
    clearTimeout(loadingTimer);
    set({
      panel:
        'data' in next
          ? { status: 'ready', guid, data: next.data }
          : { status: 'empty', guid, reason: next.reason },
    });
  },

  clear: () => {
    clearTimeout(loadingTimer);
    set({ panel: { status: 'idle' } });
  },
}));

/** Click on any AIM link — the parent app navigates; the iframe never does. */
export function postAimNavigate(href: string) {
  const { parentOrigin } = useAimPanelStore.getState();
  window.parent.postMessage(
    { source: 'aim-bridge', type: 'AIM_NAVIGATE', href },
    parentOrigin ?? '*',
  );
}
