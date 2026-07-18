/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Identifier index — `normalized code → model element(s)`, built once per
 * (models, config) combination and cached in the store (never recomputed per
 * render). Mirrors the AIM PDF viewer's ETL-side `object_ref` lookup, but runs
 * fully client-side over the loaded IFC data stores.
 *
 * Cheap columnar sources (Name / Description / ObjectType) sweep the entity
 * table directly; Tag re-reads the source buffer via EntityExtractor and pset
 * values are extracted once per property set then fanned out to entities via
 * `onDemandPropertyMap` — neither runs per-entity extraction in a hot loop.
 */

import {
  EntityExtractor,
  extractPropertiesOnDemand,
  getAttributeNames,
  type IfcDataStore,
} from '@ifc-lite/parser';
import {
  compileIdentifierSearchPattern,
  isCaseSensitiveSource,
  normalizeIdentifier,
  type IdentifierLinkConfig,
  type IdentifierSource,
  type IdentifierSourceKind,
} from './config.js';

export interface IdentifierTarget {
  modelId: string;
  expressId: number;
  /** IFC GlobalId (22-char GUID) of the element. */
  guid: string;
  name: string;
  /** IFC type, PascalCase (e.g. `IfcWall`). */
  typeName: string;
  /** GlobalId of the containing storey; '' when not storey-contained. */
  storeyGuid: string;
  /** Display name of the containing storey (candidate-picker context). */
  storeyName: string;
  /** Which configured source produced the value. */
  sourceKind: IdentifierSourceKind;
  /** The raw (pre-normalization) identifier value. */
  rawValue: string;
}

export interface IdentifierIndex {
  /** normalized code → all elements carrying it (duplicates preserved). */
  byCode: Map<string, IdentifierTarget[]>;
  /** Entities swept across all models (diagnostics). */
  scannedEntities: number;
  buildTimeMs: number;
}

export interface BuildIdentifierIndexOptions {
  /** Rows per yield point — keeps big models from blocking input. */
  chunkSize?: number;
  signal?: AbortSignal;
}

const DEFAULT_CHUNK_SIZE = 20_000;

/**
 * IFC types that carry a host element's identifier but are never a useful
 * link target — openings are subtractive voids, not components a user selects.
 */
const NON_TARGET_TYPES = new Set([
  'IFCOPENINGELEMENT',
  'IFCOPENINGSTANDARDCASE',
  'IFCVOIDINGFEATURE',
]);

/** Minimal model shape the builder needs (subset of FederatedModel). */
export interface IdentifierIndexModel {
  id: string;
  ifcDataStore: IfcDataStore | null;
}

function yieldToEventLoop(): Promise<void> {
  const maybeScheduler = (globalThis as typeof globalThis & {
    scheduler?: { yield?: () => Promise<void> };
  }).scheduler;
  if (typeof maybeScheduler?.yield === 'function') return maybeScheduler.yield();
  if (typeof setImmediate === 'function') {
    return new Promise<void>((resolve) => {
      setImmediate(() => resolve());
    });
  }
  return new Promise<void>((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      channel.port1.close();
      channel.port2.close();
      resolve();
    };
    channel.port2.postMessage(null);
  });
}

/**
 * Lazy Tag reader — Tag is not a columnar field, so it is re-parsed from the
 * source buffer on demand. The attribute index per IFC type is cached; the
 * extractor is created once per model.
 */
class TagReader {
  private extractor: EntityExtractor | null = null;
  private tagIndexByType = new Map<string, number>();

  constructor(private store: IfcDataStore) {}

  read(expressId: number): string {
    const ref = this.store.entityIndex.byId.get(expressId);
    if (!ref) return '';
    let tagIndex = this.tagIndexByType.get(ref.type);
    if (tagIndex === undefined) {
      tagIndex = getAttributeNames(ref.type).indexOf('Tag');
      this.tagIndexByType.set(ref.type, tagIndex);
    }
    if (tagIndex < 0) return '';
    if (!this.extractor) this.extractor = new EntityExtractor(this.store.source);
    const entity = this.extractor.extractEntity(ref);
    const value = entity?.attributes?.[tagIndex];
    return typeof value === 'string' ? value : '';
  }
}

/**
 * Pset-property reader — extraction is gated by `onDemandPropertyMap` (only
 * entities that HAVE property sets are extracted at all), and the whole build
 * runs once per config change, chunked with event-loop yields.
 */
class PsetValueReader {
  constructor(
    private store: IfcDataStore,
    private psetName: string,
    private propertyName: string,
  ) {}

  read(expressId: number): string {
    if (!this.psetName || !this.propertyName) return '';
    const psetIds = this.store.onDemandPropertyMap?.get(expressId);
    if (!psetIds || psetIds.length === 0) return '';
    const psets = extractPropertiesOnDemand(this.store, expressId);
    const pset = psets.find((p) => p.name === this.psetName);
    const prop = pset?.properties.find((p) => p.name === this.propertyName);
    if (!prop) return '';
    const v = prop.value;
    if (typeof v === 'string') return v;
    if (typeof v === 'number' || typeof v === 'bigint') return String(v);
    return '';
  }
}

/**
 * Build the identifier index over every loaded model. For each entity the
 * configured sources are tried IN ORDER; the first one whose value normalizes
 * into a pattern match wins (a present-but-non-matching value falls through
 * to the next source).
 */
export async function buildIdentifierIndex(
  models: Iterable<IdentifierIndexModel>,
  config: IdentifierLinkConfig,
  options: BuildIdentifierIndexOptions = {},
): Promise<IdentifierIndex> {
  const start = performance.now();
  const chunkSize = options.chunkSize ?? DEFAULT_CHUNK_SIZE;
  const signal = options.signal;
  // Unanchored: the code may be embedded in a longer value ("Dvere DD02.05.04").
  const re = compileIdentifierSearchPattern(config.pattern);
  const byCode = new Map<string, IdentifierTarget[]>();
  let scannedEntities = 0;

  if (!re || config.sources.length === 0) {
    return { byCode, scannedEntities, buildTimeMs: performance.now() - start };
  }

  for (const model of models) {
    const store = model.ifcDataStore;
    if (!store) continue;

    const table = store.entities;
    const strings = store.strings;
    const count = table.count;
    const expressIdCol = table.expressId;
    const nameCol = table.name;
    const globalIdCol = table.globalId;
    const descriptionCol = table.description;
    const objectTypeCol = table.objectType;
    const hierarchy = store.spatialHierarchy;

    const tagReader = new TagReader(store);
    const psetReaders = new Map<IdentifierSource, PsetValueReader>();
    for (const source of config.sources) {
      if (source.kind === 'pset') {
        psetReaders.set(
          source,
          new PsetValueReader(store, source.psetName ?? '', source.propertyName ?? ''),
        );
      }
    }

    const readSource = (source: IdentifierSource, row: number, expressId: number): string => {
      switch (source.kind) {
        case 'name': {
          const idx = nameCol[row];
          return idx !== 0 ? strings.get(idx) : '';
        }
        case 'description': {
          const idx = descriptionCol[row];
          return idx !== 0 ? strings.get(idx) : '';
        }
        case 'objectType': {
          const idx = objectTypeCol[row];
          return idx !== 0 ? strings.get(idx) : '';
        }
        case 'globalId': {
          const idx = globalIdCol[row];
          return idx !== 0 ? strings.get(idx) : '';
        }
        case 'tag':
          return tagReader.read(expressId);
        case 'pset':
          return psetReaders.get(source)?.read(expressId) ?? '';
      }
    };

    for (let chunkStart = 0; chunkStart < count; chunkStart += chunkSize) {
      if (signal?.aborted) {
        throw new DOMException('buildIdentifierIndex aborted', 'AbortError');
      }
      const chunkEnd = Math.min(chunkStart + chunkSize, count);
      for (let row = chunkStart; row < chunkEnd; row++) {
        const guidIdx = globalIdCol[row];
        // Only rows with an IFC GlobalId are linkable targets.
        if (guidIdx === 0) continue;
        scannedEntities++;
        const expressId = expressIdCol[row];

        for (const source of config.sources) {
          const rawValue = readSource(source, row, expressId);
          if (!rawValue) continue;
          // Case-sensitive sources (GlobalId) search the trimmed raw value;
          // everything else the normalized form. The FIRST pattern match
          // inside the value becomes the code — so a Name that carries the
          // code plus a description still indexes.
          const haystack = isCaseSensitiveSource(source.kind)
            ? rawValue.trim()
            : normalizeIdentifier(rawValue);
          const match = haystack ? re.exec(haystack) : null;
          const code = match?.[0] ?? '';
          if (!code) continue;

          // Openings (the hole cut for a door/window) inherit the host's code
          // but are never a meaningful link target — skip them so the picker
          // shows the actual doors, not "IfcOpeningElement".
          const typeName = table.getTypeName(expressId) ?? '';
          if (NON_TARGET_TYPES.has(typeName.toUpperCase())) break;

          const storeyId = hierarchy?.elementToStorey.get(expressId);
          const target: IdentifierTarget = {
            modelId: model.id,
            expressId,
            guid: strings.get(guidIdx),
            name: nameCol[row] !== 0 ? strings.get(nameCol[row]) : '',
            typeName,
            storeyGuid: storeyId !== undefined ? table.getGlobalId(storeyId) : '',
            storeyName: storeyId !== undefined ? table.getName(storeyId) : '',
            sourceKind: source.kind,
            rawValue,
          };
          const list = byCode.get(code);
          if (list) {
            // Dedupe true duplicates (same element indexed twice, e.g. the
            // code present in two attributes) by GlobalId; genuinely distinct
            // elements that share a code are kept (the picker lists them).
            if (!list.some((t) => t.guid === target.guid && t.modelId === target.modelId)) {
              list.push(target);
            }
          } else {
            byCode.set(code, [target]);
          }
          break;
        }
      }
      if (chunkEnd < count) await yieldToEventLoop();
    }
  }

  return { byCode, scannedEntities, buildTimeMs: performance.now() - start };
}

/**
 * Look up a printed value (settings live-test + link resolution). Tries the
 * normalized key first, then the exact trimmed value — so codes from
 * normalized sources AND case-sensitive GlobalId keys both resolve. Targets
 * from both key spaces are merged (deduped per element).
 */
export function lookupIdentifier(
  index: IdentifierIndex,
  value: string,
): IdentifierTarget[] {
  const normalized = normalizeIdentifier(value);
  const exact = value.trim();
  const fromNormalized = normalized ? (index.byCode.get(normalized) ?? []) : [];
  if (!exact || exact === normalized) return fromNormalized;
  const fromExact = index.byCode.get(exact) ?? [];
  if (fromExact.length === 0) return fromNormalized;
  const seen = new Set(fromNormalized.map((t) => `${t.modelId}:${t.expressId}`));
  return [...fromNormalized, ...fromExact.filter((t) => !seen.has(`${t.modelId}:${t.expressId}`))];
}
