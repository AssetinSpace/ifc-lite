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

/** Gap ≤ this × line height: same word — concatenate directly. */
const MERGE_JOIN_GAP = 0.25;
/** Gap ≤ this × line height: same line — concatenate with a space. */
const MERGE_SPACE_GAP = 2;
/** Perpendicular offset ≤ max(this, 0.5 × height): same text line. */
const MERGE_LINE_TOL_PT = 2;

interface Run {
  str: string;
  /** Extent along the baseline direction. */
  along0: number;
  along1: number;
  /** Signed offset perpendicular to the baseline (line coordinate). */
  perp: number;
  h: number;
  ux: number;
  uy: number;
}

/**
 * Reassemble glyph runs into words/lines. CAD-exported PDFs (AutoCAD, Revit
 * print drivers) often emit every character — or short fragments — as its own
 * text-show operation, so a bubble label `ZV01` arrives as four items and no
 * single token can ever match the code pattern. (The reference `pdf_link.py`
 * never sees this because PyMuPDF's word extraction merges glyphs itself.)
 *
 * Items are grouped by baseline direction, clustered into lines by their
 * perpendicular offset, sorted along the baseline, and merged: touching runs
 * concatenate directly, word-sized gaps become a space (so tokenization still
 * splits there), larger gaps start a new item. Ordinary PDFs whose items are
 * already whole words pass through unchanged (a single run per line merges
 * with nothing or gains only spaces).
 */
export function mergeTextItems(items: readonly PdfTextItemLike[]): PdfTextItemLike[] {
  const groups = new Map<string, Run[]>();
  for (const item of items) {
    const { str, width, height, transform } = item;
    if (!str || str.length === 0 || !(width > 0)) continue;
    const [a, b, , , e, f] = transform;
    const len = Math.hypot(a, b);
    const ux = len > 1e-9 ? a / len : 1;
    const uy = len > 1e-9 ? b / len : 0;
    const along = e * ux + f * uy;
    const perp = -e * uy + f * ux;
    const h = height > 0 ? height : (width / str.length) * 1.4;
    const run: Run = { str, along0: along, along1: along + width, perp, h, ux, uy };
    const key = `${ux.toFixed(3)}:${uy.toFixed(3)}`;
    const list = groups.get(key);
    if (list) list.push(run);
    else groups.set(key, [run]);
  }

  const out: PdfTextItemLike[] = [];
  const toItem = (r: Run): PdfTextItemLike => {
    const nx = -r.uy;
    const ny = r.ux;
    return {
      str: r.str,
      transform: [r.ux, r.uy, nx, ny, r.ux * r.along0 + nx * r.perp, r.uy * r.along0 + ny * r.perp],
      width: r.along1 - r.along0,
      height: r.h,
    };
  };

  for (const group of groups.values()) {
    group.sort((p, q) => p.perp - q.perp || p.along0 - q.along0);
    let line: Run[] = [];
    const flushLine = () => {
      if (line.length === 0) return;
      line.sort((p, q) => p.along0 - q.along0);
      let cur: Run = { ...line[0] };
      for (let i = 1; i < line.length; i++) {
        const r = line[i];
        const h = Math.max(cur.h, r.h);
        const gap = r.along0 - cur.along1;
        if (gap <= MERGE_JOIN_GAP * h) {
          cur.str += r.str;
        } else if (gap <= MERGE_SPACE_GAP * h) {
          cur.str += ` ${r.str}`;
        } else {
          out.push(toItem(cur));
          cur = { ...r };
          continue;
        }
        cur.along1 = Math.max(cur.along1, r.along1);
        cur.h = h;
      }
      out.push(toItem(cur));
      line = [];
    };
    let prev: Run | null = null;
    for (const r of group) {
      if (
        prev &&
        Math.abs(r.perp - prev.perp) > Math.max(MERGE_LINE_TOL_PT, 0.5 * Math.max(r.h, prev.h))
      ) {
        flushLine();
      }
      line.push(r);
      prev = r;
    }
    flushLine();
  }
  return out;
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
  // Reassemble per-glyph CAD output into words first — see mergeTextItems.
  const tokens = collectTokens(mergeTextItems(items));
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
