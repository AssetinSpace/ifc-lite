/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Identifier-link settings (D-076 in the AIM repo) — configure WHERE the
 * element identifier lives in this project's IFC model (Name / Description /
 * ObjectType / Tag / custom Pset property, with fallback order), the code
 * regex (with a live test field), and the per-project enable/debug switches.
 * Rendered as a section of the Documents panel; the config persists per
 * project via localStorage keyed by the primary model's file name.
 */

import { useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, Link2, Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useViewerStore } from '@/store';
import { useIdentifierLinks } from '@/hooks/useIdentifierLinks';
import {
  compileIdentifierPattern,
  normalizeIdentifier,
  saveIdentifierLinkConfig,
  type IdentifierLinkConfig,
  type IdentifierSource,
  type IdentifierSourceKind,
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

export function IdentifierLinkSettings() {
  const { config, index, status, modelKey } = useIdentifierLinks();
  const setConfig = useViewerStore((s) => s.setIdentifierLinkConfig);
  const scanStats = useViewerStore((s) => s.identifierScanStats);
  const [testValue, setTestValue] = useState('');

  const apply = (next: IdentifierLinkConfig) => {
    setConfig(next);
    if (modelKey) saveIdentifierLinkConfig(modelKey, next);
  };

  const updateSource = (i: number, patch: Partial<IdentifierSource>) => {
    const sources = config.sources.map((s, idx) => (idx === i ? { ...s, ...patch } : s));
    apply({ ...config, sources });
  };

  const moveSource = (i: number, delta: -1 | 1) => {
    const j = i + delta;
    if (j < 0 || j >= config.sources.length) return;
    const sources = [...config.sources];
    [sources[i], sources[j]] = [sources[j], sources[i]];
    apply({ ...config, sources });
  };

  const patternRe = useMemo(() => compileIdentifierPattern(config.pattern), [config.pattern]);

  const testNormalized = normalizeIdentifier(testValue);
  const testMatches = !!(patternRe && testNormalized && patternRe.test(testNormalized));
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
              Element codes found in the 2D plan text become clickable links that select the
              element — configure where the code is stored in this model.
            </p>

            {/* Prominent scan diagnostic — the first thing to check when links
                don't appear. Always shown while enabled so it can't be missed. */}
            {config.enabled && (
              <div className="rounded border border-amber-500/40 bg-amber-500/5 p-1.5 text-[11px] leading-snug">
                <div className="font-medium">Drawing scan</div>
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
                    Scan of {scanStats.source} failed — see the browser console.
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
                        Text found, but no token matched the pattern. Copy a printed code into the
                        test field below and adjust the regex until it matches.
                      </div>
                    )}
                    {scanStats.codes > 0 && scanStats.matched === 0 && (
                      <div className="mt-0.5 text-amber-700 dark:text-amber-400">
                        Codes found on the page but none exist in the model — switch the identifier
                        source (the code is stored in a different attribute/property).
                      </div>
                    )}
                  </>
                )}
              </div>
            )}

            {/* Identifier sources, fallback order */}
            <div className="flex flex-col gap-1" role="group" aria-label="Identifier sources">
              {config.sources.map((source, i) => (
                <div key={i} className="flex items-center gap-1">
                  <select
                    className="h-6 min-w-0 flex-1 rounded border bg-background px-1 text-[11px]"
                    value={source.kind}
                    aria-label={`Identifier source ${i + 1}`}
                    onChange={(e) => {
                      const kind = e.target.value as IdentifierSourceKind;
                      updateSource(i, {
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
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-5 shrink-0"
                    disabled={i === 0}
                    onClick={() => moveSource(i, -1)}
                    aria-label="Move source up"
                  >
                    <ArrowUp className="size-3" aria-hidden />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-5 shrink-0"
                    disabled={i === config.sources.length - 1}
                    onClick={() => moveSource(i, 1)}
                    aria-label="Move source down"
                  >
                    <ArrowDown className="size-3" aria-hidden />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-5 shrink-0"
                    disabled={config.sources.length <= 1}
                    onClick={() =>
                      apply({ ...config, sources: config.sources.filter((_, idx) => idx !== i) })
                    }
                    aria-label="Remove source"
                  >
                    <Trash2 className="size-3" aria-hidden />
                  </Button>
                </div>
              ))}
              {config.sources.map(
                (source, i) =>
                  source.kind === 'pset' && (
                    <div key={`pset:${i}`} className="flex items-center gap-1 pl-2">
                      <input
                        className="h-6 min-w-0 flex-1 rounded border bg-background px-1 text-[11px]"
                        placeholder="Pset name (e.g. Pset_Custom)"
                        value={source.psetName ?? ''}
                        aria-label={`Source ${i + 1} property set name`}
                        onChange={(e) => updateSource(i, { psetName: e.target.value })}
                      />
                      <input
                        className="h-6 min-w-0 flex-1 rounded border bg-background px-1 text-[11px]"
                        placeholder="Property (e.g. ElementCode)"
                        value={source.propertyName ?? ''}
                        aria-label={`Source ${i + 1} property name`}
                        onChange={(e) => updateSource(i, { propertyName: e.target.value })}
                      />
                    </div>
                  ),
              )}
              <Button
                variant="ghost"
                size="sm"
                className="h-6 self-start px-1.5 text-[11px]"
                onClick={() => apply({ ...config, sources: [...config.sources, { kind: 'name' }] })}
              >
                <Plus className="mr-1 size-3" aria-hidden /> Add fallback source
              </Button>
            </div>

            {/* Code pattern + live test */}
            <div className="flex flex-col gap-1">
              <label className="text-[11px] text-muted-foreground" htmlFor="identifier-pattern">
                Code pattern (regex)
              </label>
              <input
                id="identifier-pattern"
                className="h-6 rounded border bg-background px-1 font-mono text-[11px]"
                value={config.pattern}
                onChange={(e) => apply({ ...config, pattern: e.target.value })}
                spellCheck={false}
              />
              {!patternRe && (
                <p className="text-[11px] text-destructive">Invalid regex — links are disabled.</p>
              )}
              <input
                className="h-6 rounded border bg-background px-1 text-[11px]"
                placeholder="Test a value (e.g. DD.01.02.003)"
                value={testValue}
                aria-label="Test identifier value"
                onChange={(e) => setTestValue(e.target.value)}
              />
              {testValue && (
                <p className="text-[11px] text-muted-foreground">
                  → <span className="font-mono">{testNormalized || '∅'}</span>{' '}
                  {testMatches ? 'matches the pattern' : 'does not match'}
                  {testMatches && index
                    ? `, ${testHits.length} element${testHits.length === 1 ? '' : 's'} in the model`
                    : ''}
                </p>
              )}
            </div>

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

            {/* Deployed-build stamp — lets users confirm which version a
                browser is actually running (stale-cache triage). */}
            <p className="text-[10px] text-muted-foreground/70">
              build {__BUILD_SHA__}
            </p>
      </div>
    </div>
  );
}
