/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Identifier-scheme analysis — proposes the identifier-link configuration by
 * LOOKING AT the loaded model instead of guessing: which fields carry codes
 * (Name / ObjectType / Tag), what shape type codes have, whether occurrence
 * codes are printed verbatim (direct) or composed from the type code plus a
 * per-instance discriminator (e.g. the Revit `Mark` shared parameter).
 *
 * The proposal seeds the settings; the user can override everything there.
 */

import { extractPropertiesOnDemand, type IfcDataStore } from '@ifc-lite/parser';
import {
  normalizeIdentifier,
  type IdentifierLinkConfig,
  type IdentifierSource,
  type OccurrenceMode,
} from './config.js';

/** Broad candidate shape used only during analysis (config gets a tight one). */
const CANDIDATE = /[A-Z]{2,4}\.?\d{2,4}(?:\.\d{1,4})*/;

/** Discriminator property names worth probing, in priority order. */
const DISCRIMINATOR_PROPS = ['Mark', 'Označení', 'Číslo pozice'];

/** Cap for the (pset-extracting) discriminator probe — keeps analysis O(1)-ish. */
const DISCRIMINATOR_SAMPLE = 300;

export interface SchemeProposalStats {
  scanned: number;
  codedElements: number;
  typeEntitiesWithCode: number;
  directOccurrences: number;
  discriminatorProp: string | null;
  discriminatorFill: number;
}

export interface SchemeProposal {
  sources: IdentifierSource[];
  typePattern: string;
  occurrencePattern: string;
  mode: OccurrenceMode;
  discriminatorSources: IdentifierSource[];
  /** Human-readable findings for the settings panel. */
  summary: string;
  stats: SchemeProposalStats;
  /** A few example codes, for the summary/test field. */
  examples: { type: string[]; occurrence: string[] };
}

interface AnalyzeModel {
  id: string;
  ifcDataStore: IfcDataStore | null;
}

interface ShapeSample {
  letters: number;
  firstDigits: number;
  tail: number[];
}

function parseShape(code: string): ShapeSample | null {
  const m = /^([A-Z]{2,4})\.?(\d{2,4})((?:\.\d{1,4})*)$/.exec(code);
  if (!m) return null;
  const tail = m[3] ? m[3].slice(1).split('.').map((g) => g.length) : [];
  return { letters: m[1].length, firstDigits: m[2].length, tail };
}

function range(values: number[]): [number, number] {
  return [Math.min(...values), Math.max(...values)];
}

/** Most common value in a list (ties → smaller). */
function mode<T>(values: T[]): T | undefined {
  const counts = new Map<T, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  let best: T | undefined;
  let bestN = 0;
  for (const [v, n] of [...counts.entries()].sort()) {
    if (n > bestN) {
      best = v;
      bestN = n;
    }
  }
  return best;
}

/**
 * Analyze the loaded models and propose an identifier configuration.
 * Returns null when no identifier-shaped codes are found at all.
 */
export function analyzeIdentifierScheme(models: Iterable<AnalyzeModel>): SchemeProposal | null {
  const fieldHits: Record<'name' | 'objectType' | 'tag', number> = { name: 0, objectType: 0, tag: 0 };
  const typeShapes: ShapeSample[] = [];
  const occShapes: ShapeSample[] = [];
  const typeExamples = new Set<string>();
  const occExamples = new Set<string>();
  /** Coded occurrence elements — candidates for the discriminator probe. */
  const codedOccurrences: Array<{ store: IfcDataStore; expressId: number }> = [];
  let scanned = 0;
  let typeEntitiesWithCode = 0;

  for (const model of models) {
    const store = model.ifcDataStore;
    if (!store) continue;
    const table = store.entities;
    const strings = store.strings;
    for (let row = 0; row < table.count; row++) {
      const guidIdx = table.globalId[row];
      if (guidIdx === 0) continue;
      scanned++;
      const expressId = table.expressId[row];
      const typeName = table.getTypeName(expressId) ?? '';
      const upper = typeName.toUpperCase();
      if (upper.includes('OPENING')) continue;
      const isType = /Type$|Style$/.test(typeName);

      const fields: Array<['name' | 'objectType' | 'tag', number]> = [
        ['name', table.name[row]],
        ['objectType', table.objectType[row]],
      ];
      let matched: string | null = null;
      let matchedField: 'name' | 'objectType' | 'tag' | null = null;
      for (const [field, idx] of fields) {
        if (idx === 0) continue;
        const m = CANDIDATE.exec(normalizeIdentifier(strings.get(idx)));
        if (m) {
          matched = m[0];
          matchedField = field;
          break;
        }
      }
      if (!matched || !matchedField) continue;
      const shape = parseShape(matched);
      if (!shape) continue;

      fieldHits[matchedField]++;
      if (isType) {
        typeEntitiesWithCode++;
        typeShapes.push(shape);
        if (typeExamples.size < 5) typeExamples.add(matched);
      } else {
        occShapes.push(shape);
        if (occExamples.size < 5) occExamples.add(matched);
        codedOccurrences.push({ store, expressId });
      }
    }
  }

  const allShapes = [...typeShapes, ...occShapes];
  if (allShapes.length === 0) return null;

  // Type tail length: what TYPE entities carry; occurrences fall back when a
  // model exports no coded type entities.
  const typeTailK = mode((typeShapes.length > 0 ? typeShapes : occShapes).map((s) => s.tail.length)) ?? 0;
  const directOccShapes = occShapes.filter((s) => s.tail.length > typeTailK);

  // Discriminator probe: does a Mark-like property distinguish instances?
  let discriminatorProp: string | null = null;
  let discriminatorFill = 0;
  if (codedOccurrences.length > 0) {
    const sample = codedOccurrences.slice(0, DISCRIMINATOR_SAMPLE);
    const fills = new Map<string, number>();
    for (const { store, expressId } of sample) {
      if (!store.onDemandPropertyMap?.get(expressId)?.length) continue;
      const psets = extractPropertiesOnDemand(store, expressId);
      for (const prop of DISCRIMINATOR_PROPS) {
        const hit = psets.some((p) =>
          p.properties.some((q) => q.name === prop && q.value !== null && q.value !== undefined && String(q.value).length > 0 && String(q.value).length <= 6),
        );
        if (hit) fills.set(prop, (fills.get(prop) ?? 0) + 1);
      }
    }
    for (const prop of DISCRIMINATOR_PROPS) {
      const fill = (fills.get(prop) ?? 0) / sample.length;
      if (fill > discriminatorFill) {
        discriminatorFill = fill;
        discriminatorProp = prop;
      }
    }
    if (discriminatorFill < 0.2) discriminatorProp = null;
  }

  // Pattern synthesis from observed shapes.
  const [lMin, lMax] = range(allShapes.map((s) => s.letters));
  const [dMin, dMax] = range(allShapes.map((s) => s.firstDigits));
  const tailLens = allShapes.flatMap((s) => s.tail);
  const [gMin, gMax] = tailLens.length > 0 ? range(tailLens) : [1, 3];
  const letters = lMin === lMax ? `{${lMin}}` : `{${lMin},${lMax}}`;
  const digits = dMin === dMax ? `{${dMin}}` : `{${dMin},${dMax}}`;
  // Discriminators (Mark '03' / '003') may be shorter/longer than in-Name
  // groups — widen the occurrence group bounds by one on each side.
  const occG = `{${Math.max(1, gMin - 1)},${Math.min(4, gMax + 1)}}`;
  const core = `[A-Z]${letters}\\.?\\d${digits}`;
  const typePattern =
    typeTailK > 0 ? `^${core}(?:\\.\\d{${gMin},${gMax}}){${typeTailK}}$` : `^${core}$`;
  const occurrencePattern = `^${core}(?:\\.\\d${occG}){${typeTailK + 1},${Math.max(typeTailK + 1, mode(directOccShapes.map((s) => s.tail.length)) ?? typeTailK + 1)}}$`;

  const occMode: OccurrenceMode =
    directOccShapes.length > 0 && discriminatorProp ? 'auto'
    : directOccShapes.length > 0 ? 'direct'
    : discriminatorProp ? 'composed'
    : 'auto';

  const sources: IdentifierSource[] = (['name', 'objectType', 'tag'] as const)
    .filter((f) => fieldHits[f] > 0)
    .sort((a, b) => fieldHits[b] - fieldHits[a])
    .map((f) => ({ kind: f }));

  const discriminatorSources: IdentifierSource[] = discriminatorProp
    ? [{ kind: 'pset', psetName: '', propertyName: discriminatorProp }]
    : [{ kind: 'pset', psetName: '', propertyName: 'Mark' }];

  const summaryParts = [
    `${occShapes.length + typeShapes.length} coded of ${scanned} elements`,
    `codes live in ${sources.map((s) => s.kind).join(', ') || 'name'}`,
    `type shape e.g. ${[...typeExamples][0] ?? [...occExamples][0] ?? '—'}`,
  ];
  if (directOccShapes.length > 0) summaryParts.push(`${directOccShapes.length} occurrence codes printed directly`);
  if (discriminatorProp) {
    summaryParts.push(
      `instance discriminator "${discriminatorProp}" on ${Math.round(discriminatorFill * 100)}% (composed codes)`,
    );
  }

  return {
    sources: sources.length > 0 ? sources : [{ kind: 'name' }],
    typePattern,
    occurrencePattern,
    mode: occMode,
    discriminatorSources,
    summary: summaryParts.join('; ') + '.',
    stats: {
      scanned,
      codedElements: occShapes.length + typeShapes.length,
      typeEntitiesWithCode,
      directOccurrences: directOccShapes.length,
      discriminatorProp,
      discriminatorFill,
    },
    examples: { type: [...typeExamples], occurrence: [...occExamples] },
  };
}

/** Apply a proposal onto a config (keeps `enabled`/`debug` as they are). */
export function applySchemeProposal(
  config: IdentifierLinkConfig,
  proposal: SchemeProposal,
): IdentifierLinkConfig {
  return {
    ...config,
    sources: proposal.sources.map((s) => ({ ...s })),
    pattern: proposal.typePattern,
    occurrence: {
      mode: proposal.mode,
      pattern: proposal.occurrencePattern,
      discriminatorSources: proposal.discriminatorSources.map((s) => ({ ...s })),
    },
  };
}
