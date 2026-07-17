/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Identifier-link configuration — element codes (e.g. `DD.01.02.003`) found in
 * 2D drawing text become hyperlinks that select the matching model element.
 *
 * Different BIM coordinators store the code in different places (Name,
 * Description, Tag, a custom Pset property), so the SOURCE of the identifier
 * is configurable per project / IFC file rather than hardcoded, with an
 * ordered fallback list (first source that yields a pattern-matching value
 * wins). The code SHAPE is a configurable anchored regex so arbitrary page
 * text (dimensions, axis numbers) can't produce accidental links.
 */

export type IdentifierSourceKind =
  | 'name'
  | 'description'
  | 'objectType'
  | 'tag'
  | 'globalId'
  | 'pset';

export interface IdentifierSource {
  kind: IdentifierSourceKind;
  /** Property-set name — `kind === 'pset'` only (e.g. `Pset_Custom`). */
  psetName?: string;
  /** Property name within the pset — `kind === 'pset'` only. */
  propertyName?: string;
}

export interface IdentifierLinkConfig {
  /** Master switch — per project; off by default. */
  enabled: boolean;
  /** Ordered fallback list of identifier sources. */
  sources: IdentifierSource[];
  /**
   * Regex the full NORMALIZED code must match (see `normalizeIdentifier`).
   * Compiled anchored — `^`/`$` in the stored pattern are optional.
   */
  pattern: string;
  /**
   * Debug mode: also outline text recognized as a code but not found in the
   * model, so unmatched codes are visually distinguishable from plain text.
   */
  debug: boolean;
}

/** Matches `DD.01.02.003` / `DD01.06.03` style codes after normalization. */
export const DEFAULT_IDENTIFIER_PATTERN = '^[A-Z]{2,3}\\.?\\d{2}(?:\\.\\d{1,3})+$';

export const DEFAULT_IDENTIFIER_LINK_CONFIG: IdentifierLinkConfig = {
  enabled: false,
  sources: [{ kind: 'name' }],
  pattern: DEFAULT_IDENTIFIER_PATTERN,
  debug: false,
};

/**
 * Normalize a candidate identifier for index/lookup equality:
 * case-insensitive, whitespace-trimmed, and separator-tolerant — runs of
 * spaces, hyphens, en/em dashes and underscores collapse to a single dot
 * (drawings often print `DD-01-02` or `DD 01 02` for `DD.01.02`).
 */
export function normalizeIdentifier(raw: string): string {
  return raw
    .trim()
    .toUpperCase()
    .replace(/[\s\-–—_]+/g, '.')
    .replace(/\.{2,}/g, '.')
    .replace(/^\.+|\.+$/g, '');
}

/**
 * Compile the configured pattern as a full-string match. Returns null for an
 * invalid regex (settings UI shows the error; matching is disabled until
 * fixed). User anchors are stripped first so both `^…$` and bare patterns
 * behave identically.
 */
export function compileIdentifierPattern(pattern: string): RegExp | null {
  const trimmed = pattern.trim();
  if (!trimmed) return null;
  const body = trimmed.replace(/^\^/, '').replace(/\$$/, '');
  try {
    return new RegExp(`^(?:${body})$`);
  } catch {
    return null;
  }
}

/** True when the (raw or normalized) value normalizes into a pattern match. */
export function matchesIdentifierPattern(re: RegExp, value: string): boolean {
  const normalized = normalizeIdentifier(value);
  return normalized.length > 0 && re.test(normalized);
}

/**
 * Sources exempt from normalization: IFC GlobalIds are case-sensitive base64
 * (`_` and `$` are payload, upper/lower case are DIFFERENT guids), so
 * uppercasing or separator-collapsing them would corrupt the key. Exempt
 * sources are keyed and matched on the trimmed raw value instead.
 */
export function isCaseSensitiveSource(kind: IdentifierSourceKind): boolean {
  return kind === 'globalId';
}

/** Index/lookup key for a value produced by the given source kind. */
export function identifierKeyForSource(kind: IdentifierSourceKind, raw: string): string {
  return isCaseSensitiveSource(kind) ? raw.trim() : normalizeIdentifier(raw);
}

// ── Per-project persistence (localStorage; host-agnostic) ───────────────────

const STORAGE_PREFIX = 'ifc-lite:identifier-links:';

/** Storage key for a project — keyed by the primary model's file name. */
export function identifierConfigStorageKey(modelKey: string): string {
  return `${STORAGE_PREFIX}${modelKey}`;
}

function sanitizeSource(value: unknown): IdentifierSource | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  const kind = v.kind;
  if (
    kind !== 'name' &&
    kind !== 'description' &&
    kind !== 'objectType' &&
    kind !== 'tag' &&
    kind !== 'globalId' &&
    kind !== 'pset'
  ) {
    return null;
  }
  const source: IdentifierSource = { kind };
  if (kind === 'pset') {
    source.psetName = typeof v.psetName === 'string' ? v.psetName : '';
    source.propertyName = typeof v.propertyName === 'string' ? v.propertyName : '';
  }
  return source;
}

/** Parse a persisted config, falling back to defaults field-by-field. */
export function sanitizeIdentifierLinkConfig(value: unknown): IdentifierLinkConfig {
  if (typeof value !== 'object' || value === null) return { ...DEFAULT_IDENTIFIER_LINK_CONFIG };
  const v = value as Record<string, unknown>;
  const sources = Array.isArray(v.sources)
    ? v.sources.map(sanitizeSource).filter((s): s is IdentifierSource => s !== null)
    : [];
  return {
    enabled: typeof v.enabled === 'boolean' ? v.enabled : DEFAULT_IDENTIFIER_LINK_CONFIG.enabled,
    sources: sources.length > 0 ? sources : DEFAULT_IDENTIFIER_LINK_CONFIG.sources.map((s) => ({ ...s })),
    pattern: typeof v.pattern === 'string' && v.pattern.trim() ? v.pattern : DEFAULT_IDENTIFIER_PATTERN,
    debug: typeof v.debug === 'boolean' ? v.debug : DEFAULT_IDENTIFIER_LINK_CONFIG.debug,
  };
}

export function loadIdentifierLinkConfig(modelKey: string): IdentifierLinkConfig {
  if (typeof localStorage === 'undefined') return { ...DEFAULT_IDENTIFIER_LINK_CONFIG };
  try {
    const raw = localStorage.getItem(identifierConfigStorageKey(modelKey));
    if (!raw) return { ...DEFAULT_IDENTIFIER_LINK_CONFIG };
    return sanitizeIdentifierLinkConfig(JSON.parse(raw));
  } catch (err) {
    console.warn('identifier links: failed to load persisted config', err);
    return { ...DEFAULT_IDENTIFIER_LINK_CONFIG };
  }
}

export function saveIdentifierLinkConfig(modelKey: string, config: IdentifierLinkConfig): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(identifierConfigStorageKey(modelKey), JSON.stringify(config));
  } catch (err) {
    console.warn('identifier links: failed to persist config', err);
  }
}
