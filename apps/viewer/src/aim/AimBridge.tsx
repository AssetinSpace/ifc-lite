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
import { parsePlacement, serializePlacement } from '@ifc-lite/drawing-underlay';
import { useBim } from '../sdk/BimProvider.js';
import { useViewerStore } from '../store/index.js';
import { AUTOLOAD_COMPLETE_EVENT, parseAutoloadUrls } from '../lib/autoload.js';
import {
  SOURCE,
  FILTER_COLOR,
  FOCUS_COLOR,
  isInboundMessage,
  resolveGuids,
  resolveSelector,
  guidForEntity,
  type OpsSelector,
  type OutboundMessage,
} from './bridge-protocol.js';
import { useAimPanelStore } from './aimPanelStore.js';
import { useCapturePinsStore } from './capturePinsStore.js';

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
    useAimPanelStore.getState().setEmbedded(true, parentOriginRef.current);

    function post(msg: OutboundMessage) {
      window.parent.postMessage(msg, parentOriginRef.current ?? '*');
    }

    // Ops berú buď explicitné GUIDy, alebo množinový selektor (typy/model)
    // rozkladaný viewer-side — „celý VZT.ifc" tak necestuje ako zoznam GUIDov.
    function refsForOp(msg: { guids?: string[]; selector?: OpsSelector }) {
      const models = useViewerStore.getState().models;
      if (msg.guids?.length) return resolveGuids(models, msg.guids);
      if (msg.selector) return resolveSelector(models, msg.selector);
      return [];
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
        case 'COLORIZE': {
          const refs = refsForOp(e.data);
          if (refs.length > 0) bim.viewer.colorize(refs, e.data.color);
          break;
        }
        case 'HIDE': {
          const refs = refsForOp(e.data);
          if (refs.length > 0) bim.viewer.hide(refs);
          break;
        }
        case 'SHOW': {
          const refs = refsForOp(e.data);
          if (refs.length > 0) bim.viewer.show(refs);
          break;
        }
        case 'ISOLATE': {
          const refs = refsForOp(e.data);
          if (refs.length > 0) bim.viewer.isolate(refs);
          break;
        }
        case 'SHOW_ALL':
          bim.viewer.resetVisibility();
          break;
        case 'RESET_COLORS':
          bim.viewer.resetColors();
          focusedRef.current = [];
          break;
        case 'AIM_PANEL_DATA':
          useAimPanelStore.getState().resolve(e.data.guid, { data: e.data.data });
          break;
        case 'AIM_PANEL_EMPTY':
          useAimPanelStore.getState().resolve(e.data.guid, { reason: e.data.reason });
          break;
        case 'UNDERLAYS_LOAD': {
          // Georeferencované PDF podklady (D-072): host posiela zoznam
          // dokumentov naviazaných na podlažia + perzistované _georef.
          // Placement JSON je untrusted — validuje ho parsePlacement;
          // nevalidný georef = výkres bez umiestnenia (kalibruje sa znova).
          const drawings = e.data.drawings.map((d) => ({
            id: d.documentId,
            name: d.name,
            pdfUrl: d.pdfUrl,
            placement: d.georef !== undefined ? parsePlacement(d.georef) : null,
          }));
          useViewerStore.getState().setUnderlayDrawings(drawings);
          break;
        }
        case 'DOCUMENTS_LOAD': {
          // Projektové dokumenty (D-075): host posiela knižnicu dokumentov
          // (výkresy/dokumenty/obrázky) pre in-viewer Documents panel.
          // Súrodenec UNDERLAYS_LOAD — kalibrované výkresy chodia v oboch.
          const docs = e.data.documents.map((d) => ({
            id: d.documentId,
            name: d.name,
            kind: d.kind,
            url: d.url,
            mime: d.mime,
            storeyGuid: d.storeyGuid ?? null,
            folder: d.folder,
            meta: d.meta,
          }));
          useViewerStore.getState().setViewerDocuments(docs);
          break;
        }
        case 'DOCUMENT_OPEN':
          // Deep link (D-075): otvor dokument ako kartu. Neznáme id je no-op
          // (openDocument si to ustráži) — host mohol poslať staršiu linku.
          useViewerStore
            .getState()
            .openDocument(e.data.documentId, e.data.page !== undefined ? { page: e.data.page } : undefined);
          break;
        case 'CAPTURES_LOAD':
          // Reality Capture pins (D-073): host pushes capture points with world
          // coords; the billboard layer (CapturePinLayer) renders them.
          useCapturePinsStore.getState().setPins(e.data.captures);
          break;
      }
    }

    // Kalibrácia uložená vo viewri → host ju perzistuje do
    // documents.properties._georef (D-072). Session-only bez hosta.
    useViewerStore.getState().setUnderlaySaveHandler((documentId, placement) => {
      post({
        source: SOURCE,
        type: 'UNDERLAY_SAVE',
        documentId,
        georef: serializePlacement(placement),
      });
    });

    // 3D -> host: a capture pin click opens its gallery/panorama host-side (D-073).
    useCapturePinsStore.getState().setEmitClick((captureId) => {
      post({ source: SOURCE, type: 'CAPTURE_PIN_CLICK', captureId });
    });

    // Tab dokumentu otvorený/zavretý vo viewri → host recents/analytics (D-075).
    useViewerStore.getState().setDocumentEventHandler(({ docId, event, page }) => {
      // Session-local files never leave the viewer — the host has no use for
      // (and no way to resolve) `local:` ids.
      if (docId.startsWith('local:')) return;
      post({ source: SOURCE, type: 'DOCUMENT_EVENT', documentId: docId, event, page });
    });

    window.addEventListener('message', onMessage);
    post({ source: SOURCE, type: 'READY' });
    return () => {
      window.removeEventListener('message', onMessage);
      useViewerStore.getState().setUnderlaySaveHandler(null);
      useViewerStore.getState().setDocumentEventHandler(null);
      useCapturePinsStore.getState().setEmitClick(null);
      useCapturePinsStore.getState().setPins([]);
    };
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
      useAimPanelStore.getState().clear();
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
