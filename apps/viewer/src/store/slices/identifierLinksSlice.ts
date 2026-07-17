/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Identifier-link state — configuration (per project, persisted via
 * `lib/identifier-links/config`) plus the built code → element index.
 *
 * The index is built ONCE per (models, config) combination by
 * `useIdentifierLinks` and cached here with its build signature; renders only
 * read it. Persistence of the config itself happens in the settings UI /
 * hook (the slice stays storage-agnostic, mirroring drawingUnderlaySlice).
 */

import type { StateCreator } from 'zustand';
import {
  DEFAULT_IDENTIFIER_LINK_CONFIG,
  type IdentifierLinkConfig,
} from '@/lib/identifier-links/config';
import type { IdentifierIndex } from '@/lib/identifier-links/identifier-index';

export type IdentifierIndexStatus = 'idle' | 'building' | 'ready' | 'error';

/** Result of the most recent page-text scan — settings diagnostics. */
export interface IdentifierScanStats {
  /** Where the scan ran (drawing/document name or id). */
  source: string;
  page: number;
  /** pdf.js text items on the page (0 = the PDF has no text layer). */
  textItems: number;
  /** Identifier-shaped codes recognized on the page. */
  codes: number;
  /** Codes that resolved to at least one model element. */
  matched: number;
}

export interface IdentifierLinksSlice {
  identifierLinkConfig: IdentifierLinkConfig;
  /**
   * Which project (model key) the current config was loaded for — guards the
   * one-time per-model localStorage load in `useIdentifierLinks`.
   */
  identifierConfigModelKey: string | null;
  identifierIndex: IdentifierIndex | null;
  identifierIndexStatus: IdentifierIndexStatus;
  /** Build signature (models + config) of the cached index. */
  identifierIndexSignature: string | null;
  /** Most recent page-scan diagnostics (null until a page is scanned). */
  identifierScanStats: IdentifierScanStats | null;

  setIdentifierLinkConfig: (config: IdentifierLinkConfig) => void;
  setIdentifierScanStats: (stats: IdentifierScanStats | null) => void;
  setIdentifierConfigModelKey: (key: string | null) => void;
  setIdentifierIndexBuilding: (signature: string) => void;
  setIdentifierIndexReady: (index: IdentifierIndex, signature: string) => void;
  setIdentifierIndexError: () => void;
  clearIdentifierIndex: () => void;
}

export const createIdentifierLinksSlice: StateCreator<
  IdentifierLinksSlice,
  [],
  [],
  IdentifierLinksSlice
> = (set) => ({
  identifierLinkConfig: { ...DEFAULT_IDENTIFIER_LINK_CONFIG },
  identifierConfigModelKey: null,
  identifierIndex: null,
  identifierIndexStatus: 'idle',
  identifierIndexSignature: null,
  identifierScanStats: null,

  setIdentifierScanStats: (stats) => set({ identifierScanStats: stats }),

  setIdentifierLinkConfig: (config) =>
    set({
      identifierLinkConfig: config,
      // Any config change invalidates the cached index (signature mismatch
      // triggers a rebuild in useIdentifierLinks).
    }),

  setIdentifierConfigModelKey: (key) => set({ identifierConfigModelKey: key }),

  setIdentifierIndexBuilding: (signature) =>
    set({ identifierIndexStatus: 'building', identifierIndexSignature: signature }),

  setIdentifierIndexReady: (index, signature) =>
    set((state) =>
      // A stale async build (config changed mid-build) must not clobber the
      // newer build's state — only the signature owner lands its result.
      state.identifierIndexSignature === signature
        ? { identifierIndex: index, identifierIndexStatus: 'ready' }
        : state,
    ),

  setIdentifierIndexError: () => set({ identifierIndexStatus: 'error' }),

  clearIdentifierIndex: () =>
    set({ identifierIndex: null, identifierIndexStatus: 'idle', identifierIndexSignature: null }),
});
