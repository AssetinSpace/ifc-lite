/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Identifier hyperlink overlay for the 2D plan pane (D-076 in the AIM repo).
 *
 * Scans the drawing page's pdf.js text layer for identifier-shaped tokens
 * (configurable regex), resolves them through the code → element index, and
 * renders clickable boxes over the rasterized plan via the shared
 * `IdentifierLinkBoxes` (same visuals + click path as the PDF reader).
 * A click triggers EXACTLY the same action as picking the element in the
 * scene — see `selectIdentifierTarget` in IdentifierLinkBoxes.
 *
 * Duplicate codes: same-storey candidates win (resolvePageLinks); remaining
 * ambiguity opens a small candidate picker. Codes recognized in the text but
 * absent from the model stay plain text — debug mode outlines them dashed.
 */

import { useEffect, useMemo, useState } from 'react';
import type { UnderlayDrawing } from '@/store';
import { useViewerStore } from '@/store';
import { useIdentifierLinks } from '@/hooks/useIdentifierLinks';
import { compileIdentifierPattern } from '@/lib/identifier-links/config';
import {
  findIdentifierBoxes,
  resolvePageLinks,
  type PageLinkBox,
  type ResolvedPageLink,
} from '@/lib/identifier-links/page-links';
import { openPdfDocument, getPdfPageTextItems } from '@/lib/pdf/rasterize';
import { IdentifierLinkBoxes, selectIdentifierTarget } from './IdentifierLinkBoxes';

export { selectIdentifierTarget };

interface IdentifierLinkLayerProps {
  drawing: UnderlayDrawing;
  /** Current pane zoom — used to inverse-scale the candidate picker only. */
  zoom: number;
}

export function IdentifierLinkLayer({ drawing, zoom }: IdentifierLinkLayerProps) {
  const { config, index } = useIdentifierLinks();
  const [boxes, setBoxes] = useState<PageLinkBox[] | null>(null);
  const [textItems, setTextItems] = useState(0);

  const placement = drawing.placement;
  const page = placement?.page;

  // Scan the page text once per drawing/page/pattern (cached until they change).
  useEffect(() => {
    if (!config.enabled || page === undefined) return;
    let stale = false;
    useViewerStore.getState().setIdentifierScanStats({
      source: drawing.name, page, status: 'scanning', textItems: 0, codes: 0, matched: 0,
    });
    void (async () => {
      try {
        const doc = await openPdfDocument(drawing.pdfUrl);
        try {
          const { items } = await getPdfPageTextItems(doc, page);
          if (stale) return;
          const re = compileIdentifierPattern(config.pattern);
          setTextItems(items.length);
          setBoxes(re ? findIdentifierBoxes(items, re) : []);
        } finally {
          void doc.destroy();
        }
      } catch (err) {
        if (stale) return;
        console.error('identifier links: page text scan failed', err);
        useViewerStore.getState().setIdentifierScanStats({
          source: drawing.name, page, status: 'error', textItems: 0, codes: 0, matched: 0,
          error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
        });
      }
    })();
    return () => {
      stale = true;
      setBoxes(null);
    };
  }, [config.enabled, config.pattern, drawing.pdfUrl, page, drawing.name]);

  const links = useMemo<ResolvedPageLink[]>(() => {
    if (!config.enabled || !index || !boxes) return [];
    return resolvePageLinks(boxes, index, { preferStoreyGuid: placement?.storeyGuid });
  }, [config.enabled, index, boxes, placement?.storeyGuid]);

  // Publish scan diagnostics for the settings panel ("why don't I see links?").
  useEffect(() => {
    if (!config.enabled || boxes === null || page === undefined) return;
    useViewerStore.getState().setIdentifierScanStats({
      source: drawing.name,
      page,
      status: 'done',
      textItems,
      codes: boxes.length,
      matched: links.filter((l) => l.targets.length > 0).length,
    });
  }, [config.enabled, boxes, links, textItems, drawing.name, page]);

  if (!config.enabled || !placement) return null;

  const [pageW, pageH] = placement.pageSize;
  return (
    <IdentifierLinkBoxes
      links={links}
      pageW={pageW}
      pageH={pageH}
      debug={config.debug}
      pickerScale={1 / zoom}
    />
  );
}
