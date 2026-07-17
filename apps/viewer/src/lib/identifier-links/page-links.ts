/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Page-text scanning — find identifier-shaped tokens in the pdf.js text layer
 * of a drawing page and turn them into clickable page-space boxes.
 *
 * Pure logic (no pdf.js import): callers pass the text items, so the matcher
 * is unit-testable and reusable for other text layers (IFC annotations,
 * generated 2D labels) later.
 */

import { matchesIdentifierPattern, normalizeIdentifier } from './config.js';
import type { IdentifierIndex, IdentifierTarget } from './identifier-index.js';

/** Minimal shape of a pdf.js `TextItem` (scale-1 viewport). */
export interface PdfTextItemLike {
  str: string;
  /** pdf.js text transform [a, b, c, d, e, f]; e/f = baseline origin in page points (y-up). */
  transform: number[];
  /** Total advance width in page points. */
  width: number;
  /** Line height in page points. */
  height: number;
}

/** One identifier occurrence on the page, box in PDF points (bottom-left origin). */
export interface PageLinkBox {
  /** Normalized code (index lookup key). */
  code: string;
  /** Raw matched substring as printed on the page. */
  raw: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ResolvedPageLink extends PageLinkBox {
  /** Matching model elements; empty = recognized as a code but not in the model. */
  targets: IdentifierTarget[];
}

/** Leading/trailing punctuation that may cling to a printed code (`SN11.01:`). */
const TRIM_EDGES = /^[^0-9A-Za-z]+|[^0-9A-Za-z]+$/g;

/**
 * Scan text items for identifier-shaped tokens. Tokens are whitespace-split
 * runs with clinging punctuation trimmed; each surviving token must FULLY
 * match the configured pattern after normalization. Sub-token boxes are
 * proportional slices of the item's advance width — an approximation (no
 * per-glyph metrics) that is amply precise for click targets.
 *
 * Rotated text is skipped: the pane renders axis-aligned overlays, and codes
 * in title blocks / labels are horizontal in practice.
 */
export function findIdentifierBoxes(
  items: readonly PdfTextItemLike[],
  pattern: RegExp,
): PageLinkBox[] {
  const boxes: PageLinkBox[] = [];
  for (const item of items) {
    const { str, transform, width, height } = item;
    if (!str || str.length === 0 || !(width > 0)) continue;
    const [a, b, c] = transform;
    // Horizontal, non-mirrored text only (b/c carry rotation or skew).
    if (Math.abs(b) > 1e-6 || Math.abs(c) > 1e-6 || a <= 0) continue;

    const originX = transform[4];
    const originY = transform[5];
    const perChar = width / str.length;

    const tokenRe = /\S+/g;
    let m: RegExpExecArray | null;
    while ((m = tokenRe.exec(str)) !== null) {
      const rawToken = m[0];
      const trimmed = rawToken.replace(TRIM_EDGES, '');
      if (!trimmed) continue;
      if (!matchesIdentifierPattern(pattern, trimmed)) continue;

      const leading = rawToken.indexOf(trimmed);
      const startChar = m.index + (leading >= 0 ? leading : 0);
      boxes.push({
        code: normalizeIdentifier(trimmed),
        raw: trimmed,
        x: originX + startChar * perChar,
        y: originY,
        w: trimmed.length * perChar,
        h: height > 0 ? height : perChar * 1.4,
      });
    }
  }
  return boxes;
}

/**
 * Resolve scanned boxes against the identifier index. When multiple elements
 * share a code and `preferStoreyGuid` is set (the storey the drawing is
 * calibrated to), same-storey candidates win — the drawing context
 * disambiguates duplicated codes. Ambiguity that survives is kept: the UI
 * offers a candidate picker.
 */
export function resolvePageLinks(
  boxes: readonly PageLinkBox[],
  index: IdentifierIndex,
  options: { preferStoreyGuid?: string } = {},
): ResolvedPageLink[] {
  const prefer = options.preferStoreyGuid;
  return boxes.map((box) => {
    let targets = index.byCode.get(box.code) ?? [];
    if (prefer && targets.length > 1) {
      const sameStorey = targets.filter((t) => t.storeyGuid === prefer);
      if (sameStorey.length > 0) targets = sameStorey;
    }
    return { ...box, targets };
  });
}
