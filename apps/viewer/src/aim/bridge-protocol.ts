/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Pure, framework-free core of the AIM postMessage bridge — the wire
 * contract plus the GUID <-> EntityRef resolution logic. Split out of
 * AimBridge.tsx so it can be unit-tested without React or a live viewer
 * store: every function here takes its inputs explicitly instead of
 * reaching into useViewerStore. The component (AimBridge.tsx) is the thin
 * shell that wires these to the store, the window, and the viewer API.
 */

import type { EntityRef } from '../store/index.js';

export const SOURCE = 'aim-bridge' as const;

/** Blue-400 — matches the old FILTER_COLOR in the AIM three.js viewer. */
export const FILTER_COLOR = '#60a5fa';

export type InboundMessage =
  | { source: typeof SOURCE; type: 'FOCUS'; guids: string[] }
  | { source: typeof SOURCE; type: 'HIGHLIGHT_FILTER'; guids: string[] }
  | { source: typeof SOURCE; type: 'CLEAR_FILTER' };

export type OutboundMessage =
  | { source: typeof SOURCE; type: 'READY' }
  | { source: typeof SOURCE; type: 'MODELS_LOADED'; count: number }
  | { source: typeof SOURCE; type: 'ENTITY_SELECTED'; guid: string }
  | { source: typeof SOURCE; type: 'ENTITY_DESELECTED' };

/**
 * Narrow untrusted `MessageEvent.data` to a bridge message we handle.
 * Only checks the envelope (source + a string type); the per-type payload
 * (e.g. `guids`) is validated where it's consumed. Guards against the noise
 * every window sees — React DevTools, Vite HMR, wallet extensions, etc.
 */
export function isInboundMessage(data: unknown): data is InboundMessage {
  return (
    !!data &&
    typeof data === 'object' &&
    (data as { source?: unknown }).source === SOURCE &&
    typeof (data as { type?: unknown }).type === 'string'
  );
}

/** Minimal structural view of a model's GlobalId index. */
export interface GuidIndex {
  getExpressIdByGlobalId(globalId: string): number;
  getGlobalId(expressId: number): string;
}

/** Minimal structural view of a federated model — satisfied by FederatedModel. */
export interface GuidResolvableModel {
  ifcDataStore?: { entities: GuidIndex } | null;
}

/**
 * GUID -> EntityRef across every federated model. Uses the pre-built
 * GlobalId index on each model's entity table (O(1) per model, no scan) —
 * see `getExpressIdByGlobalId` in packages/data/src/entity-table.ts. A GUID
 * resolves to at most one ref (first model that owns it wins); unknown GUIDs
 * are silently dropped, so the result can be shorter than `guids`.
 */
export function resolveGuids(
  models: ReadonlyMap<string, GuidResolvableModel>,
  guids: readonly string[],
): EntityRef[] {
  const refs: EntityRef[] = [];
  for (const guid of guids) {
    for (const [modelId, model] of models) {
      const expressId = model.ifcDataStore?.entities.getExpressIdByGlobalId(guid) ?? -1;
      if (expressId !== -1) {
        refs.push({ modelId, expressId });
        break;
      }
    }
  }
  return refs;
}

/** GlobalId for a given EntityRef, or undefined if the model/entity is gone. */
export function guidForEntity(
  models: ReadonlyMap<string, GuidResolvableModel>,
  ref: EntityRef,
): string | undefined {
  const model = models.get(ref.modelId);
  return model?.ifcDataStore?.entities.getGlobalId(ref.expressId) || undefined;
}
