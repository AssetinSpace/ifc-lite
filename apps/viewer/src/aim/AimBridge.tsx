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

const SOURCE = 'aim-bridge' as const;

/** Blue-400 — matches the old FILTER_COLOR in the AIM three.js viewer. */
const FILTER_COLOR = '#60a5fa';

type InboundMessage =
  | { source: typeof SOURCE; type: 'FOCUS'; guids: string[] }
  | { source: typeof SOURCE; type: 'HIGHLIGHT_FILTER'; guids: string[] }
  | { source: typeof SOURCE; type: 'CLEAR_FILTER' };

type OutboundMessage =
  | { source: typeof SOURCE; type: 'READY' }
  | { source: typeof SOURCE; type: 'ENTITY_SELECTED'; guid: string }
  | { source: typeof SOURCE; type: 'ENTITY_DESELECTED' };

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
      }
    }

    window.addEventListener('message', onMessage);
    post({ source: SOURCE, type: 'READY' });
    return () => window.removeEventListener('message', onMessage);
  }, [bim]);

  // 3D -> DB: forward native selection changes to the host. The host
  // resolves guid -> objects.id via its own guidMap (see lib/data/ifc.ts
  // in the AIM repo) and drives ElementInfoPanel / space-siblings from there.
  const selectedEntity = useViewerStore((s) => s.selectedEntity);
  useEffect(() => {
    if (!embeddedRef.current) return;
    const targetOrigin = parentOriginRef.current ?? '*';
    if (!selectedEntity) {
      window.parent.postMessage({ source: SOURCE, type: 'ENTITY_DESELECTED' } satisfies OutboundMessage, targetOrigin);
      return;
    }
    const guid = guidForEntity(selectedEntity);
    if (guid) {
      window.parent.postMessage({ source: SOURCE, type: 'ENTITY_SELECTED', guid } satisfies OutboundMessage, targetOrigin);
    }
  }, [selectedEntity]);

  return null;
}
