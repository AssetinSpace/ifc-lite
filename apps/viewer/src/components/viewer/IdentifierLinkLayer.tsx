/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Identifier hyperlink overlay for the 2D plan pane (D-076 in the AIM repo).
 *
 * Scans the drawing page's pdf.js text layer for identifier-shaped tokens
 * (configurable regex), resolves them through the code → element index, and
 * renders clickable boxes over the rasterized plan. A click triggers EXACTLY
 * the same action as picking the element in the scene — the shared selection
 * store actions (`setSelectedEntityId` + `setSelectedEntity`, the pair
 * `handlePickForSelection` uses) plus revealing the Information panel; no
 * duplicated preview logic, just a different input trigger.
 *
 * Duplicate codes: same-storey candidates win (resolvePageLinks); remaining
 * ambiguity opens a small candidate picker. Codes recognized in the text but
 * absent from the model stay plain text — debug mode outlines them dashed.
 */

import { useEffect, useMemo, useState } from 'react';
import type { UnderlayDrawing } from '@/store';
import { useViewerStore, toGlobalIdFromModels } from '@/store';
import { useIdentifierLinks } from '@/hooks/useIdentifierLinks';
import { compileIdentifierPattern } from '@/lib/identifier-links/config';
import {
  findIdentifierBoxes,
  resolvePageLinks,
  type PageLinkBox,
  type ResolvedPageLink,
} from '@/lib/identifier-links/page-links';
import type { IdentifierTarget } from '@/lib/identifier-links/identifier-index';
import { openPdfDocument, getPdfPageTextItems } from '@/lib/pdf/rasterize';

/**
 * Select the element behind an identifier link — the single source of truth
 * for "open the element preview", shared with direct scene picks: the same
 * selection actions the Viewport pick handler calls, plus revealing the
 * Information (properties) panel that renders the preview.
 */
export function selectIdentifierTarget(target: IdentifierTarget): void {
  const store = useViewerStore.getState();
  const globalId = toGlobalIdFromModels(store.models, target.modelId, target.expressId);
  store.setSelectedEntityId(globalId);
  store.setSelectedEntity({ modelId: target.modelId, expressId: target.expressId });
  store.showWorkspacePanel('properties');
}

interface IdentifierLinkLayerProps {
  drawing: UnderlayDrawing;
  /** Current pane zoom — used to inverse-scale the candidate picker only. */
  zoom: number;
}

export function IdentifierLinkLayer({ drawing, zoom }: IdentifierLinkLayerProps) {
  const { config, index } = useIdentifierLinks();
  const [boxes, setBoxes] = useState<PageLinkBox[] | null>(null);
  const [picker, setPicker] = useState<ResolvedPageLink | null>(null);

  const placement = drawing.placement;
  const page = placement?.page;

  // Scan the page text once per drawing/page/pattern (cached until they change).
  useEffect(() => {
    if (!config.enabled || page === undefined) return;
    let stale = false;
    void (async () => {
      try {
        const doc = await openPdfDocument(drawing.pdfUrl);
        try {
          const { items } = await getPdfPageTextItems(doc, page);
          if (stale) return;
          const re = compileIdentifierPattern(config.pattern);
          setBoxes(re ? findIdentifierBoxes(items, re) : []);
        } finally {
          void doc.destroy();
        }
      } catch (err) {
        console.error('identifier links: page text scan failed', err);
      }
    })();
    return () => {
      stale = true;
      setBoxes(null);
      setPicker(null);
    };
  }, [config.enabled, config.pattern, drawing.pdfUrl, page]);

  const links = useMemo<ResolvedPageLink[]>(() => {
    if (!config.enabled || !index || !boxes) return [];
    return resolvePageLinks(boxes, index, { preferStoreyGuid: placement?.storeyGuid });
  }, [config.enabled, index, boxes, placement?.storeyGuid]);

  if (!config.enabled || !placement || links.length === 0) return null;

  const [pageW, pageH] = placement.pageSize;
  if (!(pageW > 0) || !(pageH > 0)) return null;

  /** PDF points (bottom-left, y-up) → percent CSS box (top-left origin). */
  const toCss = (box: PageLinkBox): React.CSSProperties => ({
    left: `${(box.x / pageW) * 100}%`,
    // box.y is the text baseline; the box extends up by box.h.
    top: `${((pageH - box.y - box.h) / pageH) * 100}%`,
    width: `${(box.w / pageW) * 100}%`,
    height: `${((box.h * 1.25) / pageH) * 100}%`,
  });

  const activate = (link: ResolvedPageLink) => {
    if (link.targets.length === 0) return;
    if (link.targets.length === 1) {
      setPicker(null);
      selectIdentifierTarget(link.targets[0]);
    } else {
      setPicker((prev) => (prev === link ? null : link));
    }
  };

  return (
    <div className="pointer-events-none absolute inset-0" data-testid="identifier-link-layer">
      {links.map((link, i) => {
        const matched = link.targets.length > 0;
        if (!matched && !config.debug) return null;
        return (
          <div
            key={`${link.code}:${i}`}
            role={matched ? 'button' : undefined}
            tabIndex={matched ? 0 : undefined}
            title={
              matched
                ? link.targets.length === 1
                  ? `${link.code} → ${link.targets[0].name || link.targets[0].typeName}`
                  : `${link.code} — ${link.targets.length} elements`
                : `${link.code} — not found in model`
            }
            className={
              matched
                ? 'pointer-events-auto absolute cursor-pointer rounded-[1px] border border-sky-500/60 bg-sky-400/15 hover:bg-sky-400/30'
                : 'absolute rounded-[1px] border border-dashed border-amber-500/70'
            }
            style={toCss(link)}
            onPointerDown={matched ? (e) => e.stopPropagation() : undefined}
            onPointerUp={matched ? (e) => e.stopPropagation() : undefined}
            onClick={matched ? () => activate(link) : undefined}
            onKeyDown={
              matched
                ? (e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      activate(link);
                    }
                  }
                : undefined
            }
          />
        );
      })}
      {picker && (
        <div
          className="pointer-events-auto absolute z-20"
          style={{
            left: `${(picker.x / pageW) * 100}%`,
            top: `${((pageH - picker.y) / pageH) * 100}%`,
            transform: `scale(${1 / zoom})`,
            transformOrigin: '0 0',
          }}
          onPointerDown={(e) => e.stopPropagation()}
          onPointerUp={(e) => e.stopPropagation()}
        >
          <div className="min-w-44 max-w-64 rounded border bg-background p-1 text-[11px] shadow-md">
            <div className="px-1.5 py-0.5 font-medium text-muted-foreground">
              {picker.code} — {picker.targets.length} elements
            </div>
            {picker.targets.slice(0, 8).map((t) => (
              <button
                key={`${t.modelId}:${t.expressId}`}
                type="button"
                className="block w-full truncate rounded px-1.5 py-0.5 text-left hover:bg-accent"
                onClick={() => {
                  setPicker(null);
                  selectIdentifierTarget(t);
                }}
              >
                {t.name || t.typeName || t.guid}
                <span className="ml-1 text-muted-foreground">{t.typeName}</span>
              </button>
            ))}
            {picker.targets.length > 8 && (
              <div className="px-1.5 py-0.5 text-muted-foreground">
                +{picker.targets.length - 8} more…
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
