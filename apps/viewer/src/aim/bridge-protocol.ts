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

/** Orange-500 — matches the old HIGHLIGHT_COLOR (focus/pick) in the AIM viewer. */
export const FOCUS_COLOR = '#f97316';

/**
 * AIM card render schema — host-driven: the AIM app decides labels, rows,
 * sections and links; AimCard.tsx renders it generically, so new AIM fields
 * never require a viewer redeploy. All `href`s are host-relative paths
 * (e.g. /node/{id}) bounced back via AIM_NAVIGATE — never navigated here.
 */
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

/**
 * Množinový výber pre viewer ops (D-066 rozšírenie): namiesto vymenovania
 * GUIDov popíše CELÚ triedu prvkov a viewer ju rozloží sám z entity tables —
 * „celý VZT.ifc", „všetko HVAC", „steny + stropy naraz". Obrovské množiny tak
 * necestujú ako GUID zoznamy v URL/postMessage.
 */
export interface OpsSelector {
  /**
   * IFC triedy (case-insensitive, napr. "IfcDuctSegment"); StandardCase /
   * ElementedCase varianty sa priraďujú k základnej triede automaticky.
   */
  types?: string[];
  /** Model federácie — case-insensitive zhoda s názvom súboru ("VZT" ~ "VZT.ifc"). */
  model?: string;
}

export type InboundMessage =
  | { source: typeof SOURCE; type: 'FOCUS'; guids: string[] }
  | { source: typeof SOURCE; type: 'HIGHLIGHT_FILTER'; guids: string[] }
  | { source: typeof SOURCE; type: 'CLEAR_FILTER' }
  // AI dock viewer ops (D-066 in the AIM repo) — colorize/visibility over
  // explicit GUIDs, or over an OpsSelector resolved viewer-side.
  | { source: typeof SOURCE; type: 'COLORIZE'; guids?: string[]; selector?: OpsSelector; color: string }
  | { source: typeof SOURCE; type: 'HIDE'; guids?: string[]; selector?: OpsSelector }
  | { source: typeof SOURCE; type: 'SHOW'; guids?: string[]; selector?: OpsSelector }
  | { source: typeof SOURCE; type: 'ISOLATE'; guids?: string[]; selector?: OpsSelector }
  | { source: typeof SOURCE; type: 'SHOW_ALL' }
  | { source: typeof SOURCE; type: 'RESET_COLORS' }
  // AIM panel data for the selected element (host DB → AimCard in the
  // PropertiesPanel). Guid-stamped so stale answers are dropped store-side.
  | { source: typeof SOURCE; type: 'AIM_PANEL_DATA'; guid: string; data: AimPanelData }
  | { source: typeof SOURCE; type: 'AIM_PANEL_EMPTY'; guid: string; reason: string };

export type OutboundMessage =
  | { source: typeof SOURCE; type: 'READY' }
  | { source: typeof SOURCE; type: 'MODELS_LOADED'; count: number }
  | { source: typeof SOURCE; type: 'ENTITY_SELECTED'; guid: string }
  | { source: typeof SOURCE; type: 'ENTITY_DESELECTED' }
  // Click on a link inside the AimCard — the parent app performs the
  // navigation (href is a host-relative path, e.g. /node/{id}).
  | { source: typeof SOURCE; type: 'AIM_NAVIGATE'; href: string };

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

/** Minimal structural view of an entity table for selector resolution. */
export interface SelectorEntityTable {
  count: number;
  expressId: Uint32Array;
  getTypeName(expressId: number): string;
  hasGeometry(expressId: number): boolean;
}

/** Minimal structural view of a federated model — satisfied by FederatedModel. */
export interface SelectorResolvableModel {
  name?: string;
  ifcDataStore?: { entities: SelectorEntityTable } | null;
}

/** StandardCase/ElementedCase varianty patria k základnej triede (IfcWallStandardCase → IfcWall). */
const SUBTYPE_SUFFIX_RE = /(STANDARDCASE|ELEMENTEDCASE)$/;

/**
 * OpsSelector -> EntityRef[] pre viewer ops. Model sa vyberá case-insensitive
 * zhodou s názvom súboru (presná, bez prípony, alebo substring — "vzt" nájde
 * "VZT.ifc"); triedy sa porovnávajú cez getTypeName (rawTypeName fallback,
 * takže funguje aj pre triedy mimo IfcTypeEnum) so zložením StandardCase
 * variantov. Len prvky s geometriou — ops (farba/viditeľnosť) inde nemajú
 * účinok a type-objekty by len nafukovali payload. Prázdny selektor = [].
 */
export function resolveSelector(
  models: ReadonlyMap<string, SelectorResolvableModel>,
  selector: OpsSelector,
): EntityRef[] {
  const wantedModel = selector.model?.trim().toLowerCase();
  const wantedTypes = selector.types?.length
    ? new Set(selector.types.map((t) => t.trim().toUpperCase()).filter(Boolean))
    : null;
  if (!wantedModel && (!wantedTypes || wantedTypes.size === 0)) return [];

  const refs: EntityRef[] = [];
  for (const [modelId, model] of models) {
    if (wantedModel) {
      const name = (model.name ?? '').toLowerCase();
      const base = name.replace(/\.[^.]+$/, '');
      if (name !== wantedModel && base !== wantedModel && !name.includes(wantedModel)) continue;
    }
    const table = model.ifcDataStore?.entities;
    if (!table) continue;
    for (let i = 0; i < table.count; i++) {
      const expressId = table.expressId[i];
      if (!table.hasGeometry(expressId)) continue;
      if (wantedTypes) {
        const type = table.getTypeName(expressId).toUpperCase();
        if (!wantedTypes.has(type) && !wantedTypes.has(type.replace(SUBTYPE_SUFFIX_RE, ''))) {
          continue;
        }
      }
      refs.push({ modelId, expressId });
    }
  }
  return refs;
}
