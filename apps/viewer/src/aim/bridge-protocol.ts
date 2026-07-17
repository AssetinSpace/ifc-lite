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

/**
 * One project document pushed by the host (D-075): identity, a fetchable URL
 * and library metadata for the in-viewer Documents panel. A sibling of
 * `UnderlayDrawingWire`, NOT a replacement — calibrated drawings arrive in
 * both messages (same documentId) and cross-link via `storeyGuid`.
 */
export interface DocumentDescriptorWire {
  documentId: string;
  name: string;
  /** 'drawing' = calibratable plan; 'document' = paged PDF; 'image' = bitmap. */
  kind: 'drawing' | 'document' | 'image';
  url: string;
  mime?: string;
  /** Storey GlobalId a `drawing` belongs to (D-072 binding), if known. */
  storeyGuid?: string;
  /** Host-defined tree path for the panel's grouping, e.g. ['Building A', '2.NP']. */
  folder?: string[];
  /** Free-form metadata shown in the list (revision, status, discipline…). */
  meta?: Record<string, string>;
}

/**
 * One reality-capture pin pushed by the host (D-073): a capture point with its
 * world-space position (viewer Y-up frame), kind (photo vs 360° panorama) and an
 * optional thumbnail. Clicking it in 3D bounces `CAPTURE_PIN_CLICK` back so the
 * host opens the gallery / panorama.
 */
export interface CapturePinWire {
  id: string;
  kind: 'photo' | 'pano360';
  world: { x: number; y: number; z: number };
  name?: string;
  thumbUrl?: string;
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
  | { source: typeof SOURCE; type: 'UNDERLAYS_LOAD'; drawings: UnderlayDrawingWire[] }
  // Project documents (D-075): the host pushes the document library after
  // MODELS_LOADED (same timing slot as UNDERLAYS_LOAD).
  | { source: typeof SOURCE; type: 'DOCUMENTS_LOAD'; documents: DocumentDescriptorWire[] }
  // Deep link (D-075): open one document as a tab (postMessage-only — the
  // host owns the iframe src, and changing it reloads the whole viewer).
  | { source: typeof SOURCE; type: 'DOCUMENT_OPEN'; documentId: string; page?: number }
  // Reality Capture pins (D-073): the host pushes capture points with world
  // coords after MODELS_LOADED; the viewer billboards them over the canvas.
  | { source: typeof SOURCE; type: 'CAPTURES_LOAD'; captures: CapturePinWire[] };

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
  | { source: typeof SOURCE; type: 'UNDERLAY_SAVE'; documentId: string; georef: unknown }
  // A reality-capture pin was clicked in 3D (D-073) — the host opens the
  // capture's gallery / 360° panorama for the given capture point id.
  | { source: typeof SOURCE; type: 'CAPTURE_PIN_CLICK'; captureId: string }
  // A document tab was opened/closed in the viewer (D-075) — host-side
  // recents / analytics; the viewer expects no reply.
  | { source: typeof SOURCE; type: 'DOCUMENT_EVENT'; documentId: string; event: 'opened' | 'closed' };

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

/**
 * One wire document must carry a non-empty documentId/name/url and a known
 * kind; the optional fields are shape-checked so a malformed host payload
 * can't leak junk into the documents store.
 */
function isDocumentDescriptorWire(v: unknown): v is DocumentDescriptorWire {
  if (!v || typeof v !== 'object') return false;
  const d = v as {
    documentId?: unknown;
    name?: unknown;
    kind?: unknown;
    url?: unknown;
    mime?: unknown;
    storeyGuid?: unknown;
    folder?: unknown;
    meta?: unknown;
  };
  if (typeof d.documentId !== 'string' || d.documentId.length === 0) return false;
  if (typeof d.name !== 'string') return false;
  if (d.kind !== 'drawing' && d.kind !== 'document' && d.kind !== 'image') return false;
  if (typeof d.url !== 'string' || d.url.length === 0) return false;
  if (d.mime !== undefined && typeof d.mime !== 'string') return false;
  if (d.storeyGuid !== undefined && typeof d.storeyGuid !== 'string') return false;
  if (d.folder !== undefined && !isStringArray(d.folder)) return false;
  if (d.meta !== undefined) {
    if (!d.meta || typeof d.meta !== 'object') return false;
    if (!Object.values(d.meta).every((s) => typeof s === 'string')) return false;
  }
  return true;
}

/**
 * One capture pin must carry a non-empty id, a known kind and finite world
 * coordinates; name/thumbUrl are optional. Malformed entries are dropped so a
 * bad host payload can't crash the billboard projection loop.
 */
function isCapturePinWire(v: unknown): v is CapturePinWire {
  if (!v || typeof v !== 'object') return false;
  const c = v as { id?: unknown; kind?: unknown; world?: unknown };
  if (typeof c.id !== 'string' || c.id.length === 0) return false;
  if (c.kind !== 'photo' && c.kind !== 'pano360') return false;
  const w = c.world as { x?: unknown; y?: unknown; z?: unknown } | undefined;
  if (!w || typeof w !== 'object') return false;
  return (
    Number.isFinite(w.x as number) &&
    Number.isFinite(w.y as number) &&
    Number.isFinite(w.z as number)
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
    documents?: unknown;
    documentId?: unknown;
    page?: unknown;
    captures?: unknown;
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
    case 'DOCUMENTS_LOAD':
      return Array.isArray(msg.documents) && msg.documents.every(isDocumentDescriptorWire);
    case 'DOCUMENT_OPEN':
      return (
        typeof msg.documentId === 'string' &&
        msg.documentId.length > 0 &&
        (msg.page === undefined || (typeof msg.page === 'number' && Number.isFinite(msg.page)))
      );
    case 'CAPTURES_LOAD':
      return Array.isArray(msg.captures) && msg.captures.every(isCapturePinWire);
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
