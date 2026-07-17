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
 *
 * Two matching layers, mirroring the AIM PDF viewer's `pdf_link.py`:
 *  1. FULL — a single token fully matches the configured pattern.
 *  2. PROXIMITY — drawings often split one code across two text runs in a
 *     label bubble (`DD01` above `02.03`, or side by side). Unmatched tokens
 *     within `PROXIMITY_PT` of each other are joined in reading order
 *     (top→bottom / left→right) and re-tested against the pattern.
 *
 * Rotated text is supported: boxes are the axis-aligned bounds of the run's
 * true (possibly rotated) glyph quad, so vertical labels stay clickable.
 */

import { matchesIdentifierPattern, normalizeIdentifier } from './config.js';

/**
 * A candidate string matches when either its NORMALIZED form (regular code
 * sources) or its EXACT form (case-sensitive sources like GlobalId, where
 * normalization would corrupt the key) passes the pattern.
 */
function matchesEitherForm(pattern: RegExp, value: string): boolean {
  return matchesIdentifierPattern(pattern, value) || pattern.test(value);
}
import type { IdentifierIndex, IdentifierTarget } from './identifier-index.js';

/** Minimal shape of a pdf.js `TextItem` (scale-1 viewport). */
export interface PdfTextItemLike {
  str: string;
  /** pdf.js text transform [a, b, c, d, e, f]; e/f = baseline origin in page points (y-up). */
  transform: number[];
  /** Total advance width in page points (along the baseline direction). */
  width: number;
  /** Line height in page points (along the up direction). */
  height: number;
}

/** One identifier occurrence on the page, box in PDF points (bottom-left origin). */
export interface PageLinkBox {
  /** Normalized code (index lookup key for normalized sources). */
  code: string;
  /** Exact trimmed text — lookup key for case-sensitive sources (GlobalId). */
  exactKey: string;
  /** Raw matched text as printed (joined fragments separated by a space). */
  raw: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** 'full' = single-token match; 'proximity' = joined from split fragments. */
  layer: 'full' | 'proximity';
}

export interface ResolvedPageLink extends PageLinkBox {
  /** Matching model elements; empty = recognized as a code but not in the model. */
  targets: IdentifierTarget[];
}

/**
 * Max center-to-center distance (page points) for joining split code
 * fragments — same ballpark as `PROXIMITY_PT = 28.0` in the reference
 * `pdf_link.py` detector.
 */
export const PROXIMITY_PT = 28;

/** Leading/trailing punctuation that may cling to a printed code (`SN11.01:`). */
const TRIM_EDGES = /^[^0-9A-Za-z]+|[^0-9A-Za-z]+$/g;

/** Fragments longer than this can't plausibly be part of a code — skip pairing. */
const MAX_FRAGMENT_CHARS = 24;

interface PageToken {
  raw: string;
  x: number;
  y: number;
  w: number;
  h: number;
  cx: number;
  cy: number;
  matched: boolean;
}

/** Axis-aligned bounds of a (possibly rotated) sub-run of one text item. */
function tokenBounds(
  item: PdfTextItemLike,
  startChar: number,
  charCount: number,
): { x: number; y: number; w: number; h: number } {
  const [a, b, c, d, e, f] = item.transform;
  const perChar = item.width / item.str.length;
  const along = Math.hypot(a, b);
  // Unit baseline direction; degenerate transforms fall back to +x.
  const ux = along > 1e-9 ? a / along : 1;
  const uy = along > 1e-9 ? b / along : 0;
  const up = Math.hypot(c, d);
  const height = item.height > 0 ? item.height : perChar * 1.4;
  const vx = up > 1e-9 ? (c / up) * height : 0;
  const vy = up > 1e-9 ? (d / up) * height : height;

  const sx = e + ux * (startChar * perChar);
  const sy = f + uy * (startChar * perChar);
  const ex = sx + ux * (charCount * perChar);
  const ey = sy + uy * (charCount * perChar);

  const xs = [sx, ex, sx + vx, ex + vx];
  const ys = [sy, ey, sy + vy, ey + vy];
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  return { x: minX, y: minY, w: Math.max(...xs) - minX, h: Math.max(...ys) - minY };
}

/** Split items into positioned tokens (whitespace runs, punctuation trimmed). */
function collectTokens(items: readonly PdfTextItemLike[]): PageToken[] {
  const tokens: PageToken[] = [];
  for (const item of items) {
    const { str, width } = item;
    if (!str || str.length === 0 || !(width > 0)) continue;

    const tokenRe = /\S+/g;
    let m: RegExpExecArray | null;
    while ((m = tokenRe.exec(str)) !== null) {
      const rawToken = m[0];
      const trimmed = rawToken.replace(TRIM_EDGES, '');
      if (!trimmed) continue;
      const leading = rawToken.indexOf(trimmed);
      const startChar = m.index + (leading >= 0 ? leading : 0);
      const bounds = tokenBounds(item, startChar, trimmed.length);
      tokens.push({
        raw: trimmed,
        ...bounds,
        cx: bounds.x + bounds.w / 2,
        cy: bounds.y + bounds.h / 2,
        matched: false,
      });
    }
  }
  return tokens;
}

/**
 * Scan text items for identifier-shaped text. Single tokens must FULLY match
 * the configured pattern after normalization; unmatched token pairs within
 * `PROXIMITY_PT` are joined in reading order and re-tested (split-bubble
 * labels). Sub-token boxes are proportional slices of the item's advance
 * width — an approximation (no per-glyph metrics) amply precise for clicks.
 */
export function findIdentifierBoxes(
  items: readonly PdfTextItemLike[],
  pattern: RegExp,
): PageLinkBox[] {
  const tokens = collectTokens(items);
  const boxes: PageLinkBox[] = [];

  // Layer 1 — full single-token matches.
  for (const token of tokens) {
    if (!matchesEitherForm(pattern, token.raw)) continue;
    token.matched = true;
    boxes.push({
      code: normalizeIdentifier(token.raw),
      exactKey: token.raw,
      raw: token.raw,
      x: token.x,
      y: token.y,
      w: token.w,
      h: token.h,
      layer: 'full',
    });
  }

  // Layer 2 — proximity join of unmatched fragments (`DD01` + `02.03`).
  const fragments = tokens.filter(
    (t) => !t.matched && t.raw.length <= MAX_FRAGMENT_CHARS && /[0-9A-Za-z]/.test(t.raw),
  );
  const used = new Set<PageToken>();
  for (let i = 0; i < fragments.length; i++) {
    const a = fragments[i];
    if (used.has(a)) continue;
    let best: { token: PageToken; dist: number } | null = null;
    for (let j = 0; j < fragments.length; j++) {
      if (i === j) continue;
      const b = fragments[j];
      if (used.has(b)) continue;
      const dist = Math.hypot(a.cx - b.cx, a.cy - b.cy);
      if (dist > PROXIMITY_PT) continue;
      // Reading order: vertical stacks join top→bottom, rows join left→right.
      // Only the pair's FIRST fragment initiates the join, so each pair is
      // considered exactly once with a deterministic order.
      const dx = Math.abs(a.cx - b.cx);
      const dy = Math.abs(a.cy - b.cy);
      const aFirst = dy > dx ? a.cy > b.cy : a.cx < b.cx;
      if (!aFirst) continue;
      if (!matchesEitherForm(pattern, `${a.raw}.${b.raw}`)) continue;
      if (!best || dist < best.dist) best = { token: b, dist };
    }
    if (!best) continue;
    const b = best.token;
    used.add(a);
    used.add(b);
    const minX = Math.min(a.x, b.x);
    const minY = Math.min(a.y, b.y);
    boxes.push({
      code: normalizeIdentifier(`${a.raw}.${b.raw}`),
      exactKey: `${a.raw}.${b.raw}`,
      raw: `${a.raw} ${b.raw}`,
      x: minX,
      y: minY,
      w: Math.max(a.x + a.w, b.x + b.w) - minX,
      h: Math.max(a.y + a.h, b.y + b.h) - minY,
      layer: 'proximity',
    });
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
    // Union of the normalized-key and exact-key (GlobalId) target lists.
    const fromCode = index.byCode.get(box.code) ?? [];
    let targets = fromCode;
    if (box.exactKey !== box.code) {
      const fromExact = index.byCode.get(box.exactKey) ?? [];
      if (fromExact.length > 0) {
        const seen = new Set(fromCode.map((t) => `${t.modelId}:${t.expressId}`));
        targets = [...fromCode, ...fromExact.filter((t) => !seen.has(`${t.modelId}:${t.expressId}`))];
      }
    }
    if (prefer && targets.length > 1) {
      const sameStorey = targets.filter((t) => t.storeyGuid === prefer);
      if (sameStorey.length > 0) targets = sameStorey;
    }
    return { ...box, targets };
  });
}
