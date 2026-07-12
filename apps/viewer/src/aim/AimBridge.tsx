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
import { useViewerStore } from '../store/index.js';
import { AUTOLOAD_COMPLETE_EVENT, parseAutoloadUrls } from '../lib/autoload.js';
import {
  SOURCE,
  FILTER_COLOR,
  FOCUS_COLOR,
  isInboundMessage,
  resolveGuids,
  guidForEntity,
  type OutboundMessage,
} from './bridge-protocol.js';

export function AimBridge() {
  const bim = useBim();
  const parentOriginRef = useRef<string | null>(null);
  const embeddedRef = useRef(false);
  // Prvky ofarbené posledným FOCUS-om — ďalší FOCUS ich vráti do pôvodných
  // farieb (partial resetColors), aby sa oranžová nehromadila po scéne.
  const focusedRef = useRef<ReturnType<typeof resolveGuids>>([]);
  // Selekcie nastavené hostovým FOCUS-om — tie sa hostovi NEposielajú späť
  // ako ENTITY_SELECTED (echo by z jeho vlastného príkazu spravilo "user
  // pick" a prirodzená host implementácia by sa zacyklila FOCUS→SELECTED).
  const programmaticSelectionRef = useRef<Set<string> | null>(null);

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
      // Len priamy rodič — iné okná (popupy, vnorené iframy) nemajú čo
      // posielať bridge príkazy, ani keby trafili origin.
      if (e.source !== window.parent) return;
      if (parentOriginRef.current && e.origin !== parentOriginRef.current) return;
      if (!isInboundMessage(e.data)) return;

      switch (e.data.type) {
        case 'FOCUS': {
          const refs = resolveGuids(useViewerStore.getState().models, e.data.guids);
          if (refs.length === 0) return;
          // Explicitné ofarbenie (oranžová ako v pôvodnom AIM three.js
          // vieweri): multi-select cez SDK plní iba selectedEntitiesSet a
          // renderer highlight (selectedEntityIds sync) necháva na callerovi
          // — pozri addEntityToSelection v selectionSlice — takže samotný
          // select() by v 3D nebol vidieť.
          if (focusedRef.current.length > 0) bim.viewer.resetColors(focusedRef.current);
          bim.viewer.colorize(refs, FOCUS_COLOR);
          focusedRef.current = refs;
          programmaticSelectionRef.current = new Set(refs.map((r) => `${r.modelId}:${r.expressId}`));
          bim.viewer.select(refs);
          bim.viewer.flyTo(refs);
          break;
        }
        case 'HIGHLIGHT_FILTER': {
          // Plný reset zhodí aj focus ofarbenie — filter ho nahrádza.
          bim.viewer.resetColors();
          focusedRef.current = [];
          const refs = resolveGuids(useViewerStore.getState().models, e.data.guids);
          if (refs.length > 0) bim.viewer.colorize(refs, FILTER_COLOR);
          break;
        }
        case 'CLEAR_FILTER':
          bim.viewer.resetColors();
          focusedRef.current = [];
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
  // resolveGuids can actually find the entity.
  //
  // Autoload je SEKVENČNÝ — latch na prvom náraste models.size by ohlásil
  // MODELS_LOADED po PRVOM modeli a deep-link focus na prvok z neskoršieho
  // modelu (VZT vo federácii ASR+VZT) by sa vyhodnotil do prázdna. Pri
  // autoloade preto čakáme na AUTOLOAD_COMPLETE_EVENT z ViewerLayout (fire-uje
  // vždy, aj pri zlyhaní URL — host nesmie čakať navždy); bez autoload
  // parametrov ostáva pôvodný 0 → N latch (manuálny load v embede).
  const modelCount = useViewerStore((s) => s.models.size);
  const modelsAnnouncedRef = useRef(false);
  const announceModels = () => {
    const count = useViewerStore.getState().models.size;
    if (count === 0 || modelsAnnouncedRef.current) return;
    modelsAnnouncedRef.current = true;
    window.parent.postMessage(
      { source: SOURCE, type: 'MODELS_LOADED', count } satisfies OutboundMessage,
      parentOriginRef.current ?? '*',
    );
  };
  const autoloadingRef = useRef(false);
  useEffect(() => {
    if (!embeddedRef.current) return;
    autoloadingRef.current =
      parseAutoloadUrls(window.location.search, window.location.href).length > 0;
    if (!autoloadingRef.current) return;
    const onAutoloadComplete = () => {
      // Autoload skončil — od tejto chvíle prípadné ďalšie (manuálne) loady
      // ohlasuje štandardný 0 → N latch nižšie.
      autoloadingRef.current = false;
      announceModels();
    };
    window.addEventListener(AUTOLOAD_COMPLETE_EVENT, onAutoloadComplete);
    return () => window.removeEventListener(AUTOLOAD_COMPLETE_EVENT, onAutoloadComplete);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (!embeddedRef.current) return;
    if (modelCount === 0) {
      // Všetky modely odstránené — odlatchni, nech ďalší load ohlási znova.
      modelsAnnouncedRef.current = false;
      return;
    }
    // Počas autoloadu ohlasuje completion event vyššie, nie prvý nárast size.
    if (autoloadingRef.current) return;
    announceModels();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modelCount]);

  // 3D -> DB: forward native selection changes to the host. The host
  // resolves guid -> objects.id via its own guidMap (see lib/data/ifc.ts
  // in the AIM repo) and drives ElementInfoPanel / space-siblings from there.
  const selectedEntity = useViewerStore((s) => s.selectedEntity);
  const hadSelectionRef = useRef(false);
  useEffect(() => {
    if (!embeddedRef.current) return;
    const targetOrigin = parentOriginRef.current ?? '*';
    if (!selectedEntity) {
      // Úvodný render má selectedEntity === null — DESELECTED posielaj až
      // po skutočnej selekcii, inak host dostane šum hneď po READY.
      if (!hadSelectionRef.current) return;
      hadSelectionRef.current = false;
      window.parent.postMessage({ source: SOURCE, type: 'ENTITY_DESELECTED' } satisfies OutboundMessage, targetOrigin);
      return;
    }
    hadSelectionRef.current = true;
    // Selekcia vyvolaná hostovým FOCUS-om sa neechuje späť (viď ref vyššie).
    if (programmaticSelectionRef.current?.has(`${selectedEntity.modelId}:${selectedEntity.expressId}`)) {
      programmaticSelectionRef.current = null;
      return;
    }
    programmaticSelectionRef.current = null;
    const guid = guidForEntity(useViewerStore.getState().models, selectedEntity);
    if (guid) {
      window.parent.postMessage({ source: SOURCE, type: 'ENTITY_SELECTED', guid } satisfies OutboundMessage, targetOrigin);
    }
  }, [selectedEntity]);

  return null;
}
