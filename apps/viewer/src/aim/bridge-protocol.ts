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

/**
 * One drawing pushed by the host (D-072): the document identity, a fetchable
 * PDF URL, and optionally the persisted `_georef` placement JSON. The georef
 * payload is treated as untrusted — the handler validates it with
 * `parsePlacement` before it reaches the store.
 */
export interface UnderlayDrawingWire {
  documentId: string;
  name: string;
  pdfUrl: string;
  georef?: unknown;
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
  | { source: typeof SOURCE; type: 'AIM_PANEL_EMPTY'; guid: string; reason: string }
  // Georeferenced PDF underlays (D-072): the host pushes its drawing list
  // (documents linked to storeys + persisted _georef) after MODELS_LOADED.
  | { source: typeof SOURCE; type: 'UNDERLAYS_LOAD'; drawings: UnderlayDrawingWire[] };

export type OutboundMessage =
  | { source: typeof SOURCE; type: 'READY' }
  | { source: typeof SOURCE; type: 'MODELS_LOADED'; count: number }
  | { source: typeof SOURCE; type: 'ENTITY_SELECTED'; guid: string }
  | { source: typeof SOURCE; type: 'ENTITY_DESELECTED' }
  // Click on a link inside the AimCard — the parent app performs the
  // navigation (href is a host-relative path, e.g. /node/{id}).
  | { source: typeof SOURCE; type: 'AIM_NAVIGATE'; href: string }
  // A drawing was (re)calibrated in the viewer — the host persists the
  // serialized _georef v1 JSON on the document (D-072).
  | { source: typeof SOURCE; type: 'UNDERLAY_SAVE'; documentId: string; georef: unknown };

/**
 * Narrow untrusted `MessageEvent.data` to a bridge message we handle.
 * Checks the envelope (source + type) AND the per-type payload: FOCUS and
 * HIGHLIGHT_FILTER must carry `guids: string[]`, otherwise the handler would
 * throw iterating `undefined` on every malformed message. Also guards against
 * the noise every window sees — React DevTools, Vite HMR, wallet extensions.
 */
function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((s) => typeof s === 'string');
}

function isOpsSelector(v: unknown): v is OpsSelector {
  if (!v || typeof v !== 'object') return false;
  const sel = v as { types?: unknown; model?: unknown };
  if (sel.types !== undefined && !isStringArray(sel.types)) return false;
  if (sel.model !== undefined && typeof sel.model !== 'string') return false;
  return true;
}

/**
 * A viewer op (COLORIZE/HIDE/SHOW/ISOLATE) targets explicit `guids` or a
 * `selector`; both are optional (refsForOp resolves the empty case to []),
 * but when present they must be well-formed.
 */
function hasValidOpTarget(msg: { guids?: unknown; selector?: unknown }): boolean {
  if (msg.guids !== undefined && !isStringArray(msg.guids)) return false;
  if (msg.selector !== undefined && !isOpsSelector(msg.selector)) return false;
  return true;
}

/**
 * One wire drawing entry must carry a non-empty documentId/name/pdfUrl;
 * `georef` stays `unknown` here — placement validation is the store
 * handler's job (parsePlacement), not the envelope check's.
 */
function isUnderlayDrawingWire(v: unknown): v is UnderlayDrawingWire {
  if (!v || typeof v !== 'object') return false;
  const d = v as { documentId?: unknown; name?: unknown; pdfUrl?: unknown };
  return (
    typeof d.documentId === 'string' && d.documentId.length > 0 &&
    typeof d.name === 'string' &&
    typeof d.pdfUrl === 'string' && d.pdfUrl.length > 0
  );
}

export function isInboundMessage(data: unknown): data is InboundMessage {
  if (!data || typeof data !== 'object') return false;
  const msg = data as {
    source?: unknown;
    type?: unknown;
    guids?: unknown;
    selector?: unknown;
    color?: unknown;
    guid?: unknown;
    data?: unknown;
    reason?: unknown;
    drawings?: unknown;
  };
  if (msg.source !== SOURCE || typeof msg.type !== 'string') return false;
  switch (msg.type) {
    case 'FOCUS':
    case 'HIGHLIGHT_FILTER':
      return isStringArray(msg.guids);
    case 'CLEAR_FILTER':
    case 'SHOW_ALL':
    case 'RESET_COLORS':
      return true;
    case 'COLORIZE':
      // COLORIZE navyše potrebuje farbu; guids/selector kontrola je spoločná.
      return typeof msg.color === 'string' && hasValidOpTarget(msg);
    case 'HIDE':
    case 'SHOW':
    case 'ISOLATE':
      return hasValidOpTarget(msg);
    case 'AIM_PANEL_DATA':
      return typeof msg.guid === 'string' && !!msg.data && typeof msg.data === 'object';
    case 'AIM_PANEL_EMPTY':
      return typeof msg.guid === 'string' && typeof msg.reason === 'string';
    case 'UNDERLAYS_LOAD':
      return Array.isArray(msg.drawings) && msg.drawings.every(isUnderlayDrawingWire);
    default:
      // Unknown type — not a message this bridge version handles.
      return false;
  }
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
