/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * AIM platform bridge — postMessage contract between the AIM Next.js app
 * (iframe host) and this viewer. Mirrors the old three.js ViewerApi /
 * onSelect contract 1:1 so the host side (components/ifc-viewer.tsx in the
 * AIM repo) is a thin iframe wrapper instead of a rewrite. Kept in its own
 * directory, mounted from a single line in App.tsx, so upstream rebases
 * touch this file's neighbourhood as little as possible.
 *
 * Wire format is intentionally NOT @ifc-lite/embed-protocol — that protocol
 * is scoped to the thin `viewer-embed` app (numeric expressId selection,
 * generic host). This bridge talks to one specific, trusted parent (the AIM
 * app) and only needs GUID-centric focus/filter/pick, so a small
 * self-contained protocol keeps the Fáza 2 host wrapper close to the
 * original ViewerApi shape.
 */

import { useEffect, useRef } from 'react';
import { useBim } from '../sdk/BimProvider.js';
import { useViewerStore, type EntityRef } from '../store/index.js';
import { useAimPanelStore, type AimPanelData } from './aimPanelStore.js';

const SOURCE = 'aim-bridge' as const;

/** Blue-400 — matches the old FILTER_COLOR in the AIM three.js viewer. */
const FILTER_COLOR = '#60a5fa';

type InboundMessage =
  | { source: typeof SOURCE; type: 'FOCUS'; guids: string[] }
  | { source: typeof SOURCE; type: 'HIGHLIGHT_FILTER'; guids: string[] }
  | { source: typeof SOURCE; type: 'CLEAR_FILTER' }
  // AI dock viewer ops (D-066 in the AIM repo) — colorize/visibility over GUIDs.
  | { source: typeof SOURCE; type: 'COLORIZE'; guids: string[]; color: string }
  | { source: typeof SOURCE; type: 'HIDE'; guids: string[] }
  | { source: typeof SOURCE; type: 'SHOW'; guids: string[] }
  | { source: typeof SOURCE; type: 'ISOLATE'; guids: string[] }
  | { source: typeof SOURCE; type: 'SHOW_ALL' }
  | { source: typeof SOURCE; type: 'RESET_COLORS' }
  // AIM panel data for the selected element (host DB → AimCard in the
  // PropertiesPanel). Guid-stamped so stale answers are dropped store-side.
  | { source: typeof SOURCE; type: 'AIM_PANEL_DATA'; guid: string; data: AimPanelData }
  | { source: typeof SOURCE; type: 'AIM_PANEL_EMPTY'; guid: string; reason: string };

type OutboundMessage =
  | { source: typeof SOURCE; type: 'READY' }
  | { source: typeof SOURCE; type: 'MODELS_LOADED'; count: number }
  | { source: typeof SOURCE; type: 'ENTITY_SELECTED'; guid: string }
  | { source: typeof SOURCE; type: 'ENTITY_DESELECTED' }
  // Click on a link inside the AimCard — the parent app performs the
  // navigation (href is a host-relative path, e.g. /node/{id}).
  | { source: typeof SOURCE; type: 'AIM_NAVIGATE'; href: string };

function isInboundMessage(data: unknown): data is InboundMessage {
  return (
    !!data &&
    typeof data === 'object' &&
    (data as { source?: unknown }).source === SOURCE &&
    typeof (data as { type?: unknown }).type === 'string'
  );
}

/**
 * GUID -> EntityRef across every federated model. Uses the pre-built
 * GlobalId index on each model's entity table (O(1) per model, no scan) —
 * see `getExpressIdByGlobalId` in packages/data/src/entity-table.ts.
 */
function resolveGuids(guids: string[]): EntityRef[] {
  const models = useViewerStore.getState().models;
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

/** GUID for the entity currently sitting in `selectedEntity`, if any. */
function guidForEntity(ref: EntityRef): string | undefined {
  const model = useViewerStore.getState().models.get(ref.modelId);
  return model?.ifcDataStore?.entities.getGlobalId(ref.expressId) || undefined;
}

export function AimBridge() {
  const bim = useBim();
  const parentOriginRef = useRef<string | null>(null);
  const embeddedRef = useRef(false);

  useEffect(() => {
    // No parent frame (e.g. a standalone viewer tab) — nothing to bridge.
    embeddedRef.current = window.parent !== window;
    if (!embeddedRef.current) return;

    // This app is only ever embedded by the AIM host, so the referrer at
    // mount time IS the trusted origin — no build-time config needed.
    parentOriginRef.current = document.referrer ? new URL(document.referrer).origin : null;
    useAimPanelStore.getState().setEmbedded(true, parentOriginRef.current);

    function post(msg: OutboundMessage) {
      window.parent.postMessage(msg, parentOriginRef.current ?? '*');
    }

    function onMessage(e: MessageEvent) {
      if (parentOriginRef.current && e.origin !== parentOriginRef.current) return;
      if (!isInboundMessage(e.data)) return;

      switch (e.data.type) {
        case 'FOCUS': {
          const refs = resolveGuids(e.data.guids);
          if (refs.length === 0) return;
          bim.viewer.select(refs);
          bim.viewer.flyTo(refs);
          break;
        }
        case 'HIGHLIGHT_FILTER': {
          bim.viewer.resetColors();
          const refs = resolveGuids(e.data.guids);
          if (refs.length > 0) bim.viewer.colorize(refs, FILTER_COLOR);
          break;
        }
        case 'CLEAR_FILTER':
          bim.viewer.resetColors();
          break;
        case 'COLORIZE': {
          const refs = resolveGuids(e.data.guids);
          if (refs.length > 0) bim.viewer.colorize(refs, e.data.color);
          break;
        }
        case 'HIDE': {
          const refs = resolveGuids(e.data.guids);
          if (refs.length > 0) bim.viewer.hide(refs);
          break;
        }
        case 'SHOW': {
          const refs = resolveGuids(e.data.guids);
          if (refs.length > 0) bim.viewer.show(refs);
          break;
        }
        case 'ISOLATE': {
          const refs = resolveGuids(e.data.guids);
          if (refs.length > 0) bim.viewer.isolate(refs);
          break;
        }
        case 'SHOW_ALL':
          bim.viewer.resetVisibility();
          break;
        case 'RESET_COLORS':
          bim.viewer.resetColors();
          break;
        case 'AIM_PANEL_DATA':
          useAimPanelStore.getState().resolve(e.data.guid, { data: e.data.data });
          break;
        case 'AIM_PANEL_EMPTY':
          useAimPanelStore.getState().resolve(e.data.guid, { reason: e.data.reason });
          break;
      }
    }

    window.addEventListener('message', onMessage);
    post({ source: SOURCE, type: 'READY' });
    return () => window.removeEventListener('message', onMessage);
  }, [bim]);

  // Signal the host once models finish loading (the `?models=` autoload is
  // async, so READY fires well before geometry/data exist). The host defers
  // the initial deep-link focus (?focus=<guid>) until this event so
  // resolveGuids can actually find the entity. Fires on the 0 -> N transition.
  const modelCount = useViewerStore((s) => s.models.size);
  const modelsAnnouncedRef = useRef(false);
  useEffect(() => {
    if (!embeddedRef.current) return;
    if (modelCount === 0 || modelsAnnouncedRef.current) return;
    modelsAnnouncedRef.current = true;
    window.parent.postMessage(
      { source: SOURCE, type: 'MODELS_LOADED', count: modelCount } satisfies OutboundMessage,
      parentOriginRef.current ?? '*',
    );
  }, [modelCount]);

  // 3D -> DB: forward native selection changes to the host. The host
  // resolves guid -> objects.id via its own guidMap (see lib/data/ifc.ts
  // in the AIM repo) and drives ElementInfoPanel / space-siblings from there.
  const selectedEntity = useViewerStore((s) => s.selectedEntity);
  useEffect(() => {
    if (!embeddedRef.current) return;
    const targetOrigin = parentOriginRef.current ?? '*';
    if (!selectedEntity) {
      useAimPanelStore.getState().clear();
      window.parent.postMessage({ source: SOURCE, type: 'ENTITY_DESELECTED' } satisfies OutboundMessage, targetOrigin);
      return;
    }
    const guid = guidForEntity(selectedEntity);
    if (guid) {
      // AimCard shows its skeleton immediately; the host answers with
      // AIM_PANEL_DATA / AIM_PANEL_EMPTY (or the store times out quietly).
      useAimPanelStore.getState().beginLoading(guid);
      window.parent.postMessage({ source: SOURCE, type: 'ENTITY_SELECTED', guid } satisfies OutboundMessage, targetOrigin);
    } else {
      useAimPanelStore.getState().clear();
    }
  }, [selectedEntity]);

  return null;
}
