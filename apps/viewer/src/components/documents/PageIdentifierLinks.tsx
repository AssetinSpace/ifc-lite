/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Identifier hyperlinks inside the PDF document reader (D-076 in the AIM
 * repo) — the document-tab counterpart of the 2D plan pane's
 * `IdentifierLinkLayer`. Each rendered page is scanned for identifier-shaped
 * tokens (configurable regex + split-bubble proximity join) and matched codes
 * get the shared pale-green clickable highlight; a click selects the element
 * and opens its preview exactly like a scene pick.
 *
 * Scanning is virtualization-aware: it runs only while the page is in the
 * reader's render window (`render`), and the scan result is dropped when the
 * page leaves it — the text items are tiny compared to rasters, but the
 * behaviour mirrors the reader's memory discipline.
 */

import { useEffect, useMemo, useState } from 'react';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { useViewerStore } from '@/store';
import { useIdentifierLinks } from '@/hooks/useIdentifierLinks';
import { combinedPagePattern, compileIdentifierPattern } from '@/lib/identifier-links/config';
import {
  findIdentifierBoxes,
  resolvePageLinks,
  type ResolvedPageLink,
} from '@/lib/identifier-links/page-links';
import { getPdfPageTextItems, type PdfPageTextItem as PageTextItem } from '@/lib/pdf/rasterize';
import { IdentifierLinkBoxes } from '@/components/viewer/IdentifierLinkBoxes';

interface PageIdentifierLinksProps {
  pdf: PDFDocumentProxy;
  page: number;
  /** Scan only while the page is inside the reader's render window. */
  render: boolean;
  /** Owning document id — used to prefer same-storey candidates. */
  docId: string;
}

export function PageIdentifierLinks({ pdf, page, render, docId }: PageIdentifierLinksProps) {
  const { config, index } = useIdentifierLinks();
  // A drawing document knows its storey (D-072 binding) — candidates on that
  // storey win, so a floor-plan click opens THE door on this floor directly
  // instead of a picker listing its same-tag siblings on other floors.
  const docStoreyGuid = useViewerStore((s) => s.viewerDocuments.get(docId)?.storeyGuid ?? undefined);
  // Only the raw text items are fetched async; box detection is a memo below
  // so it re-runs (index-aware) once the model index is ready.
  const [text, setText] = useState<{ items: PageTextItem[]; pageSize: [number, number] } | null>(
    null,
  );

  useEffect(() => {
    if (!config.enabled || !render) return;
    let stale = false;
    // Publish a "scanning" marker up front, so the settings readout reflects
    // this page even if the scan then errors or the PDF has no text layer.
    useViewerStore.getState().setIdentifierScanStats({
      source: 'document', page, status: 'scanning', textItems: 0, codes: 0, matched: 0,
    });
    void (async () => {
      try {
        const { items, pageSizePts } = await getPdfPageTextItems(pdf, page);
        if (stale) return;
        setText({ items, pageSize: pageSizePts });
      } catch (err) {
        if (stale) return;
        console.error(`identifier links: page ${page} text scan failed`, err);
        useViewerStore.getState().setIdentifierScanStats({
          source: 'document', page, status: 'error', textItems: 0, codes: 0, matched: 0,
          error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
        });
      }
    })();
    return () => {
      stale = true;
      setText(null);
    };
  }, [config.enabled, config.pattern, pdf, page, render]);

  const scan = useMemo(() => {
    if (!config.enabled || !text) return null;
    // A printed token may be a TYPE code or a full OCCURRENCE code.
    const re = compileIdentifierPattern(combinedPagePattern(config));
    const isKnown = index ? (code: string) => index.byCode.has(code) : undefined;
    const boxes = re ? findIdentifierBoxes(text.items, re, isKnown) : [];
    return { boxes, pageSize: text.pageSize, textItems: text.items.length };
  }, [config, text, index]);

  const links = useMemo<ResolvedPageLink[]>(() => {
    if (!config.enabled || !index || !scan) return [];
    return resolvePageLinks(scan.boxes, index, { preferStoreyGuid: docStoreyGuid ?? undefined });
  }, [config.enabled, index, scan, docStoreyGuid]);

  // Publish scan diagnostics for the settings panel ("why don't I see links?").
  useEffect(() => {
    if (!config.enabled || !scan) return;
    useViewerStore.getState().setIdentifierScanStats({
      source: 'document',
      page,
      status: 'done',
      textItems: scan.textItems,
      codes: scan.boxes.length,
      matched: links.filter((l) => l.targets.length > 0).length,
    });
  }, [config.enabled, scan, links, page]);

  if (!config.enabled || !scan) return null;

  return (
    <IdentifierLinkBoxes
      links={links}
      pageW={scan.pageSize[0]}
      pageH={scan.pageSize[1]}
      debug={config.debug}
    />
  );
}
