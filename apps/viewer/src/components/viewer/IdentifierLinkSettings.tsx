/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Identifier-link settings (D-076 in the AIM repo) — configure the project's
 * identifier scheme on two levels:
 *
 *  - TYPE code: its regex + the model fields it lives in (Name / ObjectType /
 *    Tag / custom Pset property, fallback order);
 *  - OCCURRENCE code: its regex + how it is obtained — printed verbatim in a
 *    field (`direct`), composed from the type code plus a per-instance
 *    discriminator like the Revit `Mark` parameter (`composed`), or both
 *    tried (`auto`).
 *
 * "Analyze model" proposes the whole configuration by inspecting the loaded
 * model's data; everything stays editable and persists per project.
 * Rendered as a section of the Documents panel.
 */

import { useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, Link2, Plus, Trash2, Wand2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useViewerStore } from '@/store';
import { runIdentifierSchemeAnalysis, useIdentifierLinks } from '@/hooks/useIdentifierLinks';
import {
  combinedPagePattern,
  compileIdentifierPattern,
  normalizeIdentifier,
  saveIdentifierLinkConfig,
  type IdentifierLinkConfig,
  type IdentifierSource,
  type IdentifierSourceKind,
  type OccurrenceMode,
} from '@/lib/identifier-links/config';
import { lookupIdentifier } from '@/lib/identifier-links/identifier-index';

const KIND_LABELS: Record<IdentifierSourceKind, string> = {
  name: 'Name (IfcName)',
  description: 'Description',
  objectType: 'ObjectType',
  tag: 'Tag',
  globalId: 'GlobalId (GUID)',
  pset: 'Property set…',
};

const MODE_LABELS: Record<OccurrenceMode, string> = {
  auto: 'Auto (try both)',
  direct: 'Printed in the field',
  composed: 'Type code + discriminator',
};

/** Ordered fallback-source editor, shared by the type and discriminator lists. */
function SourceListEditor({
  label,
  sources,
  psetPlaceholder,
  onChange,
}: {
  label: string;
  sources: IdentifierSource[];
  psetPlaceholder: string;
  onChange: (sources: IdentifierSource[]) => void;
}) {
  const update = (i: number, patch: Partial<IdentifierSource>) =>
    onChange(sources.map((s, idx) => (idx === i ? { ...s, ...patch } : s)));
  const move = (i: number, delta: -1 | 1) => {
    const j = i + delta;
    if (j < 0 || j >= sources.length) return;
    const next = [...sources];
    [next[i], next[j]] = [next[j], next[i]];
    onChange(next);
  };

  return (
    <div className="flex flex-col gap-1" role="group" aria-label={label}>
      {sources.map((source, i) => (
        <div key={i} className="flex items-center gap-1">
          <select
            className="h-6 min-w-0 flex-1 rounded border bg-background px-1 text-[11px]"
            value={source.kind}
            aria-label={`${label} ${i + 1}`}
            onChange={(e) => {
              const kind = e.target.value as IdentifierSourceKind;
              update(i, {
                kind,
                psetName: kind === 'pset' ? (source.psetName ?? '') : undefined,
                propertyName: kind === 'pset' ? (source.propertyName ?? '') : undefined,
              });
            }}
          >
            {(Object.keys(KIND_LABELS) as IdentifierSourceKind[]).map((kind) => (
              <option key={kind} value={kind}>
                {KIND_LABELS[kind]}
              </option>
            ))}
          </select>
          <Button variant="ghost" size="icon" className="size-5 shrink-0" disabled={i === 0}
            onClick={() => move(i, -1)} aria-label="Move source up">
            <ArrowUp className="size-3" aria-hidden />
          </Button>
          <Button variant="ghost" size="icon" className="size-5 shrink-0"
            disabled={i === sources.length - 1} onClick={() => move(i, 1)} aria-label="Move source down">
            <ArrowDown className="size-3" aria-hidden />
          </Button>
          <Button variant="ghost" size="icon" className="size-5 shrink-0" disabled={sources.length <= 1}
            onClick={() => onChange(sources.filter((_, idx) => idx !== i))} aria-label="Remove source">
            <Trash2 className="size-3" aria-hidden />
          </Button>
        </div>
      ))}
      {sources.map(
        (source, i) =>
          source.kind === 'pset' && (
            <div key={`pset:${i}`} className="flex items-center gap-1 pl-2">
              <input
                className="h-6 min-w-0 flex-1 rounded border bg-background px-1 text-[11px]"
                placeholder="Pset (empty = any)"
                value={source.psetName ?? ''}
                aria-label={`${label} ${i + 1} property set name`}
                onChange={(e) => update(i, { psetName: e.target.value })}
              />
              <input
                className="h-6 min-w-0 flex-1 rounded border bg-background px-1 text-[11px]"
                placeholder={psetPlaceholder}
                value={source.propertyName ?? ''}
                aria-label={`${label} ${i + 1} property name`}
                onChange={(e) => update(i, { propertyName: e.target.value })}
              />
            </div>
          ),
      )}
      <Button
        variant="ghost"
        size="sm"
        className="h-6 self-start px-1.5 text-[11px]"
        onClick={() => onChange([...sources, { kind: 'name' }])}
      >
        <Plus className="mr-1 size-3" aria-hidden /> Add fallback source
      </Button>
    </div>
  );
}

export function IdentifierLinkSettings() {
  const { config, index, status, modelKey } = useIdentifierLinks();
  const setConfig = useViewerStore((s) => s.setIdentifierLinkConfig);
  const scanStats = useViewerStore((s) => s.identifierScanStats);
  const schemeSummary = useViewerStore((s) => s.identifierSchemeSummary);
  const [testValue, setTestValue] = useState('');

  const apply = (next: IdentifierLinkConfig) => {
    setConfig(next);
    if (modelKey) saveIdentifierLinkConfig(modelKey, next);
  };

  const typeRe = useMemo(() => compileIdentifierPattern(config.pattern), [config.pattern]);
  const occRe = useMemo(
    () => compileIdentifierPattern(config.occurrence.pattern),
    [config.occurrence.pattern],
  );
  const pageRe = useMemo(() => compileIdentifierPattern(combinedPagePattern(config)), [config]);

  const testNormalized = normalizeIdentifier(testValue);
  const testIsOccurrence = !!(occRe && testNormalized && occRe.test(testNormalized));
  const testIsType = !testIsOccurrence && !!(typeRe && testNormalized && typeRe.test(testNormalized));
  const testMatches = !!(pageRe && testNormalized && pageRe.test(testNormalized));
  const testHits = testMatches && index ? lookupIdentifier(index, testValue) : [];

  const codeCount = index?.byCode.size ?? 0;

  return (
    <div className="border-b p-2" aria-label="Identifier links settings">
      <div className="flex items-center gap-2 px-1">
        <Link2 className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
        <span className="min-w-0 flex-1 truncate text-xs font-medium">Identifier links</span>
        <label className="flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground">
          <input
            type="checkbox"
            checked={config.enabled}
            onChange={(e) => apply({ ...config, enabled: e.target.checked })}
            aria-label="Enable identifier links"
          />
          Enabled
        </label>
      </div>

      <div className="mt-2 flex flex-col gap-2 px-1">
        <p className="text-[11px] leading-snug text-muted-foreground">
          Element codes found in the 2D plan text become clickable links that select the element.
          Configure the TYPE code and how the per-instance OCCURRENCE code is obtained — or let
          the analysis propose it from the model.
        </p>

        {/* Model-scheme analysis: proposes sources, patterns and the
            occurrence mode from the loaded data. */}
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            className="h-6 px-2 text-[11px]"
            onClick={() => runIdentifierSchemeAnalysis()}
            title="Inspect the loaded model and propose sources, patterns and the occurrence mode"
          >
            <Wand2 className="mr-1 size-3" aria-hidden /> Analyze model
          </Button>
          {schemeSummary && (
            <span className="min-w-0 flex-1 text-[10px] leading-snug text-muted-foreground">
              {schemeSummary}
            </span>
          )}
        </div>

        {/* Prominent scan diagnostic — the first thing to check when links
            don't appear. Always shown while enabled so it can't be missed. */}
        {config.enabled && (
          <div className="rounded border border-amber-500/40 bg-amber-500/5 p-1.5 text-[11px] leading-snug">
            <div className="flex items-center justify-between gap-2">
              <span className="font-medium">Drawing scan</span>
              {/* Build stamp here (top, always visible) so the running version
                  is confirmable without scrolling — stale-cache triage on
                  mobile where the console isn't reachable. */}
              <span className="shrink-0 font-mono text-[10px] text-muted-foreground/70">
                build {__BUILD_SHA__}
              </span>
            </div>
            {!scanStats && (
              <div className="text-muted-foreground">
                Open a PDF drawing/document to scan its text for codes.
              </div>
            )}
            {scanStats?.status === 'scanning' && (
              <div className="text-muted-foreground">Scanning {scanStats.source}…</div>
            )}
            {scanStats?.status === 'error' && (
              <div className="text-destructive">
                Scan of {scanStats.source} failed:{' '}
                <span className="break-words font-mono">{scanStats.error ?? 'unknown error'}</span>
              </div>
            )}
            {scanStats?.status === 'done' && (
              <>
                <div className="text-muted-foreground">
                  {scanStats.source}, page {scanStats.page}: {scanStats.textItems} text items,{' '}
                  {scanStats.codes} codes, {scanStats.matched} linked.
                </div>
                {scanStats.textItems === 0 && (
                  <div className="mt-0.5 text-amber-700 dark:text-amber-400">
                    This PDF has no selectable text layer (outlined text / scan). Links can't be
                    detected — the drawing would need OCR.
                  </div>
                )}
                {scanStats.textItems > 0 && scanStats.codes === 0 && (
                  <div className="mt-0.5 text-amber-700 dark:text-amber-400">
                    Text found, but no token matched the patterns. Copy a printed code into the
                    test field below and adjust the regexes until it matches.
                  </div>
                )}
                {scanStats.codes > 0 && scanStats.matched === 0 && (
                  <div className="mt-0.5 text-amber-700 dark:text-amber-400">
                    Codes found on the page but none exist in the model — check the sources /
                    occurrence mode (or run Analyze model).
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {/* ── TYPE code ─────────────────────────────────────────────── */}
        <div className="flex flex-col gap-1 rounded border p-1.5">
          <span className="text-[11px] font-medium">Type code</span>
          <label className="text-[10px] text-muted-foreground" htmlFor="identifier-type-pattern">
            Pattern (regex) — e.g. DD01.03
          </label>
          <input
            id="identifier-type-pattern"
            className="h-6 rounded border bg-background px-1 font-mono text-[11px]"
            value={config.pattern}
            onChange={(e) => apply({ ...config, pattern: e.target.value })}
            spellCheck={false}
          />
          {!typeRe && (
            <p className="text-[11px] text-destructive">Invalid regex — links are disabled.</p>
          )}
          <span className="text-[10px] text-muted-foreground">Searched in (fallback order):</span>
          <SourceListEditor
            label="Type-code source"
            sources={config.sources}
            psetPlaceholder="Property (e.g. ElementCode)"
            onChange={(sources) => apply({ ...config, sources })}
          />
        </div>

        {/* ── OCCURRENCE code ───────────────────────────────────────── */}
        <div className="flex flex-col gap-1 rounded border p-1.5">
          <span className="text-[11px] font-medium">Occurrence code</span>
          <label className="text-[10px] text-muted-foreground" htmlFor="identifier-occ-pattern">
            Pattern (regex) — e.g. DD01.03.001
          </label>
          <input
            id="identifier-occ-pattern"
            className="h-6 rounded border bg-background px-1 font-mono text-[11px]"
            value={config.occurrence.pattern}
            onChange={(e) =>
              apply({ ...config, occurrence: { ...config.occurrence, pattern: e.target.value } })
            }
            spellCheck={false}
          />
          {!occRe && (
            <p className="text-[11px] text-destructive">Invalid regex — links are disabled.</p>
          )}
          <label className="text-[10px] text-muted-foreground" htmlFor="identifier-occ-mode">
            How the occurrence code is obtained
          </label>
          <select
            id="identifier-occ-mode"
            className="h-6 rounded border bg-background px-1 text-[11px]"
            value={config.occurrence.mode}
            onChange={(e) =>
              apply({
                ...config,
                occurrence: { ...config.occurrence, mode: e.target.value as OccurrenceMode },
              })
            }
          >
            {(Object.keys(MODE_LABELS) as OccurrenceMode[]).map((m) => (
              <option key={m} value={m}>
                {MODE_LABELS[m]}
              </option>
            ))}
          </select>
          {config.occurrence.mode !== 'direct' && (
            <>
              <span className="text-[10px] text-muted-foreground">
                Instance discriminator — appended to the type code (e.g. Mark "001" →
                DD01.03.001):
              </span>
              <SourceListEditor
                label="Discriminator source"
                sources={config.occurrence.discriminatorSources}
                psetPlaceholder="Property (e.g. Mark)"
                onChange={(discriminatorSources) =>
                  apply({ ...config, occurrence: { ...config.occurrence, discriminatorSources } })
                }
              />
            </>
          )}
        </div>

        {/* Live test */}
        <input
          className="h-6 rounded border bg-background px-1 text-[11px]"
          placeholder="Test a value (e.g. DD01.03.001)"
          value={testValue}
          aria-label="Test identifier value"
          onChange={(e) => setTestValue(e.target.value)}
        />
        {testValue && (
          <p className="text-[11px] text-muted-foreground">
            → <span className="font-mono">{testNormalized || '∅'}</span>{' '}
            {testIsOccurrence
              ? 'matches the occurrence pattern'
              : testIsType
                ? 'matches the type pattern'
                : 'does not match'}
            {testMatches && index
              ? `, ${testHits.length} element${testHits.length === 1 ? '' : 's'} in the model`
              : ''}
          </p>
        )}

        <label className="flex items-center gap-1 text-[11px] text-muted-foreground">
          <input
            type="checkbox"
            checked={config.debug}
            onChange={(e) => apply({ ...config, debug: e.target.checked })}
          />
          Debug: outline codes not found in the model
        </label>

        <p className="text-[11px] text-muted-foreground">
          {status === 'building' && 'Building identifier index…'}
          {status === 'ready' && `Index ready — ${codeCount} distinct codes.`}
          {status === 'error' && 'Index build failed — see console.'}
          {status === 'idle' && config.enabled && 'Index will build once a model is loaded.'}
          {status === 'idle' && !config.enabled && 'Enable to build the identifier index.'}
        </p>
      </div>
    </div>
  );
}
