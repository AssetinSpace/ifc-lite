/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Identifier-links orchestration hook:
 *  1. loads the persisted per-project config once the first model is known;
 *  2. (re)builds the code → element index when models or config change.
 *
 * Multiple mounts (settings panel + plan pane) are safe: the build is
 * signature-guarded through the store, so only one build runs per
 * (models, config) combination and late results can't clobber newer ones.
 */

import { useEffect, useMemo } from 'react';
import { useViewerStore } from '@/store';
import {
  loadIdentifierLinkConfig,
  type IdentifierLinkConfig,
} from '@/lib/identifier-links/config';
import {
  buildIdentifierIndex,
  type IdentifierIndex,
} from '@/lib/identifier-links/identifier-index';
import type { IdentifierIndexStatus } from '@/store/slices/identifierLinksSlice';

/** Project key = primary model's file name (host-agnostic, stable per file). */
export function identifierModelKey(models: ReadonlyMap<string, { name: string }>): string | null {
  const first = models.values().next();
  return first.done ? null : first.value.name;
}

export interface UseIdentifierLinksResult {
  config: IdentifierLinkConfig;
  index: IdentifierIndex | null;
  status: IdentifierIndexStatus;
  /** Persistence key for the current project (null with no model loaded). */
  modelKey: string | null;
}

export function useIdentifierLinks(): UseIdentifierLinksResult {
  const models = useViewerStore((s) => s.models);
  const config = useViewerStore((s) => s.identifierLinkConfig);
  const configModelKey = useViewerStore((s) => s.identifierConfigModelKey);
  const index = useViewerStore((s) => s.identifierIndex);
  const status = useViewerStore((s) => s.identifierIndexStatus);

  const modelKey = useMemo(() => identifierModelKey(models), [models]);

  // 1) Load the persisted config once per project.
  useEffect(() => {
    if (!modelKey || modelKey === configModelKey) return;
    const store = useViewerStore.getState();
    store.setIdentifierLinkConfig(loadIdentifierLinkConfig(modelKey));
    store.setIdentifierConfigModelKey(modelKey);
    store.clearIdentifierIndex();
  }, [modelKey, configModelKey]);

  // Data-store readiness participates in the signature so the index rebuilds
  // when a model finishes parsing (ifcDataStore flips null → populated).
  const modelsSignature = useMemo(() => {
    const parts: string[] = [];
    for (const [id, m] of models) parts.push(`${id}:${m.ifcDataStore ? 1 : 0}`);
    return parts.join('|');
  }, [models]);

  // 2) Build the index when enabled and out of date. An empty model set
  // still "builds" (an empty index) so the page scan + debug outlines work
  // before a model finishes loading.
  useEffect(() => {
    if (!config.enabled) return;
    const signature = `${modelsSignature}::${JSON.stringify({
      sources: config.sources,
      pattern: config.pattern,
    })}`;
    const store = useViewerStore.getState();
    if (store.identifierIndexSignature === signature) return;

    const abort = new AbortController();
    store.setIdentifierIndexBuilding(signature);
    void buildIdentifierIndex(models.values(), config, { signal: abort.signal })
      .then((built) => {
        useViewerStore.getState().setIdentifierIndexReady(built, signature);
      })
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        console.error('identifier links: index build failed', err);
        useViewerStore.getState().setIdentifierIndexError();
      });
    return () => abort.abort();
  }, [config, models, modelsSignature]);

  return { config, index, status, modelKey };
}
